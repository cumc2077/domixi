const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');

const app = express();

const HOST = process.env.HOST || '0.0.0.0';
const WEB_PORT = Number(process.env.PORT || 3000);
const ESP_PORT = Number(process.env.ESP_PORT || 3001);
const IS_RENDER = process.env.RENDER === 'true';
const USE_LEGACY_ESP_PORT = process.env.SINGLE_PORT !== '1' && !IS_RENDER && ESP_PORT !== WEB_PORT;
const ESP_PATHS = new Set(['/esp32', '/esp', '/device']);
const MAX_BUFFERED_BYTES = Number(process.env.MAX_BUFFERED_BYTES || 4096);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_FILE = path.join(__dirname, 'cert.pem');
const KEY_FILE = path.join(__dirname, 'key.pem');

const webClients = new Map();
const espClients = new Map();
let nextClientId = 1;

app.use(express.static(PUBLIC_DIR));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    webClients: webClients.size,
    espClients: espClients.size,
    espPath: '/esp32',
    legacyEspPort: USE_LEGACY_ESP_PORT ? ESP_PORT : null
  });
});

app.use((req, res, next) => {
  if (req.method === 'GET') {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  next();
});

function createWebServer() {
  const hasLocalCert = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);

  if (hasLocalCert && process.env.DISABLE_HTTPS !== '1' && !IS_RENDER) {
    return {
      protocol: 'https',
      server: https.createServer({
        key: fs.readFileSync(KEY_FILE),
        cert: fs.readFileSync(CERT_FILE)
      }, app)
    };
  }

  if (!IS_RENDER) {
    console.warn('Local cert.pem/key.pem not found. Falling back to HTTP.');
  }

  return {
    protocol: 'http',
    server: http.createServer(app)
  };
}

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return false;

  try {
    ws.send(payload);
    return true;
  } catch (error) {
    console.error('WebSocket send failed:', error.message);
    return false;
  }
}

function broadcast(clients, payload, exceptWs = null) {
  let sent = 0;

  clients.forEach(({ ws }) => {
    if (ws !== exceptWs && safeSend(ws, payload)) {
      sent += 1;
    }
  });

  return sent;
}

function clampInteger(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function createControlPacket(lx, r2) {
  const steering = clampInteger(lx, -100, 100);
  const throttle = clampInteger(r2, 0, 100);
  return Buffer.from([steering & 0xff, throttle & 0xff]);
}

function parseBinaryControl(message) {
  if (!Buffer.isBuffer(message) || message.length < 2) return null;

  const lx = message.readInt8(0);
  const r2 = message.readUInt8(1);
  if (lx < -100 || lx > 100 || r2 > 100) return null;

  return createControlPacket(lx, r2);
}

function parseCompactControl(text) {
  const match = /^(-?\d{1,3}),(\d{1,3})$/.exec(text);
  if (!match) return null;

  return createControlPacket(match[1], match[2]);
}

function parseBridgeMessage(message, isBinary = false) {
  if (isBinary) {
    const controlPayload = parseBinaryControl(message);
    return controlPayload ? { type: 'control', payload: controlPayload } : null;
  }

  const text = typeof message === 'string' ? message : message.toString();
  const compactControl = parseCompactControl(text);
  if (compactControl) {
    return { type: 'control', payload: compactControl };
  }

  try {
    const data = JSON.parse(text);

    if (!data || typeof data !== 'object') return null;

    const hasControl = Object.prototype.hasOwnProperty.call(data, 'lx')
      || Object.prototype.hasOwnProperty.call(data, 'r2');
    if (hasControl) {
      return { type: 'control', payload: createControlPacket(data.lx, data.r2) };
    }

    const hasTelemetry = Object.prototype.hasOwnProperty.call(data, 'lat')
      || Object.prototype.hasOwnProperty.call(data, 'lon');
    return hasTelemetry ? { type: 'telemetry', payload: text } : null;
  } catch (error) {
    return null;
  }
}

function tuneSocket(socket) {
  if (!socket) return;

  try {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
  } catch (error) {
    console.warn('Socket tuning failed:', error.message);
  }
}

function attachHeartbeat(ws, label) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const heartbeat = setInterval(() => {
    if (ws.isAlive === false) {
      console.warn(`${label} heartbeat timed out`);
      ws.terminate();
      clearInterval(heartbeat);
      return;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      clearInterval(heartbeat);
      ws.terminate();
    }
  }, 30000);

  ws.on('close', () => clearInterval(heartbeat));
}

function getUpgradePath(requestUrl) {
  try {
    return new URL(requestUrl, 'http://localhost').pathname;
  } catch (error) {
    return '/';
  }
}

function handleUpgradeWith(server, request, socket, head) {
  tuneSocket(socket);
  server.handleUpgrade(request, socket, head, (ws) => {
    server.emit('connection', ws, request);
  });
}

function publicHttpUrl() {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }

  return `${protocol}://${HOST}:${WEB_PORT}`;
}

function publicWsUrl(route = '') {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}${route}`;
  }

  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  return `${wsProtocol}://${HOST}:${WEB_PORT}${route}`;
}

const { protocol, server: webServer } = createWebServer();
const webSocketServer = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 512
});
const espSocketServer = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 1024
});
let legacyEspServer = null;

webServer.on('upgrade', (request, socket, head) => {
  const pathName = getUpgradePath(request.url);

  if (ESP_PATHS.has(pathName)) {
    handleUpgradeWith(espSocketServer, request, socket, head);
    return;
  }

  handleUpgradeWith(webSocketServer, request, socket, head);
});

if (USE_LEGACY_ESP_PORT) {
  legacyEspServer = http.createServer();
  legacyEspServer.on('upgrade', (request, socket, head) => {
    handleUpgradeWith(espSocketServer, request, socket, head);
  });
}

webSocketServer.on('connection', (ws, req) => {
  const id = nextClientId++;
  const ip = req.socket.remoteAddress;
  tuneSocket(req.socket);
  webClients.set(id, { ws, ip, connectedAt: new Date() });
  attachHeartbeat(ws, `web client ${id}`);

  console.log(`Web client ${id} connected from ${ip}. Active web clients: ${webClients.size}`);

  ws.on('message', (message, isBinary) => {
    const parsed = parseBridgeMessage(message, isBinary);
    if (!parsed) {
      console.warn(`Web client ${id} sent invalid payload`);
      return;
    }

    if (parsed.type === 'control') {
      broadcast(espClients, parsed.payload);
      return;
    }

    broadcast(webClients, parsed.payload, ws);
  });

  ws.on('error', (error) => {
    console.error(`Web client ${id} error:`, error.message);
  });

  ws.on('close', (code) => {
    webClients.delete(id);
    console.log(`Web client ${id} disconnected with code ${code}. Active web clients: ${webClients.size}`);
  });
});

espSocketServer.on('connection', (ws, req) => {
  const id = nextClientId++;
  const ip = req.socket.remoteAddress;
  tuneSocket(req.socket);
  espClients.set(id, { ws, ip, connectedAt: new Date() });
  attachHeartbeat(ws, `ESP32 client ${id}`);

  console.log(`ESP32 client ${id} connected from ${ip}. Active ESP32 clients: ${espClients.size}`);

  ws.on('message', (message, isBinary) => {
    if (isBinary) return;
    broadcast(webClients, message.toString());
  });

  ws.on('error', (error) => {
    console.error(`ESP32 client ${id} error:`, error.message);
  });

  ws.on('close', (code) => {
    espClients.delete(id);
    console.log(`ESP32 client ${id} disconnected with code ${code}. Active ESP32 clients: ${espClients.size}`);
  });
});

webServer.listen(WEB_PORT, HOST, () => {
  console.log(`Web app ready at ${publicHttpUrl()}`);
  console.log(`WebSocket for dashboard ready at ${publicWsUrl()}`);
  console.log(`WebSocket for ESP32 ready at ${publicWsUrl('/esp32')}`);
});

if (legacyEspServer) {
  legacyEspServer.listen(ESP_PORT, HOST, () => {
    console.log(`Legacy ESP32 WebSocket bridge ready at ws://${HOST}:${ESP_PORT}`);
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });
}

function closeWebSocketServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('Shutting down...');

  [...webClients.values(), ...espClients.values()].forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Server shutting down');
    }
  });

  setTimeout(() => process.exit(1), 5000).unref();

  await Promise.all([
    closeWebSocketServer(webSocketServer),
    closeWebSocketServer(espSocketServer)
  ]);

  await Promise.all([
    closeHttpServer(webServer),
    closeHttpServer(legacyEspServer)
  ]);

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
