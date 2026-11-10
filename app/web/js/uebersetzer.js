// Offline-Übersetzer ins Deutsche für die Leseansicht (Bergamot von Mozilla, läuft im Browser):
// Englisch immer, andere Sprachen, wenn sie für den Gesprächs-Übersetzer installiert sind.
// Bibliothek und Sprachmodell liegen in programme\uebersetzer und werden unter /uebersetzer/ ausgeliefert.
"use strict";

const Uebersetzer = (() => {
  let an = false;              // Übersetzen eingeschaltet? Gilt dann auch für weitere Artikel
  let lauf = 0;                // Zählt Übersetzungsläufe, damit ein alter Lauf abbricht
  let originale = new Map();   // Element → ursprüngliches HTML
  let aktuellesDok = null;

  try { an = localStorage.getItem("ow-uebersetzen") === "1"; } catch { }

  const verfuegbar = () => !!(OW.status && OW.status.uebersetzer);
  const installiert = () => new Set((OW.status && OW.status.sprachen) || []);

  // ---------------------------------------------------------------- Warteschlange und Worker
  // Eigene Warteschlange statt des BatchTranslator aus der Bibliothek. Mit dem blieb die Übersetzung im
  // PDF-Leser hängen oder wurde sehr langsam:
  // - Starten zwei Worker zugleich und findet der zweite keine Arbeit mehr, stolpert er (Fehler „reading
  //   'requests'“) und gilt danach für immer als beschäftigt. Ein hängender oder abgestürzter Worker wurde nie
  //   ersetzt, Fehler wurden still verschluckt: danach passierte gar nichts mehr.
  // - Aufträge liefen streng der Reihe nach. Nach Seitenwechseln oder einem Wechsel der Ansicht wurden alte,
  //   längst unsichtbare Seiten zuerst übersetzt, die neue Seite wartete dahinter.
  // Hier hat jeder Auftrag einen Vorrang (eine Zahl oder eine Funktion, die bei jedem Verteilen neu gefragt
  // wird, z. B. Abstand zur sichtbaren Seite) und eine Prüfung, ob er noch gebraucht wird. Verteilt wird immer
  // das Wichtigste, nicht mehr Gebrauchtes fällt weg. Antwortet ein Worker nicht oder meldet er einen Fehler,
  // wird er beendet und durch einen neuen ersetzt. Fertige Übersetzungen merkt sich ein Zwischenspeicher, und
  // gleiche Texte werden nur einmal übersetzt (Zurückblättern geht dann sofort).
  // Andere Sprachen gehen über Englisch (wie im Übersetzer): z. B. Spanisch → Englisch → Deutsch.

  const WORKER_URL = "/uebersetzer/lib/worker/translator-worker.js";
  const STAPEL_STUECKE = 10;      // höchstens so viele Texte in einem Aufruf …
  const STAPEL_ZEICHEN = 1200;    // … und so viele Zeichen (kleinere Stapel: die sichtbare Seite ist schneller da)
  const SPEICHER_MAX = 3000;      // gemerkte Übersetzungen
  const START_MS = 180000;        // Worker starten oder Modell laden darf so lange dauern
  const MODELL_MS = 60000;        // Modellregister und Modelldateien holen darf so lange dauern
  const LEERLAUF_MS = 180000;     // Worker ohne Arbeit wird nach so langer Zeit beendet
  // Ein bis zwei Rechenkerne: schnell genug, ohne den Laptop zu blockieren
  const maxWorker = () => Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));

  let modul = null;               // Promise der Bibliothek (translator.js)
  let backing = null, backingSig = "";   // Promise eines TranslatorBacking (Modellregister und Modelldateien)
  const warte = [];               // wartende Aufträge
  const offen = new Map();        // Schlüssel → Auftrag (wartend oder in Arbeit), gleiche Texte nur einmal
  const worker = [];              // { w, zustand: "startet" | "frei" | "arbeitet" | "weg", modelle, aufrufe }
  const speicher = new Map();     // Schlüssel → fertige Übersetzung (älteste fliegen zuerst raus)
  let nr = 0, rufNr = 0, startFehler = 0, geplant = false;
  // Zum Prüfen in der Konsole: Uebersetzer.zustand()
  const zahlen = { erledigt: 0, ausSpeicher: 0, verworfen: 0, fehler: 0, neustarts: 0, letzterFehler: "", letzterStapel: "" };

  class Verworfen extends Error { constructor() { super("nicht mehr gebraucht"); this.name = "Verworfen"; } }

  const holeModul = () => modul || (modul = import("/uebersetzer/lib/translator.js").catch((e) => { modul = null; throw e; }));

  // Modellregister: Kommt eine Sprache dazu, neu anlegen, damit es ihre Modelle kennt
  function backingHolen() {
    const sig = [...installiert()].sort().join(",");
    if (!backing || sig !== backingSig) {
      backingSig = sig;
      const p = backing = holeModul().then((m) => {
        const b = new m.TranslatorBacking({ registryUrl: "/api/uebersetzer/modelle", pivotLanguage: "en", downloadTimeout: 0 });
        b.registry.catch(() => { });   // Fehler kommt beim Abfragen an, nicht als „unbehandelt“
        return b;
      });
      p.catch(() => { if (backing === p) backing = null; });
    }
    return backing;
  }

  const gilt = (x) => { try { return !x.gueltig || !!x.gueltig(); } catch { return false; } };
  const vorrangVon = (x) => { let p = x.prio; try { if (typeof p === "function") p = p(); } catch { p = 99; } return Number.isFinite(+p) ? +p : 0; };
  const vorrang = (a) => Math.min(...a.wer.map(vorrangVon));

  // Ein Auftrag: { from, to, text, html, priority (Zahl oder Funktion, kleiner = früher), gueltig() }.
  // Ergebnis wie bei der Bibliothek: { request, target: { text } }. Nicht mehr gebrauchte Aufträge enden mit
  // einem Fehler namens "Verworfen".
  function uebersetze(anfrage) {
    const key = anfrage.from + ">" + anfrage.to + (anfrage.html ? "|h|" : "|t|") + anfrage.text;
    if (speicher.has(key)) {
      const text = speicher.get(key);
      speicher.delete(key); speicher.set(key, text);   // wieder nach hinten: zuletzt gebraucht
      zahlen.ausSpeicher++;
      return Promise.resolve({ request: anfrage, target: { text } });
    }
    return new Promise((resolve, reject) => {
      const wer = { resolve, reject, prio: anfrage.priority, gueltig: anfrage.gueltig, anfrage };
      const a = offen.get(key);
      if (a) { a.wer.push(wer); return; }              // derselbe Text ist schon unterwegs
      const neu = { key, from: anfrage.from, to: anfrage.to, text: String(anfrage.text), html: !!anfrage.html,
        wer: [wer], nr: ++nr, versuche: 0, einzeln: false };
      offen.set(key, neu);
      warte.push(neu);
      anstossen();
    });
  }

  // Alle Aufträge eines Durchgangs sammeln, dann einmal verteilen (so entstehen volle Stapel)
  function anstossen() {
    if (geplant) return;
    geplant = true;
    setTimeout(() => { geplant = false; verteilen(); }, 0);
  }

  // Aufträge, die niemand mehr braucht, verwerfen
  function aufraeumen() {
    for (let i = warte.length - 1; i >= 0; i--) {
      const a = warte[i];
      a.wer = a.wer.filter((x) => { if (gilt(x)) return true; zahlen.verworfen++; x.reject(new Verworfen()); return false; });
      if (!a.wer.length) { warte.splice(i, 1); offen.delete(a.key); }
    }
  }

  // Wie remove() der Bibliothek: filter(anfrage) === true heißt verwerfen
  function entfernen(filter) {
    for (const a of warte) for (const x of a.wer) if (filter(x.anfrage)) x.gueltig = () => false;
    aufraeumen();
  }

  function verteilen() {
    aufraeumen();
    while (warte.length) {
      const w = worker.find((x) => x.zustand === "frei");
      if (!w) {
        // Noch Platz für einen Worker? Der meldet sich, sobald er bereit ist
        const startend = worker.filter((x) => x.zustand === "startet").length;
        if (worker.length < maxWorker() && warte.length > startend * STAPEL_STUECKE) neuerWorker();
        return;
      }
      arbeiten(w, stapelBilden());
    }
  }

  // Das Wichtigste zuerst, dazu weitere Texte derselben Sprache (in Vorrang-Reihenfolge), bis der Stapel voll ist
  function stapelBilden() {
    const sortiert = warte.map((a) => ({ a, p: vorrang(a) })).sort((x, y) => x.p - y.p || x.a.nr - y.a.nr);
    const erster = sortiert[0].a, stapel = [erster];
    let zeichen = erster.text.length;
    if (!erster.einzeln) {
      for (const { a } of sortiert.slice(1)) {
        if (stapel.length >= STAPEL_STUECKE || zeichen >= STAPEL_ZEICHEN) break;
        if (a.einzeln || a.from !== erster.from || a.to !== erster.to) continue;
        if (zeichen + a.text.length > STAPEL_ZEICHEN) break;
        stapel.push(a);
        zeichen += a.text.length;
      }
    }
    for (const a of stapel) warte.splice(warte.indexOf(a), 1);
    return stapel;
  }

  async function arbeiten(w, stapel) {
    w.zustand = "arbeitet";
    let abschnitt = "modelle";
    const t0 = performance.now(), zeichen = stapel.reduce((n, a) => n + a.text.length, 0);
    clearTimeout(w.leerlauf);
    try {
      // Holen der Modelle mit Frist: hängt der Server, bleibt der Worker sonst ewig „arbeitet“. Bei Ablauf
      // landet der Fehler im Abschnitt „modelle“ (Register wird verworfen, Auftrag einmal neu eingereiht).
      const b = await mitFrist(backingHolen(), MODELL_MS, "Modellregister");
      const modelle = await mitFrist(b.getModels({ from: stapel[0].from, to: stapel[0].to }), MODELL_MS, "Modellliste");
      for (const { from, to } of modelle) {
        if (w.modelle.has(from + to)) continue;
        abschnitt = "modelle";
        const puffer = await mitFrist(b.getTranslationModel({ from, to }), MODELL_MS, "Sprachmodell");
        abschnitt = "worker";
        await w.rufe("loadTranslationModel", [{ from, to }, puffer], START_MS);
        w.modelle.add(from + to);
      }
      abschnitt = "worker";
      // Großzügige Frist: ein langsamer Laptop braucht für einen vollen Stapel einige Sekunden
      const antworten = await w.rufe("translate", [{
        models: modelle.map(({ from, to }) => ({ from, to })),
        texts: stapel.map((a) => ({ text: a.text, html: a.html, qualityScores: false })),
      }], 60000 + zeichen * 50);
      zahlen.letzterStapel = stapel.length + " Texte, " + zeichen + " Zeichen, " + Math.round(performance.now() - t0) + " ms";
      stapel.forEach((a, i) => fertigMelden(a, antworten[i] && antworten[i].target ? antworten[i].target.text : null));
    } catch (e) {
      zahlen.fehler++;
      zahlen.letzterFehler = (e && e.message) || String(e);
      console.warn("Übersetzer:", zahlen.letzterFehler);
      // Fehler im Worker: der ist danach nicht mehr verlässlich, ersetzen. Fehler beim Laden der Modelle:
      // Register beim nächsten Mal neu holen.
      if (abschnitt === "worker") wegwerfen(w, e); else backing = null;
      // Noch einmal versuchen, aus einem Stapel einzeln (ein Text, der Fehler auslöst, legt so nicht alle lahm)
      for (const a of stapel) {
        a.versuche++;
        if (a.versuche >= 2) { offen.delete(a.key); for (const x of a.wer) x.reject(e); continue; }
        if (stapel.length > 1) a.einzeln = true;
        warte.push(a);
      }
    } finally {
      if (w.zustand === "arbeitet") { w.zustand = "frei"; leerlaufPlanen(w); }
      anstossen();
    }
  }

  // Promise mit Zeitgrenze (Promise.race); der Timer wird immer aufgeräumt
  function mitFrist(p, ms, was) {
    let uhr;
    const ablauf = new Promise((_, reject) => { uhr = setTimeout(() => reject(new Error(was + ": keine Antwort vom Server")), ms); });
    return Promise.race([p, ablauf]).finally(() => clearTimeout(uhr));
  }

  // Ein Worker ohne Arbeit gibt nach einigen Minuten seinen Speicher frei; bei Bedarf entsteht ein neuer
  function leerlaufPlanen(w) {
    clearTimeout(w.leerlauf);
    w.leerlauf = setTimeout(() => {
      if (w.zustand !== "frei") return;
      wegwerfen(w, new Error("Übersetzer-Worker beendet (Leerlauf)"), true);
    }, LEERLAUF_MS);
  }

  function fertigMelden(a, text) {
    offen.delete(a.key);
    if (typeof text !== "string") { for (const x of a.wer) x.reject(new Error("keine Übersetzung erhalten")); return; }
    zahlen.erledigt++;
    speicher.set(a.key, text);
    if (speicher.size > SPEICHER_MAX) speicher.delete(speicher.keys().next().value);
    for (const x of a.wer) x.resolve({ request: x.anfrage, target: { text } });
  }

  // Ein Worker der Bibliothek (Bergamot als WebAssembly). Jeder Aufruf hat eine Frist.
  function neuerWorker() {
    const w = { zustand: "startet", modelle: new Set(), aufrufe: new Map(), w: null };
    worker.push(w);
    try { w.w = new Worker(WORKER_URL); }
    catch (e) { wegwerfen(w, e); startFehlschlag(e); return w; }
    w.w.addEventListener("message", ({ data }) => {
      const ruf = data && w.aufrufe.get(data.id);
      if (!ruf) return;
      w.aufrufe.delete(data.id);
      clearTimeout(ruf.uhr);
      if (data.error !== undefined) ruf.reject(Object.assign(new Error((data.error && data.error.message) || "Fehler im Übersetzer"), { name: (data.error && data.error.name) || "Error" }));
      else ruf.resolve(data.result);
    });
    // Absturz im Worker (z. B. zu wenig Speicher): ersetzen
    w.w.addEventListener("error", (e) => { if (e.preventDefault) e.preventDefault(); wegwerfen(w, new Error("Übersetzer-Worker abgestürzt: " + (e.message || "unbekannt"))); });
    w.w.addEventListener("messageerror", () => wegwerfen(w, new Error("Übersetzer-Worker: Nachricht unlesbar")));
    w.rufe = (name, args, ms) => new Promise((resolve, reject) => {
      if (w.zustand === "weg") { reject(new Error("Übersetzer-Worker beendet")); return; }
      const id = ++rufNr;
      const uhr = setTimeout(() => wegwerfen(w, new Error("Übersetzer antwortet nicht (" + name + ")")), ms);
      w.aufrufe.set(id, { resolve, reject, uhr });
      try { w.w.postMessage({ id, name, args }); }
      catch (e) { clearTimeout(uhr); w.aufrufe.delete(id); reject(e); }
    });
    w.rufe("initialize", [{ cacheSize: 4000, useNativeIntGemm: false }], START_MS).then(() => {
      if (w.zustand !== "startet") return;
      startFehler = 0;
      w.zustand = "frei";
      leerlaufPlanen(w);
      anstossen();
    }, (e) => { wegwerfen(w, e); startFehlschlag(e); });
    return w;
  }

  // Startet der Worker zweimal hintereinander nicht, die wartenden Aufträge mit dem Fehler beenden
  // (sonst würde es endlos neu versucht). Der nächste neue Auftrag versucht es wieder.
  function startFehlschlag(e) {
    zahlen.letzterFehler = (e && e.message) || String(e);
    console.warn("Übersetzer startet nicht:", zahlen.letzterFehler);
    if (++startFehler < 2) { anstossen(); return; }
    startFehler = 0;
    for (const a of warte.splice(0)) { offen.delete(a.key); for (const x of a.wer) x.reject(e); }
  }

  function wegwerfen(w, fehler, leise) {
    if (w.zustand === "weg") return;
    w.zustand = "weg";
    clearTimeout(w.leerlauf);
    const i = worker.indexOf(w);
    if (i >= 0) worker.splice(i, 1);
    if (!leise) zahlen.neustarts++;
    try { if (w.w) w.w.terminate(); } catch { }
    for (const ruf of w.aufrufe.values()) { clearTimeout(ruf.uhr); ruf.reject(fehler); }
    w.aufrufe.clear();
    anstossen();
  }

  // Für Artikel und PDF-Leser: lädt die Bibliothek (Fehler kommen hier an) und gibt die Warteschlange
  const schlange = { translate: uebersetze, remove: entfernen };
  function holen() { return holeModul().then(() => schlange); }

  // Für den Übersetzer (Gespräch): einen Text übersetzen, vor Artikeln und PDF-Seiten
  async function textUebersetzen(von, nach, text) {
    const t = await holen();
    const r = await t.translate({ from: von, to: nach, text, html: false, priority: -1 });
    return r.target.text;
  }

  // Zum Prüfen in der Konsole
  function zustand() {
    return Object.assign({
      warten: warte.length,
      wartenTexte: warte.reduce((n, a) => n + a.wer.length, 0),
      worker: worker.map((w) => w.zustand + (w.modelle.size ? " (" + [...w.modelle].join(",") + ")" : "")),
      gemerkt: speicher.size,
    }, zahlen);
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
    let fertig = 0, erfolge = 0, fehler = 0, letzterGrund = "";
    anzeige("Übersetze … 0 %", "Original");
    await Promise.all(liste.map(({ e, s }) => {
      const oben = e.getBoundingClientRect().top;
      const prio = oben < hoehe * 1.5 ? 0 : oben < hoehe * 4 ? 1 : 2;
      const html = e.innerHTML;
      // Neuer Artikel oder „Original“: wartende Aufträge dieses Laufs fallen weg, statt abgearbeitet zu werden
      return t.translate({ from: s, to: "de", text: html, html: true, priority: prio, gueltig: () => meinLauf === lauf && e.isConnected }).then((r) => {
        if (meinLauf !== lauf || !e.isConnected) return;
        originale.set(e, html);
        e.innerHTML = r.target.text;
        erfolge++;
      }).catch((err) => {
        // Nicht mehr gebrauchte Aufträge sind kein Fehler; alles andere zählen und merken
        if (err && err.name === "Verworfen") return;
        fehler++;
        letzterGrund = (err && err.message) || String(err);
      }).finally(() => {
        fertig++;
        if (meinLauf === lauf && (fertig % 5 === 0 || fertig === liste.length))
          anzeige("Übersetze … " + Math.round(fertig / liste.length * 100) + " %", "Original");
      });
    }));
    if (meinLauf !== lauf) return;
    if (!erfolge && fehler) {
      anzeige("Die Übersetzung hat nicht geklappt." + (letzterGrund ? " (" + letzterGrund + ")" : ""), "Auf Deutsch");
      an = false;
      return;
    }
    anzeige("Maschinell übersetzt" + (fehler ? " (" + fehler + " Stellen nicht übersetzbar)" : "") + (fehltText ? ", außer " + fehltText + " (nicht installiert)" : ""), "Original");
  }

  function original() {
    lauf++;
    for (const [e, html] of originale) if (e.isConnected) e.innerHTML = html;
    originale = new Map();
    aufraeumen();               // wartende Aufträge des Artikels verwerfen (sie gehören zum alten Lauf)
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
  // optionen.prio: Zahl oder Funktion (kleiner = früher; wird bei jedem Verteilen neu gefragt, z. B. Abstand
  // zur sichtbaren Seite). optionen.gueltig(): false, sobald die Stellen nicht mehr gebraucht werden; ihre
  // wartenden Aufträge fallen dann weg. Stellen, die aus der Seite entfernt wurden, fallen immer weg.
  async function elementeUebersetzen(elemente, fertig, optionen) {
    const opt = optionen || {};
    const nochGebraucht = () => { try { return !opt.gueltig || !!opt.gueltig(); } catch { return false; } };
    if (!elemente.length) return { anzahl: 0, fehlt: [], verworfen: 0 };
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
    if (!liste.length) return { anzahl: 0, fehlt: [...fehlt], verworfen: 0 };
    const t = await holen();
    if (!nochGebraucht()) return { anzahl: 0, fehlt: [...fehlt], verworfen: liste.length };
    const prio = opt.prio === undefined ? 0 : opt.prio;
    let anzahl = 0, verworfen = 0, fehler = null;
    await Promise.all(liste.map(({ e, s }) => {
      // Ohne Auszeichnung (fett, kursiv …) als reiner Text: spart dem Übersetzer das Zuordnen der Tags
      const html = e.children.length > 0;
      return t.translate({ from: s, to: "de", text: html ? e.innerHTML : e.textContent, html, priority: prio,
        gueltig: () => e.isConnected && nochGebraucht() })
        .then((r) => {
          if (!e.isConnected) return;
          if (html) e.innerHTML = r.target.text; else e.textContent = r.target.text;
          anzahl++;
          if (fertig) fertig(e);
        })
        .catch((err) => { if (err && err.name === "Verworfen") verworfen++; else fehler = err; });
    }));
    // Ging gar nichts, den Fehler melden (sonst bliebe die Seite still englisch)
    if (fehler && !anzahl && !verworfen) throw fehler;
    return { anzahl, fehlt: [...fehlt], verworfen };
  }

  // Gemeinsamer Schalter „Auf Deutsch“ (gilt für Artikel und PDF-Bücher, wird gemerkt)
  const istAn = () => an;
  function setzeAn(wert) {
    an = !!wert;
    try { localStorage.setItem("ow-uebersetzen", an ? "1" : "0"); } catch { }
  }

  return { anbinden, neueSeite, verfuegbar, elementeUebersetzen, textUebersetzen, istAn, setzeAn, zustand };
})();
