// Eigene Unterlagen: eigene Dateien (PDF, Word, Bilder, Text) in daten/eigene, in der Bibliothek ganz oben.
// PDFs öffnen im PDF-Leser, alles andere in der Ansicht „#dokument“ (Word über mammoth.js). Den Text liest
// diese Seite im Hintergrund einmal aus und schickt ihn an den Server; Suche und KI finden ihn dann wie die
// PDF-Bücher der Pakete (Paketname „eigene“, siehe Server.cs).
"use strict";

const Eigene = (() => {
  const BASIS = "/api/eigene/datei/";
  const ENDUNGEN = [".pdf", ".docx", ".doc", ".txt", ".md", ".jpg", ".jpeg", ".png", ".webp", ".gif"];
  // Wie ein Paket für Suche und KI: gesucht wird im ausgelesenen Text (/api/pdftext/suche?buch=eigene)
  const BUCH = { id: "eigene", name: "eigene", titel: "Eigene Unterlagen", text: "", sprache: "deu", englisch: false,
    durchsuchen: true, pdf: true, eigene: true, kategorien: ["eigene"], bild: null, start: "#bibliothek" };

  const endung = (d) => (String(d).match(/\.[^.]+$/) || [""])[0].toLowerCase();
  const ohneEndung = (d) => String(d).replace(/\.[^.]+$/, "");
  function art(d) {
    const e = endung(d);
    if (e === ".pdf") return "pdf";
    if (e === ".docx") return "word";
    if (e === ".doc") return "doc";
    if (e === ".txt" || e === ".md") return "text";
    if (e === ".html") return "notiz";   // Notizen aus Fieldbook (js/notizen.js)
    return "bild";
  }
  const ART_TEXT = { pdf: "PDF", word: "Word", doc: "Word (altes Format)", text: "Text", bild: "Bild", notiz: "Notiz" };

  // Gesicherte Webseiten haben den Schlüssel „web:<ordner>“ (siehe webseiten.js); Adresse wie in Server.cs
  // (Uri.EscapeDataString kodiert auch ! ' ( ) *)
  const istWeb = (d) => String(d).startsWith("web:");
  const teilKodieren = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const webAdresse = (ordner) => "/gesichert/" + String(ordner).split("/").map(teilKodieren).join("/") + "/index.html";
  const url = (d) => istWeb(d) ? webAdresse(String(d).slice(4)) : BASIS + encodeURIComponent(d);
  // Name zum Anzeigen: bei Webseiten der gespeicherte Name, sonst der Dateiname ohne Endung
  const titel = (d) => d.web ? (d.name || d.ordner) : ohneEndung(d.datei);
  function link(d, seite) {
    if (istWeb(d)) return "#web?ordner=" + encodeURIComponent(String(d).slice(4));
    if (art(d) === "notiz") return "#notiz?datei=" + encodeURIComponent(d);
    if (art(d) === "pdf") return "#pdf?url=" + encodeURIComponent(url(d)) + (seite ? "&seite=" + seite : "") + "&titel=" + encodeURIComponent(ohneEndung(d));
    return "#dokument?datei=" + encodeURIComponent(d);
  }
  // Adresse einer eigenen Datei (Suche, Quellen der KI, Zuletzt gelesen) → Link in Fieldbook, sonst null
  function linkVon(adresse, seite) {
    const w = String(adresse || "").match(/^\/gesichert\/(.+)\/index\.html$/);
    if (w) { try { return "#web?ordner=" + encodeURIComponent(w[1].split("/").map(decodeURIComponent).join("/")); } catch { return null; } }
    const m = String(adresse || "").match(/^\/api\/eigene\/datei\/([^#?]+)(?:#page=(\d+))?/);
    if (!m) return null;
    let d;
    try { d = decodeURIComponent(m[1]); } catch { return null; }
    return link(d, seite || m[2]);
  }

  // Dateiliste vom Server (kurz zwischengespeichert, damit Bibliothek und Suche nicht doppelt fragen)
  let cache = null, cacheZeit = 0;
  async function antwort(neu) {
    if (!cache || neu || Date.now() - cacheZeit > 10000) { cache = api("eigene"); cacheZeit = Date.now(); }
    try { return await cache; } catch (e) { cache = null; throw e; }
  }
  async function liste(neu) { return (await antwort(neu)).dateien || []; }
  // Eigene Ordner für gesicherte Webseiten ([{ id, name }])
  async function gruppen(neu) { return (await antwort(neu)).gruppen || []; }
  // Für Suche und KI: das „Paket“ nur, wenn es Text zum Durchsuchen gibt
  async function alsBuch() {
    try { return (await liste()).some(d => d.text) ? [BUCH] : []; } catch { return []; }
  }

  // ---------------------------------------------------------------- Liste in der Bibliothek

  // Wer gerade eine Liste zeigt (Bibliothek): wird nach jeder Änderung neu gezeichnet
  const beobachter = new Set();
  function geaendert() {
    cache = null;
    for (const f of beobachter) f();
  }

  // Inhalt der Klapp-Zeile „Eigene Unterlagen“. zahlSetzen(n) aktualisiert die Anzahl im Kopf der Zeile.
  function inhalt(zahlSetzen) {
    const box = el("div", { class: "klapp-liste eigene-liste" });
    const meldung = el("div", { class: "eigene-meldung", "aria-live": "polite" });
    const waehler = el("input", { type: "file", multiple: true, hidden: true, accept: ENDUNGEN.filter(e => e !== ".doc").join(",") });
    waehler.addEventListener("change", () => { const f = [...waehler.files]; waehler.value = ""; hochladen(f, meldung); });
    let lauf = 0;
    async function zeichnen() {
      if (!box.isConnected && lauf) { beobachter.delete(zeichnen); return; }
      const mein = ++lauf;
      let dateien, ordner;
      try { [dateien, ordner] = await Promise.all([liste(), gruppen()]); }
      catch (e) { if (mein === lauf) box.replaceChildren(fehlerBox("Die eigenen Unterlagen ließen sich nicht laden.", zeichnen, null, e && e.message)); return; }
      if (mein !== lauf) return;
      if (zahlSetzen) zahlSetzen(dateien.length);
      // Erst die eigenen Ordner, dann alles ohne Ordner (Dateien, dann Webseiten)
      const zeile = (d) => d.web ? webZeile(d, ordner) : dateiZeile(d, ordner);
      const teile = [];
      for (const o of ordner) {
        const drin = dateien.filter(d => d.gruppe === o.id);
        const k = klappAbschnitt(offeneOrdner, o.id, "folder", o.name, null, drin.length === 1 ? "1 Eintrag" : drin.length + " Einträge", false);
        k.innen.append(el("div", { class: "klapp-liste" },
          drin.length ? drin.map(zeile) : el("p", { class: "hinweis merk-ordner-leer" }, "Noch leer.", el("br"), "Über das Menü ", sym("ellipsis-vertical"), " an einem Eintrag legst du ihn hier hinein."),
          el("div", { class: "knopfreihe merk-ordner-knoepfe" },
            el("button", { type: "button", class: "knopf knopf-klein", onclick: () => ordnerUmbenennen(o) }, sym("pencil"), "Ordner umbenennen"),
            el("button", { type: "button", class: "knopf knopf-klein", onclick: () => ordnerLoeschen(o, drin.length) }, sym("trash-2"), "Ordner löschen"))));
        teile.push(k.box);
      }
      const lose = dateien.filter(d => !ordner.some(o => o.id === d.gruppe));
      if (ordner.length && lose.length) teile.push(el("h3", { class: "merk-zwischen" }, "Ohne Ordner"));
      teile.push(...lose.filter(d => !d.web).map(zeile), ...lose.filter(d => d.web).map(zeile));
      if (!dateien.length) teile.push(el("p", { class: "hinweis eigene-leer" },
        "Hier kannst du eigene Dateien ablegen, zum Beispiel Bedienungsanleitungen, einen Medikamentenplan oder Fotos wichtiger Unterlagen.",
        el("br"), "Mit „Neue Notiz“ schreibst du selbst etwas auf, zum Beispiel wichtige Telefonnummern oder euren Treffpunkt.",
        el("br"), "Die Suche und die KI finden dann auch, was darin steht."));
      teile.push(el("div", { class: "knopfreihe eigene-knoepfe" },
        el("button", { type: "button", class: "knopf knopf-haupt eigene-hinzufuegen", onclick: () => Rundgang.aktiv() ? beispielDatei(meldung) : waehler.click() }, sym("upload"), "Datei hinzufügen"),
        el("button", { type: "button", class: "knopf", onclick: () => Notizen.neu(), title: "Eigenen Text schreiben, z. B. Telefonnummern oder einen Treffpunkt" }, sym("notebook-pen"), "Neue Notiz"),
        el("a", { class: "knopf", href: "#web", title: "Eine Webseite mit allen Bildern für die Zeit ohne Internet speichern" }, sym("globe"), "Webseite sichern"),
        dateien.length ? el("button", { type: "button", class: "knopf", onclick: () => neuerOrdner(null), title: "Ordner zum Sortieren deiner Unterlagen" }, sym("folder-plus"), "Neuer Ordner") : null,
        el("button", { type: "button", class: "knopf", onclick: ordnerOeffnen }, sym("folder-open"), "Ordner öffnen")),
        el("p", { class: "hinweis klein eigene-info" }, "Oder Dateien einfach hierher ziehen.",
          el("br"), "Fieldbook zeigt PDF, Word (.docx), Bilder und Textdateien."),
        meldung, waehler);
      box.replaceChildren(...teile);
    }
    beobachter.add(zeichnen);
    box._meldung = meldung;
    zeichnen();
    return box;
  }

  // Gesicherte Webseite: Menü (wie in der Merkliste) mit Umbenennen, In Ordner legen, Löschen
  const offeneOrdner = new Set();
  function webZeile(d, ordner) {
    let wo = "";
    try { wo = new URL(d.url).hostname.replace(/^www\./, ""); } catch { }
    const am = d.datum ? new Date(d.datum).toLocaleDateString("de-DE") : "";
    const zusatz = d.auslesen ? " · wird für Suche und KI vorbereitet …" : "";
    const menueKnopf = el("button", { type: "button", class: "knopf knopf-klein merk-menue-knopf", title: "Umbenennen, in Ordner legen, löschen",
      "aria-label": "Menü für „" + titel(d) + "“", "aria-haspopup": "true", "aria-expanded": "false" }, sym("ellipsis-vertical"));
    const z = el("div", { class: "eigene-zeile merk-zeile" },
      el("a", { class: "eintrag paket-zeile", href: link(d.datei) },
        symFeld("globe"),
        el("span", { class: "e-text" }, el("b", {}, titel(d)), el("small", {}, "Webseite · " + wo + (am ? " · gesichert am " + am : "") + zusatz)),
        el("span", { class: "paket-pfeil", "aria-hidden": "true" })),
      menueKnopf);
    menueKnopf.addEventListener("click", () => menue(z, menueKnopf, d, ordner || []));
    return z;
  }

  let offenesMenue = null;
  function menueZu(fokus) {
    if (!offenesMenue) return;
    const m = offenesMenue;
    offenesMenue = null;
    m.liste.remove();
    m.knopf.setAttribute("aria-expanded", "false");
    if (fokus) m.knopf.focus();
  }
  document.addEventListener("pointerdown", (ev) => {
    if (offenesMenue && !offenesMenue.liste.contains(ev.target) && !offenesMenue.knopf.contains(ev.target)) menueZu();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && offenesMenue) menueZu(true); });

  function menue(zeileEl, knopf, d, ordner) {
    const warOffen = offenesMenue && offenesMenue.knopf === knopf;
    menueZu();
    if (warOffen) return;
    const punkt = (icon, text, fn, klasse) => el("button", { type: "button", class: klasse || null,
      onclick: () => { menueZu(); fn(); } }, icon ? sym(icon) : el("span", { class: "menue-haken" }, "✓"), text);
    const imOrdner = ordner.some(o => o.id === d.gruppe);
    const liste = el("div", { class: "menue merk-menue", role: "menu" },
      punkt("pencil", "Umbenennen", () => umbenennen(d.datei, d)),
      el("hr"),
      el("div", { class: "menue-titel" }, "In Ordner legen"),
      ...ordner.map(o => punkt(d.gruppe === o.id ? null : "folder", o.name, () => verschieben(d, o.id), d.gruppe === o.id ? "menue-aktiv" : null)),
      imOrdner ? punkt("folder-input", "Aus dem Ordner nehmen", () => verschieben(d, "")) : null,
      punkt("folder-plus", "Neuer Ordner …", () => neuerOrdner(d)),
      el("hr"),
      punkt("trash-2", "Löschen", () => loeschen(d.datei, d), "menue-rot"));
    zeileEl.append(liste);
    knopf.setAttribute("aria-expanded", "true");
    offenesMenue = { liste, knopf };
    const erster = liste.querySelector("button");
    if (erster) erster.focus();
  }

  // Ordner: nur in Fieldbook (webseiten.json), auf der Festplatte bleibt alles, wo es ist
  async function gruppenAendern(daten, fehlerText) {
    let r;
    try { r = await api("web/gruppen", daten); } catch (e) { r = { fehler: "Fieldbook antwortet gerade nicht." }; }
    if (r.fehler) await dialog(fehlerText, el("div", {}, zeilen(r.fehler)), [{ text: "OK", wert: 1, haupt: true }]);
    geaendert();
    return r.fehler ? null : r;
  }
  const verschieben = (d, gruppe) => gruppenAendern(Object.assign({ aktion: "verschieben", gruppe }, d.web ? { ordner: d.ordner } : { datei: d.datei }), "Verschieben");

  async function nameFragen(ueberschrift, frage, wert, knopfText) {
    const feld = el("input", { type: "text", class: "eingabe", value: wert || "", maxlength: "100", "aria-label": frage, style: "width:100%" });
    feld.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); const k = feld.closest(".dialog").querySelector(".knopf-haupt"); if (k) k.click(); } });
    setTimeout(() => { feld.focus(); feld.select(); }, 0);
    const ok = await dialog(ueberschrift, el("div", {}, el("p", {}, frage), feld), [{ text: "Abbrechen", wert: null }, { text: knopfText, wert: "ok", haupt: true }]);
    const t = feld.value.trim();
    return ok === "ok" && t ? t : null;
  }

  // Neuer Ordner; mit d wird die Webseite gleich hineingelegt
  async function neuerOrdner(d) {
    const name = await nameFragen("Neuer Ordner", "Name des Ordners:", "", "Anlegen");
    if (!name) return null;
    const r = await gruppenAendern({ aktion: "neu", name }, "Neuer Ordner");
    if (!r) return null;
    offeneOrdner.add(r.neu);
    if (d) await verschieben(d, r.neu);
    return r.neu;
  }
  async function ordnerUmbenennen(o) {
    const name = await nameFragen("Ordner umbenennen", "Neuer Name des Ordners:", o.name, "Umbenennen");
    if (name && name !== o.name) gruppenAendern({ aktion: "umbenennen", id: o.id, name }, "Ordner umbenennen");
  }
  async function ordnerLoeschen(o, n) {
    if (n) {
      const ok = await dialog("Ordner löschen?", el("p", {}, "Der Ordner „" + o.name + "“ wird gelöscht.", el("br"),
        n === 1 ? "Der Eintrag darin bleibt erhalten und steht dann ohne Ordner da." : "Die " + n + " Einträge darin bleiben erhalten und stehen dann ohne Ordner da."),
        [{ text: "Abbrechen", wert: null }, { text: "Ordner löschen", wert: "ok", haupt: true }]);
      if (ok !== "ok") return;
    }
    offeneOrdner.delete(o.id);
    gruppenAendern({ aktion: "loeschen", id: o.id }, "Ordner löschen");
  }

  function dateiZeile(d, ordner) {
    if (d.web) return webZeile(d, ordner);
    const a = art(d.datei);
    let zusatz = "";
    if (d.auslesen) zusatz = " · wird für Suche und KI vorbereitet …";
    else if ((a === "pdf" || a === "word" || a === "text") && !d.text) zusatz = a === "pdf" ? " · kein Text gefunden (eingescannt?)" : " · kein Text gefunden";
    else if (a === "notiz" && !d.text) zusatz = " · noch leer";
    const info = a === "notiz" ? "Notiz · geändert am " + new Date(d.geaendert).toLocaleDateString("de-DE") : ART_TEXT[a] + " · " + groesse(d.groesse);
    const menueKnopf = el("button", { type: "button", class: "knopf knopf-klein merk-menue-knopf", title: "Umbenennen, in Ordner legen, löschen",
      "aria-label": "Menü für „" + ohneEndung(d.datei) + "“", "aria-haspopup": "true", "aria-expanded": "false" }, sym("ellipsis-vertical"));
    const z = el("div", { class: "eigene-zeile merk-zeile" },
      el("a", { class: "eintrag paket-zeile", href: link(d.datei) },
        symFeld(a === "bild" ? "image" : a === "notiz" ? "notebook-pen" : "file-text"),
        el("span", { class: "e-text" }, el("b", {}, ohneEndung(d.datei)), el("small", {}, info + zusatz)),
        el("span", { class: "paket-pfeil", "aria-hidden": "true" })),
      menueKnopf);
    menueKnopf.addEventListener("click", () => menue(z, menueKnopf, d, ordner || []));
    return z;
  }

  async function ordnerOeffnen() {
    try { const r = await api("eigene/ordner", {}); if (r.fehler) throw new Error(r.fehler); }
    catch (e) { dialog("Ordner öffnen", "Der Ordner ließ sich nicht öffnen.", [{ text: "OK", wert: 1, haupt: true }]); }
  }

  // Dateien hochladen (Knopf oder Hineinziehen). meldung: Element für Fortschritt und Fehler
  async function hochladen(dateien, meldung) {
    if (!dateien.length) return;
    const fehler = [];
    let fertig = 0;
    for (const f of dateien) {
      const e = endung(f.name);
      if (e === ".doc") { fehler.push("„" + f.name + "“: Dieses alte Word-Format kann Fieldbook nicht anzeigen. Öffne die Datei in Word und speichere sie als .docx oder PDF."); continue; }
      if (!ENDUNGEN.includes(e)) { fehler.push("„" + f.name + "“: Diese Dateiart kann Fieldbook nicht anzeigen."); continue; }
      if (meldung) meldung.replaceChildren(el("p", { class: "hinweis klein" }, "„" + f.name + "“ wird hinzugefügt …"));
      try {
        const r = await fetch("/api/eigene/hochladen?name=" + encodeURIComponent(f.name), { method: "POST", body: f });
        const j = r.ok ? await r.json() : { fehler: "Fieldbook antwortet mit " + r.status + "." };
        if (j.fehler) fehler.push("„" + f.name + "“: " + j.fehler); else fertig++;
      } catch (err) { fehler.push("„" + f.name + "“: Die Datei ließ sich nicht hinzufügen."); }
    }
    if (meldung) meldung.replaceChildren(...fehler.map(t => el("p", { class: "fehlerbox" }, zeilen(t))));
    // Die Meldungszeile bleibt beim Neuzeichnen der Liste dieselbe, Fehler bleiben also stehen
    if (fertig) { geaendert(); anstossen(); }
  }

  // Rundgang (Kapitel Eigene Unterlagen): statt der Dateiauswahl von Windows die Beispieldatei aus
  // app/web/uebung/eigene (Server legt sie nur im Speicher an, siehe UebungEigene in Server.cs)
  async function beispielDatei(meldung) {
    const name = "Stromerzeuger Bedienungsanleitung.pdf";
    const wert = await dialog("Datei hinzufügen", el("div", {},
      el("p", {}, "Normalerweise öffnet sich jetzt ein Fenster von Windows.", el("br"), "Darin suchst du eine Datei auf deinem Laptop aus."),
      el("p", {}, "Im Rundgang nimmst du diese Beispieldatei:"),
      el("div", { class: "eintrag paket-zeile eigene-beispiel" }, symFeld("file-text"),
        el("span", { class: "e-text" }, el("b", {}, ohneEndung(name)), el("small", {}, "PDF · Beispiel")))),
      [{ text: "Abbrechen", wert: null }, { text: "Hinzufügen", wert: "ok", haupt: true }]);
    if (wert !== "ok") return;
    try { const r = await api("uebung/beispieldatei", {}); if (r.fehler) throw new Error(r.fehler); }
    catch (e) { if (meldung) meldung.replaceChildren(el("p", { class: "fehlerbox" }, "Die Beispieldatei ließ sich nicht hinzufügen.")); return; }
    geaendert();
    anstossen();
  }

  async function umbenennen(datei, d) {
    const alt = d ? titel(d) : ohneEndung(datei);
    const feld = el("input", { type: "text", class: "eingabe", value: alt, "aria-label": "Neuer Name", style: "width:100%" });
    feld.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const k = feld.closest(".dialog").querySelector(".knopf-haupt"); if (k) k.click(); } });
    const fehlerZeile = el("p", { class: "fehlerbox", hidden: true });
    setTimeout(() => { feld.focus(); feld.select(); }, 0);
    const wert = await dialog("Umbenennen", el("div", {}, el("p", {}, "Neuer Name für „" + alt + "“:"), feld, fehlerZeile),
      [{ text: "Abbrechen", wert: null }, { text: "Umbenennen", wert: "ok", haupt: true }]);
    if (wert !== "ok") return;
    const neu = feld.value.trim();
    if (!neu || neu === alt) return;
    let r;
    try { r = d && d.web ? await api("web/umbenennen", { ordner: d.ordner, name: neu }) : await api("eigene/umbenennen", { datei, neu }); }
    catch (e) { r = { fehler: "Fieldbook antwortet gerade nicht." }; }
    if (r.fehler) { await dialog("Umbenennen", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
    geaendert();
  }

  async function loeschen(datei, d) {
    const web = d && d.web;
    const wert = await dialog(web ? "Webseite löschen?" : "Datei löschen?", el("div", {}, "„" + (d ? titel(d) : ohneEndung(datei)) + "“ wird aus Fieldbook gelöscht.", el("br"), "Das lässt sich nicht rückgängig machen."),
      [{ text: "Abbrechen", wert: null }, { text: "Löschen", wert: "ja", haupt: true }]);
    if (wert !== "ja") return;
    let r;
    try { r = web ? await api("web/loeschen", { ordner: d.ordner }) : await api("eigene/loeschen", { datei }); }
    catch (e) { r = { fehler: "Fieldbook antwortet gerade nicht." }; }
    if (r.fehler) { await dialog("Löschen", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
    if (web) await Webseiten.nachLoeschen(d.ordner);
    geaendert();
  }

  // ---------------------------------------------------------------- Anzeigen (Word, Text, Bild)

  let mammothLaden = null;
  function mammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!mammothLaden) mammothLaden = new Promise((ok, fehl) => {
      const s = el("script", { src: "vendor/mammoth.browser.min.js" });
      s.onload = () => ok(window.mammoth);
      s.onerror = () => { mammothLaden = null; s.remove(); fehl(new Error("mammoth.js fehlt")); };
      document.head.append(s);
    });
    return mammothLaden;
  }

  // Textdateien: meist UTF-8, ältere aus dem Windows-Editor auch ANSI oder UTF-16 („Unicode“)
  function textDekodieren(buf) {
    const b = new Uint8Array(buf.slice(0, 2));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder("utf-16le").decode(buf);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder("utf-16be").decode(buf);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { return new TextDecoder("windows-1252").decode(buf); }
  }

  async function holen(datei) {
    const r = await fetch(url(datei));
    if (!r.ok) throw new Error(r.status === 404 ? "nicht gefunden" : "Fieldbook antwortet mit " + r.status);
    return r.arrayBuffer();
  }

  let dokLauf = 0;
  async function dokument(params) {
    const datei = params.get("datei") || "";
    const mein = ++dokLauf;
    const flaeche = $("#dok-flaeche");
    $("#dok-titel").textContent = ohneEndung(datei);
    flaeche.replaceChildren(el("p", { class: "hinweis dok-laden" }, "Wird geöffnet …"));
    flaeche.scrollTop = 0;
    const a = art(datei);
    let inhaltEl;
    try {
      if (!ENDUNGEN.includes(endung(datei))) throw new Error("unbekannte Dateiart");
      if (a === "doc") {
        inhaltEl = el("div", { class: "dok-text" }, el("div", { class: "karte-box" },
          el("p", { style: "margin-top:0" }, "Dieses alte Word-Format (.doc) kann Fieldbook nicht anzeigen.",
            el("br"), "Öffne die Datei in Word und speichere sie als .docx oder PDF.",
            el("br"), "Danach erscheint sie hier richtig, und die Suche und die KI finden auch, was darin steht."),
          el("button", { type: "button", class: "knopf", onclick: ordnerOeffnen }, sym("folder-open"), "Ordner öffnen")));
      } else if (a === "bild") {
        inhaltEl = el("div", { class: "dok-bild" }, el("img", { src: url(datei), alt: ohneEndung(datei) }));
      } else if (a === "text") {
        const text = textDekodieren(await holen(datei));
        inhaltEl = el("article", { class: "dok-text dok-schlicht" }, text);
      } else {
        const [m, buf] = await Promise.all([mammoth(), holen(datei)]);
        const erg = await m.convertToHtml({ arrayBuffer: buf });
        inhaltEl = el("article", { class: "dok-text" });
        inhaltEl.innerHTML = erg.value;
        linksAnpassen(inhaltEl);
      }
    } catch (e) {
      if (mein !== dokLauf) return;
      flaeche.replaceChildren(el("div", { class: "dok-text" }, fehlerBox(/nicht gefunden/.test(e.message)
        ? "Diese Datei gibt es nicht mehr. Vielleicht wurde sie umbenannt oder gelöscht."
        : "Diese Datei ließ sich nicht öffnen. Vielleicht ist sie beschädigt.", null, null, e && e.message),
        el("p", {}, el("a", { href: "#bibliothek" }, "Zur Bibliothek"))));
      return;
    }
    if (mein !== dokLauf) return;
    flaeche.replaceChildren(inhaltEl);
    if (a !== "doc") zuletztMerken({ url: url(datei), titel: ohneEndung(datei), paket: "eigene" });
  }

  // Links im Word-Dokument: Sprungmarken im Dokument scrollen, Internet-Adressen in einem neuen Tab,
  // alles andere (z. B. Pfade auf dem Rechner des Verfassers) wird zu normalem Text
  function linksAnpassen(wurzel) {
    for (const a of wurzel.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href");
      if (h.startsWith("#")) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          let ziel = null;
          try { ziel = wurzel.querySelector("#" + CSS.escape(decodeURIComponent(h.slice(1)))); } catch { }
          if (ziel) ziel.scrollIntoView({ block: "start" });
        });
      } else if (/^(https?:|mailto:)/i.test(h)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      else a.removeAttribute("href");
    }
  }

  $("#dok-zurueck").addEventListener("click", () => {
    if (window.navigation ? navigation.currentEntry.index > 0 : history.length > 1) history.back();
    else location.hash = "#bibliothek";
  });

  // ---------------------------------------------------------------- Text für Suche und KI auslesen

  // Text in Stücke von etwa 1.500 Zeichen teilen (an Absätzen), damit die Suche Stellen findet wie Seiten im PDF
  function stuecke(text) {
    const absaetze = String(text).replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const erg = [];
    let akt = "";
    for (const a of absaetze) {
      if (akt && akt.length + a.length > 1500) { erg.push(akt); akt = ""; }
      akt += (akt ? "\n\n" : "") + a;
      while (akt.length > 3000) { erg.push(akt.slice(0, 1500)); akt = akt.slice(1500); }
    }
    if (akt) erg.push(akt);
    return erg;
  }

  async function textVon(d) {
    if (d.web) return stuecke(await Webseiten.text(d.adresse || url(d.datei)));
    const a = art(d.datei);
    if (a === "notiz") return stuecke(await Webseiten.text(url(d.datei)));
    if (a === "pdf") return PdfText.seitenText(url(d.datei));
    const buf = await holen(d.datei);
    if (a === "text") return stuecke(textDekodieren(buf));
    const m = await mammoth();
    return stuecke((await m.extractRawText({ arrayBuffer: buf })).value);
  }

  let leseLaeuft = false, letzterLauf = 0, angestossen = false;
  const fehlschlaege = new Map();
  function anstossen() { angestossen = true; auslesen(); }
  // Nach jedem Status-Abruf (app.js), höchstens einmal je Minute; nach Änderungen sofort
  async function auslesen() {
    // Auf Akku nur direkt nach dem Hinzufügen, nicht bei den regelmäßigen Nachproben
    if (leseLaeuft || (!angestossen && (Date.now() - letzterLauf < 60000 || aufAkku()))) return;
    leseLaeuft = true; angestossen = false; letzterLauf = Date.now();
    try {
      const arbeit = async () => {
        for (let runde = 0; runde < 50; runde++) {
          const offen = (await liste(true)).filter(d => d.auslesen && (fehlschlaege.get(d.datei + "|" + d.kennung) || 0) < 2);
          if (!offen.length) break;
          const d = offen[0];
          const key = d.datei + "|" + d.kennung;
          let seiten;
          try { seiten = await textVon(d); }
          catch (e) {
            console.warn("Eigene Unterlagen:", d.datei, e);
            const n = (fehlschlaege.get(key) || 0) + 1;
            fehlschlaege.set(key, n);
            if (n < 2) continue;
            seiten = [];   // zweimal gescheitert: leer merken, sonst würde es bei jedem Start wieder versucht
          }
          await api("eigene/text", { datei: d.datei, kennung: d.kennung, seiten });
          geaendert();
        }
      };
      // Sind mehrere Fieldbook-Tabs offen, liest nur einer aus
      if (navigator.locks) await navigator.locks.request("fieldbook-eigene", { ifAvailable: true }, (lock) => lock ? arbeit() : null);
      else await arbeit();
    } catch (e) { console.warn("Eigene Unterlagen:", e); }
    finally { leseLaeuft = false; }
  }

  return { BUCH, url, link, linkVon, liste, gruppen, neuerOrdner, alsBuch, inhalt, hochladen, geaendert, dokument, auslesen, anstossen, ohneEndung, titel };
})();
