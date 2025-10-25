# Next Stop — Minimal Shuttle Tracker

Next Stop App is the React + Vite front-end that renders a live Mapbox map of Gainesville, FL. It connects to the WebSocket relay, subscribes to a device ID, and shows a moving shuttle marker, live speed, and ETA toward a destination you pick on the map.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the sample environment file and add your Mapbox token. Update the default relay URL if needed:
   ```bash
   cp .env.example .env         # Windows PowerShell: Copy-Item .env.example .env
   # edit .env → set VITE_MAPBOX_TOKEN=pk.your_token_here
   ```
3. In a second terminal start the WebSocket relay from the sibling repo:
   ```bash
   cd ../nextstop-relay
   npm start
   ```
4. Back in the app directory, launch Vite with LAN access:
   ```bash
   npm run dev -- --host
   ```
5. Open the printed **Local** URL for development on your laptop. Use the right-hand panel to:
   - Enter the WebSocket URL (defaults to `ws://localhost:8080`) and click **Connect**.
   - Set a `Device ID` (e.g. `shuttle-uf-1`).
   - Toggle **Driver mode** when streaming from a device with GPS.
   - Override the Mapbox token or WebSocket URL directly in the UI at any time.

## Using the App

- Click anywhere on the map to move the destination pin; the ETA updates instantly.
- Set a **Display name** so viewers see a friendly label above the shuttle marker (falls back to the device ID if blank).
- Pick a **Route** and **Direction** to project the vehicle onto a predefined line, render the stop sequence, and see distance/ETA for the next few stops.
- Driver mode throttles telemetry to ~3 Hz to stay under the relay’s 5 msg/sec cap.
- Switching between viewer/driver or changing the device ID automatically re-sends the handshake – no manual reconnect needed.
- The log panel shows hello/telemetry activity and server messages for quick debugging.

## Phone Test via Network URL

1. Make sure the relay is running (`npm start` in `../nextstop-relay`).
2. With `npm run dev -- --host`, Vite prints a **Network** URL (for example `http://192.168.1.23:5173`). Open that URL on your phone while it’s on the same Wi-Fi.
3. On the phone tab, choose **Driver mode** to stream location; on your laptop tab, stay in viewer mode with the same device ID.
4. Movement should appear in ≤2 seconds. If it doesn’t:
   - Ensure your phone allowed the browser to access location.
   - Confirm the phone and laptop are on the same subnet (guest Wi-Fi often blocks peer-to-peer traffic).

## Troubleshooting

- **Blank map** — The Mapbox token is missing or scoped to another origin. Paste a valid token in the UI or `.env`, then press **Apply token**.
- **Cannot connect to relay** — Firewalls or VPNs frequently block `ws://localhost:8080`. Allow that port or point the app at the hosted relay URL.
- **Phone can’t reach the laptop** — Some guest/campus networks isolate clients. Use a hotspot or wired network that allows device-to-device traffic.
- **Telemetry slow or missing** — Battery saver modes throttle GPS updates. Make sure Driver mode stays active and the device ID matches the viewer.
- **Role/device changes not reflected** — The app resends `{ type: "hello" }` automatically; if you still see stale data, check the relay logs for rate limiting or protocol errors.
- **Upcoming stops missing** — Ensure a route is selected and the driver is sharing a position close to that route; otherwise the projection filter will skip the stop list.

### Environment toggles

- `VITE_USE_MATRIX=yes` enables the (optional) Mapbox Matrix ETA enhancement. Leave it as `no` to rely on local speed + dwell-time estimates.
- `VITE_MAPBOX_MATRIX_PROFILE` lets you switch profiles (defaults to `driving-traffic`) if you enable Matrix requests.
