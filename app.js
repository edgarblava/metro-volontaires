(() => {
  "use strict";

  // Réglage d'origine : Volontaires (ligne 12), direction Mairie d'Issy.
  const FACTORY = {
    n: "Volontaires",
    line: "C01382",
    ln: { name: "12", color: "00643C", text: "FFFFFF" },
    zda: ["45060"],
    label: "Mairie d'Issy",
    quais: ["462964"],
    heads: ["Mairie d'Issy"],
  };
  const KEY_DEFAULT = "metro.default.v1";
  const REFRESH_MS = 30_000;
  const ALERT_REFRESH_MS = 120_000;
  const BACK_TO_DEFAULT_MS = 15 * 60_000; // après 15 min en arrière-plan, on revient à la station par défaut

  const params = new URLSearchParams(location.search);
  const WORKER = (params.get("worker") || (window.METRO_CONFIG || {}).workerUrl || "").replace(/\/+$/, "");

  const $ = (id) => document.getElementById(id);
  const el = {
    pastille: $("pastille"), station: $("station"), direction: $("direction"),
    t1: $("t1"), d1: $("d1"), t2: $("t2"), d2: $("d2"),
    notice: $("notice"), alert: $("alert"), updated: $("updated"), foot: document.querySelector(".foot"),
    backDefault: $("back-default"), picker: $("picker"), search: $("search"), step: $("step"),
    remember: $("remember"), factory: $("factory"), open: $("open-picker"),
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
  let def = isSel(load(KEY_DEFAULT)) ? load(KEY_DEFAULT) : FACTORY;
  let current = def;
  let visits = null;      // [{t, dest, atStop}] ou null si jamais chargé
  let lastOk = null;      // Date de la dernière réponse correcte
  let error = null;       // message d'erreur de la dernière tentative
  let alerts = [];        // textes de perturbation pour la ligne
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

  async function refreshAlerts(sel) {
    if (alertsFor === sel.line && Date.now() - alertsAt < ALERT_REFRESH_MS) return;
    alertsFor = sel.line;
    alertsAt = Date.now();
    try {
      const j = await getJSON(`/general-message?LineRef=${encodeURIComponent(`STIF:Line::${sel.line}:`)}`);
      const now = Date.now();
      const texts = [];
      for (const d of (j.Siri && j.Siri.ServiceDelivery && j.Siri.ServiceDelivery.GeneralMessageDelivery) || []) {
        for (const m of d.InfoMessage || []) {
          if (!/perturbation/i.test(val(m.InfoChannelRef) || "")) continue;
          const until = Date.parse(val(m.ValidUntilTime));
          if (Number.isFinite(until) && until < now) continue;
          const msgs = (m.Content && m.Content.Message) || [];
          const pick = msgs.find((x) => /short/i.test(val(x.MessageType) || "")) || msgs[0];
          const text = pick && val(pick.MessageText);
          if (text && !texts.includes(text.trim())) texts.push(text.trim());
        }
      }
      if (alertsFor === sel.line) { alerts = texts; render(); }
    } catch (e) {
      alerts = [];
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
    el.backDefault.hidden = same(sel, def);

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
    el.alert.textContent = alerts.length ? `⚠ ${alerts.join("\n\n")}` : "";

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
      if (alertsFor !== sel.line) { alerts = []; alertsFor = null; }
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
      if (hiddenAt && Date.now() - hiddenAt > BACK_TO_DEFAULT_MS && !same(current, def)) show(def);
      else restartPolling();
    }
  });
  window.addEventListener("online", refresh);
  window.addEventListener("pageshow", (e) => { if (e.persisted) restartPolling(); });

  document.querySelector(".times").addEventListener("click", refresh);
  el.alert.addEventListener("click", () => el.alert.classList.toggle("open"));
  el.backDefault.addEventListener("click", () => show(def));

  // ---------- Choix de la station ----------
  let catalog = null;

  async function loadCatalog() {
    if (catalog) return catalog;
    const r = await fetch("stations.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    catalog = await r.json();
    catalog.stations.forEach((s) => { s.key = norm(`${s.n} ${s.t}`); });
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
        const sel = { n: s.n, line: l.id, ln, zda: l.zda, label: d.label, quais: d.quais, heads: d.heads };
        el.step.append(item(() => choose(sel), mini(ln), text("span", `→ ${d.label}`)));
      }
    }
    el.step.append(item(listStations, text("span", "← Autres stations", "sub")));
  }

  function choose(sel) {
    if (el.remember.checked) {
      def = sel;
      same(sel, FACTORY) ? store(KEY_DEFAULT, null) : store(KEY_DEFAULT, sel);
    }
    el.picker.close();
    show(sel);
  }

  el.open.addEventListener("click", async () => {
    el.search.value = "";
    el.remember.checked = false;
    el.step.replaceChildren(text("p", "Chargement de la liste des stations…", "hint"));
    el.picker.showModal();
    try {
      await loadCatalog();
      listStations();
    } catch {
      el.step.replaceChildren(text("p", "Impossible de charger la liste des stations.", "hint"));
    }
  });
  el.search.addEventListener("input", listStations);
  el.factory.addEventListener("click", () => {
    def = FACTORY;
    store(KEY_DEFAULT, null);
    el.picker.close();
    show(FACTORY);
  });

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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
