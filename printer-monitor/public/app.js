(() => {
  "use strict";

  const POLL_MS = 3000;
  const ALARM_REPEAT_MS = 10000;
  const $ = (id) => document.getElementById(id);

  const el = {
    grid: $("grid"), empty: $("empty"), banner: $("banner"), bannerText: $("bannerText"),
    silence: $("silence"), agent: $("agent"), agentText: $("agentText"), enable: $("enable"),
    toast: $("toast"), clock: $("clock"), favicon: $("favicon"), tpl: $("card-tpl"),
  };

  const HEART = "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
  const COLORS = { ok: "#22d38a", bad: "#ff3b4e", idle: "#6b7592" };

  let snap = null;          // última respuesta de /api/status
  let offset = 0;           // reloj del servidor - reloj local
  let serverOk = true;      // ¿llegamos al Worker?
  let silenced = false;
  let alarmTimer = null;
  let titleTimer = null;
  let toastTimer = null;
  let audio = null;
  const prevState = new Map();   // ip -> "up" | "down" (último estado conocido)
  const cards = new Map();       // ip -> { root, ...nodos }

  // ---------- utilidades ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin storage: no pasa nada */ } },
  };

  const now = () => Date.now() + offset;

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ${s % 60} s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ${m % 60} min`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
  }

  const label = (t) => (t.name ? `${t.name} (${t.ip})` : t.ip);

  function stateOf(t) {
    if (!snap || !serverOk || !snap.agentOnline || t.alive === null) return "unknown";
    return t.alive ? "up" : "down";
  }

  // ---------- alertas ----------
  function unlockAudio() {
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch { audio = null; }
  }

  function siren() {
    if (!audio || audio.state !== "running") return;
    const t0 = audio.currentTime;
    for (let i = 0; i < 6; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "square";
      osc.frequency.value = i % 2 ? 660 : 880;
      const start = t0 + i * 0.22;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    }
  }

  function notify(title, body, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try { new Notification(title, { body, tag, requireInteraction: true }); } catch { /* Android exige Service Worker */ }
  }

  function alertDown(list) {
    silenced = false;
    list.forEach((t) => notify("⚠ IP sin ping", `${label(t)} dejó de hacer ping`, t.ip));
    siren();
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 600]);
  }

  function showToast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
  }

  function setFavicon(color) {
    el.favicon.href = "data:image/svg+xml," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${HEART}"/></svg>`);
  }

  // ---------- render ----------
  function buildCard(t) {
    const root = el.tpl.content.firstElementChild.cloneNode(true);
    const c = {
      root,
      ip: root.querySelector(".ip"), name: root.querySelector(".name"),
      status: root.querySelector(".status"), detail: root.querySelector(".detail"),
      strip: root.querySelector(".strip"), sig: "",
    };
    c.ip.textContent = t.ip;
    el.grid.appendChild(root);
    cards.set(t.ip, c);
    return c;
  }

  function render() {
    const targets = snap?.targets ?? [];

    // Tarjetas: crear las nuevas y retirar las que ya no se reportan.
    // Se actualizan en sitio para no reiniciar la animación del latido.
    const ips = new Set(targets.map((t) => t.ip));
    for (const [ip, c] of cards) if (!ips.has(ip)) { c.root.remove(); cards.delete(ip); }
    el.empty.hidden = targets.length > 0 || !snap;

    const down = [];
    for (const t of targets) {
      const c = cards.get(t.ip) ?? buildCard(t);
      const st = stateOf(t);
      if (c.root.dataset.state !== st) c.root.dataset.state = st;
      c.name.textContent = t.name || "";

      if (st === "up") {
        c.status.textContent = "En línea";
        c.detail.textContent = `${t.ms == null ? "—" : t.ms < 1 ? "<1" : Math.round(t.ms)} ms · estable ${fmt(now() - t.since)}`;
      } else if (st === "down") {
        down.push(t);
        c.status.textContent = "Sin respuesta";
        c.detail.textContent = `Caída hace ${fmt(now() - t.since)}`;
      } else {
        c.status.textContent = "Sin datos";
        c.detail.textContent = !serverOk ? "Sin conexión con el servidor" : "El agente no reporta";
      }

      const sig = t.history.map((h) => (h[1] < 0 ? 0 : 1)).join("");
      if (sig !== c.sig) {
        c.sig = sig;
        c.strip.replaceChildren(...t.history.map(([ts, v]) => {
          const i = document.createElement("i");
          if (v < 0) i.className = "bad";
          i.title = `${new Date(ts).toLocaleTimeString()} · ${v < 0 ? "sin respuesta" : `${v} ms`}`;
          return i;
        }));
      }
    }

    renderAgent();
    renderAlertState(down);
    el.clock.textContent = new Date().toLocaleTimeString();
  }

  function renderAgent() {
    let state = "unknown", text = "Conectando…";
    if (!serverOk) { state = "warn"; text = "Sin conexión con el servidor"; }
    else if (snap && !snap.agentSeen) { state = "warn"; text = "Agente nunca conectado"; }
    else if (snap && !snap.agentOnline) { state = "warn"; text = `Agente sin señal (${fmt(now() - snap.agentSeen)})`; }
    else if (snap) { state = "ok"; text = `Agente activo · hace ${fmt(now() - snap.agentSeen)}`; }
    if (el.agent.dataset.state !== state) el.agent.dataset.state = state;
    el.agentText.textContent = text;
  }

  function renderAlertState(down) {
    const hasDown = down.length > 0;
    const agentLost = !hasDown && snap && snap.agentSeen && (!snap.agentOnline || !serverOk);

    document.body.dataset.alert = hasDown ? "down" : "none";

    if (hasDown) {
      el.banner.dataset.kind = "down";
      el.bannerText.textContent = down.length === 1
        ? `${label(down[0])} dejó de hacer ping`
        : `${down.length} IP dejaron de hacer ping: ${down.map((t) => t.ip).join(", ")}`;
      el.silence.hidden = false;
      el.silence.textContent = silenced ? "Sonido silenciado" : "Silenciar";
      el.silence.disabled = silenced;
    } else if (agentLost) {
      el.banner.dataset.kind = "warn";
      el.bannerText.textContent = serverOk
        ? "El agente de tu red no reporta: el estado mostrado no es fiable"
        : "No hay conexión con el servidor";
      el.silence.hidden = true;
    }
    el.banner.hidden = !(hasDown || agentLost);

    // Favicon y título parpadeante
    setFavicon(hasDown ? COLORS.bad : snap && snap.agentOnline && serverOk ? COLORS.ok : COLORS.idle);
    if (hasDown && !titleTimer) {
      let on = false;
      titleTimer = setInterval(() => {
        on = !on;
        document.title = on ? "🚨 ¡IP sin ping!" : "Monitor de red";
      }, 1000);
    } else if (!hasDown && titleTimer) {
      clearInterval(titleTimer);
      titleTimer = null;
      document.title = "Monitor de red";
    }

    // Sirena repetida mientras haya IP caída y no se silencie
    const shouldRing = hasDown && !silenced;
    if (shouldRing && !alarmTimer) alarmTimer = setInterval(siren, ALARM_REPEAT_MS);
    else if (!shouldRing && alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
  }

  // ---------- datos ----------
  function apply(data) {
    snap = data;
    offset = data.now - Date.now();

    const newlyDown = [], recovered = [];
    for (const t of data.targets) {
      const st = stateOf(t);
      if (st === "unknown") continue;      // sin agente: no inventamos transiciones
      const before = prevState.get(t.ip);
      if (st === "down" && before !== "down") newlyDown.push(t);
      if (st === "up" && before === "down") recovered.push(t);
      prevState.set(t.ip, st);
    }
    if (newlyDown.length) alertDown(newlyDown);
    if (recovered.length) showToast(`✔ ${recovered.map(label).join(", ")} volvió a responder`);
  }

  async function poll() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      serverOk = true;
      apply(await res.json());
    } catch {
      serverOk = false;
    }
    render();
  }

  // ---------- controles ----------
  async function enableAlerts() {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* ignorar */ }
    }
    store.set("alerts", "1");
    refreshEnableButton();
    siren(); // prueba audible
  }

  function refreshEnableButton() {
    const on = store.get("alerts") === "1";
    el.enable.dataset.on = String(on);
    el.enable.textContent = on ? "🔔 Alertas activas" : "🔔 Activar alertas";
  }

  el.enable.addEventListener("click", enableAlerts);
  el.silence.addEventListener("click", () => { silenced = true; render(); });
  // Los navegadores bloquean el audio hasta el primer gesto del usuario.
  window.addEventListener("pointerdown", () => { if (store.get("alerts") === "1") unlockAudio(); }, { once: true });

  refreshEnableButton();
  poll();
  setInterval(poll, POLL_MS);
  setInterval(() => { if (snap) render(); }, 1000);   // contadores de tiempo
})();
