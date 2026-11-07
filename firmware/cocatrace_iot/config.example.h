#pragma once
// Copia este archivo como config.h y pon tus datos (config.h no se sube a GitHub)

const char* WIFI_SSID = "TU_RED_WIFI";      // solo redes de 2.4 GHz
const char* WIFI_PASS = "TU_CLAVE";

// Endpoint de AWS IoT Core: aws iot describe-endpoint --endpoint-type iot:Data-ATS
const char* AWS_IOT_ENDPOINT = "xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com";
const uint16_t AWS_IOT_PORT  = 8883;

const char* THING_NAME = "esp32-secadero-01";   // nombre del thing y client id MQTT
const char* SECADERO   = "secadero1";           // primer nivel de los topics

// Certificado raiz de Amazon (AmazonRootCA1.pem)
static const char AWS_CERT_CA[] = R"EOF(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)EOF";

// Certificado del dispositivo (xxxx-certificate.pem.crt)
static const char AWS_CERT_CRT[] = R"EOF(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)EOF";

// Llave privada del dispositivo (xxxx-private.pem.key)
static const char AWS_CERT_PRIVATE[] = R"EOF(
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
)EOF";
