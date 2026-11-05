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
  kochen: { zeigen: () => Kochen.zeigen() },
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
  const ziel = Ansichten[name] ? name : "start";
  if (ziel !== "lesen") Bibliothek.anhalten();
  if (ziel !== "pdf") PdfLeser.verlassen();
  $$(".ansicht").forEach(a => a.classList.toggle("sichtbar", a.dataset.ansicht === ziel));
  // Paket-Startseiten und PDF-Bücher gehören zur Bibliothek
  const menue = ziel === "paketstart" || ziel === "pdf" ? "bibliothek" : ziel;
  $$("#hauptnav a").forEach(a => a.classList.toggle("aktiv", a.getAttribute("href") === "#" + menue));
  try { Ansichten[ziel].zeigen(params); } catch (e) { console.error(e); Statistik.fehler("Ansicht " + ziel + ": " + e.message); }
  Statistik.bereich(ziel);
  if (ziel !== "lesen" && ziel !== "pdf") window.scrollTo(0, 0);
}

async function aktualisiereStatus() {
  try {
    const s = await api("status");
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
    const p = $("#ki-pill");
    p.textContent = "Server nicht erreichbar";
    p.className = "pill fehler";
    return null;
  }
}

function zeigeKopfStatus(s) {
  const p = $("#ki-pill");
  const ki = s.ki || {};
  if (!s.modell) { p.textContent = "KI: keine"; p.className = "pill"; p.title = "Keine KI eingerichtet"; }
  // Bei schmalem Fenster steht nur die Kurzform (CSS), damit die Kopfzeile in eine Zeile passt
  else if (s.sparmodus) { p.replaceChildren(sym("zap"), el("span", { class: "lang" }, "Sparmodus (KI aus)"), el("span", { class: "kurz" }, "KI aus")); p.className = "pill warn"; p.title = "Sparmodus: Klicken, um die KI einzuschalten"; }
  else if (ki.status === "bereit") { p.textContent = "KI bereit"; p.className = "pill ok"; p.title = ki.modell + " – klicken für Sparmodus"; }
  else if (ki.status === "laedt") { p.textContent = "KI lädt …"; p.className = "pill warn"; p.title = ki.modell; }
  else if (ki.status === "fehler") { p.textContent = "KI-Fehler"; p.className = "pill fehler"; p.title = ki.fehler; }
  else { p.textContent = "KI aus"; p.className = "pill"; }

  // Laufende Downloads: kleiner Hinweis in der Kopfzeile, Klick führt zu "Inhalte"
  const dp = $("#download-pill");
  dp.hidden = !s.downloadAktiv || location.hash.startsWith("#inhalte");
  if (s.downloadAktiv) api("fortschritt").then(f => {
    if (f.gesamt > 0) dp.replaceChildren(sym("download"), Math.floor(f.bytes / f.gesamt * 100) + " %");
  }).catch(() => { });

  const a = s.akku || {};
  const ap = $("#akku-pill");
  if (a.vorhanden) {
    ap.hidden = false;
    ap.replaceChildren(sym(a.netz ? "plug" : a.prozent <= 20 ? "battery-low" : "battery"), a.prozent + " %");
    ap.title = a.netz ? "Am Stromnetz" : (a.restMinuten > 0 ? "Noch " + dauer(a.restMinuten * 60) : "Akkubetrieb");
    ap.className = "pill pill-still" + (!a.netz && a.prozent <= 20 ? " fehler" : "");
  } else ap.hidden = true;

  // Hinweis bei schwachem Akku
  const b = $("#banner");
  if (a.vorhanden && !a.netz && a.prozent <= 20 && s.modell && !s.sparmodus && sessionStorage.getItem("akkuHinweis") !== "weg") {
    b.hidden = false;
    b.innerHTML = "";
    b.append(
      sym("battery-low"), " Akku schwach (" + a.prozent + " %). Antworten der KI brauchen viel Strom. Der Sparmodus schaltet sie ab, damit der Akku länger hält.",
      el("button", { class: "knopf knopf-klein", onclick: () => schalteKi(false) }, "Sparmodus einschalten"),
      el("button", { class: "knopf knopf-klein", onclick: () => { sessionStorage.setItem("akkuHinweis", "weg"); b.hidden = true; } }, "Später"),
    );
  } else if ((s.programmNeu || s.programmBereit) && sessionStorage.getItem("updateHinweis") !== "weg") {
    // Hinweis auf eine neue Fieldbook-Version
    b.hidden = false;
    b.innerHTML = "";
    b.append(
      sym("download"), s.programmBereit ? " Fieldbook " + s.programmBereit + " ist heruntergeladen und wird beim nächsten Start eingespielt."
                       : " Eine neue Fieldbook-Version ist verfügbar: " + s.programmNeu + ".",
      el("a", { class: "knopf knopf-klein", href: "#einstellungen" }, "Ansehen"),
      el("button", { class: "knopf knopf-klein", onclick: () => { sessionStorage.setItem("updateHinweis", "weg"); b.hidden = true; } }, "Später"),
    );
  } else if (!b.dataset.fest) b.hidden = true;
}

async function schalteKi(an) {
  try { OW.status = await api("ki", { an }); zeigeKopfStatus(OW.status); } catch (e) { alert(e.message); }
}

// KI-Menü in der Kopfzeile: KI wechseln, aus- und einschalten
(function () {
  const knopf = $("#ki-pill"), liste = $("#ki-liste");
  const zu = () => { liste.hidden = true; knopf.setAttribute("aria-expanded", "false"); };
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
          knopf.textContent = "KI wechselt …"; knopf.className = "pill warn";
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
    knopf.setAttribute("aria-expanded", String(!liste.hidden));
    if (!liste.hidden) fuellen();
  });
  document.addEventListener("click", (e) => { if (!liste.contains(e.target) && !knopf.contains(e.target)) zu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") zu(); });
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
  const zu = () => { liste.hidden = true; knopf.setAttribute("aria-expanded", "false"); };
  knopf.addEventListener("click", (e) => {
    e.stopPropagation();
    liste.hidden = !liste.hidden;
    knopf.setAttribute("aria-expanded", String(!liste.hidden));
  });
  document.addEventListener("click", (e) => { if (!liste.contains(e.target)) zu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") zu(); });
  $("#menue-beenden").addEventListener("click", () => { zu(); programmBeenden(); });
})();

async function programmBeenden() {
  if (!confirm("Fieldbook beenden? Bibliothek, KI und Karten werden geschlossen.")) return;
  await api("beenden", {}).catch(() => { });
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
  document.documentElement.lang = Land.sprache();
  if (s && !s.setupFertig && s.wissen === 0 && !s.modell && !location.hash) location.hash = "#setup";
  navigiere();
  setInterval(aktualisiereStatus, 5000);
})();
