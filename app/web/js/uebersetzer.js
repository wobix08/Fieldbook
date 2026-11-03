// Offline-Übersetzer Englisch → Deutsch für die Leseansicht (Bergamot von Mozilla, läuft im Browser).
// Bibliothek und Sprachmodell liegen in programme\uebersetzer und werden unter /uebersetzer/ ausgeliefert.
"use strict";

const Uebersetzer = (() => {
  let translator = null;
  let laden = null;
  let an = false;              // Übersetzen eingeschaltet? Gilt dann auch für weitere Artikel
  let lauf = 0;                // Zählt Übersetzungsläufe, damit ein alter Lauf abbricht
  let originale = new Map();   // Element → ursprüngliches HTML
  let aktuellesDok = null;

  try { an = localStorage.getItem("ow-uebersetzen") === "1"; } catch { }

  const verfuegbar = () => !!(OW.status && OW.status.uebersetzer);

  function holen() {
    if (translator) return Promise.resolve(translator);
    if (!laden) {
      laden = import("/uebersetzer/lib/translator.js").then((mod) => {
        // Ein bis zwei Rechenkerne: schnell genug, ohne den Laptop zu blockieren
        const kerne = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
        translator = new mod.BatchTranslator({
          registryUrl: "/api/uebersetzer/modelle", pivotLanguage: null, downloadTimeout: 0,
          workers: kerne, batchSize: 8, cacheSize: 4000,
        });
        return translator;
      }).catch((e) => { laden = null; throw e; });
    }
    return laden;
  }

  // Grob prüfen, ob ein Text englisch ist (häufige Wörter zählen)
  function istEnglisch(text) {
    const t = " " + text.slice(0, 4000).toLowerCase() + " ";
    const en = (t.match(/\b(the|and|of|to|is|with|for|that|this|you|are|it)\b/g) || []).length;
    const de = (t.match(/\b(der|die|und|das|ist|mit|für|nicht|ein|eine|sie|auf|den)\b/g) || []).length;
    return en > 8 && en > de * 1.5;
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
    if (!istEnglisch(doc.body.innerText || "")) { anzeige("Seite ist schon deutsch", "Original"); return; }
    const liste = bloecke(doc);
    if (!liste.length) return;
    anzeige("Übersetzer wird geladen …", "Original");
    let t;
    try { t = await holen(); }
    catch (e) { anzeige("Übersetzer konnte nicht starten: " + e.message, "Auf Deutsch"); an = false; return; }
    if (meinLauf !== lauf) return;

    // Sichtbares zuerst
    const hoehe = (doc.defaultView && doc.defaultView.innerHeight) || 800;
    let fertig = 0;
    anzeige("Übersetze … 0 %", "Original");
    await Promise.all(liste.map((e) => {
      const oben = e.getBoundingClientRect().top;
      const prio = oben < hoehe * 1.5 ? 0 : oben < hoehe * 4 ? 1 : 2;
      const html = e.innerHTML;
      return t.translate({ from: "en", to: "de", text: html, html: true, priority: prio }).then((r) => {
        if (meinLauf !== lauf || !e.isConnected) return;
        originale.set(e, html);
        e.innerHTML = r.target.text;
      }).catch(() => { }).finally(() => {
        fertig++;
        if (meinLauf === lauf && (fertig % 5 === 0 || fertig === liste.length))
          anzeige("Übersetze … " + Math.round(fertig / liste.length * 100) + " %", "Original");
      });
    }));
    if (meinLauf === lauf) anzeige("Maschinell übersetzt", "Original");
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

  return { anbinden, neueSeite, verfuegbar };
})();
