import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || process.env.WS_PORT || 8080);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000);
const TELEMETRY_LIMIT_PER_SEC = 5;

const rooms = new Map(); // deviceId -> { driver: WebSocket|null, viewers: Set<WebSocket> }
const latestTelemetry = new Map(); // deviceId -> last telemetry payload
const names = new Map(); // deviceId -> latest displayName
const routeMeta = new Map(); // deviceId -> { routeId?: string, direction?: string }

function ensureRoom(deviceId) {
  if (!rooms.has(deviceId)) {
    rooms.set(deviceId, { driver: null, viewers: new Set() });
  }
  return rooms.get(deviceId);
}

function removeSocketFromRoom(ws) {
  const { deviceId, role } = ws.meta;
  if (!deviceId || !rooms.has(deviceId)) return;
  const room = rooms.get(deviceId);
  if (role === "driver" && room.driver === ws) {
    room.driver = null;
  } else if (role === "viewer") {
    room.viewers.delete(ws);
  }
  if (!room.driver && room.viewers.size === 0) {
    rooms.delete(deviceId);
    latestTelemetry.delete(deviceId);
  }
}

function assignSocketToRoom(ws, deviceId, role) {
  removeSocketFromRoom(ws);
  const room = ensureRoom(deviceId);
  ws.meta.deviceId = deviceId;
  ws.meta.role = role;

  if (role === "driver") {
    if (room.driver && room.driver !== ws) {
      room.driver.close(1001, "driver replaced");
    }
    room.driver = ws;
  } else {
    room.viewers.add(ws);
    const snapshot = latestTelemetry.get(deviceId);
    if (snapshot) {
      sendJson(ws, snapshot);
    }
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function validateHello(msg) {
  if (!msg || typeof msg !== "object") return "Payload must be object";
  if (msg.type !== "hello") return "Expected type \"hello\"";
  if (msg.role !== "driver" && msg.role !== "viewer") return "Role must be driver or viewer";
  if (typeof msg.deviceId !== "string" || msg.deviceId.trim() === "") return "deviceId required";
  return null;
}

function validateTelemetry(msg) {
  if (!msg || typeof msg !== "object") return "Payload must be object";
  if (msg.type !== "telemetry") return "Expected type \"telemetry\"";
  if (typeof msg.deviceId !== "string" || msg.deviceId.trim() === "") return "deviceId required";
  if (typeof msg.lat !== "number" || Number.isNaN(msg.lat)) return "lat must be number";
  if (typeof msg.lng !== "number" || Number.isNaN(msg.lng)) return "lng must be number";
  if (typeof msg.ts !== "number" || Number.isNaN(msg.ts)) return "ts must be number";
  if (msg.speed !== undefined && (typeof msg.speed !== "number" || Number.isNaN(msg.speed))) {
    return "speed must be number";
  }
  if (msg.heading !== undefined && (typeof msg.heading !== "number" || Number.isNaN(msg.heading))) {
    return "heading must be number";
  }
  return null;
}

function initRateLimiter(meta) {
  if (!meta.rate) {
    meta.rate = { tokens: TELEMETRY_LIMIT_PER_SEC, last: Date.now() };
  }
}

function consumeRateToken(meta) {
  initRateLimiter(meta);
  const now = Date.now();
  const bucket = meta.rate;
  const elapsed = now - bucket.last;
  bucket.last = now;
  bucket.tokens = Math.min(
    TELEMETRY_LIMIT_PER_SEC,
    bucket.tokens + (elapsed / 1000) * TELEMETRY_LIMIT_PER_SEC,
  );
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.meta = { role: null, deviceId: null, rate: null, remote: req.socket.remoteAddress };
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.warn("Malformed JSON from client", err);
      sendJson(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    if (!msg || typeof msg !== "object") {
      sendJson(ws, { type: "error", error: "Payload must be object" });
      return;
    }

    if (msg.type === "hello") {
      const error = validateHello(msg);
      if (error) {
        sendJson(ws, { type: "error", error });
        return;
      }
      assignSocketToRoom(ws, msg.deviceId, msg.role);
      const announcedName = typeof msg.displayName === "string" ? msg.displayName.trim() : "";
      if (announcedName) {
        names.set(msg.deviceId, announcedName);
      }
      const announcedRoute = typeof msg.routeId === "string" ? msg.routeId.trim() : "";
      const announcedDirection = typeof msg.direction === "string" ? msg.direction.trim() : "";
      if (announcedRoute || announcedDirection) {
        routeMeta.set(msg.deviceId, {
          routeId: announcedRoute || routeMeta.get(msg.deviceId)?.routeId,
          direction: announcedDirection || routeMeta.get(msg.deviceId)?.direction,
        });
      }
      const meta = routeMeta.get(msg.deviceId);
      const nameForLog = announcedName || names.get(msg.deviceId) || "(none)";
      const routeForLog = meta?.routeId || "(none)";
      const directionForLog = meta?.direction || "(none)";
      console.log(
        `[hello] ${msg.role} subscribed to ${msg.deviceId} name=${nameForLog} route=${routeForLog}/${directionForLog} (remote=${ws.meta.remote})`,
      );
      const helloAck = { type: "hello-ack", role: msg.role, deviceId: msg.deviceId };
      if (announcedName) helloAck.displayName = announcedName;
      if (meta?.routeId) helloAck.routeId = meta.routeId;
      if (meta?.direction) helloAck.direction = meta.direction;
      sendJson(ws, helloAck);
      return;
    }

    if (msg.type === "telemetry") {
      if (ws.meta.role !== "driver") {
        sendJson(ws, { type: "error", error: "Only drivers may send telemetry" });
        return;
      }
      const error = validateTelemetry(msg);
      if (error) {
        sendJson(ws, { type: "error", error });
        return;
      }
      if (msg.deviceId !== ws.meta.deviceId) {
        sendJson(ws, { type: "error", error: "Driver must send telemetry for subscribed deviceId" });
        return;
      }
      if (!consumeRateToken(ws.meta)) {
        console.warn(`[telemetry] rate limited device=${ws.meta.deviceId}`);
        return;
      }
      const payload = {
        type: "telemetry",
        deviceId: msg.deviceId,
        lat: msg.lat,
        lng: msg.lng,
        ts: msg.ts,
      };
      if (msg.speed !== undefined) payload.speed = msg.speed;
      if (msg.heading !== undefined) payload.heading = msg.heading;
      const incomingName = typeof msg.displayName === "string" ? msg.displayName.trim() : "";
      if (incomingName) {
        names.set(msg.deviceId, incomingName);
        payload.displayName = incomingName;
      } else {
        const remembered = names.get(msg.deviceId);
        if (remembered) payload.displayName = remembered;
      }
      const incomingRoute = typeof msg.routeId === "string" ? msg.routeId.trim() : "";
      const incomingDirection = typeof msg.direction === "string" ? msg.direction.trim() : "";
      if (incomingRoute || incomingDirection) {
        routeMeta.set(msg.deviceId, {
          routeId: incomingRoute || routeMeta.get(msg.deviceId)?.routeId,
          direction: incomingDirection || routeMeta.get(msg.deviceId)?.direction,
        });
      }
      const rememberedMeta = routeMeta.get(msg.deviceId);
      if (incomingRoute) payload.routeId = incomingRoute;
      else if (rememberedMeta?.routeId) payload.routeId = rememberedMeta.routeId;
      if (incomingDirection) payload.direction = incomingDirection;
      else if (rememberedMeta?.direction) payload.direction = rememberedMeta.direction;

      latestTelemetry.set(msg.deviceId, payload);
      const room = ensureRoom(msg.deviceId);
      room.viewers.forEach((viewer) => {
        sendJson(viewer, payload);
      });
      const nameForLog = payload.displayName || "(none)";
      const routeForLog = payload.routeId || "(none)";
      const directionForLog = payload.direction || "(none)";
      console.log(
        `[telemetry] device=${msg.deviceId} name=${nameForLog} route=${routeForLog}/${directionForLog} lat=${msg.lat.toFixed(5)} lng=${msg.lng.toFixed(5)}`,
      );
      return;
    }

    sendJson(ws, { type: "error", error: "Unsupported message type" });
  });

  ws.on("close", () => {
    removeSocketFromRoom(ws);
  });

  ws.on("error", (err) => {
    console.warn("Socket error", err);
    removeSocketFromRoom(ws);
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

//adding comment
