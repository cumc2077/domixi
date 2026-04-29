# Boat Tracker Control

Static dashboard for Vercel plus a local WebSocket bridge for the ESP32 boat.

## Render WebSocket server

Render runs the long-lived WebSocket server from `server.js`. The repository includes `render.yaml`, so you can create it as a Render Blueprint.

Service settings:

```text
Name: domixi-ws
Build command: npm install
Start command: npm start
Health check path: /health
```

Render exposes one public port per web service. Use these public URLs after deploy:

```text
Dashboard WebSocket: wss://<render-service>.onrender.com
ESP32 WebSocket:     wss://<render-service>.onrender.com/esp32
```

The old local ESP32 port `ws://<local-ip>:3001` still works when you run the server outside Render.

## Vercel deploy

Vercel deploys the `public` folder as the frontend. It does not run the long-lived `server.js` WebSocket bridge, so host that bridge on a server that supports WebSockets and set this Vercel environment variable:

```text
BOAT_WS_URL=wss://<render-service>.onrender.com
```

Build command:

```bash
npm run build
```

Output directory:

```text
public
```

If Vercel imports the parent folder, set the project root directory to `ps4_control`.

## Local run

```bash
npm install
npm start
```

The local web dashboard listens on `https://0.0.0.0:3000` when `cert.pem` and `key.pem` exist, otherwise it falls back to HTTP. The ESP32 WebSocket bridge listens on `ws://0.0.0.0:3001`.

Generate a local certificate when needed:

```bash
node generate-cert.js
```
