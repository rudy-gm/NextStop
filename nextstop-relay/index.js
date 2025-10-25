/* eslint-env node */
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || process.env.WS_PORT || 8080);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000);

// In-memory state for the MVP; no persistence is required.
const drivers = new Map(); // deviceId -> WebSocket
const viewers = new Map(); // deviceId -> Set<WebSocket>
const latestTelemetry = new Map(); // deviceId -> telemetry payload

function getViewerSet(deviceId) {
  if (!viewers.has(deviceId)) viewers.set(deviceId, new Set());
  return viewers.get(deviceId);
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastTelemetry(deviceId, telemetry) {
  const targets = viewers.get(deviceId);
  if (!targets) return;
  for (const ws of targets) {
    sendJson(ws, telemetry);
  }
}

function unregister(ws) {
  const { role, deviceId } = ws.meta ?? {};
  if (!role || !deviceId) return;
  if (role === "driver") {
    const existing = drivers.get(deviceId);
    if (existing === ws) drivers.delete(deviceId);
  } else if (role === "viewer") {
    const group = viewers.get(deviceId);
    if (group) {
      group.delete(ws);
      if (group.size === 0) viewers.delete(deviceId);
    }
  }
}

function validateHello(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, error: "Malformed message" };
  if (msg.type !== "hello") return { ok: false, error: "Unexpected message type" };
  if (msg.role !== "driver" && msg.role !== "viewer") return { ok: false, error: "Unknown role" };
  if (typeof msg.deviceId !== "string" || msg.deviceId.trim() === "") {
    return { ok: false, error: "Missing deviceId" };
  }
  return { ok: true };
}

function validateTelemetry(msg, expectedDeviceId) {
  if (!msg || typeof msg !== "object") return { ok: false, error: "Malformed message" };
  if (msg.type !== "telemetry") return { ok: false, error: "Unexpected message type" };
  if (msg.deviceId !== expectedDeviceId) return { ok: false, error: "Device mismatch" };
  if (typeof msg.lat !== "number" || Number.isNaN(msg.lat)) return { ok: false, error: "lat must be number" };
  if (typeof msg.lng !== "number" || Number.isNaN(msg.lng)) return { ok: false, error: "lng must be number" };
  if (typeof msg.ts !== "number" || Number.isNaN(msg.ts)) return { ok: false, error: "ts must be number" };
  if (msg.speed !== undefined && (typeof msg.speed !== "number" || Number.isNaN(msg.speed))) {
    return { ok: false, error: "speed must be number" };
  }
  if (msg.heading !== undefined && (typeof msg.heading !== "number" || Number.isNaN(msg.heading))) {
    return { ok: false, error: "heading must be number" };
  }
  return { ok: true };
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.meta = { connectedAt: Date.now(), origin: req.headers.origin };
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (buffer) => {
    let msg;
    try {
      msg = JSON.parse(buffer.toString());
    } catch (error) {
      console.warn("Invalid JSON payload:", error);
      sendJson(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    // First message must always be hello.
    if (!ws.meta.role) {
      const validation = validateHello(msg);
      if (!validation.ok) {
        sendJson(ws, { type: "error", error: validation.error });
        ws.close(1002, "protocol error");
        return;
      }
      ws.meta.role = msg.role;
      ws.meta.deviceId = msg.deviceId;

      if (msg.role === "driver") {
        // Replace any existing driver connection.
        const previous = drivers.get(msg.deviceId);
        if (previous && previous !== ws) {
          sendJson(previous, { type: "info", message: "Another driver connected" });
          previous.close(1001, "driver replaced");
        }
        drivers.set(msg.deviceId, ws);
      } else {
        const group = getViewerSet(msg.deviceId);
        group.add(ws);
        const snapshot = latestTelemetry.get(msg.deviceId);
        if (snapshot) sendJson(ws, snapshot);
      }

      sendJson(ws, { type: "hello-ack", role: msg.role, deviceId: msg.deviceId });
      return;
    }

    if (msg.type === "telemetry") {
      const { role, deviceId } = ws.meta;
      if (role !== "driver") {
        sendJson(ws, { type: "error", error: "Only drivers may send telemetry" });
        return;
      }
      const validation = validateTelemetry(msg, deviceId);
      if (!validation.ok) {
        sendJson(ws, { type: "error", error: validation.error });
        return;
      }

      const payload = {
        type: "telemetry",
        deviceId,
        lat: msg.lat,
        lng: msg.lng,
        ts: msg.ts,
      };
      if (msg.speed !== undefined) payload.speed = msg.speed;
      if (msg.heading !== undefined) payload.heading = msg.heading;

      latestTelemetry.set(deviceId, payload);
      broadcastTelemetry(deviceId, payload);
      return;
    }

    sendJson(ws, { type: "error", error: "Unsupported message" });
  });

  ws.on("close", () => {
    unregister(ws);
  });

  ws.on("error", () => {
    unregister(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, () => {
  console.log(`WS relay running on ws://localhost:${PORT}`);
});

process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  wss.clients.forEach((ws) => ws.terminate());
  server.close(() => process.exit(0));
});
