// Gemeinsame Hilfsfunktionen: Server-API, Kiwix (Bibliothek), KI.
"use strict";

const OW = {
  status: null,       // letzter /api/status
  buecher: null,      // Bücher aus Kiwix
  pakete: null,       // pakete.json (für Sprache, keineSuche)
};

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Kleines Hilfsmittel zum Bauen von Elementen: el("div", {class: "x"}, "Text", kind)
function el(tag, attrs, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kinder.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}

// Text aus den Konfigurationsdateien mit jedem Satz in eigener Zeile: el("p", {}, zeilen(text)).
// Abkürzungen wie „z. B.“ und Zahlen wie „6. November“ trennen nicht. {notruf} wird ersetzt.
const KEIN_SATZENDE = /(?:(?:^|[\s(„"])[a-zäöü]|\b(?:ca|bzw|evtl|ggf|usw|etc|inkl|nr|min|std|tel|bspw|vgl)|\d)\.$/i;
function zeilen(text) {
  const t = typeof Land !== "undefined" ? Land.einsetzen(text) : String(text);
  const teile = [];
  for (const s of t.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„"(])/)) {
    if (teile.length && KEIN_SATZENDE.test(teile[teile.length - 1])) teile[teile.length - 1] += " " + s;
    else teile.push(s);
  }
  return teile.flatMap((s, i) => i ? [el("br"), s] : [s]);
}

// Text für „Fieldbook läuft nicht mehr oder antwortet nicht“ (jeder Satz in eigener Zeile über zeilen())
const NICHT_ERREICHBAR = "Fieldbook antwortet gerade nicht. Läuft das schwarze Fieldbook-Fenster noch? Sonst Fieldbook neu starten.";

// Roter Fehlerkasten mit Knopf zum nochmal Versuchen: fehlerBox("Text", () => neuLaden()).
// nochmal fehlt: kein Knopf. knopfText: Beschriftung des Knopfs. technisch: nur als Tooltip (title), nicht im Text.
function fehlerBox(text, nochmal, knopfText, technisch) {
  const box = el("div", { class: "fehlerbox", role: "alert", title: technisch ? String(technisch) : null }, zeilen(text));
  if (nochmal) box.append(el("div", { style: "margin-top:8px" },
    el("button", { type: "button", class: "knopf knopf-klein", onclick: nochmal }, knopfText || "Erneut versuchen")));
  return box;
}

// Linien-Symbol aus symbole.svg (Lucide), färbt sich wie der Text: sym("map")
function sym(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "sym");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "symbole.svg#" + name);
  s.append(u);
  return s;
}
// Symbol im dezenten Farbfeld (Kacheln, Listen)
function symFeld(name, klasse) {
  return el("span", { class: "feld" + (klasse ? " " + klasse : ""), "aria-hidden": "true" }, sym(name));
}

// Kästchen mit „an“ bzw. „aus“ daneben (Einstellungen); der Text folgt dem Haken
function anAus(input) {
  const text = el("span", {}, input.checked ? "an" : "aus");
  input.addEventListener("change", () => { text.textContent = input.checked ? "an" : "aus"; });
  return el("label", { class: "schalter" }, input, text);
}

// Abschnitt, der beim Anklicken nach unten aufklappt (Inhalte und Einrichtung). „offen“ merkt sich die
// aufgeklappten Schlüssel, damit sie beim Neuzeichnen offen bleiben. Gibt { box, innen } zurück.
// einzeln: nur ein Abschnitt in der Liste offen, beim Aufklappen gehen die anderen zu (wie in der Bibliothek).
function klappAbschnitt(offen, schluessel, icon, titel, unter, rechts, einzeln) {
  const auf = offen.has(schluessel);
  const knopf = el("button", { type: "button", class: "eintrag klapp-kopf", "aria-expanded": String(auf) },
    symFeld(icon, "gross"),
    el("span", { class: "e-text" }, el("b", {}, titel), unter ? el("small", { class: "klapp-unter" }, unter) : null),
    rechts ? el("span", { class: "e-zahl" }, rechts) : null,
    el("span", { class: "klapp-pfeil", "aria-hidden": "true" }));
  const innen = el("div", { class: "klapp-abschnitt-innen" });
  const box = el("div", { class: "klapp klapp-kat klapp-abschnitt" + (auf ? " auf" : "") }, knopf,
    el("div", { class: "klapp-huelle" }, el("div", { class: "klapp-innen" }, innen)));
  const setzen = (jetzt) => {
    box.classList.toggle("auf", jetzt);
    knopf.setAttribute("aria-expanded", String(jetzt));
    if (jetzt) offen.add(schluessel); else offen.delete(schluessel);
  };
  box._setzen = setzen;
  knopf.addEventListener("click", () => {
    const jetzt = !box.classList.contains("auf");
    if (jetzt && einzeln && box.parentElement) {
      const vorher = knopf.getBoundingClientRect().top;
      for (const nachbar of box.parentElement.children) {
        if (nachbar !== box && nachbar.classList.contains("auf") && nachbar._setzen) nachbar._setzen(false);
      }
      nachOben(knopf, vorher);
    }
    setzen(jetzt);
  });
  return { box, innen };
}

// Scrollen beim Aufklappen, so wenig wie möglich (Nutzer, 10. Nov. 2026):
// 1. Passt der aufgeklappte Abschnitt dorthin, wo er nach dem Zuklappen der anderen von selbst steht: nicht scrollen.
// 2. Sonst nur so weit, dass auch der nächste Abschnitt (sein Kopf) noch zu sehen ist.
// 3. Reicht der Platz dafür nicht, steht der Kopf direkt unter der Kopfzeile.
// Entschieden wird nach dem Zustand, wenn Auf- und Zuklappen fertig sind (dazwischen passt es oft kurz nicht, das
// gab ein Zucken). Die Bewegung folgt dem Zuklappen der Abschnitte darüber, so läuft sie nur in eine Richtung.
// top: Lage der Zeile vor dem Klick.
function nachOben(knopf, top) {
  if (!knopf.isConnected) return;
  const kopf = document.querySelector(".kopf");
  const oben = (kopf ? kopf.getBoundingClientRect().bottom : 0) + 12;
  // Unten zählt die feste Leiste mit (z. B. „Auswahl herunterladen“ bzw. „Neu herunterzuladen“)
  const leiste = [...document.querySelectorAll(".summe")].find(x => x.offsetParent && getComputedStyle(x).position === "sticky");
  const unten = window.innerHeight - (leiste ? leiste.offsetHeight : 0) - 12;
  const box = knopf.parentElement;
  const huelle = box && box.querySelector(":scope > .klapp-huelle");
  const innen = huelle && huelle.querySelector(".klapp-innen");
  const hoehe = knopf.offsetHeight + (innen ? innen.scrollHeight : 0);
  // Abschnitte darüber, die gerade zuklappen: um so viel rutscht die Zeile von selbst nach oben
  const oberhalb = [];
  for (let s = box && box.previousElementSibling; s; s = s.previousElementSibling) {
    const h = s.querySelector(":scope > .klapp-huelle");
    if (h && h.offsetHeight > 0) oberhalb.push(h);
  }
  const rest = () => oberhalb.reduce((a, h) => a + h.offsetHeight, 0);
  const zu = rest();
  // Seite am Ende: die Zeile steht ohne Scrollen bei top - zu; höher scrollen als bis ganz oben bzw. ganz unten geht nicht
  const wachsen = (innen ? innen.scrollHeight : 0) - (huelle ? huelle.offsetHeight : 0);
  const docEnde = document.documentElement.scrollHeight - zu + wachsen;
  const zeileDoc = top + window.scrollY - zu;
  // Der nächste Abschnitt: Nachbar darunter, beim letzten der Liste der Abschnitt nach der übergeordneten Liste
  // (z. B. nach „Beschäftigung & Lesen“ der Bereich „Karten“). Platz bis zu seinem Kopf samt Abstand.
  let naechster = box && box.nextElementSibling;
  if (!naechster && box && box.parentElement) { const obenBox = box.parentElement.closest(".klapp"); naechster = obenBox && obenBox.nextElementSibling; }
  const naechsterKopf = naechster && (naechster.querySelector(":scope > .klapp-kopf") || null);
  const extra = naechsterKopf ? naechsterKopf.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom : 0;
  const vonSelbst = top - zu;   // Lage nach dem Zuklappen, ohne zu scrollen
  let ziel = vonSelbst >= oben && vonSelbst + hoehe <= unten ? vonSelbst
    : Math.max(oben, Math.min(vonSelbst, unten - hoehe - extra));
  ziel = Math.min(ziel, zeileDoc);                                              // scrollY ≥ 0
  ziel = Math.max(ziel, zeileDoc - Math.max(0, docEnde - window.innerHeight));  // scrollY ≤ Maximum
  // Bewegung reduzieren: sofort springen
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const d = knopf.getBoundingClientRect().top - ziel;
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
    return;
  }
  const start = performance.now(), dauer = 300;
  const schritt = () => {
    if (!knopf.isConnected) return;
    const t = Math.min(1, (performance.now() - start) / dauer);
    // Fortschritt: wie weit die Abschnitte darüber schon zu sind, sonst nach der Zeit
    let p = zu > 0 ? 1 - rest() / zu : 1 - Math.pow(1 - t, 3);
    if (t >= 1) p = 1;
    const soll = top + (ziel - top) * p;
    const diff = knopf.getBoundingClientRect().top - soll;
    if (Math.abs(diff) >= 1) window.scrollBy(0, diff);
    if (t < 1 || p < 1) requestAnimationFrame(schritt);
  };
  requestAnimationFrame(schritt);
}

// Schiebeschalter mit mehreren Stellungen (Vorauswahl im Assistenten: Nichts · Empfohlen · Alles · Eigene).
// stellungen: [{ id, text, unter, gesperrt }]; der grüne Knopf gleitet zur gewählten Stellung, danach onWahl(id).
// aktiv null: keine Stellung gewählt (Knopf unsichtbar).
function stufenSchalter(stellungen, aktiv, onWahl, label) {
  const i = stellungen.findIndex(s => s.id === aktiv);
  const box = el("div", { class: "stufen" + (i < 0 ? " leer" : ""), role: "radiogroup", "aria-label": label, style: "--n:" + stellungen.length + ";--i:" + Math.max(0, i) },
    el("span", { class: "stufen-knopf", "aria-hidden": "true" }));
  stellungen.forEach((s, j) => {
    const b = el("button", { type: "button", class: "stufen-seite" + (j === i ? " an" : ""), role: "radio", "aria-checked": String(j === i), tabindex: j === i || (i < 0 && j === 0) ? "0" : "-1", disabled: !!s.gesperrt },
      el("span", { class: "stufen-name" }, s.text), s.unter ? el("small", {}, s.unter) : null);
    b.addEventListener("keydown", (e) => {   // Pfeil links/rechts wechselt die Stellung
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      const alle = [...box.querySelectorAll(".stufen-seite")];
      for (let k = j + d; k >= 0 && k < alle.length; k += d) {
        if (alle[k].disabled) continue;
        e.preventDefault(); alle[k].focus(); alle[k].click(); break;
      }
    });
    b.addEventListener("click", () => {
      if (j === i) return;
      box.style.setProperty("--i", j);
      box.classList.remove("leer");
      box.querySelectorAll(".stufen-seite").forEach((x, k) => {
        x.classList.toggle("an", k === j);
        x.setAttribute("aria-checked", String(k === j));
        x.tabIndex = k === j ? 0 : -1;
      });
      setTimeout(() => onWahl(s.id), 220);   // Gleiten erst zeigen
    });
    box.append(b);
  });
  return box;
}

// Ein Paket mit Varianten (z. B. Wikipedia kompakt, ohne oder mit Bildern) als eine Zeile:
// Häkchen, Titel, Beschreibung der gewählten Variante und ein Schalter mit allen Varianten samt Größe.
// Es ist immer höchstens eine Variante gewählt; eine andere als die installierte ersetzt diese nach dem Download.
// o: { titel, varianten, gewaehlt (id|null), installiert (id|null), standard (id), tags, onWahl(id|null), gesperrt, hinweis, knoepfe }
function variantenZeile(o) {
  const an = !!o.gewaehlt;
  const p = o.varianten.find(v => v.id === (o.gewaehlt || o.installiert || o.standard)) || o.varianten[0];
  const input = el("input", { type: "checkbox", checked: an, disabled: !!o.gesperrt });
  input.addEventListener("change", () => o.onWahl(input.checked ? (o.installiert || o.standard || o.varianten[0].id) : null));
  const schalter = stufenSchalter(o.varianten.map(v => ({ id: v.id, text: v.variante || v.titel,
    unter: (v.id === o.installiert ? "✓ " : "") + groesse(v.bytes), gesperrt: v.gesperrt })), an ? o.gewaehlt : null, id => o.onWahl(id), o.titel);
  const installiertDa = an && o.installiert && o.gewaehlt === o.installiert;
  return el("div", { class: "wahl variante" + (installiertDa ? " installiert" : an ? " gewaehlt" : "") },
    installiertDa ? el("span", { class: "w-haken", "aria-hidden": "true" }, "✓") : input,
    el("div", { class: "w-text" }, el("div", { class: "w-titel" }, o.titel, ...(o.tags || [])),
      p.text ? el("small", {}, p.text) : null,
      el("div", { class: "variante-schalter" }, schalter),
      o.hinweis ? el("small", { class: "w-hinweis" }, ...[].concat(o.hinweis)) : null),
    o.knoepfe && o.knoepfe.length ? el("div", { class: "knopfreihe", style: "margin:0;align-items:center;flex-wrap:nowrap" }, ...o.knoepfe) : null);
}

// Zusammenfassung für einen zugeklappten Abschnitt: was installiert ist und was gerade ausgewählt ist.
// fehlen (optional): Namen, die noch nicht installiert sind. Ist alles da, steht nur „Alles installiert“,
// fehlen höchstens drei, steht „Es fehlt: …“ statt der langen Liste.
function klappZusammenfassung(namen, ausgewaehlt, fehlen) {
  const teile = [];
  if (!namen.length) teile.push("Noch nichts installiert");
  else if (fehlen && !fehlen.length) teile.push("Alles installiert");
  else if (fehlen && fehlen.length <= 3) teile.push("Es fehlt: " + fehlen.join(", "));
  else teile.push(namen.join(", "));
  if (ausgewaehlt) teile.push(ausgewaehlt + " zum Laden ausgewählt");
  return teile.join(" · ");
}

// Ungefähre Kartengröße aus config/karten.json, solange die genaue noch nicht berechnet ist
function kartenSchaetzung(r, sparen) {
  const mb = sparen && !r.maxzoom ? r.mbSparen : r.mb;
  return mb > 0 ? mb * 1e6 : 0;
}

// Zahl und Einheit mit geschütztem Leerzeichen ( ), damit „27 MB“ nie auf zwei Zeilen landet
function groesse(bytes) {
  if (bytes == null || bytes < 0 || isNaN(bytes)) return "?";
  if (bytes >= 1e9) return (bytes / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " GB";
  if (bytes >= 1e6) return Math.round(bytes / 1e6).toLocaleString("de-DE") + " MB";
  return Math.max(1, Math.round(bytes / 1e3)) + " KB";
}

// Download-Geschwindigkeit wie bei Internetanbietern: Megabit pro Sekunde
function mbit(bytesProSek) {
  const m = bytesProSek * 8 / 1e6;
  return m.toLocaleString("de-DE", { maximumFractionDigits: m < 10 ? 1 : 0 }) + " MBit/s";
}

function dauer(sek) {
  if (!isFinite(sek) || sek < 0) return "";
  if (sek < 60) return "unter 1 Min.";
  const m = Math.round(sek / 60);
  if (m < 60) return "ca. " + m + " Min.";
  const h = Math.floor(m / 60);
  return "ca. " + h + " Std. " + (m % 60) + " Min.";
}

async function api(pfad, daten) {
  const opt = daten === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(daten) };
  const r = await fetch("/api/" + pfad, opt);
  if (!r.ok) throw new Error("Server antwortet mit " + r.status);
  return r.json();
}

// KI auf Grafikkarte ("vulkan") oder Prozessor ("cpu") umstellen. Fehlt das Programm für die Grafikkarte,
// lädt Fieldbook es nach (bis dahin rechnet weiter der Prozessor). Danach startet die KI neu.
async function rechenwegSetzen(backend) {
  const s = OW.status || {};
  if (backend === "vulkan" && s.modell) await api("installieren", { modell: s.modell, backend }).catch(() => { });
  // Laufende Statusabfragen dürfen den neuen Stand nicht mit dem alten überschreiben
  if (typeof statusUngueltig === "function") statusUngueltig();
  OW.status = await api("einstellungen", { backend });
  if (typeof statusUngueltig === "function") statusUngueltig();
}

async function ladeKonfig(name) {
  const r = await fetch("/config/" + name + ".json");
  return r.json();
}

// ---------------------------------------------------------------- Land und Sprache
// Land: gespeicherte Auswahl, sonst Windows-Region, sonst Standard (DE).
// Sprache: nur "de" oder "en". Die Oberfläche ist vorerst nur auf Deutsch.

const Land = {
  konf: null,
  async laden() {
    if (!this.konf) {
      try { this.konf = await ladeKonfig("laender"); }
      catch { this.konf = { standard: "DE", sprachen: ["de"], laender: [{ code: "DE", aktiv: true, sprache: "de", notruf: "112", name: { de: "Deutschland" }, nummern: [{ nummer: "112", titel: { de: "Notruf" } }] }] }; }
    }
    return this.konf;
  },
  aktive() { return (this.konf ? this.konf.laender : []).filter(l => l.aktiv); },
  aktuell() {
    const s = OW.status || {}, a = this.aktive();
    return a.find(l => l.code === s.land) || a.find(l => l.code === s.landErkannt)
      || a.find(l => l.code === (this.konf && this.konf.standard)) || a[0];
  },
  sprache() {
    const s = (OW.status && OW.status.sprache) || (this.aktuell() || {}).sprache || "de";
    return ["de", "en"].includes(s) ? s : "de";
  },
  text(obj) { return obj ? (obj[this.sprache()] || obj.de || obj.en || "") : ""; },
  notruf() { return (this.aktuell() || {}).notruf || "112"; },
  // Giftnotruf des Landes (Eintrag in laender.json, dessen englischer Titel „poison“ enthält)
  giftnotruf() {
    const n = ((this.aktuell() || {}).nummern || []).find(x => /poison/i.test((x.titel || {}).en || ""));
    return n ? n.nummer : this.notruf();
  },
  // Ersetzt {notruf} und {giftnotruf} in Texten aus den Konfigurationsdateien
  einsetzen(t) { return String(t).replace(/\{notruf\}/g, this.notruf()).replace(/\{giftnotruf\}/g, this.giftnotruf()); },
};

// Sprache des Geräts für Ländernamen (nur Deutsch oder Englisch)
function geraeteSprache() {
  return /^de/i.test(navigator.language || "") ? "de" : "en";
}

function normText(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
}

// Suchbares Länderfeld: zeigt Namen in der Gerätesprache, findet Länder unter allen Namen und dem Kürzel
function landAuswahl(aktuell, onWahl) {
  const sp = geraeteSprache();
  const name = (l) => l.name[sp] || l.name.de || l.name.en || l.code;
  const feld = el("input", { type: "search", placeholder: sp === "de" ? "Land suchen …" : "Search country …", autocomplete: "off", value: aktuell ? name(aktuell) : "", "aria-label": "Land" });
  const liste = el("div", { class: "land-liste", hidden: true });
  const wrap = el("div", { class: "land-auswahl" }, feld, liste);
  const zeigen = () => {
    const q = normText(feld.value === (aktuell && name(aktuell)) ? "" : feld.value);
    const treffer = Land.aktive()
      .filter(l => !q || [l.code, ...Object.values(l.name)].some(n => normText(n).includes(q)))
      .sort((a, b) => name(a).localeCompare(name(b), sp));
    liste.innerHTML = "";
    for (const l of treffer.slice(0, 30)) {
      liste.append(el("button", { type: "button", onmousedown: (e) => e.preventDefault(), onclick: () => {
        aktuell = l; feld.value = name(l); liste.hidden = true; onWahl(l);
      } }, name(l), " ", el("small", {}, l.code)));
    }
    if (!treffer.length) liste.append(el("div", { class: "leer" }, sp === "de" ? "Kein Land gefunden" : "No country found"));
    liste.hidden = false;
  };
  let getippt = false;
  feld.addEventListener("focus", () => { getippt = false; feld.select(); zeigen(); });
  feld.addEventListener("input", () => { getippt = true; zeigen(); });
  feld.addEventListener("blur", () => { liste.hidden = true; if (aktuell) feld.value = name(aktuell); });
  feld.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Nur wirksam, wenn getippt wurde und genau ein Treffer übrig ist
      const bs = liste.querySelectorAll("button");
      if (getippt && bs.length === 1) bs[0].click();
      feld.blur();
    }
    if (e.key === "Escape") feld.blur();
  });
  return wrap;
}

// Einstellungen der automatischen Aktualisierung speichern (legt die Windows-Aufgaben an oder entfernt sie)
async function aktualisierungSpeichern(akt, neu, sofort) {
  Object.assign(akt, neu);
  const r = await api("aktualisierung", { an: akt.an, modus: akt.modus, wann: akt.wann, mbit: akt.mbit || 0, programm: akt.programm !== false, sofort });
  if (r.fehler) alert("Die Windows-Aufgabenplanung hat das nicht angenommen: " + r.fehler);
  Object.assign(akt, r);
}

// Einstellungen für die automatische Aktualisierung der Inhalte (Assistent und Einstellungen)
// sofort=true: Windows-Aufgaben direkt anlegen/entfernen, sonst erst beim Herunterladen im Assistenten.
// opt.eingebettet: ohne eigenen Kasten und Überschrift, ohne den Schalter für Fieldbook-Versionen
// (außer mit opt.programm); opt.kurz: nur der Haken mit kurzer Erklärung (erster Schritt im Assistenten,
// genauer einstellen kann man es später in den Einstellungen); opt.geaendert: nach jeder Änderung.
function aktualisierungBox(akt, sofort, opt) {
  opt = opt || {};
  const box = opt.eingebettet || opt.kurz ? el("div") : el("div", { class: "karte-box", style: "margin-top:16px" });
  const zeichne = () => {
    box.innerHTML = "";
    const setze = async (neu) => {
      await aktualisierungSpeichern(akt, neu, sofort);
      zeichne();
      if (opt.geaendert) opt.geaendert();
    };
    if (opt.kurz) {
      box.append(el("div", { class: "einst-zeile", style: "border:0;padding-bottom:0" },
        el("div", {}, el("b", {}, "Inhalte automatisch aktuell halten"),
          el("small", {}, "Empfohlen, denn Wikipedia, Medizin-Wissen und Karten werden laufend verbessert.", el("br"),
            "Windows prüft einmal pro Woche kurz nach Neuem, über Handy-Hotspots wird nie ohne Nachfrage geladen.", el("br"),
            "Genauer einstellen kannst du das später in den Einstellungen.")),
        anAus(el("input", { type: "checkbox", checked: akt.an, onchange: (e) => setze({ an: e.target.checked }) }))));
      return;
    }
    if (!opt.eingebettet) box.append(el("h2", { style: "margin-top:0" }, "Automatische Aktualisierung"));
    box.append(
      el("label", { class: "schalter" },
        el("input", { type: "checkbox", checked: akt.an, onchange: (e) => setze({ an: e.target.checked }) }),
        el("b", {}, "Inhalte automatisch aktuell halten")),
      el("p", { class: akt.an ? "hinweis klein" : "warnung klein", style: "margin:10px 0" },
        "Empfohlen: Wikipedia, Medizin-Wissen, Karten und Wegedaten werden laufend verbessert und korrigiert. " +
        "Damit im Ernstfall aktuelle Informationen da sind, solltest du das einschalten. " +
        "Es läuft kein Programm dauerhaft im Hintergrund: Windows prüft einmal pro Woche kurz nach neuen Inhalten " +
        "und lädt sie mit niedrigster Priorität, damit du normal weiterarbeiten kannst. Über Handy-Hotspots wird nie ohne Nachfrage geladen."));
    if (akt.an) {
      const wahl = (name, feld, wert, titel, text) => {
        const i = el("input", { type: "radio", name, checked: akt[feld] === wert, onchange: () => setze({ [feld]: wert }) });
        return el("label", { class: "wahl" + (akt[feld] === wert ? " gewaehlt" : "") }, i,
          el("div", { class: "w-text" }, el("div", { class: "w-titel" }, titel), el("small", {}, text)));
      };
      if (!opt.eingebettet || opt.programm) box.append(
        el("label", { class: "schalter", style: "margin:4px 0 6px" },
          el("input", { type: "checkbox", checked: akt.programm !== false, onchange: (e) => setze({ programm: e.target.checked }) }),
          el("span", {}, "Dabei auch neue Fieldbook-Versionen mitladen")));
      box.append(
        el("h3", {}, "Wenn es Neues gibt"),
        wahl("akt-modus", "modus", "fragen", "Vorher fragen", "Ein Fenster zeigt, was es Neues gibt, und fragt, ob es geladen werden soll."),
        wahl("akt-modus", "modus", "auto", "Automatisch herunterladen", "Ohne Nachfrage, aber nie über getaktete Verbindungen wie Handy-Hotspots."),
        el("h3", {}, "Wann herunterladen"),
        wahl("akt-wann", "wann", "sofort", "Sofort, im Hintergrund", "Startet direkt mit niedrigster Priorität. Unterbrochene Downloads gehen beim nächsten Einschalten weiter."),
        wahl("akt-wann", "wann", "leerlauf", "Nur wenn der Computer nicht benutzt wird", "Lädt erst, wenn der Computer etwa 10 Minuten unbenutzt am Strom hängt, und pausiert sofort, sobald du ihn benutzt."));
    }
    // Drosselung: auch für "Inhalte aktualisieren" in den Einstellungen
    if (akt.an || sofort) {
      const stufen = [0, 50, 20, 10, 5, 2];
      const sel = el("select", { style: "width:auto", onchange: (e) => setze({ mbit: +e.target.value }) },
        ...stufen.map(m => el("option", { value: m, selected: (akt.mbit || 0) === m }, m ? "höchstens " + m + " MBit/s" : "Unbegrenzt (volle Geschwindigkeit)")));
      box.append(el("h3", {}, "Download-Geschwindigkeit"),
        el("div", { class: "einst-zeile", style: "border:0;padding-top:0" },
          el("div", {}, el("small", {}, "Begrenzt Aktualisierungen, damit Internet für andere im Haushalt flüssig bleibt (z. B. Videos, Telefonate). Gilt auch für „Inhalte aktualisieren“.")),
          sel));
    }
  };
  zeichne();
  return box;
}

// Einfaches Dialogfenster mit eigenen Knöpfen. Gibt den Wert des gedrückten Knopfs zurück.
// knoepfe: [{ text, wert, haupt }]
let dialogZaehler = 0;
function dialog(titel, inhalt, knoepfe) {
  return new Promise((fertig) => {
    const hinter = el("div", { class: "dialog-hinter" });
    const titelId = "dialog-titel-" + (++dialogZaehler);
    const vorherFokus = document.activeElement;
    const schliessen = (wert) => {
      document.removeEventListener("keydown", taste, true); hinter.remove(); fertig(wert);
      if (vorherFokus && vorherFokus.isConnected && vorherFokus.focus) vorherFokus.focus();   // Fokus zurück
    };
    // Escape wirkt wie ein Klick auf den Hintergrund; nur beim obersten Dialog
    const taste = (e) => {
      const alle = document.querySelectorAll(".dialog-hinter");
      if (alle[alle.length - 1] !== hinter) return;
      if (e.key === "Tab") {   // Fokusfalle: Tab bleibt im Dialog
        const f = [...box.querySelectorAll("a[href],button,input,select,textarea,[tabindex]")]
          .filter(x => !x.disabled && x.tabIndex >= 0 && !x.closest("[hidden]"));
        if (!f.length) { e.preventDefault(); return; }
        const erst = f[0], letzt = f[f.length - 1];
        if (!box.contains(document.activeElement)) { e.preventDefault(); erst.focus(); }
        else if (e.shiftKey && document.activeElement === erst) { e.preventDefault(); letzt.focus(); }
        else if (!e.shiftKey && document.activeElement === letzt) { e.preventDefault(); erst.focus(); }
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      schliessen(null);
    };
    const box = el("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": titelId },
      el("h2", { id: titelId }, titel), typeof inhalt === "string" ? el("p", {}, zeilen(inhalt)) : inhalt,
      el("div", { class: "knopfreihe", style: "justify-content:flex-end" },
        ...knoepfe.map(k => el("button", { class: "knopf" + (k.haupt ? " knopf-haupt" : ""), onclick: () => schliessen(k.wert) }, k.text))));
    hinter.append(box);
    hinter.addEventListener("click", (e) => { if (e.target === hinter) schliessen(null); });
    document.addEventListener("keydown", taste, true);
    document.body.append(hinter);
    box.querySelector(".knopf-haupt, .knopf").focus();
  });
}

// Verbindungstest: prüft alle Adressen, die Fieldbook zum Herunterladen braucht, und zeigt das Ergebnis
async function verbindungPruefen(knopf) {
  const vorher = knopf ? [...knopf.childNodes] : [];
  if (knopf) { knopf.disabled = true; knopf.textContent = "Wird geprüft …"; }
  let t;
  try { t = await api("verbindungstest"); }
  catch (e) { t = { ok: false, ergebnisse: [], fehler: e.message }; }
  finally { if (knopf) { knopf.disabled = false; knopf.replaceChildren(...vorher); } }
  const liste = el("div", { class: "verbindung-liste" },
    ...t.ergebnisse.map(r => el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, (r.ok ? "✓ " : "✗ ") + r.name), el("small", {}, r.ok ? r.adresse : r.meldung)),
      el("span", { class: r.ok ? "ok-text" : "fehler-text" }, r.ok ? "erreichbar" : "gesperrt"))));
  const kopf = t.fehler ? "Der Test konnte nicht laufen: " + t.fehler
    : t.ok ? "Alle Adressen sind erreichbar." + (t.proxy ? " Verbunden über den Proxy " + t.proxy + "." : "")
    : "Nicht alles ist erreichbar. Bei einem Werbeblocker, einer Firewall oder einem Jugendschutzfilter die gesperrten Adressen freigeben. In Firmen- und Schulnetzen hilft oft ein Proxy (Einstellungen → Erweitert).";
  await dialog("Verbindungstest", el("div", {}, el("p", {}, kopf), liste), [{ text: "OK", wert: 1, haupt: true }]);
  return t;
}

// "Inhalte aktualisieren": suchen, bei getakteter Verbindung warnen, dann herunterladen.
// opt.programmNeu: gerade gefundene neue Fieldbook-Version (Einstellungen suchen beides zugleich)
async function jetztAktualisieren(knopf, opt) {
  opt = opt || {};
  const text = knopf.textContent;
  knopf.disabled = true;
  knopf.textContent = "Suche nach neuen Inhalten …";
  try {
    const a = await api("aktualisierung/pruefen", {});
    if (a.fehler) { await dialog("Keine Verbindung", "Die Suche nach neuen Inhalten hat nicht geklappt. Bitte die Internetverbindung prüfen.", [{ text: "OK", wert: 1, haupt: true }]); return null; }
    if (!a.anzahl && opt.programmNeu) {
      await dialog("Neue Fieldbook-Version", el("p", {}, "Fieldbook " + opt.programmNeu + " ist verfügbar.", el("br"),
        "Einspielen kannst du sie mit dem Knopf „Auf Version " + opt.programmNeu + " aktualisieren“.", el("br"),
        "Die Inhalte sind auf dem neuesten Stand."), [{ text: "OK", wert: 1, haupt: true }]);
      return a;
    }
    if (!a.anzahl) { await dialog("Alles aktuell", el("p", {}, "Es gibt nichts Neues.", el("br"), "Alles ist auf dem neuesten Stand."), [{ text: "OK", wert: 1, haupt: true }]); return a; }
    knopf.textContent = "Prüfe Verbindung …";
    const v = await api("verbindung").catch(() => ({ getaktet: false }));
    const liste = el("div", {},
      el("p", {}, "Neue Daten gefunden (ca. " + groesse(a.bytes) + "):"),
      el("ul", {}, ...a.titel.map(t => el("li", {}, t))));
    if (v.getaktet) {
      liste.append(el("p", { class: "warnung" },
        "Achtung: Du bist mit einer getakteten Verbindung verbunden" + (v.name ? " („" + v.name + "“)" : "") +
        ", zum Beispiel einem Handy-Hotspot. Das Herunterladen von " + groesse(a.bytes) + " kann dein Datenvolumen verbrauchen und Kosten verursachen."));
    }
    const ok = await dialog(v.getaktet ? "Getaktete Verbindung" : "Inhalte aktualisieren?", liste,
      v.getaktet ? [{ text: "Abbrechen", wert: false }, { text: "Trotzdem laden", wert: true, haupt: true }]
                 : [{ text: "Abbrechen", wert: false }, { text: "Herunterladen", wert: true, haupt: true }]);
    if (!ok) return a;
    const r = await api("aktualisierung/laden", {});
    if (r.fehler) await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]);
    else location.hash = "#inhalte";
    return a;
  } finally {
    knopf.disabled = false;
    knopf.textContent = text;
  }
}

// Neustart nach Programm-Update: warten, bis die neue Version antwortet, dann die Einstellungen
// neu laden (dort steht die neue Versionsnummer)
function neustartAnzeigen(neu) {
  const info = el("p", { class: "hinweis" }, "Fieldbook wird beendet und gleich wieder gestartet. Das dauert etwa 10 bis 30 Sekunden.");
  const hinter = el("div", { class: "dialog-hinter" },
    el("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "neustart-titel" }, el("h2", { id: "neustart-titel" }, "Fieldbook wird aktualisiert …"), info,
      el("div", { class: "balken" }, el("div", { style: "width:100%;animation:none;opacity:.6" }))));
  if (document.querySelector(".dialog-hinter[data-neustart]")) return; // Anzeige läuft schon
  hinter.dataset.neustart = "1";
  document.body.append(hinter);
  const start = Date.now();
  const alt = OW.status && OW.status.version;
  let warAus = false;
  const neuLaden = () => { history.replaceState(null, "", location.pathname + "#einstellungen"); location.reload(); };
  const pruefe = async () => {
    try {
      const s = await fetch("/api/status", { cache: "no-store" }).then(r => r.json());
      // Neue Version da, Fieldbook war kurz weg, oder nach spätestens einer Minute wieder erreichbar
      if ((neu && s.version === neu) || (alt && s.version !== alt) || warAus || Date.now() - start > 60000) { neuLaden(); return; }
    } catch { warAus = true; }
    if (Date.now() - start > 120000) {
      info.textContent = "Das dauert länger als erwartet. Falls sich nichts tut: Fieldbook über die Datei „Fieldbook“ im Programmordner neu öffnen.";
    }
    setTimeout(pruefe, 1500);
  };
  setTimeout(pruefe, 3000);
}

// Konfiguration in der passenden Sprache laden (z. B. notfall.en.json), sonst Deutsch
async function ladeKonfigSprache(name) {
  if (Land.sprache() !== "de") {
    try { return await ladeKonfig(name + "." + Land.sprache()); } catch { }
  }
  return ladeKonfig(name);
}

// ---------------------------------------------------------------- Kiwix

const Kiwix = {
  // Liste aller installierten Bücher aus dem Kiwix-Katalog.
  // Nur eine leere Liste, wenn wirklich nichts installiert ist; ist Fieldbook nicht erreichbar, gibt es einen Fehler (Exception).
  _laeuft: null,   // laufende Katalog-Anfrage, wird geteilt
  async buecher(neu) {
    if (OW.buecher && OW.buecher.length && !neu) return OW.buecher;
    if (!OW.status) throw new Error("Kein Status von Fieldbook");
    if (!Kiwix._laeuft) {
      const p = Kiwix._ladeBuecher();
      Kiwix._laeuft = p;
      const frei = () => { if (Kiwix._laeuft === p) Kiwix._laeuft = null; };
      p.then(frei, frei);   // bei Fehler verwerfen, der Aufrufer bekommt ihn trotzdem
    }
    return Kiwix._laeuft;
  },

  async _ladeBuecher() {
    if (!OW.status.bibliothek) return [];
    if (!OW.pakete) {
      try { const pk = await ladeKonfig("pakete"); OW.pakete = pk.pakete || []; OW.kategorien = pk.kategorien || []; }
      catch { OW.pakete = []; OW.kategorien = []; }
    }
    const r = await fetch("/kiwix/catalog/v2/entries?count=-1");
    if (!r.ok) throw new Error("Bibliothek antwortet nicht (" + r.status + ")");
    const xml = new DOMParser().parseFromString(await r.text(), "application/xml");
    const liste = [];
    for (const e of xml.querySelectorAll("entry")) {
      const t = (sel) => (e.querySelector(sel) || {}).textContent || "";
      const html = Array.from(e.querySelectorAll("link")).find(l => (l.getAttribute("type") || "").startsWith("text/html"));
      const bild = Array.from(e.querySelectorAll("link")).find(l => (l.getAttribute("rel") || "").includes("thumbnail"));
      if (!html) continue;
      const href = html.getAttribute("href");                  // /kiwix/content/<id>
      const id = decodeURIComponent(href.split("/content/")[1] || "").replace(/\/$/, "");
      const name = t("name");
      // Name und Variante vergleichen (z. B. Wikipedia mini / nopic / maxi haben denselben Namen)
      const flavour = t("flavour");
      const paket = OW.pakete.find(p => p.name === name && (p.flavour || "") === flavour) || OW.pakete.find(p => p.name === name) || {};
      const sprache = t("language");
      liste.push({
        // Deutsche Titel und Beschreibungen aus pakete.json, sonst die (oft englischen) aus dem Kiwix-Katalog
        id, name, titel: paket.titel ? paket.titel.replace(/\s*\(Englisch\)$/, "") : t("title"), text: paket.text || t("summary"), sprache,
        englisch: /eng/.test(sprache) && !/deu/.test(sprache),
        volltext: /_ftindex:yes/.test(t("tags")),
        durchsuchen: !paket.keineSuche,
        // PDF-Pakete ("pdf" in pakete.json, selbst hinzugefügte erst nach dem Auslesen): kein Zufall,
        // gesucht wird im ausgelesenen Text der Bücher
        pdf: !!paket.pdf || !!(OW.status && OW.status.pdfTexte && id in OW.status.pdfTexte),
        // Selbst hinzugefügte Pakete ohne Eintrag in pakete.json landen unter "Weitere Pakete"
        kategorien: paket.kategorien && paket.kategorien.length ? paket.kategorien : ["sonstiges"],
        bild: bild ? bild.getAttribute("href") : null,
        start: "/kiwix/viewer#" + id,
        // Eigene Fieldbook-Startseite (Kacheln, iFixit-Übersicht), siehe "startseite" in pakete.json
        startseite: paket.startseite || null,
      });
    }
    // Reihenfolge wie in pakete.json (wie in Inhalte und Assistent), selbst hinzugefügte nach dem Alphabet dahinter
    const rang = (b) => { const i = OW.pakete.findIndex(p => p.name === b.name); return i < 0 ? 1e6 : i; };
    liste.sort((a, b) => rang(a) - rang(b) || a.titel.localeCompare(b.titel));
    return (OW.buecher = liste);
  },

  // Frist für Kiwix-Abrufe: ohne eigenes signal 15 s; mit signal gilt, was zuerst kommt
  _frist(signal) {
    const MS = 15000;
    let frist;
    if (typeof AbortSignal.timeout === "function") frist = AbortSignal.timeout(MS);
    else { const c = new AbortController(); setTimeout(() => c.abort(), MS); frist = c.signal; }
    if (!signal) return frist;
    if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, frist]);
    const c = new AbortController();
    const ab = () => c.abort();
    for (const s of [signal, frist]) { if (s.aborted) c.abort(); else s.addEventListener("abort", ab, { once: true }); }
    return c.signal;
  },
  // Welche Parameter-Variante die laufende kiwix-serve-Version annimmt (nach dem ersten Erfolg gemerkt)
  _variante: { suggest: 0, search: 0 },
  async _mitVariante(art, urls, signal) {
    const reihe = Kiwix._variante[art] ? [1, 0] : [0, 1];
    let r = null;
    for (const i of reihe) {
      r = await fetch(urls[i], { signal });
      if (r.ok) { Kiwix._variante[art] = i; return r; }
    }
    return r;
  },

  // Titelvorschläge (schnell, für exakte Artikelnamen); signal optional, sonst Frist 15 s
  async vorschlaege(buch, begriff, anzahl, signal) {
    if (OW.status && OW.status.pdfTexte && buch.id in OW.status.pdfTexte) return [];   // PDF-Bücher: siehe suche()
    const q = "term=" + encodeURIComponent(begriff) + "&count=" + (anzahl || 5);
    signal = Kiwix._frist(signal);
    // Variante 0 = content, 1 = books.name
    const r = await Kiwix._mitVariante("suggest", [
      "/kiwix/suggest?content=" + encodeURIComponent(buch.id) + "&" + q,
      "/kiwix/suggest?books.name=" + encodeURIComponent(buch.id) + "&" + q], signal);
    if (!r.ok) return [];
    let daten;
    try { daten = await r.json(); } catch (e) { if (signal.aborted) throw e; return []; }
    return daten.filter(d => d.path && d.kind !== "pattern").map(d => ({
      // Kiwix liefert Titel teils mit HTML-Zeichen („&apos;“), die hier zu echten Zeichen werden
      titel: new DOMParser().parseFromString((d.value || d.label || "").replace(/<[^>]+>/g, ""), "text/html").documentElement.textContent,
      url: "/kiwix/content/" + encodeURIComponent(buch.id) + "/" + d.path.replace(/^\//, "").replace(/[?#]|%(?![0-9a-fA-F]{2})/g, c => encodeURIComponent(c)),
      buch,
    }));
  },

  // Volltextsuche. Pakete ohne Volltext-Index (z. B. iFixit) durchsucht Kiwix trotzdem über die Titel
  async suche(buch, begriff, anzahl, signal) {
    signal = Kiwix._frist(signal);
    // PDF-Bücher (z. B. Medizin-Handbücher): Kiwix findet darin nichts, gesucht wird im ausgelesenen Text
    const pdf = OW.status && OW.status.pdfTexte;
    if (pdf && buch.id in pdf) {
      const r = await fetch("/api/pdftext/suche?buch=" + encodeURIComponent(buch.id) + "&q=" + encodeURIComponent(begriff) + "&n=" + (anzahl || 5), { signal });
      if (!r.ok) return [];
      return (await r.json()).map(t => Object.assign(t, { buch }));
    }
    const q = "pattern=" + encodeURIComponent(begriff) + "&format=xml&pageLength=" + (anzahl || 5);
    // Variante 0 = books.name, 1 = content
    const r = await Kiwix._mitVariante("search", [
      "/kiwix/search?books.name=" + encodeURIComponent(buch.id) + "&" + q,
      "/kiwix/search?content=" + encodeURIComponent(buch.id) + "&" + q], signal);
    if (!r.ok) return [];
    const xml = new DOMParser().parseFromString(await r.text(), "application/xml");
    return Array.from(xml.querySelectorAll("item")).map(i => ({
      titel: (i.querySelector("title") || {}).textContent || "",
      url: (i.querySelector("link") || {}).textContent || "",
      auszug: ((i.querySelector("description") || {}).textContent || "").replace(/<[^>]+>/g, ""),
      buch,
    })).filter(t => t.url);
  },

  // Artikel laden und als reinen Text in Abschnitten zurückgeben
  async artikelText(url, tiefe, signal) {
    signal = Kiwix._frist(signal);
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error("Artikel nicht gefunden");
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    // Weiterleitungsseiten (meta refresh) verfolgen, z. B. "Schnittwunde" -> "Wunde#Wundarten"
    const refresh = doc.querySelector('meta[http-equiv="refresh" i]');
    if (refresh && (tiefe || 0) < 3) {
      const m = (refresh.getAttribute("content") || "").match(/url\s*=\s*'?([^']+)'?/i);
      if (m) {
        const ziel = new URL(m[1], location.origin + url);
        const anker = decodeURIComponent(ziel.hash.slice(1)).replace(/_/g, " ");
        const erg = await Kiwix.artikelText(ziel.pathname, (tiefe || 0) + 1, signal);
        if (anker) erg.anker = anker;
        return erg;
      }
    }
    doc.querySelectorAll("script, style, noscript, table, figure, sup, .infobox, .navbox, .reference, .references, .mw-editsection, .thumb, .gallery, .hatnote, .metadata, nav, footer, #toc, .toc").forEach(n => n.remove());
    const titel = (doc.querySelector("h1") || doc.querySelector("title") || {}).textContent || "";
    const abschnitte = [];
    let ueberschrift = "";
    for (const n of doc.body ? doc.body.querySelectorAll("h2, h3, h4, p, li, dd, pre") : []) {
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (/^H[234]$/.test(n.tagName)) { ueberschrift = t; continue; }
      if (/^(Literatur|Weblinks|Einzelnachweise|Siehe auch|References|External links|See also|Further reading)$/i.test(ueberschrift)) continue;
      if (t.length < 25 && n.tagName !== "LI") continue;
      abschnitte.push({ ueberschrift, text: t });
    }
    return { titel: titel.trim(), abschnitte, url: new URL(url, location.origin).pathname };
  },
};

// ---------------------------------------------------------------- Nutzungsstatistik
// Meldet nur, wenn der jeweilige Schalter in den Einstellungen an ist (der Server prüft das noch einmal).
// Nie Inhalte: nur der Name des Bereichs, Fehlertexte der Oberfläche und das Tempo der KI.

const Statistik = {
  melden(daten) { fetch("/api/statistik/ereignis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(daten) }).catch(() => { }); },
  bereich(name) { if (OW.status && OW.status.statistikNutzung) this.melden({ art: "bereich", name }); },
  fehler(text) {
    if (!(OW.status && OW.status.statistikFehler) || !text) return;
    this.anzahl = (this.anzahl || 0) + 1;
    if (this.anzahl <= 20) this.melden({ art: "jsfehler", text: String(text).slice(0, 400) });
  },
  ki(t) {
    if (!(OW.status && OW.status.statistikFehler) || !t) return;
    this.melden({ art: "ki", antwort: t.predicted_per_second || 0, lesen: t.prompt_per_second || 0 });
  },
};
// Die Bitte um Zustimmung mit den zwei Haken (Einrichtung und einmalige Nachfrage nach einem Update).
// wahl = { fehler, nutzung } wird beim Anhaken direkt geändert.
function statistikBitte(wahl) {
  const haken = (feld, titel, text) => el("label", { class: "stat-haken" },
    el("input", { type: "checkbox", checked: !!wahl[feld], onchange: (e) => { wahl[feld] = e.target.checked; } }),
    el("span", {}, el("b", {}, titel), el("small", {}, text)));
  return el("div", { class: "stat-bitte" },
    el("p", {}, "Ich mag es selbst nicht, wenn Programme ungefragt Nutzungsdaten sammeln, und schalte das bei anderen Programmen meist aus.", el("br"),
      "Deshalb ist hier alles aus, solange du nichts anhakst."),
    el("p", {}, "Trotzdem bitte ich dich, die beiden Haken zu setzen.", el("br"),
      "Fieldbook läuft auf sehr unterschiedlichen Geräten.", el("br"),
      "Ohne diese Angaben erfahre ich kaum, wo Fehler auftreten, was zu langsam ist und welche Bereiche tatsächlich genutzt werden.", el("br"),
      "Mit ihnen kann ich Fieldbook gezielt verbessern."),
    el("p", { class: "hinweis klein" }, "Inhalte werden nie gesendet: Deine Fragen, Chats, Suchbegriffe und Einträge bleiben auf deinem Gerät.", el("br"),
      "Das erste kleine Paket geht gleich nach dem Einschalten raus, danach eins pro Woche, nie über einen Handy-Hotspot.", el("br"),
      "Was genau darin steht, siehst du jederzeit in den Einstellungen.", el("br"),
      "Dort kannst du beides auch wieder abschalten.", el("br"),
      "Alles Weitere steht in der ", el("a", { href: "https://github.com/wobix08/Fieldbook#datenschutz", target: "_blank", rel: "noopener" }, "Datenschutzerklärung"), "."),
    haken("fehler", "Fehlerberichte und Technik", "Fehler, die in Fieldbook auftreten, dein Gerät (Prozessor, Arbeitsspeicher, Grafik) und wie schnell die KI antwortet"),
    haken("nutzung", "Nutzungsstatistik", "Wie oft du die einzelnen Bereiche öffnest, welche Pakete und Karten installiert sind und dein Land"));
}

// Einmalige Nachfrage für alle, die Fieldbook schon eingerichtet hatten, bevor es die Statistik gab
async function statistikNachfragen(s) {
  if (OW.statistikGefragt || !s.setupFertig || s.statistikGefragt || !s.statistikEingerichtet) return;
  if (location.hash.startsWith("#setup") || document.querySelector(".dialog-hinter")) return;
  OW.statistikGefragt = true;
  const wahl = { fehler: false, nutzung: false };
  const r = await dialog("Eine Bitte", statistikBitte(wahl),
    [{ text: "Nein danke", wert: "nein" }, { text: "Auswahl speichern", wert: "ja", haupt: true }]);
  if (r === null) return; // weggeklickt: beim nächsten Start noch einmal fragen
  await api("statistik/einstellen", r === "ja" ? wahl : { fehler: false, nutzung: false }).catch(() => { });
  aktualisiereStatus();
}

// Erste eigene Stelle aus dem Stack ("pdfleser.js:303"), nur Dateiname und Zeile, keine Adressen mit Inhalt
function fehlerStelle(stack) {
  const zeilen = String(stack || "").split("\n");
  const eigene = zeilen.find(z => /\/js\/[^/]+\.js/.test(z)) || zeilen.find(z => /\.js[?:]/.test(z));
  const m = eigene && eigene.match(/\/([^/?#\s]+\.js)(?:\?[^:\s]*)?:(\d+)/);
  return m ? m[1] + ":" + m[2] : "";
}

window.addEventListener("error", (e) => {
  // Harmlose Meldung des Browsers: Ein ResizeObserver hat das Layout geändert, der Rest kommt ein Bild später
  if (/^ResizeObserver loop/.test(e.message || "")) return;
  const stelle = fehlerStelle(e.error && e.error.stack) || ((e.filename || "").split("/").pop().split("?")[0] + (e.filename ? ":" + e.lineno : ""));
  Statistik.fehler((e.message || "Fehler") + (stelle ? " (" + stelle + ")" : ""));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  // Abgebrochene Anfragen (z. B. KI-Antwort gestoppt) sind keine Fehler
  if (r && r.name === "AbortError") return;
  const stelle = fehlerStelle(r && r.stack);
  Statistik.fehler("Unbehandelt: " + (r && r.message ? r.message : String(r)) + (stelle ? " (" + stelle + ")" : ""));
});

// ---------------------------------------------------------------- KI

const KI = {
  bereit() { return OW.status && OW.status.ki && OW.status.ki.status === "bereit"; },

  // Streaming-Chat. onText bekommt den bisher erzeugten Text.
  async chat(nachrichten, optionen, onText) {
    const { signal, ...rest } = optionen || {};   // signal gehört an fetch, nicht in den Body
    const body = Object.assign({
      messages: nachrichten, stream: !!onText, temperature: 0.3, top_p: 0.9,
      chat_template_kwargs: { enable_thinking: false },
    }, rest);
    const r = await fetch("/llm/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) {
      let msg = "KI-Fehler " + r.status;
      try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch { }
      throw new Error(msg);
    }
    if (!onText) {
      const j = await r.json();
      Statistik.ki(j.timings);
      return KI.ohneDenken(j.choices[0].message.content || "");
    }
    const leser = r.body.getReader();
    const dec = new TextDecoder();
    let puffer = "", text = "", beendet = false;
    const zeileAuswerten = (roh) => {
      const zeile = roh.trim();
      if (!zeile.startsWith("data:")) return;
      const d = zeile.slice(5).trim();
      if (d === "[DONE]") { beendet = true; return; }
      try {
        const j = JSON.parse(d);
        const c = j.choices && j.choices[0];
        const delta = c && c.delta;
        if (delta && delta.content) { text += delta.content; onText(KI.ohneDenken(text)); }
        if (c && c.finish_reason) beendet = true;
        if (j.timings) Statistik.ki(j.timings); // kommt mit dem letzten Stück
      } catch { }
    };
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      puffer += dec.decode(value, { stream: true });
      let i;
      while ((i = puffer.indexOf("\n")) >= 0) {
        const zeile = puffer.slice(0, i);
        puffer = puffer.slice(i + 1);
        zeileAuswerten(zeile);
      }
    }
    puffer += dec.decode();
    if (puffer) zeileAuswerten(puffer);   // letzte Zeile ohne Zeilenumbruch
    if (!beendet) throw new Error("Die KI wurde unterbrochen.");
    return KI.ohneDenken(text);
  },

  ohneDenken(t) {
    if (!t.includes("<think>")) return t.trim();   // Normalfall: kein Regex bei jedem Token
    return t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
  },
};
