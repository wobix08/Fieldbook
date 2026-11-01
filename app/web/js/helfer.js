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
  feld.addEventListener("focus", () => { feld.select(); zeigen(); });
  feld.addEventListener("input", zeigen);
  feld.addEventListener("blur", () => { liste.hidden = true; if (aktuell) feld.value = name(aktuell); });
  feld.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const b = liste.querySelector("button"); if (b) b.click(); feld.blur(); }
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
// (der steht in den Einstellungen beim Programm); opt.geaendert: wird nach jeder Änderung aufgerufen.
function aktualisierungBox(akt, sofort, opt) {
  opt = opt || {};
  const box = opt.eingebettet ? el("div") : el("div", { class: "karte-box", style: "margin-top:16px" });
  const zeichne = () => {
    box.innerHTML = "";
    const setze = async (neu) => {
      await aktualisierungSpeichern(akt, neu, sofort);
      zeichne();
      if (opt.geaendert) opt.geaendert();
    };
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
      if (!opt.eingebettet) box.append(
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
function dialog(titel, inhalt, knoepfe) {
  return new Promise((fertig) => {
    const hinter = el("div", { class: "dialog-hinter" });
    const box = el("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
      el("h2", {}, titel), typeof inhalt === "string" ? el("p", {}, inhalt) : inhalt,
      el("div", { class: "knopfreihe", style: "justify-content:flex-end" },
        ...knoepfe.map(k => el("button", { class: "knopf" + (k.haupt ? " knopf-haupt" : ""), onclick: () => { hinter.remove(); fertig(k.wert); } }, k.text))));
    hinter.append(box);
    hinter.addEventListener("click", (e) => { if (e.target === hinter) { hinter.remove(); fertig(null); } });
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
    : "Nicht alles ist erreichbar. Bei einem Werbeblocker, einer Firewall oder einem Jugendschutzfilter die gesperrten Adressen freigeben. In Firmen- und Schulnetzen hilft oft ein Proxy (Einstellungen → Internetverbindung).";
  await dialog("Verbindungstest", el("div", {}, el("p", {}, kopf), liste), [{ text: "OK", wert: 1, haupt: true }]);
  return t;
}

// "Inhalte aktualisieren": suchen, bei getakteter Verbindung warnen, dann herunterladen
async function jetztAktualisieren(knopf) {
  const text = knopf.textContent;
  knopf.disabled = true;
  knopf.textContent = "Suche nach neuen Inhalten …";
  try {
    const a = await api("aktualisierung/pruefen", {});
    if (a.fehler) { await dialog("Keine Verbindung", "Die Suche nach neuen Inhalten hat nicht geklappt. Bitte die Internetverbindung prüfen.", [{ text: "OK", wert: 1, haupt: true }]); return null; }
    if (!a.anzahl) { await dialog("Alles aktuell", "Es gibt nichts Neues. Alles ist auf dem neuesten Stand.", [{ text: "OK", wert: 1, haupt: true }]); return a; }
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
    el("div", { class: "dialog" }, el("h2", {}, "Fieldbook wird aktualisiert …"), info,
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
  // Liste aller installierten Bücher aus dem Kiwix-Katalog
  async buecher(neu) {
    if (OW.buecher && OW.buecher.length && !neu) return OW.buecher;
    if (!OW.status || !OW.status.bibliothek) return [];
    if (!OW.pakete) {
      try { const pk = await ladeKonfig("pakete"); OW.pakete = pk.pakete || []; OW.kategorien = pk.kategorien || []; }
      catch { OW.pakete = []; OW.kategorien = []; }
    }
    const r = await fetch("/kiwix/catalog/v2/entries?count=-1");
    if (!r.ok) return [];
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
        // Selbst hinzugefügte Pakete ohne Eintrag in pakete.json landen unter "Weitere Pakete"
        kategorien: paket.kategorien && paket.kategorien.length ? paket.kategorien : ["sonstiges"],
        bild: bild ? bild.getAttribute("href") : null,
        start: "/kiwix/viewer#" + id,
        // Eigene Fieldbook-Startseite (Kacheln, iFixit-Übersicht), siehe "startseite" in pakete.json
        startseite: paket.startseite || null,
      });
    }
    // Wichtige Pakete zuerst
    const rang = (b) => /wikipedia_de_all/.test(b.name) ? 0 : /medicine|mdwiki/.test(b.name) ? 1 : b.englisch ? 3 : 2;
    liste.sort((a, b) => rang(a) - rang(b) || a.titel.localeCompare(b.titel));
    return (OW.buecher = liste);
  },

  // Titelvorschläge (schnell, für exakte Artikelnamen)
  async vorschlaege(buch, begriff, anzahl) {
    const q = "term=" + encodeURIComponent(begriff) + "&count=" + (anzahl || 5);
    let r = await fetch("/kiwix/suggest?content=" + encodeURIComponent(buch.id) + "&" + q);
    if (!r.ok) r = await fetch("/kiwix/suggest?books.name=" + encodeURIComponent(buch.id) + "&" + q);
    if (!r.ok) return [];
    let daten;
    try { daten = await r.json(); } catch { return []; }
    return daten.filter(d => d.path && d.kind !== "pattern").map(d => ({
      titel: (d.value || d.label || "").replace(/<[^>]+>/g, ""),
      url: "/kiwix/content/" + encodeURIComponent(buch.id) + "/" + d.path.replace(/^\//, ""),
      buch,
    }));
  },

  // Volltextsuche. Pakete ohne Volltext-Index (z. B. iFixit) durchsucht Kiwix trotzdem über die Titel
  async suche(buch, begriff, anzahl) {
    const q = "pattern=" + encodeURIComponent(begriff) + "&format=xml&pageLength=" + (anzahl || 5);
    let r = await fetch("/kiwix/search?books.name=" + encodeURIComponent(buch.id) + "&" + q);
    if (!r.ok) r = await fetch("/kiwix/search?content=" + encodeURIComponent(buch.id) + "&" + q);
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
  async artikelText(url, tiefe) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("Artikel nicht gefunden");
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    // Weiterleitungsseiten (meta refresh) verfolgen, z. B. "Schnittwunde" -> "Wunde#Wundarten"
    const refresh = doc.querySelector('meta[http-equiv="refresh" i]');
    if (refresh && (tiefe || 0) < 3) {
      const m = (refresh.getAttribute("content") || "").match(/url\s*=\s*'?([^']+)'?/i);
      if (m) {
        const ziel = new URL(m[1], location.origin + url);
        const anker = decodeURIComponent(ziel.hash.slice(1)).replace(/_/g, " ");
        const erg = await Kiwix.artikelText(ziel.pathname, (tiefe || 0) + 1);
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

// ---------------------------------------------------------------- KI

const KI = {
  bereit() { return OW.status && OW.status.ki && OW.status.ki.status === "bereit"; },

  // Streaming-Chat. onText bekommt den bisher erzeugten Text.
  async chat(nachrichten, optionen, onText) {
    const body = Object.assign({
      messages: nachrichten, stream: !!onText, temperature: 0.3, top_p: 0.9,
      chat_template_kwargs: { enable_thinking: false },
    }, optionen || {});
    const r = await fetch("/llm/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: optionen && optionen.signal,
    });
    if (!r.ok) {
      let msg = "KI-Fehler " + r.status;
      try { const j = await r.json(); msg = (j.error && (j.error.message || j.error)) || msg; } catch { }
      throw new Error(msg);
    }
    if (!onText) {
      const j = await r.json();
      return KI.ohneDenken(j.choices[0].message.content || "");
    }
    const leser = r.body.getReader();
    const dec = new TextDecoder();
    let puffer = "", text = "";
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      puffer += dec.decode(value, { stream: true });
      let i;
      while ((i = puffer.indexOf("\n")) >= 0) {
        const zeile = puffer.slice(0, i).trim();
        puffer = puffer.slice(i + 1);
        if (!zeile.startsWith("data:")) continue;
        const d = zeile.slice(5).trim();
        if (d === "[DONE]") continue;
        try {
          const j = JSON.parse(d);
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (delta && delta.content) { text += delta.content; onText(KI.ohneDenken(text)); }
        } catch { }
      }
    }
    return KI.ohneDenken(text);
  },

  ohneDenken(t) {
    return t.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
  },
};
