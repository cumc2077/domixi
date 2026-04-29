/**
 * Run ONCE before starting the server:
 *   node generate-cert.js
 *
 * Creates cert.pem and key.pem in the current directory.
 * Requires openssl (pre-installed on macOS, Linux, and Windows via Git Bash / WSL).
 */

const { execSync } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ── Detect local IP ───────────────────────────────────────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

const ip = getLocalIP();
console.log(`🔍 Detected local IP: ${ip}`);

// ── Write openssl config with IP SAN ─────────────────────────────────────────
const opensslConf = `
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
CN = BoatControl

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1 = ${ip}
IP.2 = 127.0.0.1
DNS.1 = localhost
`;

const confPath = path.join(__dirname, '_openssl_tmp.cnf');
fs.writeFileSync(confPath, opensslConf);

// ── Generate key + self-signed cert ──────────────────────────────────────────
try {
    execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes ` +
        `-keyout key.pem -out cert.pem ` +
        `-days 365 ` +
        `-config "${confPath}"`,
        { stdio: 'inherit' }
    );

    fs.unlinkSync(confPath); // clean up temp file

    console.log('\n✅ Done! Files created:');
    console.log('   cert.pem  – certificate');
    console.log('   key.pem   – private key');
    console.log(`\n📱 Phone URL: https://${ip}:3443`);
    console.log('   (Accept the browser warning once, then camera will work)\n');

} catch (err) {
    fs.unlinkSync(confPath);
    console.error('\n❌ openssl command failed:', err.message);
    console.error('   Make sure openssl is installed and on your PATH.');
    process.exit(1);
}
