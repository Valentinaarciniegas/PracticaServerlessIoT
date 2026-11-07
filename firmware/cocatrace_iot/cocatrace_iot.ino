// CocaTrace - Practica 3: ESP32 + DHT22 -> AWS IoT Core (MQTT con TLS y certificados)
// Publica:   <SECADERO>/lecturas    -> {"temperatura": 24.6, "humedad": 71.2, "ts": 1793461967}
//            <SECADERO>/led/estado  -> {"led": "on", "ts": 1793461967}   (retenido)
//            <SECADERO>/estado      -> "conectado" / "desconectado"      (retenido, Last Will)
// Escucha:   <SECADERO>/led/cmd     -> {"led": "on"} o {"led": "off"}    (lo envia el dashboard)
// Librerias: PubSubClient (Nick O'Leary) y DHT sensor library (Adafruit)
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <time.h>
#include "config.h"

#define DHTPIN  4
#define DHTTYPE DHT22
#define LEDPIN  2        // LED azul integrado del ESP32 DevKit (representa el ventilador del secadero)

const unsigned long INTERVALO_MS = 30000;   // una lectura cada 30 s
const unsigned long REINTENTO_MQTT_MS = 5000;
const int BUFFER_MAX = 120;                 // 1 hora de respaldo

struct Lectura {
  time_t ts;
  float t;
  float h;
};

Lectura buffer[BUFFER_MAX];
int bufInicio = 0;
int bufCount  = 0;

DHT dht(DHTPIN, DHTTYPE);
WiFiClientSecure wifiClient;
PubSubClient mqtt(wifiClient);

String topicLecturas, topicEstado, topicLedCmd, topicLedEstado;
unsigned long ultimaLectura = 0;
unsigned long ultimoIntentoMqtt = 0;
bool primeraLectura = true;
bool ledEncendido = false;

void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Conectando a WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\nConectado. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nSin WiFi. Las lecturas quedan en el buffer.");
  }
}

// Informa el estado real del LED (retenido: el dashboard lo lee aunque llegue despues)
void publicarEstadoLed() {
  char msg[64];
  snprintf(msg, sizeof(msg), "{\"led\":\"%s\",\"ts\":%lu}", ledEncendido ? "on" : "off", (unsigned long)time(nullptr));
  bool ok = mqtt.publish(topicLedEstado.c_str(), msg, true);
  Serial.printf("PUB %s %s -> %s\n", topicLedEstado.c_str(), msg, ok ? "OK" : "FALLO");
}

// Llega una orden del dashboard por <SECADERO>/led/cmd
void alRecibir(char* topic, byte* payload, unsigned int len) {
  String msg;
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  Serial.printf("SUB %s %s\n", topic, msg.c_str());

  if (msg.indexOf("\"on\"") >= 0)       ledEncendido = true;
  else if (msg.indexOf("\"off\"") >= 0) ledEncendido = false;
  else {
    Serial.println("Orden desconocida, se ignora.");
    return;
  }
  digitalWrite(LEDPIN, ledEncendido ? HIGH : LOW);
  publicarEstadoLed();
}

// Conecta a AWS IoT con el certificado del dispositivo. Si el ESP32 se cae,
// AWS IoT publica "desconectado" en <SECADERO>/estado (Last Will).
bool conectarMQTT() {
  if (mqtt.connected()) return true;
  if (WiFi.status() != WL_CONNECTED) return false;
  if (millis() - ultimoIntentoMqtt < REINTENTO_MQTT_MS && ultimoIntentoMqtt != 0) return false;
  ultimoIntentoMqtt = millis();

  Serial.printf("Conectando a AWS IoT %s... ", AWS_IOT_ENDPOINT);
  if (mqtt.connect(THING_NAME, topicEstado.c_str(), 1, true, "desconectado")) {
    Serial.println("OK");
    mqtt.publish(topicEstado.c_str(), "conectado", true);
    // Al suscribirse, AWS IoT entrega la ultima orden retenida: el LED recupera su estado tras un reinicio
    mqtt.subscribe(topicLedCmd.c_str(), 1);
    publicarEstadoLed();
    return true;
  }
  // rc = -2: no hay conexion TLS (endpoint, certificados o puerto 8883 bloqueado)
  // rc = -4 o -1 justo despues de conectar: la politica de IoT no permite ese client id o topic
  Serial.printf("fallo, rc=%d\n", mqtt.state());
  return false;
}

void encolar(const Lectura& l) {
  int idx = (bufInicio + bufCount) % BUFFER_MAX;
  buffer[idx] = l;
  if (bufCount < BUFFER_MAX) bufCount++;
  else bufInicio = (bufInicio + 1) % BUFFER_MAX;  // lleno: se descarta la mas antigua
}

bool enviar(const Lectura& l) {
  if (!mqtt.connected()) return false;
  char msg[96];
  snprintf(msg, sizeof(msg), "{\"temperatura\":%.1f,\"humedad\":%.1f,\"ts\":%lu}", l.t, l.h, (unsigned long)l.ts);
  bool ok = mqtt.publish(topicLecturas.c_str(), msg);
  Serial.printf("PUB %s %s -> %s\n", topicLecturas.c_str(), msg, ok ? "OK" : "FALLO");
  return ok;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  dht.begin();
  pinMode(LEDPIN, OUTPUT);
  digitalWrite(LEDPIN, LOW);

  topicLecturas  = String(SECADERO) + "/lecturas";
  topicEstado    = String(SECADERO) + "/estado";
  topicLedCmd    = String(SECADERO) + "/led/cmd";
  topicLedEstado = String(SECADERO) + "/led/estado";

  WiFi.setAutoReconnect(true);
  conectarWiFi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  wifiClient.setCACert(AWS_CERT_CA);
  wifiClient.setCertificate(AWS_CERT_CRT);
  wifiClient.setPrivateKey(AWS_CERT_PRIVATE);

  mqtt.setServer(AWS_IOT_ENDPOINT, AWS_IOT_PORT);
  mqtt.setCallback(alRecibir);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
}

void loop() {
  conectarMQTT();
  mqtt.loop();

  if (!primeraLectura && millis() - ultimaLectura < INTERVALO_MS) return;
  primeraLectura = false;
  ultimaLectura = millis();

  conectarWiFi();

  // Cada lectura lleva su hora real; sin hora NTP no se guarda
  time_t ahora = time(nullptr);
  if (ahora < 1700000000) {
    Serial.println("Esperando la hora NTP...");
    return;
  }

  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t) || t < -40 || t > 80 || h < 0 || h > 100) {
    Serial.println("Lectura invalida, se descarta.");
    return;
  }

  Serial.printf("T = %.1f °C   HR = %.1f %%\n", t, h);
  encolar({ ahora, t, h });

  while (bufCount > 0) {
    if (!enviar(buffer[bufInicio])) break;
    bufInicio = (bufInicio + 1) % BUFFER_MAX;
    bufCount--;
  }
  if (bufCount > 0) Serial.printf("Pendientes en buffer: %d\n", bufCount);
}
