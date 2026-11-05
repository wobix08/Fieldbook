// Offline-Übersetzer ins Deutsche für die Leseansicht (Bergamot von Mozilla, läuft im Browser):
// Englisch immer, andere Sprachen, wenn sie für den Gesprächs-Übersetzer installiert sind.
// Bibliothek und Sprachmodell liegen in programme\uebersetzer und werden unter /uebersetzer/ ausgeliefert.
"use strict";

const Uebersetzer = (() => {
  let translator = null;
  let laden = null;
  let an = false;              // Übersetzen eingeschaltet? Gilt dann auch für weitere Artikel
  let lauf = 0;                // Zählt Übersetzungsläufe, damit ein alter Lauf abbricht
  let originale = new Map();   // Element → ursprüngliches HTML
  let aktuellesDok = null;

  let translatorSig = "";

  try { an = localStorage.getItem("ow-uebersetzen") === "1"; } catch { }

  const verfuegbar = () => !!(OW.status && OW.status.uebersetzer);
  const installiert = () => new Set((OW.status && OW.status.sprachen) || []);

  // Andere Sprachen gehen über Englisch (wie im Übersetzer): z. B. Spanisch → Englisch → Deutsch.
  // Kommt eine Sprache dazu, wird der Übersetzer neu angelegt, damit er ihre Modelle kennt.
  function holen() {
    const sig = [...installiert()].sort().join(",");
    if (translator && sig === translatorSig) return Promise.resolve(translator);
    if (!laden || sig !== translatorSig) {
      translatorSig = sig;
      translator = null;
      laden = import("/uebersetzer/lib/translator.js").then((mod) => {
        // Ein bis zwei Rechenkerne: schnell genug, ohne den Laptop zu blockieren
        const kerne = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
        translator = new mod.BatchTranslator({
          registryUrl: "/api/uebersetzer/modelle", pivotLanguage: "en", downloadTimeout: 0,
          workers: kerne, batchSize: 8, cacheSize: 4000,
        });
        return translator;
      }).catch((e) => { laden = null; throw e; });
    }
    return laden;
  }

  // Spracherkennung mit franc (Codes nach ISO 639-3). Baskisch und Isländisch kennt franc nicht.
  const FRANC = { de: "deu", en: "eng", fr: "fra", nl: "nld", sv: "swe", nb: "nob", fi: "fin", da: "dan", es: "spa", it: "ita",
    pt: "por", pl: "pol", cs: "ces", sk: "slk", sl: "slv", sr: "srp", hr: "hrv", hu: "hun", bs: "bos", el: "ell", ru: "rus",
    tr: "tur", lt: "lit", lv: "lvs", be: "bel", ca: "cat", et: "ekk", sq: "als", bg: "bul", ro: "ron", uk: "ukr", gl: "glg",
    ar: "arb", he: "heb", az: "azj", fa: "pes", ur: "urd", ug: "uig", hi: "hin", gu: "guj", mr: "mar", te: "tel", bn: "ben",
    kn: "kan", ta: "tam", ml: "mal", vi: "vie", af: "afr", th: "tha", ms: "zlm", tl: "tgl", id: "ind" };
  const AUS_FRANC = Object.fromEntries(Object.entries(FRANC).map(([k, v]) => [v, k]));
  let erkenner = null;
  const holeErkenner = () => erkenner || (erkenner = import("/vendor/franc/franc.js").then((m) => m.francAll).catch((e) => { erkenner = null; throw e; }));

  // franc verwechselt nah verwandte Sprachen. Liegt eine aus derselben Gruppe fast gleichauf, gewinnt die
  // Sprache der Seite, sonst eine installierte.
  const VERWANDT = [["sv", "nb", "da"], ["es", "ca", "gl"], ["hr", "bs", "sr"], ["cs", "sk"], ["ms", "id"]];
  function erkenne(francAll, text, seite) {
    const r = francAll(text, { only: Object.values(FRANC), minLength: 10 });
    if (r[0][0] === "und") return null;
    const oben = AUS_FRANC[r[0][0]] || null;
    // Sprache der Seite gewinnt, wenn sie fast genauso gut passt (Absätze mit vielen Namen und Nummern)
    const seiteWert = seite && r.find((x) => x[0] === FRANC[seite]);
    if (seiteWert && seiteWert[1] >= 0.9) return seite;
    const gruppe = VERWANDT.find((g) => g.includes(oben));
    if (!gruppe) return oben;
    const nah = r.filter((x) => x[1] >= 0.9).map((x) => AUS_FRANC[x[0]]).filter((c) => gruppe.includes(c));
    if (seite && nah.includes(seite)) return seite;
    const da = installiert();
    return nah.find((c) => da.has(c)) || oben;
  }

  // Sprache eines Absatzes. Eindeutige englische oder deutsche Wörter zählen zuerst (franc ist bei kurzen
  // Titeln unsicher), dann franc bei längeren Texten. Kurze ohne Anhaltspunkte bekommen die Sprache der Seite.
  function absatzSprache(francAll, text, seite) {
    const w = woerter(text);
    if (w.en >= 2 && w.de === 0) return "en";
    if (w.de >= 2 && w.en === 0) return "de";
    // Kurze Texte auf deutschen und englischen Seiten (Überschriften, Bildunterschriften): Umlaute ohne
    // englische Wörter heißen deutsch. Längere Absätze erkennt franc (Schwedisch hat auch ä und ö).
    const buchstaben = (text.match(/\p{L}/gu) || []).length;
    if ((seite === "de" || seite === "en") && buchstaben < 60 && /[äöüß]/i.test(text) && w.en < 2) return "de";
    if (buchstaben >= 40) {
      const s = erkenne(francAll, text, seite);
      if (s) return s;
    }
    // Kurze deutsche Wörter der Oberfläche (iFixit: „Schritt 1“, „Einleitung“) bleiben. Umlaute zählen nur
    // auf deutschen und englischen Seiten als deutsch (Schwedisch oder Finnisch haben auch ä und ö).
    if (w.de > w.en) return "de";
    if (seite !== "de" && seite !== "en") return seite;
    const grob = sprache(text);
    if (grob !== "?") return grob;
    return seite === "de" ? null : seite;
  }

  // Grob prüfen, ob ein Text englisch ist (häufige Wörter zählen)
  function istEnglisch(text) {
    const t = " " + text.slice(0, 4000).toLowerCase() + " ";
    const en = (t.match(/\b(the|and|of|to|is|with|for|that|this|you|are|it)\b/g) || []).length;
    const de = (t.match(/\b(der|die|und|das|ist|mit|für|nicht|ein|eine|sie|auf|den)\b/g) || []).length;
    return en > 8 && en > de * 1.5;
  }

  // Sprache eines einzelnen Absatzes: "en", "de" oder "?" (zu wenig Anhaltspunkte, z. B. Namen und Zahlen).
  // Gemischte Seiten (iFixit: deutsche Seite, englische Anleitungstitel) werden so nur teilweise übersetzt.
  function woerter(text) {
    const t = " " + text.slice(0, 1000).toLowerCase() + " ";
    return {
      en: (t.match(/(?<![\p{L}])(the|and|of|to|is|with|for|that|this|you|are|it|on|an|from|how|your|not|under|inside|replacement|repair|guide|removal|install|installation|disassembly|fix|cleaning|broken|water)(?![\p{L}])/gu) || []).length,
      de: (t.match(/(?<![\p{L}])(der|die|und|das|ist|mit|für|nicht|ein|eine|sie|auf|den|dem|des|von|zu|im|wie|bei|aus|austausch|reparatur|reparaturen|ersetzen|entfernen|wechseln|reinigen|anleitung|anleitungen|schritt|schritte|einleitung|zeitaufwand|schwierigkeitsgrad|kommentare|abgeschlossen|geschrieben|mitglied|seit|kostenlose)(?![\p{L}])/gu) || []).length,
    };
  }
  function sprache(text) {
    const w = woerter(text);
    const de = w.de + (/[äöüß]/i.test(text) ? 2 : 0);
    return w.en > de ? "en" : de > w.en ? "de" : "?";
  }

  // Textblöcke ohne weitere Textblöcke darin
  const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption, blockquote, caption, summary, label, div";
  function bloecke(doc) {
    return [...doc.body.querySelectorAll(BLOCK)].filter((e) => {
      if (e.closest("script, style, pre, code, noscript, svg, math")) return false;
      if (!e.textContent.trim() || e.textContent.trim().length < 2) return false;
      return !e.querySelector(BLOCK);
    });
  }

  // Artikel-Dokument im Lesefenster (Kiwix zeigt den Artikel in einem inneren Rahmen)
  function artikelDokument() {
    const rahmen = $("#lese-rahmen");
    try {
      const aussen = rahmen.contentDocument;
      const innen = aussen && aussen.querySelector("iframe");
      return (innen && innen.contentDocument) || aussen;
    } catch { return null; }
  }

  function anzeige(text, knopfText) {
    $("#uebersetzen-status").textContent = text || "";
    $("#uebersetzen-knopf").replaceChildren(...(knopfText === "Auf Deutsch" ? [sym("languages"), knopfText] : [knopfText]));
  }

  async function uebersetzeDokument(doc) {
    const meinLauf = ++lauf;
    if (!doc || !doc.body) return;
    aktuellesDok = doc;
    originale = new Map();
    // Jeden Absatz einzeln: deutsche bleiben, alle anderen werden übersetzt, wenn ihre Sprache installiert ist
    let francAll = null;
    try { francAll = await holeErkenner(); } catch { /* ohne Erkennung nur Englisch */ }
    if (meinLauf !== lauf) return;
    const text = doc.body.innerText || "";
    const seite = (francAll && erkenne(francAll, text.slice(0, 4000))) || (istEnglisch(text) ? "en" : "de");
    const da = installiert();
    da.add("en");
    const fehlt = new Map();   // Sprache → Buchstaben, für den Hinweis auf fehlende Sprachen
    const liste = [];
    for (const e of bloecke(doc)) {
      const s = francAll ? absatzSprache(francAll, e.textContent, seite)
        : (sprache(e.textContent) === "en" || (seite === "en" && sprache(e.textContent) !== "de") ? "en" : null);
      if (!s || s === "de") continue;
      if (da.has(s)) liste.push({ e, s });
      else fehlt.set(s, (fehlt.get(s) || 0) + e.textContent.trim().length);
    }
    // Nur nennen, was nach mehr als ein paar verirrten Wörtern aussieht
    const nennen = [...fehlt].filter(([, n]) => n >= 200).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    let fehltText = "";
    if (nennen.length) {
      let namen = [];
      try { namen = (await ladeKonfig("sprachen")).sprachen || []; } catch { }
      fehltText = nennen.map((c) => (namen.find((n) => n.code === c) || { name: c }).name).join(", ");
      if (meinLauf !== lauf) return;
    }
    if (!liste.length) {
      anzeige(fehltText ? fehltText + " ist nicht installiert (Inhalte › Übersetzer)" : "Seite ist schon deutsch", "Original");
      return;
    }
    anzeige("Übersetzer wird geladen …", "Original");
    let t;
    try { t = await holen(); }
    catch (e) { anzeige("Übersetzer konnte nicht starten: " + e.message, "Auf Deutsch"); an = false; return; }
    if (meinLauf !== lauf) return;

    // Sichtbares zuerst
    const hoehe = (doc.defaultView && doc.defaultView.innerHeight) || 800;
    let fertig = 0;
    anzeige("Übersetze … 0 %", "Original");
    await Promise.all(liste.map(({ e, s }) => {
      const oben = e.getBoundingClientRect().top;
      const prio = oben < hoehe * 1.5 ? 0 : oben < hoehe * 4 ? 1 : 2;
      const html = e.innerHTML;
      return t.translate({ from: s, to: "de", text: html, html: true, priority: prio }).then((r) => {
        if (meinLauf !== lauf || !e.isConnected) return;
        originale.set(e, html);
        e.innerHTML = r.target.text;
      }).catch(() => { }).finally(() => {
        fertig++;
        if (meinLauf === lauf && (fertig % 5 === 0 || fertig === liste.length))
          anzeige("Übersetze … " + Math.round(fertig / liste.length * 100) + " %", "Original");
      });
    }));
    if (meinLauf === lauf) anzeige("Maschinell übersetzt" + (fehltText ? ", außer " + fehltText + " (nicht installiert)" : ""), "Original");
  }

  function original() {
    lauf++;
    for (const [e, html] of originale) if (e.isConnected) e.innerHTML = html;
    originale = new Map();
    if (translator) translator.remove(() => true);
    anzeige("", "Auf Deutsch");
  }

  function umschalten() {
    an = !an;
    try { localStorage.setItem("ow-uebersetzen", an ? "1" : "0"); } catch { }
    if (an) uebersetzeDokument(artikelDokument()); else original();
  }

  // Wird bei jedem neuen Artikel aufgerufen (auch bei Links innerhalb des Lesefensters)
  function neueSeite() {
    $("#uebersetzen-knopf").hidden = !verfuegbar();
    if (!verfuegbar()) return;
    const doc = artikelDokument();
    if (!doc || doc === aktuellesDok) return;
    originale = new Map();
    anzeige("", an ? "Original" : "Auf Deutsch");
    if (an) uebersetzeDokument(doc);
  }

  // Lesefenster beobachten: äußerer Rahmen (Kiwix-Viewer) und innerer Artikelrahmen
  function anbinden() {
    const rahmen = $("#lese-rahmen");
    const verbindeInnen = () => {
      try {
        const innen = rahmen.contentDocument && rahmen.contentDocument.querySelector("iframe");
        if (innen && !innen.dataset.fsUebersetzer) {
          innen.dataset.fsUebersetzer = "1";
          innen.addEventListener("load", () => setTimeout(neueSeite, 150));
        }
      } catch { }
      setTimeout(neueSeite, 150);
    };
    rahmen.addEventListener("load", verbindeInnen);
    $("#uebersetzen-knopf").addEventListener("click", umschalten);
  }

  // Beliebige Textstellen ins Deutsche übersetzen (PDF-Leser): Sprache wie bei Artikeln je Absatz erkennen,
  // deutsche Absätze und nicht installierte Sprachen bleiben. Ergebnis: Anzahl übersetzter Stellen und die
  // Namen fehlender Sprachen. fertig(e) wird nach jeder übersetzten Stelle aufgerufen (z. B. zum Einpassen).
  async function elementeUebersetzen(elemente, fertig) {
    if (!elemente.length) return { anzahl: 0, fehlt: [] };
    let francAll = null;
    try { francAll = await holeErkenner(); } catch { /* ohne Erkennung nur Englisch */ }
    const text = elemente.map((e) => e.textContent).join(" ");
    const seite = (francAll && erkenne(francAll, text.slice(0, 4000))) || (istEnglisch(text) ? "en" : "de");
    const da = installiert();
    da.add("en");
    const liste = [], fehlt = new Set();
    for (const e of elemente) {
      const s = francAll ? absatzSprache(francAll, e.textContent, seite)
        : (sprache(e.textContent) === "en" || (seite === "en" && sprache(e.textContent) !== "de") ? "en" : null);
      if (!s || s === "de") continue;
      if (da.has(s)) liste.push({ e, s }); else fehlt.add(s);
    }
    if (!liste.length) return { anzahl: 0, fehlt: [...fehlt] };
    const t = await holen();
    await Promise.all(liste.map(({ e, s }) => t.translate({ from: s, to: "de", text: e.innerHTML, html: true, priority: 0 })
      .then((r) => { if (e.isConnected) { e.innerHTML = r.target.text; if (fertig) fertig(e); } })
      .catch(() => { })));
    return { anzahl: liste.length, fehlt: [...fehlt] };
  }

  // Gemeinsamer Schalter „Auf Deutsch“ (gilt für Artikel und PDF-Bücher, wird gemerkt)
  const istAn = () => an;
  function setzeAn(wert) {
    an = !!wert;
    try { localStorage.setItem("ow-uebersetzen", an ? "1" : "0"); } catch { }
  }

  return { anbinden, neueSeite, verfuegbar, elementeUebersetzen, istAn, setzeAn };
})();
