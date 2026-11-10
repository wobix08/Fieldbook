// Hauptsteuerung: Ansichten wechseln, Status anzeigen.
"use strict";

// Breite der Bildlaufleiste messen (für den Ausgleich der Kopfzeile in Lesefenster und Karten, siehe app.css)
(function () {
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll";
  document.body.appendChild(d);
  document.documentElement.style.setProperty("--leiste", (d.offsetWidth - d.clientWidth) + "px");
  d.remove();
})();

const Ansichten = {
  start: { zeigen: zeigeStart },
  fragen: { zeigen: (p) => Fragen.zeigen(p) },
  bibliothek: { zeigen: (p) => Bibliothek.zeigen(p) },
  lesen: { zeigen: (p) => Bibliothek.lesen(p) },
  pdf: { zeigen: (p) => PdfLeser.zeigen(p) },
  paketstart: { zeigen: (p) => Paketstart.zeigen(p) },
  kochen: { zeigen: (p) => Kochen.zeigen(p) },
  karten: { zeigen: () => Karten.zeigen() },
  erstehilfe: { zeigen: (p) => ErsteHilfe.zeigen(p) },
  vorsorge: { zeigen: (p) => Vorsorge.zeigen(p) },
  uebersetzen: { zeigen: () => Gespraech.zeigen() },
  // Alte Adresse des Notfall-Bereichs
  notfall: { zeigen: (p) => location.replace("#erstehilfe" + (String(p) ? "?" + p : "")) },
  setup: { zeigen: (p) => Setup.zeigen(p) },
  einstellungen: { zeigen: () => Einstellungen.zeigen() },
  inhalte: { zeigen: (p) => Inhalte.zeigen(p) },
};

function navigiere() {
  const roh = location.hash.slice(1) || "start";
  const [name, query] = roh.split("?");
  const params = new URLSearchParams(query || "");
  const ziel = Object.prototype.hasOwnProperty.call(Ansichten, name) ? name : "start";
  if (ziel !== "lesen") Bibliothek.anhalten();
  if (ziel !== "pdf") PdfLeser.verlassen();
  $$(".ansicht").forEach(a => a.classList.toggle("sichtbar", a.dataset.ansicht === ziel));
  // Erste Einrichtung: Menü oben ausblenden, bis der Assistent fertig ist (oder „Später einrichten“)
  document.documentElement.classList.toggle("einrichtung", ziel === "setup" && !!OW.status && !OW.status.setupFertig);
  // Paket-Startseiten und PDF-Bücher gehören zur Bibliothek
  const menue = ziel === "paketstart" || ziel === "pdf" ? "bibliothek" : ziel;
  $$("#hauptnav a").forEach(a => {
    const an = a.getAttribute("href") === "#" + menue;
    a.classList.toggle("aktiv", an);
    if (an) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $$(".ansicht-fehler").forEach(x => x.remove());
  // Antwortet Fieldbook nicht, würde jede Seite „nichts installiert“ o. ä. zeigen: stattdessen den Fehler
  if (OW.nichtErreichbar && ziel !== "lesen" && ziel !== "pdf") ansichtFehler(ziel, null);
  // Fehler auch aus asynchronen Ansichten abfangen, sonst bliebe die Seite leer
  else try { Promise.resolve(Ansichten[ziel].zeigen(params)).catch(e => ansichtFehler(ziel, e)); } catch (e) { ansichtFehler(ziel, e); }
  Statistik.bereich(ziel);
  if (ziel !== "lesen" && ziel !== "pdf") window.scrollTo(0, 0);
}

// Fehlerkasten oben in der Ansicht, mit „Erneut versuchen“
async function ansichtFehler(ziel, e) {
  if (e) {
    console.error(e);
    await aktualisiereStatus(); // war es ein Fehler der Seite oder antwortet Fieldbook gar nicht?
    if (!OW.nichtErreichbar) Statistik.fehler("Ansicht " + ziel + ": " + e.message);
  }
  const sek = document.querySelector('.ansicht[data-ansicht="' + ziel + '"]');
  if (!sek) return;
  sek.querySelectorAll(".ansicht-fehler").forEach(x => x.remove());
  const text = OW.nichtErreichbar ? NICHT_ERREICHBAR : "Diese Seite konnte nicht geladen werden. Bitte versuche es noch einmal.";
  // Kommt Fieldbook wieder, baut aktualisiereStatus die Seite selbst neu auf; sonst hier
  const box = fehlerBox(text, async () => { const weg = OW.nichtErreichbar; await aktualisiereStatus(); if (!weg || OW.nichtErreichbar) navigiere(); }, null, e && e.message);
  box.classList.add("ansicht-fehler");
  box.style.margin = "16px 0";
  sek.prepend(box);
}

// Statusabfrage: nie zwei zugleich, mit Frist; eine ältere Antwort überschreibt keine neuere
let statusLauf = null, statusZaehler = 0, statusBeendet = false, statusTimer = null, schnellTimer = null;
function aktualisiereStatus() {
  if (statusBeendet) return Promise.resolve(null);
  if (!statusLauf) statusLauf = holeStatus().finally(() => { statusLauf = null; });
  return statusLauf;
}

async function holeStatus() {
  const nr = ++statusZaehler;
  try {
    const r = await fetch("/api/status", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error("Server antwortet mit " + r.status);
    const s = await r.json();
    if (nr !== statusZaehler) return OW.status || s;
    // Fieldbook antwortet wieder: eine Fehlerseite von eben neu aufbauen
    const warWeg = OW.nichtErreichbar;
    OW.nichtErreichbar = false;
    if (warWeg && document.querySelector(".ansicht-fehler")) setTimeout(navigiere, 0);
    const vorher = OW.status;
    // Fieldbook wurde neu gestartet und nutzt diesen Tab weiter: einmal frisch laden
    if (vorher && vorher.start && s.start && vorher.start !== s.start && !document.querySelector(".dialog-hinter[data-neustart]")) { location.reload(); return s; }
    OW.status = s;
    if (vorher && vorher.bibliothek !== s.bibliothek) OW.buecher = null;
    zeigeKopfStatus(s);
    statistikNachfragen(s);
    PdfText.pruefen();
    return s;
  } catch (e) {
    if (statusBeendet) return null;
    OW.nichtErreichbar = true;
    const p = $("#ki-pill");
    if (p) pillSetzen(p, "weg", () => { p.textContent = "Fieldbook antwortet nicht"; p.className = "pill fehler"; });
    return null;
  }
}

// Pill nur neu aufbauen, wenn sich ihr Inhalt geändert hat (sonst gehen Klicks verloren)
function pillSetzen(p, sig, bau) {
  if (p.dataset.sig === sig) return;
  p.dataset.sig = sig;
  bau();
}

function zeigeKopfStatus(s) {
  const p = $("#ki-pill");
  const ki = s.ki || {};
  const kiSig = [s.modell, s.sparmodus, ki.status, ki.modell, ki.fehler].join("|");
  pillSetzen(p, kiSig, () => {
    if (!s.modell) { p.textContent = "KI: keine"; p.className = "pill"; p.title = "Keine KI eingerichtet"; }
    // Bei schmalem Fenster steht nur die Kurzform (CSS), damit die Kopfzeile in eine Zeile passt
    else if (s.sparmodus) { p.replaceChildren(sym("zap"), el("span", { class: "lang" }, "Sparmodus (KI aus)"), el("span", { class: "kurz" }, "KI aus")); p.className = "pill warn"; p.title = "Sparmodus: Klicken, um die KI einzuschalten"; }
    else if (ki.status === "bereit") { p.textContent = "KI bereit"; p.className = "pill ok"; p.title = ki.modell + " – klicken für Sparmodus"; }
    else if (ki.status === "laedt") { p.textContent = "KI lädt …"; p.className = "pill warn"; p.title = ki.modell; }
    else if (ki.status === "fehler") { p.textContent = "KI-Fehler"; p.className = "pill fehler"; p.title = ki.fehler; }
    else { p.textContent = "KI aus"; p.className = "pill"; }
  });

  // Laufende Downloads: kleiner Hinweis in der Kopfzeile, Klick führt zu "Inhalte"
  const dp = $("#download-pill");
  dp.hidden = !s.downloadAktiv || location.hash.startsWith("#inhalte");
  if (s.downloadAktiv) api("fortschritt").then(f => {
    if (f.gesamt > 0) { const t = Math.floor(f.bytes / f.gesamt * 100) + " %"; pillSetzen(dp, t, () => dp.replaceChildren(sym("download"), t)); }
  }).catch(() => { });

  // Akku: Prozent und Restzeit (die Restzeit fällt bei schmalem Fenster weg), gelb ab 30 %, rot ab 15 %
  const a = s.akku || {};
  const akkuWarn = a.vorhanden && !a.netz && a.prozent <= 30;
  $("#akku-box").hidden = !a.vorhanden;
  if (a.vorhanden) {
    const ap = $("#akku-pill");
    pillSetzen(ap, [a.netz, akkuWarn, a.prozent, a.restMinuten].join("|"), () => {
      ap.replaceChildren(sym(a.netz ? "plug" : akkuWarn ? "battery-low" : "battery"), a.prozent + " %",
        !a.netz && a.restMinuten > 0 ? el("span", { class: "lang" }, " · " + akkuZeit(a.restMinuten)) : "");
      ap.className = "pill" + (akkuWarn ? (a.prozent <= 15 ? " fehler" : " warn") : "");
    });
    if (!$("#akku-liste").hidden) fuelleAkkuMenue();
  }

  // Hinweis bei schwachem Akku
  const b = $("#banner");
  if (akkuWarn && s.modell && !s.sparmodus && sessionStorage.getItem("akkuHinweis") !== "weg") {
    // Nur neu bauen, wenn sich der Inhalt geändert hat
    const sig = "akku|" + a.prozent;
    if (b.dataset.sig !== sig || b.hidden) {
      b.dataset.sig = sig;
      b.hidden = false;
      b.innerHTML = "";
      b.append(
        sym("battery-low"), " Akku schwach (" + a.prozent + " %).", el("br"),
        "Antworten der KI brauchen viel Strom.", el("br"),
        "Der Sparmodus schaltet sie ab, damit der Akku länger hält.",
        el("button", { class: "knopf knopf-klein", onclick: () => schalteKi(false) }, "Sparmodus einschalten"),
        el("button", { class: "knopf knopf-klein", onclick: () => { sessionStorage.setItem("akkuHinweis", "weg"); b.hidden = true; } }, "Später"),
      );
    }
  } else if ((s.programmNeu || s.programmBereit) && sessionStorage.getItem("updateHinweis") !== "weg") {
    // Hinweis auf eine neue Fieldbook-Version
    const sig = "update|" + s.programmBereit + "|" + s.programmNeu;
    if (b.dataset.sig === sig && !b.hidden) return;
    b.dataset.sig = sig;
    b.hidden = false;
    b.innerHTML = "";
    b.append(
      sym("download"), s.programmBereit ? " Fieldbook " + s.programmBereit + " ist heruntergeladen und wird beim nächsten Start eingespielt."
                       : " Eine neue Fieldbook-Version ist verfügbar: " + s.programmNeu + ".",
      el("a", { class: "knopf knopf-klein", href: "#einstellungen" }, "Ansehen"),
      el("button", { class: "knopf knopf-klein", onclick: () => { sessionStorage.setItem("updateHinweis", "weg"); b.hidden = true; } }, "Später"),
    );
  } else { b.dataset.sig = ""; if (!b.dataset.fest) b.hidden = true; }
}

async function schalteKi(an) {
  try { OW.status = await api("ki", { an }); zeigeKopfStatus(OW.status); } catch (e) { alert(e.message); }
}

// Restzeit des Akkus: kurz für die Kopfzeile, lang für das Menü
function akkuZeit(min, lang) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!lang) return h ? h + " Std. " + m + " Min." : m + " Min.";
  const st = h === 1 ? "1 Stunde" : h + " Stunden", mi = m === 1 ? "1 Minute" : m + " Minuten";
  return h ? (m ? st + " " + mi : st) : mi;
}

// Akku-Menü: Restzeit ausgeschrieben, Spartipps, Sparmodus
function fuelleAkkuMenue() {
  const s = OW.status || {}, a = s.akku || {};
  const text = (...t) => el("div", { class: "akku-text" }, ...t);
  const teile = [el("div", { class: "menue-titel" }, a.netz ? "Am Stromnetz" : "Akku " + a.prozent + " %")];
  if (a.netz) teile.push(text("Der Akku ist zu " + a.prozent + " % geladen."));
  else {
    teile.push(text(a.restMinuten > 0 ? "Reicht noch etwa " + akkuZeit(a.restMinuten, true) + "."
      : "Windows schätzt die Restzeit erst nach ein paar Minuten auf Akku."));
    teile.push(el("div", { class: "menue-titel" }, "So hält der Akku länger"),
      text("Energiesparmodus von Windows einschalten.", el("br"), el("small", {}, "Zu finden über das Akku-Symbol unten rechts in der Taskleiste.")),
      text("Bildschirm dunkler stellen."),
      text("Fragen an die KI brauchen am meisten Strom.", el("br"), "Lesen, Karten und Kochen brauchen wenig."));
  }
  if (s.modell) {
    const zu = () => { $("#akku-liste").hidden = true; $("#akku-pill").setAttribute("aria-expanded", "false"); };
    teile.push(el("hr"), s.sparmodus
      ? el("button", { onclick: () => { zu(); schalteKi(true); } }, sym("zap"), "KI einschalten")
      : el("button", { onclick: () => { zu(); schalteKi(false); } }, sym("zap"), "KI ausschalten (Sparmodus)"));
  }
  $("#akku-liste").replaceChildren(...teile);
}

// Kopfmenüs: nur eines zugleich offen
const MENUES = [];
function andereMenuesZu(liste) { MENUES.forEach(m => { if (m.liste !== liste) m.zu(); }); }

(function () {
  const knopf = $("#akku-pill"), liste = $("#akku-liste");
  const zu = (fokus) => { liste.hidden = true; knopf.setAttribute("aria-expanded", "false"); if (fokus === true) knopf.focus(); };
  MENUES.push({ liste, zu });
  knopf.addEventListener("click", () => {
    liste.hidden = !liste.hidden;
    if (!liste.hidden) andereMenuesZu(liste);
    knopf.setAttribute("aria-expanded", String(!liste.hidden));
    if (!liste.hidden) fuelleAkkuMenue();
  });
  document.addEventListener("click", (e) => { if (!liste.contains(e.target) && !knopf.contains(e.target)) zu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !liste.hidden) zu(true); });
})();

// KI-Menü in der Kopfzeile: KI wechseln, aus- und einschalten
(function () {
  const knopf = $("#ki-pill"), liste = $("#ki-liste");
  const zu = (fokus) => { liste.hidden = true; knopf.setAttribute("aria-expanded", "false"); if (fokus === true) knopf.focus(); };
  MENUES.push({ liste, zu });
  const eintrag = (text, onclick, klasse) => el("button", { class: klasse || null, onclick: () => { zu(); onclick(); } }, ...text);
  async function fuellen() {
    const s = OW.status || {};
    liste.replaceChildren(el("div", { class: "menue-titel" }, "KI wird geladen …"));
    const kat = await api("katalog").catch(() => ({ modelle: [] }));
    // Installierte KIs und die gerade ausgewählte (auch wenn sie noch heruntergeladen wird)
    const modelle = kat.modelle.filter(m => m.installiert || m.id === s.modell);
    const teile = [];
    if (modelle.length) teile.push(el("div", { class: "menue-titel" }, "KI wechseln"));
    for (const m of modelle) {
      const aktiv = m.id === s.modell;
      const text = [el("span", { class: "menue-haken" }, aktiv ? "✓" : ""), m.name + " · " + m.modell, !m.installiert ? el("small", {}, " wird geladen") : null];
      teile.push(aktiv || !m.installiert ? el("button", { disabled: true, class: aktiv ? "menue-aktiv" : null }, ...text)
        : eintrag(text, async () => {
          knopf.textContent = "KI wechselt …"; knopf.className = "pill warn"; knopf.dataset.sig = "";
          OW.status = await api("einstellungen", { modell: m.id }); zeigeKopfStatus(OW.status);
        }));
    }
    if (s.modell) teile.push(el("hr"), s.sparmodus
      ? eintrag([sym("zap"), "KI einschalten"], () => schalteKi(true))
      : eintrag([sym("zap"), "KI ausschalten (Sparmodus)"], () => schalteKi(false)));
    teile.push(eintrag([sym("download"), modelle.length ? "Weitere KIs laden" : "KI einrichten"], () => { location.hash = modelle.length ? "#inhalte" : "#setup?schritt=1"; }));
    liste.replaceChildren(...teile);
  }
  knopf.addEventListener("click", () => {
    if (!OW.status) return;
    liste.hidden = !liste.hidden;
    if (!liste.hidden) andereMenuesZu(liste);
    knopf.setAttribute("aria-expanded", String(!liste.hidden));
    if (!liste.hidden) fuellen();
  });
  document.addEventListener("click", (e) => { if (!liste.contains(e.target) && !knopf.contains(e.target)) zu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !liste.hidden) zu(true); });
})();

async function zeigeStart() {
  const s = OW.status || await aktualisiereStatus();
  const info = $("#start-info");
  if (!s) return;
  const teile = [];
  teile.push(s.wissen + (s.wissen === 1 ? " Wissenspaket" : " Wissenspakete"));
  teile.push(s.karten.length + (s.karten.length === 1 ? " Karte" : " Karten"));
  if (s.modell) teile.push(s.ki.modell || "KI eingerichtet");
  info.textContent = teile.join(" · ");
  $("#start-suche-feld").focus();
}

$("#start-suche").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#start-suche-feld").value.trim();
  if (!q) return;
  // Frage an die KI, Stichwort an die Bibliothekssuche
  location.hash = (istFrage(q) ? "#fragen?q=" : "#bibliothek?q=") + encodeURIComponent(q);
});

// Ausschalten-Menü in der Kopfzeile
(function () {
  const knopf = $("#aus-knopf"), liste = $("#aus-liste");
  const zu = (fokus) => { liste.hidden = true; knopf.setAttribute("aria-expanded", "false"); if (fokus === true) knopf.focus(); };
  MENUES.push({ liste, zu });
  knopf.addEventListener("click", (e) => {
    e.stopPropagation();
    liste.hidden = !liste.hidden;
    if (!liste.hidden) andereMenuesZu(liste);
    knopf.setAttribute("aria-expanded", String(!liste.hidden));
  });
  document.addEventListener("click", (e) => { if (!liste.contains(e.target)) zu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !liste.hidden) zu(true); });
  $("#menue-beenden").addEventListener("click", () => { zu(); programmBeenden(); });
})();

async function programmBeenden() {
  if (!confirm("Fieldbook beenden? Bibliothek, KI und Karten werden geschlossen.")) return;
  await api("beenden", {}).catch(() => { });
  // Keine Statusabfragen mehr, sonst Fehler jede Sekunde
  statusBeendet = true;
  clearInterval(statusTimer);
  clearInterval(schnellTimer);
  document.body.innerHTML = '<div style="padding:40px;text-align:center;font-family:Segoe UI,sans-serif"><h1>Fieldbook wurde beendet.</h1><p>Du kannst dieses Fenster schließen.</p></div>';
}

// Sieht die Eingabe wie eine Frage aus? Fragezeichen ist nicht nötig.
function istFrage(t) {
  t = t.trim().toLowerCase();
  if (t.endsWith("?")) return true;
  const woerter = t.split(/\s+/).filter(Boolean);
  if (/^(wie|was|wo|wann|warum|wieso|weshalb|welche[rsmn]?|wer|wen|wem|wohin|woher|wozu|womit|kann|darf|soll|muss|ist|sind|gibt|hilft|erkläre?|erklär|zeig|beschreib\w*|how|what|why|where|when|which|who|can|should|is|are|does|do|explain)\b/.test(t)) return true;
  return woerter.length >= 4;
}

window.addEventListener("hashchange", navigiere);

// Doppelte Tabs vermeiden: Öffnet Fieldbook beim Start einen neuen Tab, obwohl schon einer offen ist
// (z. B. weil der Browser seine alten Tabs wiederhergestellt hat), schließt sich der neue wieder.
// Nur ein frisch von Fieldbook geöffneter Tab (Startseite, ohne Verlauf) tut das, nie ein Tab, in dem man schon war.
(function doppelteTabs() {
  if (!("BroadcastChannel" in window)) return;
  const kanal = new BroadcastChannel("fieldbook-tabs");
  const ich = { t: performance.timeOrigin || Date.now() };
  // Frisch: gerade erst geöffnet (höchstens 15 s), noch auf der Startseite und ohne Verlauf
  const frisch = () => Date.now() - ich.t < 15000 && location.pathname === "/" && !location.hash && history.length === 1;
  kanal.onmessage = (e) => {
    const d = e.data || {};
    if (d.art === "hallo") kanal.postMessage({ art: "da", t: ich.t, frisch: frisch() });
    // Ein anderer Tab ist da (egal, ob er vor oder nach diesem geladen hat): der frische Tab geht,
    // sind beide frisch, der jüngere
    if (frisch() && !ich.weg && (!d.frisch || d.t < ich.t)) { ich.weg = true; window.close(); }
  };
  kanal.postMessage({ art: "hallo", t: ich.t, frisch: frisch() });
})();

(async function init() {
  const s = await aktualisiereStatus();
  await Land.laden();
  // Die Oberfläche ist Deutsch (Land.sprache() gilt nur für Inhalte)
  document.documentElement.lang = "de";
  if (s && !s.setupFertig && s.wissen === 0 && !s.modell && !location.hash) location.hash = "#setup";
  navigiere();
  // Bei verstecktem Tab nur jede 4. Runde fragen
  let runde = 0;
  statusTimer = setInterval(() => { if (document.hidden && ++runde % 4) return; aktualisiereStatus(); }, 5000);
  // Solange Fieldbook nicht antwortet, jede Sekunde nachfragen (ein neu gestartetes Fieldbook findet den Tab schneller)
  let schnellLaeuft = false;
  schnellTimer = setInterval(async () => {
    if (!OW.nichtErreichbar || schnellLaeuft) return;
    schnellLaeuft = true;
    try { await aktualisiereStatus(); } finally { schnellLaeuft = false; }
  }, 1000);
})();
