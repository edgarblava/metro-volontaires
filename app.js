(() => {
  "use strict";

  // Station affichée tant que personne n'en a choisi : Volontaires (ligne 12), direction Mairie d'Issy.
  const FACTORY = {
    n: "Volontaires",
    line: "C01382",
    ln: { name: "12", color: "00643C", text: "FFFFFF" },
    zda: ["45060"],
    label: "Mairie d'Issy",
    quais: ["462964"],
    heads: ["Mairie d'Issy"],
    zdc: ["71113"],
    d: "0",
  };
  const KEY_LAST = "metro.last.v1";        // dernière station consultée
  const KEY_OLD_DEFAULT = "metro.default.v1"; // ancienne « station par défaut », reprise une fois
  const REFRESH_MS = 30_000;
  const ALERT_REFRESH_MS = 120_000;

  const params = new URLSearchParams(location.search);
  const WORKER = (params.get("worker") || (window.METRO_CONFIG || {}).workerUrl || "").replace(/\/+$/, "");

  const $ = (id) => document.getElementById(id);
  const el = {
    pastille: $("pastille"), station: $("station"), direction: $("direction"),
    t1: $("t1"), d1: $("d1"), t2: $("t2"), d2: $("d2"),
    notice: $("notice"), alert: $("alert"), updated: $("updated"), foot: document.querySelector(".foot"),
    picker: $("picker"), search: $("search"), step: $("step"), open: $("open-picker"),
  };

  // ---------- Utilitaires ----------
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const val = (x) => (Array.isArray(x) ? val(x[0]) : x && typeof x === "object" ? x.value : x);
  const hhmm = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const hhmmss = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function store(key, v) {
    try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); } catch { /* navigation privée */ }
  }
  const isSel = (s) => s && typeof s.n === "string" && /^C\d{5}$/.test(s.line) && s.ln &&
    Array.isArray(s.zda) && s.zda.length && Array.isArray(s.quais) && Array.isArray(s.heads);
  const same = (a, b) => a.n === b.n && a.line === b.line && a.label === b.label;

  // ---------- État ----------
  const saved = [load(KEY_LAST), load(KEY_OLD_DEFAULT)].find(isSel) || null;
  const firstVisit = !saved;
  let current = saved || FACTORY;
  let visits = null;      // [{t, dest, atStop}] ou null si jamais chargé
  let lastOk = null;      // Date de la dernière réponse correcte
  let error = null;       // message d'erreur de la dernière tentative
  let alerts = [];        // perturbations en cours qui touchent le trajet : {title, text, period}
  let alertsFor = null, alertsAt = 0;
  let generation = 0;     // ignore les réponses d'une station précédente
  let hiddenAt = 0;
  let pollTimer = null;

  // ---------- Données ----------
  async function getJSON(path) {
    const r = await fetch(WORKER + path, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function parseVisits(list, sel) {
    const lineRef = `STIF:Line::${sel.line}:`;
    const quais = new Set(sel.quais);
    const heads = new Set(sel.heads.map(norm));
    const now = Date.now();
    const out = [];
    for (const v of list) {
      const j = v.MonitoredVehicleJourney || {};
      if (val(j.LineRef) !== lineRef) continue;
      const c = j.MonitoredCall || {};
      const status = `${val(c.DepartureStatus) || ""} ${val(c.ArrivalStatus) || ""}`.toLowerCase();
      if (status.includes("cancel")) continue;
      const quai = ((val(v.MonitoringRef) || "") + " " + (val(c.StopPointRef) || "")).match(/StopPoint:Q:(\d+):/);
      const destName = val(j.DestinationName) || "";
      const dest = val(c.DestinationDisplay) || destName || val(j.DirectionName) || "";
      const sameDir = (quai && quais.has(quai[1])) ||
        [dest, destName, val(j.DirectionName)].some((d) => d && heads.has(norm(d)));
      if (!sameDir) continue;
      const time = val(c.ExpectedDepartureTime) || val(c.ExpectedArrivalTime) ||
        val(c.AimedDepartureTime) || val(c.AimedArrivalTime);
      const t = Date.parse(time);
      if (!Number.isFinite(t) || t < now - 60_000) continue;
      out.push({ t, dest, atStop: val(c.VehicleAtStop) === true });
    }
    out.sort((a, b) => a.t - b.t);
    return out.filter((v, i) => i === 0 || v.t - out[i - 1].t > 20_000 || v.dest !== out[i - 1].dest);
  }

  async function refresh() {
    if (!WORKER) {
      error = "config";
      render();
      return;
    }
    const gen = ++generation;
    const sel = current;
    try {
      const all = [];
      for (const z of sel.zda) {
        const j = await getJSON(`/stop-monitoring?MonitoringRef=${encodeURIComponent(`STIF:StopArea:SP:${z}:`)}`);
        for (const d of (j.Siri && j.Siri.ServiceDelivery && j.Siri.ServiceDelivery.StopMonitoringDelivery) || []) {
          for (const v of d.MonitoredStopVisit || []) all.push(v);
        }
      }
      if (gen !== generation) return;
      visits = parseVisits(all, sel);
      lastOk = new Date();
      error = null;
    } catch (e) {
      if (gen !== generation) return;
      error = navigator.onLine === false ? "offline" : "network";
      console.warn("Prochains passages :", e);
    }
    render();
    refreshAlerts(sel);
  }

  // Info trafic : on n'affiche une perturbation que si elle est en cours maintenant,
  // qu'elle gêne vraiment (pas une simple information) et qu'elle touche le trajet :
  // la station elle-même, toute la ligne, ou un tronçon situé plus loin dans le sens choisi.
  const alertKey = (sel) => `${sel.n}|${sel.line}|${sel.label}`;

  function parisNow() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
  }

  const idOf = (ref) => String(ref || "").split(":").pop();

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(
      String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n"), "text/html");
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function frenchPeriod(d) {
    const p = (d.applicationPeriods || [])[0];
    if (!p) return "";
    const fmt = (t) => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(t || "");
      return m ? `${m[3]}/${m[2]} à ${m[4]} h ${m[5]}` : "";
    };
    return p.end ? `Du ${fmt(p.begin)} au ${fmt(p.end)}` : `Depuis le ${fmt(p.begin)}`;
  }

  // La station du trajet (ZdC) et le sens GTFS, retrouvés dans le référentiel si besoin.
  function tripInfo(sel, cat) {
    let { zdc, d } = sel;
    if (!zdc || d == null) {
      const st = cat.stations.find((s) => s.n === sel.n);
      const ln = st && st.l.find((l) => l.id === sel.line);
      const dir = ln && ln.dirs.find((x) => x.label === sel.label);
      zdc = ln ? ln.zdc : [];
      d = dir ? dir.d : null;
    }
    return { zdc: new Set(zdc || []), d };
  }

  function touchesTrip(dis, sel, cat) {
    const sections = (dis.impactedSections || []).filter((x) => String(x.lineId || "").includes(sel.line));
    if (!sections.length) return true; // toute la ligne
    const { zdc, d } = tripInfo(sel, cat);
    const seqs = ((cat.lines[sel.line] || {}).seq || {})[d] || [];
    const mine = seqs.filter((q) => q.some((z) => zdc.has(z)));
    if (!mine.length) return true; // ordre inconnu : on prévient par prudence
    return sections.some((sec) => mine.some((q) => {
      const i = q.findIndex((z) => zdc.has(z));
      const a = q.indexOf(idOf(sec.from && sec.from.id));
      const b = q.indexOf(idOf(sec.to && sec.to.id));
      if (a < 0 && b < 0) return false; // autre branche
      return Math.max(a, b) >= i; // la station est dans le tronçon, ou le tronçon est plus loin
    }));
  }

  async function refreshAlerts(sel) {
    const key = alertKey(sel);
    if (alertsFor === key && Date.now() - alertsAt < ALERT_REFRESH_MS) return;
    alertsFor = key;
    alertsAt = Date.now();
    try {
      const [j, cat] = await Promise.all([getJSON(`/disruptions?line=${sel.line}`), loadCatalog()]);
      const now = parisNow();
      const byId = new Map((j.disruptions || []).map((x) => [x.id, x]));
      const found = new Map();
      for (const ln of j.lines || []) {
        for (const o of ln.impactedObjects || []) {
          for (const id of o.disruptionIds || []) {
            const dis = byId.get(id);
            if (!dis || found.has(id)) continue;
            if (!/BLOQUANTE|PERTURBEE/i.test(dis.severity || "")) continue;
            const active = (dis.applicationPeriods || []).some((p) => p.begin <= now && (!p.end || now < p.end));
            if (!active) continue;
            const relevant = o.type === "line"
              ? touchesTrip(dis, sel, cat)
              : norm(o.name).startsWith(norm(sel.n)) || sel.quais.includes(idOf(o.id)) || tripInfo(sel, cat).zdc.has(idOf(o.id));
            if (relevant) found.set(id, dis);
          }
        }
      }
      const list = [...found.values()].map((dis) => ({
        title: (dis.title || dis.shortMessage || "Perturbation").trim(),
        text: htmlToText(dis.message),
        period: frenchPeriod(dis),
      }));
      if (alertsFor === key) { alerts = list; render(); }
    } catch (e) {
      if (alertsFor === key) { alerts = []; render(); }
      console.warn("Info trafic :", e);
    }
  }

  // ---------- Affichage ----------
  function setTime(node, destNode, v, sel) {
    destNode.textContent = "";
    if (!v) {
      node.textContent = node === el.t1 || (visits && visits.length) ? "—" : "";
      node.className = "min text";
      return;
    }
    const m = Math.floor((v.t - Date.now()) / 60_000);
    if (m < 1) {
      node.textContent = v.atStop ? "À quai" : "À l'approche";
      node.className = "min text";
    } else {
      node.className = "min";
      node.textContent = String(m);
      const small = document.createElement("small");
      small.textContent = "min";
      node.append(small);
    }
    if (v.dest && !norm(v.dest).startsWith(norm(sel.label))) destNode.textContent = v.dest;
  }

  function render() {
    const sel = current;
    el.pastille.textContent = sel.ln.name;
    el.pastille.style.setProperty("--c", `#${sel.ln.color}`);
    el.pastille.style.setProperty("--t", `#${sel.ln.text}`);
    el.pastille.setAttribute("aria-label", `Ligne ${sel.ln.name}`);
    el.station.textContent = sel.n;
    el.direction.textContent = sel.label;
    document.title = `${sel.ln.name} · ${sel.n}`;

    const upcoming = (visits || []).filter((v) => v.t > Date.now() - 30_000);
    if (visits) {
      setTime(el.t1, el.d1, upcoming[0], sel);
      setTime(el.t2, el.d2, upcoming[1], sel);
    } else {
      el.t1.textContent = error ? "—" : "…";
      el.t1.className = "min text";
      el.t2.textContent = "";
      el.d1.textContent = el.d2.textContent = "";
    }

    let notice = "";
    let isError = false;
    if (error === "config") {
      notice = "Relais non configuré : renseigner l'adresse du Worker dans config.js (voir le README).";
      isError = true;
    } else if (error && !visits) {
      notice = error === "offline"
        ? "Pas de connexion Internet. Nouvel essai automatique."
        : "Impossible d'obtenir les horaires pour le moment. Nouvel essai dans 30 s.";
      isError = true;
    } else if (error) {
      notice = "Connexion perdue : temps calculés d'après les dernières données reçues.";
      isError = true;
    } else if (visits && upcoming.length === 0) {
      const h = new Date().getHours();
      notice = "Aucun passage annoncé pour le moment.";
      if (h >= 1 && h < 6) notice += " Le service est peut-être terminé (reprise vers 5 h 30).";
      else if (!alerts.length) notice += " Le trafic est peut-être interrompu.";
    }
    el.notice.hidden = !notice;
    el.notice.textContent = notice;
    el.notice.classList.toggle("error", isError);

    el.alert.hidden = alerts.length === 0;
    $("alert-text").textContent = alerts.length
      ? `⚠ ${alerts[0].title}${alerts.length > 1 ? ` (+${alerts.length - 1} autre${alerts.length > 2 ? "s" : ""})` : ""}`
      : "";

    if (lastOk) {
      const stale = !!error || Date.now() - lastOk > 2 * REFRESH_MS;
      el.updated.textContent = stale
        ? `Données de ${hhmm(lastOk)} — pas à jour`
        : `Mis à jour à ${hhmmss(lastOk)}`;
      el.foot.classList.toggle("stale", stale);
    } else {
      el.updated.textContent = error ? "Pas de données" : "Chargement…";
      el.foot.classList.toggle("stale", !!error);
    }
  }

  function show(sel) {
    if (!same(sel, current)) {
      current = sel;
      visits = null;
      lastOk = null;
      error = null;
      if (alertsFor !== alertKey(sel)) { alerts = []; alertsFor = null; }
    }
    render();
    restartPolling();
  }

  function restartPolling() {
    clearInterval(pollTimer);
    refresh();
    pollTimer = setInterval(refresh, REFRESH_MS);
  }

  // Recalcule les minutes entre deux appels.
  setInterval(() => { if (!document.hidden) render(); }, 10_000);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      clearInterval(pollTimer);
    } else {
      restartPolling();
    }
  });
  window.addEventListener("online", refresh);
  window.addEventListener("pageshow", (e) => { if (e.persisted) restartPolling(); });

  document.querySelector(".times").addEventListener("click", refresh);
  el.alert.addEventListener("click", () => {
    $("alert-title").textContent = `Info trafic · ligne ${current.ln.name}`;
    const body = $("alert-body");
    body.replaceChildren(...alerts.map((a) => {
      const p = document.createElement("p");
      const b = document.createElement("strong");
      b.textContent = a.title;
      p.append(b, document.createElement("br"));
      if (a.period) {
        const i = document.createElement("em");
        i.textContent = a.period;
        p.append(i, document.createElement("br"));
      }
      p.append(a.text);
      return p;
    }));
    body.scrollTop = 0;
    $("alert-full").showModal();
  });

  // ---------- Choix de la station ----------
  let catalog = null;

  async function loadCatalog() {
    if (catalog) return catalog;
    const r = await fetch("stations.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    catalog = await r.json();
    catalog.stations.forEach((s) => { s.key = norm(`${s.n} ${s.t}`); });
    catalog.stations.sort((a, b) => a.n.localeCompare(b.n, "fr"));
    return catalog;
  }

  function mini(ln) {
    const span = document.createElement("span");
    span.className = "mini";
    span.style.setProperty("--c", `#${ln.color}`);
    span.style.setProperty("--t", `#${ln.text}`);
    span.textContent = ln.name;
    return span;
  }

  function item(onClick, ...children) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item";
    b.append(...children);
    b.addEventListener("click", onClick);
    return b;
  }

  function text(tag, content, cls) {
    const n = document.createElement(tag);
    n.textContent = content;
    if (cls) n.className = cls;
    return n;
  }

  function listStations() {
    if (!catalog) return;
    const q = norm(el.search.value);
    const words = q ? q.split(" ") : [];
    const found = catalog.stations.filter((s) => words.every((w) => s.key.includes(w)));
    found.sort((a, b) => (norm(b.n).startsWith(q) ? 1 : 0) - (norm(a.n).startsWith(q) ? 1 : 0));
    el.step.replaceChildren();
    if (!found.length) {
      el.step.append(text("p", "Aucune station de métro ne correspond.", "hint"));
      return;
    }
    for (const s of found.slice(0, 80)) {
      const minis = document.createElement("span");
      minis.className = "minis";
      s.l.forEach((l) => minis.append(mini(catalog.lines[l.id])));
      el.step.append(item(() => listDirections(s), text("span", s.n), minis));
    }
  }

  function listDirections(s) {
    el.step.replaceChildren(text("h2", s.n));
    for (const l of s.l) {
      const ln = catalog.lines[l.id];
      for (const d of l.dirs) {
        const sel = { n: s.n, line: l.id, ln, zda: l.zda, zdc: l.zdc, d: d.d, label: d.label, quais: d.quais, heads: d.heads };
        el.step.append(item(() => choose(sel), mini(ln), text("span", `→ ${d.label}`)));
      }
    }
    el.step.append(item(listStations, text("span", "← Autres stations", "sub")));
  }

  function choose(sel) {
    store(KEY_LAST, sel); // rouvrira sur cette station la prochaine fois
    el.picker.close();
    show(sel);
  }

  async function openPicker() {
    el.search.value = "";
    el.step.replaceChildren(text("p", "Chargement de la liste des stations…", "hint"));
    el.picker.showModal();
    try {
      await loadCatalog();
      listStations();
    } catch {
      el.step.replaceChildren(text("p", "Impossible de charger la liste des stations.", "hint"));
    }
  }
  el.open.addEventListener("click", openPicker);
  el.search.addEventListener("input", listStations);

  // ---------- Installation sur l'écran d'accueil ----------
  const installBtn = $("install");
  const installHelp = $("install-help");
  const ua = navigator.userAgent;
  const isAndroid = /Android/.test(ua);
  const isIOS = !isAndroid && (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let installPrompt = null;

  function updateInstallButton() {
    installBtn.hidden = installed() || !(installPrompt || isIOS || isAndroid);
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // on garde la fenêtre d'installation pour notre bouton
    installPrompt = e;
    updateInstallButton();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installBtn.hidden = true;
  });

  function step(html) {
    const li = document.createElement("li");
    li.innerHTML = html; // textes fixes ci-dessous, aucune donnée externe
    return li;
  }

  installBtn.addEventListener("click", async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const choice = await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      if (choice && choice.outcome === "accepted") installBtn.hidden = true;
      return;
    }
    const steps = $("install-steps");
    steps.replaceChildren();
    if (isIOS) {
      steps.append(
        step("Touchez le bouton <b>Partager</b> (carré avec une flèche ↑), en bas ou en haut de l'écran."),
        step("Choisissez <b>Sur l'écran d'accueil</b> (faites défiler la liste si besoin)."),
        step("Touchez <b>Ajouter</b>."),
      );
    } else {
      steps.append(
        step("Ouvrez le menu <b>⋮</b> du navigateur (en haut à droite dans Chrome)."),
        step("Choisissez <b>Installer l'application</b> ou <b>Ajouter à l'écran d'accueil</b>."),
        step("Confirmez avec <b>Installer</b>."),
      );
    }
    installHelp.showModal();
  });

  updateInstallButton();

  // ---------- Démarrage ----------
  render();
  restartPolling();
  if (firstVisit) openPicker(); // première ouverture : chacun choisit sa station

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
