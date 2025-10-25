# Next Stop Relay

Next Stop Relay is a lightweight Node.js WebSocket broker that forwards telemetry from driver devices to any connected viewers. It expects each client to send a `hello` handshake before exchanging telemetry.

## Prerequisites

- Node.js 20+

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template and adjust if you need a non-default port or heartbeat:
   ```bash
   cp .env.example .env
   # edit .env to override PORT or HEARTBEAT_MS
   ```

## Running

```bash
npm start
```

You should see:

```
WS relay running on ws://localhost:8080
```

Use `npm run dev` during development to restart automatically when `index.js` changes (Node 20+ only).

## Message Contract

- `hello`: `{ "type":"hello","role":"driver"|"viewer","deviceId":"string","displayName"?:string,"routeId"?:string,"direction"?: "outbound"|"inbound" }`
- `telemetry`: `{ "type":"telemetry","deviceId":"string","lat":number,"lng":number,"speed"?:number,"heading"?:number,"ts":number,"displayName"?:string,"routeId"?:string,"direction"?: "outbound"|"inbound" }`

Drivers may reconnect and replace older driver sessions with the same `deviceId`. Viewers always receive the latest telemetry snapshot immediately after the handshake.
