# Next Stop Monorepo Overview

This workspace contains two sibling projects:

- `nextstop-app`: React + Vite + Mapbox GL JS front-end
- `nextstop-relay`: Node.js WebSocket relay powered by the `ws` library

Each project is designed to live in its own Git repository. Clone them independently or keep them together as a monorepo while iterating locally.

## Repository Scaffold Commands

On macOS/Linux:

```bash
mkdir nextstop && cd nextstop
git clone <your-origin>/nextstop-app.git
git clone <your-origin>/nextstop-relay.git
```

On Windows (PowerShell):

```powershell
mkdir nextstop
cd nextstop
git clone <your-origin>/nextstop-app.git
git clone <your-origin>/nextstop-relay.git
```

If you are starting fresh, initialise each project with:

```bash
npm create vite@latest nextstop-app -- --template react
mkdir nextstop-relay && cd nextstop-relay && npm init -y
```

Then replace the generated files with the versions contained here.

## Running Everything

### macOS / Linux

```bash
# Front-end
cd nextstop-app
npm install
cp .env.example .env
npm run dev -- --host

# In another terminal
cd ../nextstop-relay
npm install
cp .env.example .env
npm start
```

### Windows (PowerShell)

```powershell
# Front-end
cd nextstop-app
npm install
Copy-Item .env.example .env
npm run dev -- --host

# In new PowerShell window
cd ..\nextstop-relay
npm install
Copy-Item .env.example .env
npm start
```

The Vite command prints both Local and Network URLs; open the Network URL on your driver device so it can stream telemetry. The relay logs `WS relay running on ws://localhost:8080` when ready.

## Environment Templates

- `nextstop-app/.env.example`
  ```env
  VITE_MAPBOX_TOKEN=pk.your_mapbox_token_here
  VITE_WS_URL=ws://localhost:8080
  VITE_USE_MATRIX=no
  VITE_MAPBOX_MATRIX_PROFILE=driving-traffic
  ```
- `nextstop-relay/.env.example`
  ```env
  PORT=8080
  HEARTBEAT_MS=15000
  ```

Adjust these to match your deployment environment before running the app or relay in production.

## Package Scripts

`nextstop-app/package.json`:

- `npm run dev -- --host` &rightarrow; starts Vite dev server with LAN access.
- `npm run build` &rightarrow; build production assets.
- `npm run preview` &rightarrow; preview locally.
- `npm run lint` &rightarrow; lint React code.

`nextstop-relay/package.json`:

- `npm start` &rightarrow; run the WebSocket relay.
- `npm run dev` &rightarrow; auto-restart relay on changes (Node 20+ watch mode).

## Acceptance Checklist

- Front-end: `npm run dev -- --host` prints both Local and Network URLs, the map loads centered on Gainesville, and the selected route renders with stop labels and upcoming stop ETAs.
- Relay: `npm start` logs `WS relay running on ws://localhost:8080`.
