const express = require('express');
const https = require('https'); // Đổi từ http sang https
const fs = require('fs');
const WebSocket = require('ws');
const os = require('os');

const app = express();
app.use(express.static('public'));

// Đọc file chứng chỉ
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

const PORT = 3000;
// Tạo server HTTPS
const server = https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 HTTPS SERVER ĐANG CHẠY TẠI: https://0.0.0.0:${PORT}`);
});

// Chèn WebSocket vào server HTTPS
const wss = new WebSocket.Server({ server });

// ... (Giữ nguyên toàn bộ phần code wss.on('connection', ...) của bạn ở dưới)

// Đếm số kết nối
let connectionCount = 0;
const clients = new Map();

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    const clientId = ++connectionCount;

    clients.set(clientId, { ws, ip: clientIP, connectedAt: new Date() });

    console.log(`✅ [${clientId}] Thiết bị kết nối từ ${clientIP}`);
    console.log(`📊 Tổng số kết nối hiện tại: ${clients.size}`);

    // Gửi tin nhắn chào mừng
    try {
        ws.send(JSON.stringify({
            type: 'welcome',
            message: 'Connected to Boat Control Server',
            clientId: clientId
        }));
    } catch (error) {
        console.error(`❌ [${clientId}] Error sending welcome message:`, error.message);
    }

    // Xử lý tin nhắn từ client
    ws.on('message', (message) => {
        try {
            // Validate JSON
            const messageStr = message.toString();
            const data = JSON.parse(messageStr);

            // Kiểm tra cấu trúc dữ liệu điều khiển
            // Chấp nhận dữ liệu điều khiển (lx, r2) HOẶC dữ liệu GPS (lat, lon)
            if (typeof data === 'object' &&
                ('lx' in data || 'r2' in data || 'lat' in data || 'lon' in data)) {

                // Chuyển tiếp tới tất cả client khác
                let forwardCount = 0;
                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        try {
                            client.send(messageStr);
                            forwardCount++;
                        } catch (error) {
                            console.error('❌ Error forwarding message:', error.message);
                        }
                    }
                });

                if (connectionCount % 100 === 0) {
                    console.log(`📤 Forwarded to ${forwardCount} client(s)`);
                }
            } else {
                console.warn(`⚠️ [${clientId}] Dữ liệu không hợp lệ:`, data);
            }

        } catch (error) {
            console.error(`❌ [${clientId}] Error processing message:`, error.message);
            // Không ngắt kết nối, chỉ log lỗi
        }
    });

    // Xử lý lỗi
    ws.on('error', (error) => {
        console.error(`❌ [${clientId}] WebSocket error:`, error.message);
    });

    // Xử lý ngắt kết nối
    ws.on('close', (code, reason) => {
        clients.delete(clientId);
        console.log(`❌ [${clientId}] Thiết bị ngắt kết nối (Code: ${code})`);
        if (reason) {
            console.log(`   Lý do: ${reason}`);
        }
        console.log(`📊 Tổng số kết nối hiện tại: ${clients.size}`);
    });

    // Heartbeat để phát hiện kết nối chết
    const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
            } catch (error) {
                console.error(`❌ [${clientId}] Ping error:`, error.message);
                clearInterval(heartbeat);
            }
        } else {
            clearInterval(heartbeat);
        }
    }, 30000); // Ping mỗi 30 giây

    ws.on('pong', () => {
        // Connection still alive
    });
});

// Xử lý lỗi WebSocket server
wss.on('error', (error) => {
    console.error('❌ WebSocket Server Error:', error);
});

// Log định kỳ số lượng kết nối
setInterval(() => {
    if (clients.size > 0) {
        console.log(`📊 Status: ${clients.size} active connection(s)`);
    }
}, 60000); // Mỗi 60 giây

// Xử lý tín hiệu tắt server
process.on('SIGINT', () => {
    console.log('\n⚠️ Đang tắt server...');

    // Đóng tất cả kết nối
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1000, 'Server shutting down');
        }
    });

    wss.close(() => {
        console.log('✅ WebSocket server đã đóng');
        server.close(() => {
            console.log('✅ HTTP server đã đóng');
            process.exit(0);
        });
    });

    // Force exit sau 5 giây nếu không tắt được
    setTimeout(() => {
        console.error('❌ Không thể tắt server gracefully, forcing exit...');
        process.exit(1);
    }, 5000);
});

console.log('✅ Server initialization complete. Waiting for connections...\n');

// ================= MỞ THÊM PORT 3001 CHO ESP32 =================
const http = require('http');
const serverESP = http.createServer().listen(3001, '0.0.0.0', () => {
    console.log('🔌 Port 3001 (Không SSL) đã sẵn sàng cho ESP32!');
});
const wssESP = new WebSocket.Server({ server: serverESP });

wssESP.on('connection', (wsESP) => {
    console.log('🤖 ESP32 đã kết nối vào port 3001!');

    wsESP.on('message', (message) => {
        // Nhận dữ liệu từ ESP32 và đẩy thẳng sang cho giao diện Web (port 3000)
        wss.clients.forEach((webClient) => {
            if (webClient.readyState === WebSocket.OPEN) {
                webClient.send(message.toString());
            }
        });
    });

    // Nhận lệnh điều khiển từ Web (port 3000) và đẩy xuống ESP32
    wss.on('connection', (webClient) => {
        webClient.on('message', (cmd) => {
            if (wsESP.readyState === WebSocket.OPEN) {
                wsESP.send(cmd.toString());
            }
        });
    });
});
