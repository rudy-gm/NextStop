import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import routesData from "./routes/routes.json";
import {
  buildRouteMetrics,
  projectOntoRoute,
  formatDistance,
  formatEta,
  smoothSpeed,
} from "./utils/routeMath.js";

const ROUTES = routesData.routes;
const DEFAULT_ROUTE_ID = ROUTES[0]?.id ?? "";
const DEFAULT_DIRECTION = "outbound";
const DRIVER_SEND_INTERVAL_MS = 333; // ~3 Hz cap
const LOG_LIMIT = 60;
const UPCOMING_LIMIT = 5;

const GNV = { lat: 29.6516, lng: -82.3530 };

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function computeEtaSeconds(position, dest, speedMps) {
  const distance = haversineMeters(position, dest);
  const MIN_SPEED = 3;
  const speed = Math.max(speedMps ?? 0, MIN_SPEED);
  return distance / speed;
}

function createMarkerElement(label) {
  const wrapper = document.createElement("div");
  wrapper.className = "marker-wrapper";

  const pill = document.createElement("div");
  pill.className = "marker-label";
  pill.textContent = label;

  const pin = document.createElement("div");
  pin.className = "marker-pin";

  wrapper.appendChild(pill);
  wrapper.appendChild(pin);
  return wrapper;
}

function updateMarkerLabel(marker, label) {
  const el = marker.getElement();
  const labelEl = el.querySelector(".marker-label");
  if (labelEl && labelEl.textContent !== label) {
    labelEl.textContent = label;
  }
}

export default function App() {
  const initialMapToken = import.meta.env.VITE_MAPBOX_TOKEN || "";
  const initialWsUrl = import.meta.env.VITE_WS_URL || "ws://localhost:8080";

  const mapRef = useRef(null);
  const mapNode = useRef(null);
  const mapReadyRef = useRef(false);
  const markerRef = useRef(null);
  const markerLabelRef = useRef("");
  const destMarkerRef = useRef(null);
  const routeFitKeyRef = useRef("");
  const wsRef = useRef(null);
  const watchIdRef = useRef(null);
  const lastDriverSentRef = useRef(0);
  const skipNextHelloRef = useRef(false);

  const [connected, setConnected] = useState(false);
  const [deviceId, setDeviceId] = useState("shuttle-uf-1");
  const [displayName, setDisplayName] = useState("");
  const [asDriver, setAsDriver] = useState(false);
  const [position, setPosition] = useState(null);
  const [dest, setDest] = useState({ ...GNV });
  const [log, setLog] = useState([]);
  const [mapToken, setMapToken] = useState(initialMapToken);
  const [mapTokenInput, setMapTokenInput] = useState(initialMapToken);
  const [wsUrlInput, setWsUrlInput] = useState(initialWsUrl);
  const [activeWsUrl, setActiveWsUrl] = useState(initialWsUrl);
  const [routeId, setRouteId] = useState(DEFAULT_ROUTE_ID);
  const [direction, setDirection] = useState(DEFAULT_DIRECTION);
  const [upcomingStops, setUpcomingStops] = useState([]);
  const [smoothedSpeed, setSmoothedSpeed] = useState(null);

  const currentRole = asDriver ? "driver" : "viewer";
  const trimmedDeviceId = deviceId.trim();
  const trimmedDisplayName = displayName.trim();
  const canConnect = Boolean(wsUrlInput.trim() && trimmedDeviceId);
  const useMatrixEta = import.meta.env.VITE_USE_MATRIX === "yes";
  const matrixFlagRef = useRef(false);

  const logLine = useCallback((message) => {
    const timestamp = new Date().toLocaleTimeString();
    setLog((entries) => [`${timestamp} — ${message}`, ...entries].slice(0, LOG_LIMIT));
  }, []);

  const activeRoute = useMemo(() => ROUTES.find((r) => r.id === routeId) || null, [routeId]);
  const directionNames = activeRoute?.directionNames ?? {};
  const routeDefaults = useMemo(() => ({
    dwellSeconds: activeRoute?.defaults?.dwellSeconds ?? 20,
    minSpeedMps: activeRoute?.defaults?.minSpeedMps ?? 3,
  }), [activeRoute]);

  useEffect(() => {
    if (useMatrixEta && !matrixFlagRef.current) {
      logLine("VITE_USE_MATRIX=yes detected — falling back to local ETA calculations until Matrix integration is enabled.");
      matrixFlagRef.current = true;
    }
  }, [logLine, useMatrixEta]);

  useEffect(() => {
    if (activeRoute) return;
    if (ROUTES[0]) setRouteId(ROUTES[0].id);
  }, [activeRoute]);

  useEffect(() => {
    if (!mapToken || !mapNode.current) return;

    mapboxgl.accessToken = mapToken;
    const map = new mapboxgl.Map({
      container: mapNode.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [GNV.lng, GNV.lat],
      zoom: 12.5,
    });
    mapRef.current = map;
    mapReadyRef.current = false;

    map.on("load", () => {
      if (!map.getSource("route-line")) {
        map.addSource("route-line", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "route-line-layer",
          type: "line",
          source: "route-line",
          paint: {
            "line-color": "#f97316",
            "line-width": 4,
            "line-opacity": 0.85,
          },
        });
      }
      if (!map.getSource("route-stops")) {
        map.addSource("route-stops", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "route-stops-layer",
          type: "circle",
          source: "route-stops",
          paint: {
            "circle-radius": 5,
            "circle-color": "#1d4ed8",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
        map.addLayer({
          id: "route-stops-label",
          type: "symbol",
          source: "route-stops",
          layout: {
            "text-field": ["get", "name"],
            "text-size": 12,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#0f172a",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1,
          },
        });
      }
      mapReadyRef.current = true;
    });

    destMarkerRef.current = new mapboxgl.Marker({ color: "#333" })
      .setLngLat([GNV.lng, GNV.lat])
      .addTo(map);

    map.on("click", (event) => {
      setDest({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      markerLabelRef.current = "";
      destMarkerRef.current = null;
      mapReadyRef.current = false;
    };
  }, [mapToken]);

  useEffect(() => {
    if (destMarkerRef.current) destMarkerRef.current.setLngLat([dest.lng, dest.lat]);
  }, [dest]);

  const directionCoordinates = useMemo(() => {
    if (!activeRoute) return [];
    const coords = activeRoute.polyline || [];
    return direction === "inbound" ? [...coords].reverse() : coords;
  }, [activeRoute, direction]);

  const stopsForDirection = useMemo(() => {
    if (!activeRoute) return [];
    const sorted = [...activeRoute.stops].sort((a, b) => a.sequence - b.sequence);
    return direction === "inbound" ? [...sorted].reverse() : sorted;
  }, [activeRoute, direction]);

  const routeMetrics = useMemo(() => {
    if (!directionCoordinates.length) return null;
    return buildRouteMetrics(directionCoordinates, stopsForDirection);
  }, [directionCoordinates, stopsForDirection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    const lineSource = map.getSource("route-line");
    if (lineSource) {
      const data = routeMetrics
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "LineString", coordinates: routeMetrics.coords },
                properties: {},
              },
            ],
          }
        : { type: "FeatureCollection", features: [] };
      lineSource.setData(data);
    }
    const stopSource = map.getSource("route-stops");
    if (stopSource) {
      const features = routeMetrics
        ? routeMetrics.stops.map((stop) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [stop.lng, stop.lat] },
            properties: { id: stop.id, name: stop.name },
          }))
        : [];
      stopSource.setData({ type: "FeatureCollection", features });
    }
  }, [routeMetrics]);

  useEffect(() => {
    if (!mapRef.current || !routeMetrics) return;
    const key = `${routeId}:${direction}`;
    if (routeFitKeyRef.current === key) return;
    routeFitKeyRef.current = key;
    const bounds = new mapboxgl.LngLatBounds();
    routeMetrics.coords.forEach((coord) => bounds.extend(coord));
    if (bounds.isEmpty()) return;
    mapRef.current.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 600 });
  }, [routeMetrics, routeId, direction]);

  useEffect(() => {
    if (!position || !mapRef.current) return;

    const label = position.name || trimmedDisplayName || trimmedDeviceId || "—";

    if (!markerRef.current) {
      const element = createMarkerElement(label);
      const marker = new mapboxgl.Marker({ element })
        .setLngLat([position.lng, position.lat])
        .addTo(mapRef.current);
      markerRef.current = marker;
      markerLabelRef.current = label;
    } else {
      markerRef.current.setLngLat([position.lng, position.lat]);
      if (markerLabelRef.current !== label) {
        updateMarkerLabel(markerRef.current, label);
        markerLabelRef.current = label;
      }
    }
  }, [position, trimmedDeviceId, trimmedDisplayName]);

  const sendHello = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!trimmedDeviceId) {
      logLine("Device ID is required before subscribing.");
      return;
    }
    const payload = { type: "hello", role: currentRole, deviceId: trimmedDeviceId };
    if (trimmedDisplayName) payload.displayName = trimmedDisplayName;
    if (routeId) payload.routeId = routeId;
    if (direction) payload.direction = direction;
    wsRef.current.send(JSON.stringify(payload));
    logLine(
      `hello → role=${currentRole} device=${trimmedDeviceId} name=${trimmedDisplayName || "(none)"} route=${routeId || "(none)"}/${direction}`,
    );
  }, [currentRole, direction, logLine, routeId, trimmedDeviceId, trimmedDisplayName]);

  const disconnectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
  }, []);

  const connectWs = useCallback(() => {
    const target = wsUrlInput.trim();
    if (!target) {
      logLine("WebSocket URL cannot be empty.");
      return;
    }
    if (!trimmedDeviceId) {
      logLine("Device ID cannot be empty.");
      return;
    }

    if (wsRef.current) {
      wsRef.current.close();
    }

    try {
      const ws = new WebSocket(target);
      wsRef.current = ws;
      setActiveWsUrl(target);
      setConnected(false);

      ws.onopen = () => {
        setConnected(true);
        skipNextHelloRef.current = true;
        logLine(`Connected to ${target}`);
        sendHello();
      };

      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        logLine(`Disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      };

      ws.onerror = () => {
        logLine("WebSocket error");
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "telemetry") {
            if (msg.routeId && (!asDriver || msg.routeId !== routeId)) setRouteId(msg.routeId);
            if (msg.direction && (!asDriver || msg.direction !== direction)) setDirection(msg.direction);
            if (msg.deviceId === trimmedDeviceId) {
              const label = typeof msg.displayName === "string" && msg.displayName.trim()
                ? msg.displayName.trim()
                : msg.deviceId;
              const { lat, lng, speed, heading, ts } = msg;
              setPosition({ lat, lng, speedMps: speed, heading, ts, name: label });
            }
            return;
          }
          if (msg.type === "hello-ack") {
            const nameForLog = msg.displayName ? msg.displayName : "(none)";
            const routeForLog = msg.routeId || "(none)";
            const dirForLog = msg.direction || "(none)";
            logLine(`hello-ack ← role=${msg.role} device=${msg.deviceId} name=${nameForLog} route=${routeForLog}/${dirForLog}`);
            if (msg.routeId && (!asDriver || msg.routeId !== routeId)) setRouteId(msg.routeId);
            if (msg.direction && (!asDriver || msg.direction !== direction)) setDirection(msg.direction);
            return;
          }
          if (msg.type === "error") {
            logLine(`server error ← ${msg.error}`);
            return;
          }
          if (msg.type === "info" && msg.message) {
            logLine(`server info ← ${msg.message}`);
          }
        } catch (err) {
          logLine(`Failed to parse message: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
    } catch (error) {
      logLine(`Unable to open socket: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [asDriver, direction, logLine, routeId, sendHello, trimmedDeviceId, wsUrlInput]);

  useEffect(() => {
    if (!asDriver || !connected || !wsRef.current || !trimmedDeviceId) return;
    if (!("geolocation" in navigator)) {
      logLine("Geolocation not supported");
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const speed = pos.coords.speed ?? undefined;
        const heading = pos.coords.heading ?? undefined;
        const ts = Date.now();
        const payload = {
          type: "telemetry",
          deviceId: trimmedDeviceId,
          lat,
          lng,
          speed,
          heading,
          ts,
        };
        if (trimmedDisplayName) payload.displayName = trimmedDisplayName;
        if (routeId) payload.routeId = routeId;
        if (direction) payload.direction = direction;
        const now = Date.now();
        if (now - lastDriverSentRef.current >= DRIVER_SEND_INTERVAL_MS) {
          try {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify(payload));
              lastDriverSentRef.current = now;
            }
          } catch (err) {
            logLine(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const label = trimmedDisplayName || trimmedDeviceId;
        setPosition({ lat, lng, speedMps: speed, heading, ts, name: label });
      },
      (err) => logLine(`Geo error: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 },
    );
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    };
  }, [asDriver, connected, direction, logLine, routeId, trimmedDeviceId, trimmedDisplayName]);

  useEffect(() => {
    if (!connected) return;
    if (skipNextHelloRef.current) {
      skipNextHelloRef.current = false;
      return;
    }
    sendHello();
  }, [asDriver, connected, direction, routeId, sendHello, trimmedDeviceId, trimmedDisplayName]);

  useEffect(() => () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
  }, []);

  useEffect(() => {
    if (!position) return;
    setSmoothedSpeed((prev) => smoothSpeed(prev, position.speedMps, {
      minSpeedMps: routeDefaults.minSpeedMps ?? 3,
    }));
  }, [position, routeDefaults]);

  useEffect(() => {
    if (!routeMetrics || !position) {
      setUpcomingStops([]);
      return;
    }
    const projection = projectOntoRoute(routeMetrics, position.lng, position.lat);
    if (!projection) {
      setUpcomingStops([]);
      return;
    }
    const currentDistance = projection.distanceFromStart;
    const speed = smoothedSpeed ?? routeDefaults.minSpeedMps;
    const dwell = routeDefaults.dwellSeconds ?? 0;
    const upcoming = [];
    let previousDistance = currentDistance;
    let cumulativeSeconds = 0;

    routeMetrics.stops
      .filter((stop) => stop.distanceFromStart >= currentDistance - 5)
      .slice(0, UPCOMING_LIMIT)
      .forEach((stop) => {
        const delta = Math.max(0, stop.distanceFromStart - previousDistance);
        const travelSeconds = delta / speed;
        cumulativeSeconds += travelSeconds;
        cumulativeSeconds += dwell;
        upcoming.push({
          id: stop.id,
          name: stop.name,
          distanceMeters: stop.distanceFromStart - currentDistance,
          etaSeconds: cumulativeSeconds,
        });
        previousDistance = stop.distanceFromStart;
      });

    setUpcomingStops(upcoming);
  }, [position, routeMetrics, routeDefaults, smoothedSpeed]);

  const eta = useMemo(() => {
    if (!position) return null;
    const secs = computeEtaSeconds({ lat: position.lat, lng: position.lng }, dest, position.speedMps);
    const mm = Math.floor(secs / 60);
    const ss = Math.max(0, Math.round(secs % 60));
    return `${mm}m ${ss}s`;
  }, [position, dest]);

  const speedMph = position?.speedMps != null
    ? `${(position.speedMps * 2.236936).toFixed(1)} mph`
    : (asDriver ? "Waiting for GPS…" : "—");

  const deviceLabel = position?.name || trimmedDisplayName || trimmedDeviceId || "—";
  const directionLabel = directionNames[direction] || direction;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <strong>Next Stop</strong> <span>Real-time shuttle tracker</span>
        </div>
        <div className="connection-badge">
          <span className={`dot ${connected ? "online" : "offline"}`} />
          {connected ? "Connected" : "Disconnected"}
          {connected && activeWsUrl && (
            <span className="ws-url">{activeWsUrl}</span>
          )}
        </div>
      </header>

      <main className="layout">
        <section className="map-panel">
          <div ref={mapNode} className="map-container" />
          {!mapToken && (
            <div className="map-placeholder">
              Provide a Mapbox token to load the map.
            </div>
          )}
          <p className="map-hint">Click anywhere on the map to set a custom destination for ad-hoc ETA.</p>
        </section>

        <section className="sidebar">
          <div className="card">
            <h2>Connection</h2>
            <label>
              WebSocket URL
              <input
                value={wsUrlInput}
                onChange={(event) => setWsUrlInput(event.target.value)}
                placeholder="ws://localhost:8080"
              />
            </label>
            <div className="button-row">
              <button onClick={connectWs} className="primary" disabled={!canConnect}>
                {connected ? "Reconnect" : "Connect"}
              </button>
              <button onClick={disconnectWs} disabled={!connected}>
                Disconnect
              </button>
            </div>
            <label>
              Mapbox token
              <textarea
                value={mapTokenInput}
                onChange={(event) => setMapTokenInput(event.target.value)}
                rows={2}
                placeholder="pk.eyJ1Ijo..."
              />
            </label>
            <button
              onClick={() => {
                setMapToken(mapTokenInput.trim());
                logLine("Applied Mapbox token");
              }}
            >
              Apply token
            </button>
          </div>

          <div className="card">
            <h2>Mode</h2>
            <label>
              Device ID
              <input
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                placeholder="shuttle-uf-1"
              />
            </label>
            <label>
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Rudy G"
                maxLength={40}
              />
            </label>
            <label>
              Route
              <select value={routeId} onChange={(event) => setRouteId(event.target.value)}>
                <option value="">(none)</option>
                {ROUTES.map((route) => (
                  <option key={route.id} value={route.id}>{route.name}</option>
                ))}
              </select>
            </label>
            <div className="direction-toggle">
              {["outbound", "inbound"].map((dir) => (
                <button
                  key={dir}
                  type="button"
                  className={dir === direction ? "chip active" : "chip"}
                  onClick={() => setDirection(dir)}
                >
                  {directionNames[dir] || dir}
                </button>
              ))}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={asDriver}
                onChange={(event) => setAsDriver(event.target.checked)}
              />
              Driver mode (send my location)
            </label>
            <p className="help-text">
              Changing device ID, display name, route, direction, or role automatically re-subscribes without reconnecting.
            </p>
          </div>

          <div className="card">
            <h2>Live telemetry</h2>
            <dl>
              <div>
                <dt>Device</dt>
                <dd>{deviceLabel}</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>{routeId ? `${activeRoute?.name ?? routeId} · ${directionLabel}` : "—"}</dd>
              </div>
              <div>
                <dt>Position</dt>
                <dd>
                  {position
                    ? `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Speed</dt>
                <dd>{speedMph}</dd>
              </div>
              <div>
                <dt>ETA (custom pin)</dt>
                <dd>{eta || "—"}</dd>
              </div>
            </dl>
          </div>

          <div className="card">
            <h2>Upcoming stops</h2>
            {routeId && upcomingStops.length === 0 && (
              <p className="help-text">Waiting for vehicle position on the selected route…</p>
            )}
            {routeId && upcomingStops.length > 0 && (
              <ul className="upcoming-list">
                {upcomingStops.map((stop) => (
                  <li key={stop.id}>
                    <div className="stop-name">{stop.name}</div>
                    <div className="stop-meta">
                      <span>{formatDistance(stop.distanceMeters)}</span>
                      <span>{formatEta(stop.etaSeconds)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!routeId && (
              <p className="help-text">
                Select a route to see stop-by-stop distance and ETA.
              </p>
            )}
          </div>

          <div className="card">
            <h2>Log</h2>
            <div className="log-window">
              {log.length === 0 ? (
                <div className="log-empty">No activity yet.</div>
              ) : (
                log.map((entry, index) => (
                  <div key={index} className="log-line">
                    {entry}
                  </div>
                ))
              )}
            </div>
            <button onClick={() => setLog([])}>Clear log</button>
          </div>
        </section>
      </main>
    </div>
  );
}
