// Hauptsteuerung: Ansichten wechseln, Status anzeigen.
"use strict";

const Ansichten = {
  start: { zeigen: zeigeStart },
  fragen: { zeigen: (p) => Fragen.zeigen(p) },
  bibliothek: { zeigen: (p) => Bibliothek.zeigen(p) },
  lesen: { zeigen: (p) => Bibliothek.lesen(p) },
  kochen: { zeigen: () => Kochen.zeigen() },
  karten: { zeigen: () => Karten.zeigen() },
  erstehilfe: { zeigen: (p) => ErsteHilfe.zeigen(p) },
  vorsorge: { zeigen: (p) => Vorsorge.zeigen(p) },
  // Alte Adresse des Notfall-Bereichs
  notfall: { zeigen: (p) => location.replace("#erstehilfe" + (String(p) ? "?" + p : "")) },
  setup: { zeigen: (p) => Setup.zeigen(p) },
  einstellungen: { zeigen: () => Einstellungen.zeigen() },
  inhalte: { zeigen: () => Inhalte.zeigen() },
};

function navigiere() {
  const roh = location.hash.slice(1) || "start";
  const [name, query] = roh.split("?");
  const params = new URLSearchParams(query || "");
  const ziel = Ansichten[name] ? name : "start";
  if (ziel !== "lesen") Bibliothek.anhalten();
  $$(".ansicht").forEach(a => a.classList.toggle("sichtbar", a.dataset.ansicht === ziel));
  $$("#hauptnav a").forEach(a => a.classList.toggle("aktiv", a.getAttribute("href") === "#" + ziel));
  try { Ansichten[ziel].zeigen(params); } catch (e) { console.error(e); }
  if (ziel !== "lesen") window.scrollTo(0, 0);
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

$("#ki-pill").addEventListener("click", () => {
  const s = OW.status;
  if (!s) return;
  if (!s.modell) { location.hash = "#setup"; return; }
  schalteKi(!!s.sparmodus);
});

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
    const s = OW.status || {};
    $("#menue-sparmodus").hidden = !s.modell || s.sparmodus;
  });
  document.addEventListener("click", (e) => { if (!liste.contains(e.target)) zu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") zu(); });
  $("#menue-sparmodus").addEventListener("click", () => { zu(); schalteKi(false); });
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

(async function init() {
  const s = await aktualisiereStatus();
  await Land.laden();
  document.documentElement.lang = Land.sprache();
  if (s && !s.setupFertig && s.wissen === 0 && !s.modell && !location.hash) location.hash = "#setup";
  navigiere();
  setInterval(aktualisiereStatus, 5000);
})();
