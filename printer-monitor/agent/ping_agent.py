#!/usr/bin/env python3
"""
Agente de ping para printer.dcmdevelop.com

Corre DENTRO de tu red Wi-Fi (PC, Raspberry Pi, NAS...). Hace ping real a las IP
y reporta el resultado al Worker de Cloudflare. Solo usa la librería estándar.

Variables de entorno:
  AGENT_TOKEN        (obligatoria) mismo valor que el secreto AGENT_TOKEN del Worker
  PRINTER_URL        URL del Worker            (def: https://printer.dcmdevelop.com)
  TARGETS            IPs separadas por coma    (def: 192.168.1.3,192.168.1.4)
                     Nombre opcional: "192.168.1.3=Impresora,192.168.1.4=Router"
  INTERVAL           segundos entre rondas     (def: 5)
  FAILS_BEFORE_DOWN  fallos seguidos para dar la IP por caída; evita falsas
                     alarmas por un paquete perdido (def: 2)
"""
import json
import os
import platform
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = os.environ.get("PRINTER_URL", "https://printer.dcmdevelop.com").rstrip("/")
TOKEN = os.environ.get("AGENT_TOKEN", "")
RAW_TARGETS = os.environ.get("TARGETS", "192.168.1.3,192.168.1.4")
INTERVAL = float(os.environ.get("INTERVAL", "5"))
FAILS_BEFORE_DOWN = max(1, int(os.environ.get("FAILS_BEFORE_DOWN", "2")))

SYSTEM = platform.system()
if SYSTEM == "Windows":
    PING = ["ping", "-n", "1", "-w", "2000"]
elif SYSTEM == "Darwin":
    PING = ["ping", "-c", "1", "-W", "2000"]
else:
    PING = ["ping", "-c", "1", "-W", "2"]

TIME_RE = re.compile(r"time\s*([=<])\s*([\d.,]+)\s*ms", re.IGNORECASE)


def parse_targets(raw):
    targets = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        ip, _, name = item.partition("=")
        targets.append((ip.strip(), name.strip()))
    return targets


def ping(ip):
    """Devuelve (vivo, milisegundos|None). Un ping real: ICMP vía el comando del sistema."""
    try:
        out = subprocess.run(
            PING + [ip], capture_output=True, text=True, timeout=6
        ).stdout
    except (subprocess.TimeoutExpired, OSError):
        return False, None
    # "ttl=" solo aparece en una respuesta real (en Windows, "host unreachable"
    # también devuelve código 0, por eso no basta con mirar el exit code).
    if "ttl=" not in out.lower():
        return False, None
    m = TIME_RE.search(out)
    if not m:
        return True, None
    ms = float(m.group(2).replace(",", "."))
    return True, (0.5 if m.group(1) == "<" else ms)


def post(results):
    body = json.dumps({"results": results}).encode()
    req = urllib.request.Request(
        URL + "/api/report",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            # Cloudflare bloquea el User-Agent por defecto de urllib (error 1010).
            "User-Agent": "printer-ping-agent/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        resp.read()


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def main():
    if not TOKEN:
        sys.exit("Falta AGENT_TOKEN (el mismo que pusiste en el Worker).")
    targets = parse_targets(RAW_TARGETS)
    if not targets:
        sys.exit("TARGETS está vacío.")

    fails = {ip: 0 for ip, _ in targets}
    last_ms = {ip: None for ip, _ in targets}
    shown = {}
    post_ok = True
    first_round = True
    log(f"Monitoreando {', '.join(ip for ip, _ in targets)} → {URL}")

    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        while True:
            started = time.monotonic()
            replies = list(pool.map(lambda t: ping(t[0]), targets))
            if first_round:
                # Al arrancar no hay historial: reintenta ya las que fallan para
                # no mostrar "en línea" por inercia ni dar una falsa alarma.
                for _ in range(FAILS_BEFORE_DOWN - 1):
                    redo = [i for i, r in enumerate(replies) if not r[0]]
                    for i, r in zip(redo, pool.map(lambda i: ping(targets[i][0]), redo)):
                        replies[i] = r
                    if not redo:
                        break
                for (ip, _), (alive, _) in zip(targets, replies):
                    fails[ip] = 0 if alive else FAILS_BEFORE_DOWN - 1
                first_round = False

            results = []
            for (ip, name), (alive, ms) in zip(targets, replies):
                if alive:
                    fails[ip], last_ms[ip] = 0, ms
                else:
                    fails[ip] += 1
                up = fails[ip] < FAILS_BEFORE_DOWN
                results.append({"ip": ip, "name": name, "alive": up, "ms": last_ms[ip] if up else None})
                if shown.get(ip) != up:
                    shown[ip] = up
                    log(f"{ip}: {'EN LÍNEA' if up else 'SIN RESPUESTA'}")

            try:
                post(results)
                if not post_ok:
                    log("Conexión con el Worker restablecida")
                post_ok = True
            except urllib.error.HTTPError as e:
                post_ok = False
                log(f"El Worker respondió {e.code} (¿AGENT_TOKEN correcto?)")
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if post_ok:
                    log(f"No se pudo contactar al Worker: {e}")
                post_ok = False

            time.sleep(max(0.5, INTERVAL - (time.monotonic() - started)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
