/*
 * Smart Quail Farm IoT - ESP32 Code
 * Features:
 * - DHT22: Temperature & Humidity (V0, V1)
 * - MQ135: Ammonia Level (V2)
 * - Ultrasonic: Feed Level (V3)
 * - Relays: Fan (V10), Heater (V11), Light (V12), Cleaner (V13)
 * - Servo: Feeding Mechanism (V4)
 * - Schedules: V20-V25
 */

#define BLYNK_TEMPLATE_ID "TMPL6Aho3SnRm"
#define BLYNK_TEMPLATE_NAME "smart quail"
#define BLYNK_AUTH_TOKEN "at2L15c2T-cBRodKkRS0BW8DMWT_hmpL"

#include <WiFi.h>
#include <WiFiClient.h>
#include <BlynkSimpleEsp32.h>
#include <DHT.h>
#include <TimeLib.h>
#include <WidgetRTC.h>
#include <ArduinoOTA.h>

// WiFi Credentials
char ssid[] = "Your_WiFi_SSID";
char pass[] = "Your_WiFi_Password";

// Pin Definitions
#define DHTPIN 16
#define DHTTYPE DHT22
#define MQ137_PIN 34
#define TRIG_PIN 23
#define ECHO_PIN 4
#define FAN_PIN 26
#define LIGHT_PIN 25
#define HEATER_PIN_1 33
#define HEATER_PIN_2 32
#define STOOL_RELAY_PIN 27
#define FEED_RELAY_PIN 5 // Changed from Servo to Relay

DHT dht(DHTPIN, DHTTYPE);
BlynkTimer timer;
WidgetRTC rtc;

// Settings (Synced from Blynk)
int feedDuration = 3;
int feedTimeMins = 420; // 7:00 AM
int cleanerDuration = 20;
int cleanerTimeMins = 480; // 8:00 AM
int lightStartMins = 1080; // 6:00 PM
int lightEndMins = 360;   // 6:00 AM

bool isFeeding = false;
bool isCleaning = false;

void setup() {
  Serial.begin(115200);
  
  pinMode(FAN_PIN, OUTPUT);
  pinMode(LIGHT_PIN, OUTPUT);
  pinMode(HEATER_PIN_1, OUTPUT);
  pinMode(HEATER_PIN_2, OUTPUT);
  pinMode(STOOL_RELAY_PIN, OUTPUT);
  pinMode(FEED_RELAY_PIN, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  dht.begin();
  
  // Initial positions (OFF)
  digitalWrite(FEED_RELAY_PIN, LOW);
  digitalWrite(STOOL_RELAY_PIN, LOW);

  Blynk.begin(BLYNK_AUTH_TOKEN, ssid, pass);
  setSyncProvider(rtc.getSyncProvider); // Sync time with Blynk RTC
  rtc.begin();

  // Setup Standard OTA
  ArduinoOTA.setHostname("Quail-Farm-ESP32");
  ArduinoOTA.begin();

  // Poll sensors every 5 seconds
  timer.setInterval(5000L, sendSensorData);
  // Check schedules every minute
  timer.setInterval(60000L, checkSchedules);
}

// Sync settings from Blynk Cloud when connected
BLYNK_CONNECTED() {
  Blynk.syncVirtual(V20, V21, V22, V23, V24, V25);
  Serial.println("Settings synced from Blynk Cloud.");
}

void loop() {
  Blynk.run();
  timer.run();
  ArduinoOTA.handle();
}

// --- Sensor Data ---

void sendSensorData() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  
  if (!isnan(h) && !isnan(t)) {
    Blynk.virtualWrite(V0, t);
    Blynk.virtualWrite(V1, h);
    
    // Auto-Automation (Safety Backup)
    if (t > 27) digitalWrite(FAN_PIN, HIGH);
    else if (t <= 25) digitalWrite(FAN_PIN, LOW);
    
    if (t <= 18) {
      digitalWrite(HEATER_PIN_1, HIGH);
      digitalWrite(HEATER_PIN_2, HIGH);
    } else if (t >= 25) {
      digitalWrite(HEATER_PIN_1, LOW);
      digitalWrite(HEATER_PIN_2, LOW);
    }
  }

  // Ammonia (MQ-137)
  int mqValue = analogRead(MQ137_PIN);
  float ppm = map(mqValue, 0, 4095, 0, 100); 
  Blynk.virtualWrite(V2, ppm);
  
  if (ppm >= 10 && !isCleaning) {
    startCleaning(20); // Auto clean if high ammonia
  }

  // Feed Level (Ultrasonic)
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH);
  int distance = duration * 0.034 / 2;
  int level = map(distance, 2, 20, 100, 0); // Assuming 20cm is empty
  level = constrain(level, 0, 100);
  Blynk.virtualWrite(V3, level);
}

// --- Actuator Controls ---

BLYNK_WRITE(V4) { // Manual Feed Trigger
  if (param.asInt() == 1 && !isFeeding) {
    startFeeding(feedDuration);
  }
}

BLYNK_WRITE(V10) { 
  int val = param.asInt();
  digitalWrite(FAN_PIN, val); 
  Serial.print("Fan: "); Serial.println(val ? "ON" : "OFF");
}
BLYNK_WRITE(V11) { 
  int val = param.asInt();
  digitalWrite(HEATER_PIN_1, val); 
  digitalWrite(HEATER_PIN_2, val); 
  Serial.print("Heater: "); Serial.println(val ? "ON" : "OFF");
}
BLYNK_WRITE(V12) { 
  int val = param.asInt();
  digitalWrite(LIGHT_PIN, val); 
  Serial.print("Light: "); Serial.println(val ? "ON" : "OFF");
}
BLYNK_WRITE(V13) { 
  int val = param.asInt();
  if (val == 1) startCleaning(cleanerDuration);
  else digitalWrite(STOOL_RELAY_PIN, LOW);
  Serial.print("Cleaner: "); Serial.println(val ? "ON" : "OFF");
}

// --- Settings Sync ---

BLYNK_WRITE(V20) { feedDuration = param.asInt(); }
BLYNK_WRITE(V21) { feedTimeMins = param.asInt(); }
BLYNK_WRITE(V22) { cleanerDuration = param.asInt(); }
BLYNK_WRITE(V23) { cleanerTimeMins = param.asInt(); }
BLYNK_WRITE(V24) { lightStartMins = param.asInt(); }
BLYNK_WRITE(V25) { lightEndMins = param.asInt(); }

// --- Schedule Logic ---

void checkSchedules() {
  if (year() < 2024) return; // Wait for RTC sync

  int currentMins = hour() * 60 + minute();

  // Feeding Schedule
  if (currentMins == feedTimeMins && !isFeeding) {
    startFeeding(feedDuration);
  }

  // Cleaning Schedule
  if (currentMins == cleanerTimeMins && !isCleaning) {
    startCleaning(cleanerDuration);
  }

  // Lighting Schedule (Auto-trigger only at start/end times)
  if (currentMins == lightStartMins) {
    digitalWrite(LIGHT_PIN, HIGH);
    Blynk.virtualWrite(V12, 1);
    Serial.println("Auto-Light: ON");
  } else if (currentMins == lightEndMins) {
    digitalWrite(LIGHT_PIN, LOW);
    Blynk.virtualWrite(V12, 0);
    Serial.println("Auto-Light: OFF");
  }
}

void startFeeding(int duration) {
  isFeeding = true;
  Serial.println("Feeding started (Relay)...");
  digitalWrite(FEED_RELAY_PIN, HIGH);
  Blynk.virtualWrite(V4, 1);
  
  timer.setTimeout(duration * 1000L, []() {
    digitalWrite(FEED_RELAY_PIN, LOW);
    isFeeding = false;
    Blynk.virtualWrite(V4, 0);
    Serial.println("Feeding finished.");
  });
}

void startCleaning(int duration) {
  isCleaning = true;
  digitalWrite(STOOL_RELAY_PIN, HIGH);
  Blynk.virtualWrite(V13, 1);
  timer.setTimeout(duration * 1000L, []() {
    digitalWrite(STOOL_RELAY_PIN, LOW);
    isCleaning = false;
    Blynk.virtualWrite(V13, 0);
    Serial.println("Cleaning finished.");
  });
}
