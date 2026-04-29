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

function parseBridgeMessage(message) {
  const text = message.toString();

  try {
    const data = JSON.parse(text);
    const valid = data && typeof data === 'object'
      && ['lx', 'r2', 'lat', 'lon'].some((key) => Object.prototype.hasOwnProperty.call(data, key));

    return valid ? text : null;
  } catch (error) {
    return null;
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
const webSocketServer = new WebSocket.Server({ noServer: true });
const espSocketServer = new WebSocket.Server({ noServer: true });
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
  webClients.set(id, { ws, ip, connectedAt: new Date() });
  attachHeartbeat(ws, `web client ${id}`);

  console.log(`Web client ${id} connected from ${ip}. Active web clients: ${webClients.size}`);

  ws.on('message', (message) => {
    const payload = parseBridgeMessage(message);
    if (!payload) {
      console.warn(`Web client ${id} sent invalid payload`);
      return;
    }

    const webSent = broadcast(webClients, payload, ws);
    const espSent = broadcast(espClients, payload);
    console.log(`Relayed web payload from ${id}: ${webSent} web, ${espSent} ESP32`);
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
  espClients.set(id, { ws, ip, connectedAt: new Date() });
  attachHeartbeat(ws, `ESP32 client ${id}`);

  console.log(`ESP32 client ${id} connected from ${ip}. Active ESP32 clients: ${espClients.size}`);

  ws.on('message', (message) => {
    const payload = message.toString();
    const webSent = broadcast(webClients, payload);
    console.log(`Relayed ESP32 payload from ${id}: ${webSent} web`);
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
