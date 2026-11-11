// Text aus PDF-Büchern für die KI (z. B. Medizin-Handbücher, Ratgeber nach Katastrophen).
// Kiwix findet in PDFs nichts. Deshalb liest die Seite jedes Buch einmal mit pdf.js aus und schickt den
// Text an den Server, der ihn dauerhaft beim Paket ablegt (daten/wissen/pdf-texte). Das läuft im Hintergrund,
// sobald Fieldbook offen ist, und macht nach einer Unterbrechung beim nächsten Start mit dem nächsten Buch weiter.
"use strict";

const PdfText = (() => {
  let laeuft = false;
  let pauseBis = 0;
  const ohnePdf = new Set();   // Pakete ohne PDF-Bücher (in dieser Sitzung nicht noch einmal nachsehen)
  const fehlschlaege = new Map();   // Fehlversuche je Datei in dieser Sitzung
  // Solange der PDF-Leser offen ist, ruht das Auslesen (Blättern bleibt flüssig)
  const leserOffen = () => /^#pdf/.test(location.hash);
  let pdfjs = null;

  async function bibliothek() {
    if (!pdfjs) {
      pdfjs = await import("/vendor/pdfjs/pdf.min.js");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.js";
    }
    return pdfjs;
  }

  // Die PDF-Bücher eines Pakets stehen in seiner Bücherliste (database.js, so bauen die zimit-Pakete
  // ihre Startseite): Titel unter 'ti', Dateien unter 'fp'. Pakete ohne diese Liste haben keine.
  async function pdfsIm(id) {
    const r = await fetch("/kiwix/content/" + encodeURIComponent(id) + "/database.js");
    if (!r.ok) return [];
    const text = await r.text();
    const wert = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
    const ohneQuote = (s) => s.slice(1, -1).replace(/\\(.)/g, "$1");
    const liste = [];
    for (const z of text.split("\n")) {
      const ti = z.match(new RegExp("'ti':\\s*" + wert));
      const fp = z.match(/'fp':\s*\[([^\]]*)\]/);
      if (!fp) continue;
      for (const f of fp[1].matchAll(new RegExp(wert, "g"))) {
        const datei = ohneQuote(f[1]);
        if (/\.pdf$/i.test(datei)) liste.push({ datei, titel: ti ? ohneQuote(ti[1]) : datei.replace(/\.pdf$/i, "") });
      }
    }
    return liste;
  }

  // Text jeder Seite; Zeilenumbrüche bleiben erhalten (der Server setzt daraus Absätze zusammen)
  async function seitenText(url) {
    const lib = await bibliothek();
    const aufgabe = lib.getDocument({ url, isEvalSupported: false });
    let doc;
    try { doc = await aufgabe.promise; }
    catch (e) {
      // Laden fehlgeschlagen: Ladevorgang aufräumen, damit nichts im Hintergrund hängen bleibt
      try { await aufgabe.destroy(); } catch (_) { /* egal */ }
      throw e;
    }
    const seiten = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        // Kleine Pause alle paar Seiten, damit die KI und die Oberfläche nicht ausgebremst werden
        if (i % 4 === 0) await new Promise(res => setTimeout(res, 30));
        // Solange die KI eine Frage beantwortet, nur warten (kein Abbruch); Fragen kann fehlen
        while (leserOffen() || (typeof Fragen !== "undefined" && Fragen.beschaeftigt && Fragen.beschaeftigt())) await new Promise(res => setTimeout(res, 500));
        const seite = await doc.getPage(i);
        const inhalt = await seite.getTextContent();
        let s = "";
        for (const it of inhalt.items) {
          if (typeof it.str !== "string") continue;
          s += it.str;
          if (it.hasEOL) s += "\n"; else if (it.str && !/\s$/.test(it.str)) s += " ";
        }
        seiten.push(s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim());
        seite.cleanup();
      }
    } finally { doc.destroy(); }
    return seiten;
  }

  function hinweis(text) {
    const h = document.getElementById("pdf-hinweis");
    if (!h) return;
    h.hidden = !text;
    h.textContent = text || "";
  }

  async function paketLesen(buch, pdfs) {
    const stand = await api("pdftext/stand?buch=" + encodeURIComponent(buch.id));
    if (stand.fehler) throw new Error(stand.fehler);
    if (stand.fertig) return;
    const schon = new Set(stand.dateien || []);
    const basis = "/kiwix/content/" + encodeURIComponent(buch.id) + "/files/";
    let nr = pdfs.filter(p => schon.has(p.datei)).length;
    let uebersprungen = false, nochmal = false;
    for (const p of pdfs) {
      if (schon.has(p.datei)) continue;
      const key = buch.id + "/" + p.datei;
      // Nach 2 Fehlschlägen in dieser Sitzung überspringen (der nächste Start versucht es wieder)
      if ((fehlschlaege.get(key) || 0) >= 2) { uebersprungen = true; continue; }
      nr++;
      hinweis("Bücher in „" + buch.titel + "“ werden für die KI vorbereitet (" + nr + " von " + pdfs.length + ") …");
      const url = basis + encodeURIComponent(p.datei);
      let seiten;
      try { seiten = await seitenText(url); }
      catch (e) {
        // Nicht leer speichern: Der nächste Start versucht dieses Buch noch einmal
        console.warn("PDF-Text:", p.datei, e);
        const n = (fehlschlaege.get(key) || 0) + 1;
        fehlschlaege.set(key, n);
        if (n >= 2) uebersprungen = true; else nochmal = true;
        continue;
      }
      const r = await api("pdftext/speichern", { buch: buch.id, datei: p.datei, titel: p.titel, seiten });
      if (r.fehler) throw new Error(r.fehler);
      seiten.length = 0;
    }
    // Ein Buch hat nur einmal versagt: in einer Minute noch einmal (Pause setzt pruefen())
    if (nochmal) throw new Error("PDF-Buch in „" + buch.titel + "“ ließ sich nicht auslesen");
    if (uebersprungen) { ohnePdf.add(buch.id); return; }   // nicht als fertig melden, aber in dieser Sitzung nicht mehr anfassen
    await api("pdftext/speichern", { buch: buch.id, fertig: true });
  }

  // Nach jedem Status-Abruf: Gibt es installierte Pakete mit PDF-Büchern, deren Text noch fehlt?
  async function pruefen() {
    const s = OW.status;
    if (laeuft || !s || !s.bibliothek || Date.now() < pauseBis || leserOffen()) return;
    laeuft = true;
    try {
      const fertig = s.pdfTexte || {};
      const arbeit = async () => {
        for (const b of await Kiwix.buecher()) {
          if (fertig[b.id] === true || ohnePdf.has(b.id)) continue;
          const pdfs = await pdfsIm(b.id);
          if (!pdfs.length) { ohnePdf.add(b.id); continue; }
          await paketLesen(b, pdfs);
        }
      };
      // Sind mehrere Fieldbook-Tabs offen, liest nur einer aus
      if (navigator.locks) await navigator.locks.request("fieldbook-pdftext", { ifAvailable: true }, (lock) => lock ? arbeit() : null);
      else await arbeit();
    } catch (e) {
      // Bibliothek startet gerade neu o. Ä.: in einer Minute noch einmal
      console.warn("PDF-Text:", e);
      pauseBis = Date.now() + 60000;
    } finally {
      laeuft = false;
      hinweis(null);
    }
  }

  return { pruefen, bibliothek, pdfsIm };
})();
