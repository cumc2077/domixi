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
const unsigned long CONTROL_TIMEOUT_MS = 1000;

// ================= OBJECTS =================
WebSocketsClient webSocket;
Servo steeringServo;
Servo brushlessESC;
bool wsConnected = false;
unsigned long lastControlAt = 0;
int lastLx = 0;
int lastR2 = 0;

void setThrottleZero(bool force = false) {
  if (force || lastR2 != 0) {
    brushlessESC.writeMicroseconds(1000);
    lastR2 = 0;
  }
}

void applyControl(int lx, int r2) {
  lx = constrain(lx, -100, 100);
  r2 = constrain(r2, 0, 100);

  if (lx != lastLx) {
    int angle = map(lx, -100, 100, 45, 135);
    steeringServo.write(angle);
    lastLx = lx;
  }

  if (r2 != lastR2) {
    int escPWM = map(r2, 0, 100, 1000, 2000);
    brushlessESC.writeMicroseconds(escPWM);
    lastR2 = r2;
  }

  lastControlAt = millis();
}

void handleBinaryControlMessage(uint8_t* payload, size_t length) {
  if (length < 2) return;

  int lx = (int8_t)payload[0];
  int r2 = payload[1];
  applyControl(lx, r2);
}

bool handleCompactTextControl(uint8_t* payload, size_t length) {
  if (length > 24) return false;

  char buffer[25];
  memcpy(buffer, payload, length);
  buffer[length] = '\0';

  int lx = 0;
  int r2 = 0;
  if (sscanf(buffer, "%d,%d", &lx, &r2) != 2) return false;

  applyControl(lx, r2);
  return true;
}

void handleTextControlMessage(uint8_t* payload, size_t length) {
  if (handleCompactTextControl(payload, length)) return;

  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, payload, length);

  if (error) {
    Serial.print("[WS] JSON error: ");
    Serial.println(error.c_str());
    return;
  }

  applyControl(doc["lx"] | lastLx, doc["r2"] | lastR2);
}

// ================= WEBSOCKET =================
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from Render");
      wsConnected = false;
      setThrottleZero();
      break;

    case WStype_CONNECTED:
      wsConnected = true;
      lastControlAt = millis();
      Serial.printf("[WS] Connected: wss://%s%s\n", serverHost, serverPath);
      break;

    case WStype_TEXT:
      handleTextControlMessage(payload, length);
      break;

    case WStype_BIN:
      handleBinaryControlMessage(payload, length);
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
  setThrottleZero(true);
  delay(3000);
  Serial.println("ESC ready");

  steeringServo.write(90);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
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
    return;
  }

  if (wsConnected && millis() - lastControlAt > CONTROL_TIMEOUT_MS) {
    setThrottleZero();
  }
}
