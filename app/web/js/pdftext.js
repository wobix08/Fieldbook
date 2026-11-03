// Text aus PDF-Büchern für die KI (z. B. Medizin-Handbücher, Ratgeber nach Katastrophen).
// Kiwix findet in PDFs nichts. Deshalb liest die Seite jedes Buch einmal mit pdf.js aus und schickt den
// Text an den Server, der ihn dauerhaft beim Paket ablegt (daten/wissen/pdf-texte). Das läuft im Hintergrund,
// sobald Fieldbook offen ist, und macht nach einer Unterbrechung beim nächsten Start mit dem nächsten Buch weiter.
"use strict";

const PdfText = (() => {
  let laeuft = false;
  let pauseBis = 0;
  const ohnePdf = new Set();   // Pakete ohne PDF-Bücher (in dieser Sitzung nicht noch einmal nachsehen)
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
    const doc = await lib.getDocument({ url, isEvalSupported: false }).promise;
    const seiten = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
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
    for (const p of pdfs) {
      if (schon.has(p.datei)) continue;
      nr++;
      hinweis("Bücher in „" + buch.titel + "“ werden für die KI vorbereitet (" + nr + " von " + pdfs.length + ") …");
      const url = basis + encodeURIComponent(p.datei);
      let seiten;
      try { seiten = await seitenText(url); }
      catch (e) {
        // Ist die Datei erreichbar, ist das PDF selbst nicht lesbar: leer merken, sonst beim nächsten Mal neu versuchen
        const da = await fetch(url, { method: "HEAD" }).then(r => r.ok).catch(() => false);
        if (!da) throw e;
        seiten = [];
      }
      const r = await api("pdftext/speichern", { buch: buch.id, datei: p.datei, titel: p.titel, seiten });
      if (r.fehler) throw new Error(r.fehler);
      seiten.length = 0;
    }
    await api("pdftext/speichern", { buch: buch.id, fertig: true });
  }

  // Nach jedem Status-Abruf: Gibt es installierte Pakete mit PDF-Büchern, deren Text noch fehlt?
  async function pruefen() {
    const s = OW.status;
    if (laeuft || !s || !s.bibliothek || Date.now() < pauseBis) return;
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

  return { pruefen };
})();
