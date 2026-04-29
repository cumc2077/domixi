const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const configPath = path.join(publicDir, 'runtime-config.js');
const wsUrl = process.env.BOAT_WS_URL
  || process.env.NEXT_PUBLIC_BOAT_WS_URL
  || process.env.VITE_BOAT_WS_URL
  || '';

if (wsUrl && !/^wss?:\/\/.+/i.test(wsUrl)) {
  throw new Error('BOAT_WS_URL must start with ws:// or wss://');
}

const config = {
  wsUrl,
  isVercel: process.env.VERCEL === '1'
};

fs.writeFileSync(
  configPath,
  `window.BOAT_CONFIG = ${JSON.stringify(config, null, 2)};\n`,
  'utf8'
);

console.log(`Wrote ${path.relative(process.cwd(), configPath)}`);
