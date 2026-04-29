#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ================= CONFIG =================
const char* ssid = "BOAT";
const char* password = "00000000";

// Render endpoint:
//   ESP32 WebSocket: wss://domixi.onrender.com/esp32
const char* serverHost = "domixi.onrender.com";
const int serverPort = 443;
const char* serverPath = "/esp32";

const int SERVO_PIN = 12;
const int ESC_PIN = 13;

// ================= OBJECTS =================
WebSocketsClient webSocket;
Servo steeringServo;
Servo brushlessESC;

void setThrottleZero() {
  brushlessESC.writeMicroseconds(1000);
}

void handleControlMessage(uint8_t* payload, size_t length) {
  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, payload, length);

  if (error) {
    Serial.print("[WS] JSON error: ");
    Serial.println(error.c_str());
    return;
  }

  if (doc.containsKey("lx")) {
    int lx = constrain(doc["lx"] | 0, -100, 100);
    int angle = map(lx, -100, 100, 45, 135);
    steeringServo.write(angle);
  }

  if (doc.containsKey("r2")) {
    int r2 = constrain(doc["r2"] | 0, 0, 100);
    int escPWM = map(r2, 0, 100, 1000, 2000);
    brushlessESC.writeMicroseconds(escPWM);
  }
}

// ================= WEBSOCKET =================
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from Render");
      setThrottleZero();
      break;

    case WStype_CONNECTED:
      Serial.printf("[WS] Connected: wss://%s%s\n", serverHost, serverPath);
      break;

    case WStype_TEXT:
      handleControlMessage(payload, length);
      break;

    case WStype_ERROR:
      Serial.println("[WS] Error");
      setThrottleZero();
      break;

    default:
      break;
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);

  steeringServo.setPeriodHertz(50);
  steeringServo.attach(SERVO_PIN, 500, 2500);

  brushlessESC.setPeriodHertz(50);
  brushlessESC.attach(ESC_PIN, 1000, 2000);

  Serial.println("Arming ESC for 3 seconds...");
  setThrottleZero();
  delay(3000);
  Serial.println("ESC ready");

  steeringServo.write(90);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid, password);

  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected. IP: ");
  Serial.println(WiFi.localIP());

  Serial.printf("Connecting WebSocket: wss://%s%s\n", serverHost, serverPath);
  webSocket.beginSSL(serverHost, serverPort, serverPath, NULL, "");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000);
  webSocket.enableHeartbeat(15000, 3000, 2);
}

// ================= LOOP =================
void loop() {
  webSocket.loop();

  if (WiFi.status() != WL_CONNECTED) {
    setThrottleZero();
    WiFi.reconnect();
    delay(500);
  }
}
