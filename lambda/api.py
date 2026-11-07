"""API del dashboard CocaTrace (AWS Lambda detras de API Gateway HTTP API).

Rutas:
  GET  /lecturas?horas=24   lecturas del secadero para las graficas (JSON)
  GET  /csv?horas=24        las mismas lecturas como archivo CSV
  GET  /led                 estado real del LED y del ESP32 (mensajes retenidos de AWS IoT)
  POST /led                 {"led": "on" | "off"} con la cabecera x-clave-control

Variables de entorno: TABLA, SECADERO, IOT_ENDPOINT, CLAVE_CONTROL.
"""
import base64
import csv
import hmac
import io
import json
import os
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

TABLA = os.environ.get("TABLA", "cocatrace_lecturas")
SECADERO = os.environ.get("SECADERO", "secadero1")
CLAVE_CONTROL = os.environ.get("CLAVE_CONTROL", "")
HORAS_MAX = 24 * 7
PUNTOS_MAX = 720          # las graficas no necesitan mas puntos; el CSV lleva todos
COLOMBIA = timezone(timedelta(hours=-5))

tabla = boto3.resource("dynamodb").Table(TABLA)
iot = boto3.client("iot-data", endpoint_url=f"https://{os.environ['IOT_ENDPOINT']}")


def respuesta(codigo, cuerpo, tipo="application/json", extra=None):
    headers = {"Content-Type": tipo, "Cache-Control": "no-store"}
    headers.update(extra or {})
    if not isinstance(cuerpo, str):
        cuerpo = json.dumps(cuerpo, default=lambda d: float(d) if isinstance(d, Decimal) else str(d))
    return {"statusCode": codigo, "headers": headers, "body": cuerpo}


def leer_horas(event):
    try:
        horas = float((event.get("queryStringParameters") or {}).get("horas", 24))
    except ValueError:
        horas = 24
    return min(max(horas, 0.25), HORAS_MAX)


def consultar(horas):
    """Lecturas de las ultimas `horas`, ordenadas por hora de medicion (ts del ESP32)."""
    desde = int(time.time() - horas * 3600)
    items, kwargs = [], {
        "KeyConditionExpression": Key("secadero").eq(SECADERO) & Key("ts").gte(desde),
    }
    while True:
        pagina = tabla.query(**kwargs)
        items += pagina["Items"]
        if "LastEvaluatedKey" not in pagina:
            return items
        kwargs["ExclusiveStartKey"] = pagina["LastEvaluatedKey"]


def reducir(items):
    """Promedia lecturas vecinas para que la grafica no pase de PUNTOS_MAX puntos."""
    if len(items) <= PUNTOS_MAX:
        return items
    paso = -(-len(items) // PUNTOS_MAX)
    salida = []
    for i in range(0, len(items), paso):
        grupo = items[i:i + paso]
        salida.append({
            "ts": grupo[-1]["ts"],
            "temperatura": round(sum(float(x["temperatura"]) for x in grupo) / len(grupo), 1),
            "humedad": round(sum(float(x["humedad"]) for x in grupo) / len(grupo), 1),
        })
    return salida


def retenido(topic):
    try:
        return iot.get_retained_message(topic=topic)["payload"].decode()
    except iot.exceptions.ResourceNotFoundException:
        return None


def get_lecturas(event):
    horas = leer_horas(event)
    items = consultar(horas)
    lecturas = [{"ts": int(x["ts"]), "temperatura": x["temperatura"], "humedad": x["humedad"]} for x in items]
    return respuesta(200, {
        "secadero": SECADERO,
        "horas": horas,
        "total": len(lecturas),
        "ultima": lecturas[-1] if lecturas else None,
        "lecturas": reducir(lecturas),
    })


def get_csv(event):
    horas = leer_horas(event)
    salida = io.StringIO()
    w = csv.writer(salida)
    w.writerow(["fecha_utc", "fecha_colombia", "secadero", "temperatura_c", "humedad_pct"])
    for x in consultar(horas):
        ts = int(x["ts"])
        w.writerow([
            datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            datetime.fromtimestamp(ts, COLOMBIA).strftime("%Y-%m-%d %H:%M:%S"),
            x["secadero"], x["temperatura"], x["humedad"],
        ])
    nombre = f"cocatrace_{SECADERO}_{datetime.now(COLOMBIA):%Y%m%d_%H%M}.csv"
    return respuesta(200, salida.getvalue(), "text/csv; charset=utf-8",
                     {"Content-Disposition": f'attachment; filename="{nombre}"'})


def get_led(event):
    estado_led = retenido(f"{SECADERO}/led/estado")
    return respuesta(200, {
        "led": json.loads(estado_led) if estado_led else None,
        "dispositivo": retenido(f"{SECADERO}/estado"),
    })


def post_led(event):
    clave = (event.get("headers") or {}).get("x-clave-control", "")
    if not CLAVE_CONTROL or not hmac.compare_digest(clave, CLAVE_CONTROL):
        return respuesta(401, {"error": "Clave de control incorrecta"})
    cuerpo = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        cuerpo = base64.b64decode(cuerpo).decode()
    try:
        led = json.loads(cuerpo).get("led")
    except (ValueError, AttributeError):
        led = None
    if led not in ("on", "off"):
        return respuesta(400, {"error": 'Envia {"led": "on"} o {"led": "off"}'})
    # Retenido: si el ESP32 esta desconectado, recibe la orden al volver a conectarse
    iot.publish(topic=f"{SECADERO}/led/cmd", qos=1, retain=True,
                payload=json.dumps({"led": led, "ts": int(time.time())}))
    return respuesta(202, {"enviado": led})


RUTAS = {
    ("GET", "/lecturas"): get_lecturas,
    ("GET", "/csv"): get_csv,
    ("GET", "/led"): get_led,
    ("POST", "/led"): post_led,
}


def handler(event, context):
    http = event["requestContext"]["http"]
    # Consulta previa de CORS del navegador: API Gateway agrega las cabeceras, solo hay que responder 2xx
    if http["method"] == "OPTIONS":
        return {"statusCode": 204, "body": ""}
    funcion = RUTAS.get((http["method"], event.get("rawPath", http["path"])))
    if not funcion:
        return respuesta(404, {"error": "Ruta no encontrada"})
    return funcion(event)
