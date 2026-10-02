# Monitor de ping · printer.dcmdevelop.com

Web con un corazón palpitante por cada IP (`192.168.1.3` y `192.168.1.4`):

- 💚 **Verde y latiendo** → la IP responde al ping (muestra ms y el historial reciente).
- ❤️ **Rojo, latido rápido y parpadeo** → la IP dejó de hacer ping. Salta un banner
  _"192.168.1.x dejó de hacer ping"_, sirena (se repite cada 10 s hasta pulsar **Silenciar**),
  vibración en el móvil, notificación del navegador y el título de la pestaña parpadea.
- ⚪ **Gris** → el agente de tu red no reporta; en vez de mostrar un verde que ya no es fiable, avisa.

Responsive: 1 columna en móvil, 2 en tablet y escritorio.

## Cómo funciona (y por qué hay un agente)

Un Cloudflare Worker corre en internet: **no puede llegar a `192.168.1.x`** (son IPs privadas de tu Wi-Fi)
ni hacer ICMP ping. Por eso hay dos piezas:

```
[Tu Wi-Fi]  agent/ping_agent.py ──ping──> 192.168.1.3 / .4
                 │  POST /api/report cada 5 s (con token)
                 ▼
[Cloudflare]  Worker + Durable Object  ◀── la web consulta /api/status cada 3 s
              printer.dcmdevelop.com
```

El agente puede correr en cualquier equipo que esté en el mismo Wi-Fi y encendido 24/7
(Raspberry Pi, mini PC, NAS, PC de casa). Necesita Python 3 y el comando `ping` (ya viene en el sistema).

## 1. Desplegar el Worker

Requisito: la zona `dcmdevelop.com` debe estar en tu cuenta de Cloudflare.

```bash
cd printer-monitor
npm install
npx wrangler login
npx wrangler deploy                 # crea el Worker y el subdominio printer.dcmdevelop.com
openssl rand -hex 24                # genera un token; cópialo
npx wrangler secret put AGENT_TOKEN # pega el token
```

`wrangler.toml` ya declara `printer.dcmdevelop.com` como _custom domain_: Cloudflare crea el registro
DNS y el certificado solo. (Si ya existe un registro DNS `printer` en la zona, bórralo antes.)

## 2. Arrancar el agente en tu red

```bash
export AGENT_TOKEN=el_mismo_token
python3 agent/ping_agent.py
```

Opciones por variables de entorno: `TARGETS` (def. `192.168.1.3,192.168.1.4`; admite nombre:
`192.168.1.3=Impresora`), `INTERVAL` (5 s), `FAILS_BEFORE_DOWN` (2, evita falsas alarmas por un
paquete perdido), `PRINTER_URL`.

Para que arranque solo: `agent/printer-agent.service` (systemd, Linux/Raspberry Pi) o el Programador
de tareas en Windows (`python ping_agent.py`, "al iniciar sesión").

## 3. Alertas en el navegador

Pulsa **🔔 Activar alertas** una vez en cada dispositivo (los navegadores no permiten sonido ni
notificaciones sin ese gesto). Las alertas funcionan mientras la página esté abierta.

## Desarrollo local

```bash
echo "AGENT_TOKEN=devtoken" > .dev.vars
npm run dev                                   # http://127.0.0.1:8787
AGENT_TOKEN=devtoken PRINTER_URL=http://127.0.0.1:8787 python3 agent/ping_agent.py
```

## Notas

- **Cuotas (plan gratis):** los Durable Objects permiten 100 000 peticiones/día. El agente usa ~17 000
  y cada pestaña abierta ~29 000, así que caben unas 2–3 pestañas simultáneas todo el día.
- **Privacidad:** la web es pública (solo muestra si dos IP privadas están arriba o abajo). Si quieres
  restringirla, protege `printer.dcmdevelop.com` con Cloudflare Access (Zero Trust); no afecta al agente
  si excluyes `/api/report` de la política.
- `POST /api/report` exige `Authorization: Bearer <AGENT_TOKEN>` y valida el formato (solo IPv4).
