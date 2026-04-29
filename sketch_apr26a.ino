#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ================= CẤU HÌNH =================
const char* ssid = "BOAT";
const char* password = "00000000";

// IP của Server (Node.js) - Điền IP nội bộ máy tính của bạn
const char* serverIP = "117.0.109.212"; 
// Dùng port 3001 nếu bạn đã cấu hình mở thêm cổng phụ không mã hóa trên server
const int serverPort = 3001; 

// Chân điều khiển
const int SERVO_PIN = 12; 
const int ESC_PIN = 13;   

// ================= ĐỐI TƯỢNG =================
WebSocketsClient webSocket;
Servo steeringServo;
Servo brushlessESC;

// ================= XỬ LÝ WEBSOCKET =================
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Mất kết nối tới Server!");
      // Tự động kéo ga về 0 khi mất sóng để thuyền không chạy mất
      brushlessESC.writeMicroseconds(1000); 
      break;

    case WStype_CONNECTED:
      Serial.println("[WS] Đã kết nối tới Server!");
      break;

    case WStype_TEXT:
      StaticJsonDocument<200> doc;
      DeserializationError error = deserializeJson(doc, payload);
      
      if (!error) {
        // 1. Xử lý đánh lái (Lx: -100 đến 100 --> 45° đến 135°)
        if (doc.containsKey("lx")) {
          int lx = doc["lx"];
          int angle = map(lx, -100, 100, 45, 135);
          steeringServo.write(angle);
        }
        
        // 2. Xử lý tay ga (R2: 0 đến 100 --> 1000us đến 2000us)
        if (doc.containsKey("r2")) {
          int r2 = doc["r2"];
          int escPWM = map(r2, 0, 100, 1000, 2000);
          brushlessESC.writeMicroseconds(escPWM);
        }
      }
      break;
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);

  // 1. Khởi tạo Timer cho Servo và ESC
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  
  steeringServo.setPeriodHertz(50);
  steeringServo.attach(SERVO_PIN, 500, 2500);
  
  brushlessESC.setPeriodHertz(50);
  brushlessESC.attach(ESC_PIN, 1000, 2000);

  // --- QUÁ TRÌNH ARMING ESC ---
  Serial.println("Đang Arming ESC... Vui lòng đợi 3 giây.");
  brushlessESC.writeMicroseconds(1000); // Kéo ga về 0 (Mức min của đa số ESC)
  delay(3000); 
  Serial.println("ESC đã sẵn sàng!");
  
  // Trả servo lái về góc giữa
  steeringServo.write(90);

  // 2. Khởi tạo Wi-Fi
  WiFi.begin(ssid, password);
  Serial.print("Đang kết nối WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi đã kết nối! IP: " + WiFi.localIP().toString());

  // 3. Khởi tạo WebSocket
  webSocket.begin(serverIP, serverPort, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000); // Tự thử kết nối lại mỗi 2s
}

// ================= LOOP =================
void loop() {
  // Chỉ cần duy trì luồng dữ liệu WebSocket
  webSocket.loop();
}