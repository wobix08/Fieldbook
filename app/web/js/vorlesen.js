// Lesefenster: Artikel vorlesen, aber nicht stumpf von oben nach unten.
// Neben jeder Überschrift steht dezent ein Lautsprecher (nur wenn eine Stimme da ist); ein Tipp darauf liest ab dort,
// am Ende eines Abschnitts geht es mit dem nächsten weiter. Markierter Text bekommt daneben ein kleines Feld
// „Vorlesen“. Gelesen wird Stück für Stück mit Piper (/api/vorlesen), das nächste wird schon vorbereitet,
// während das aktuelle läuft. Tabellen, Infokästen, Bildunterschriften und Quellenangaben werden übersprungen.
// Die Leiste unten zeigt den Abschnitt, die Zeit (geschätzt aus der Textlänge), lässt spulen und hat eine eigene
// Lautstärke nur für Fieldbook. Das gerade gesprochene Wort wird markiert: Das neue Piper (piper-py) schickt die
// genaue Zeit jedes Wortes mit (Kopfzeile X-Wortzeiten). Mit dem alten Piper verteilt Fieldbook die Dauer eines
// Stücks nach Wortlänge und Satzzeichen.
"use strict";

const Vorlesen = (() => {
  const rahmen = $("#lese-rahmen"), koerper = rahmen.parentElement;
  const UEBERSCHRIFT = "h1, h2, h3, h4";
  const BLOCK = "p, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6";
  // Was vorgelesen wirr klingt oder nicht zum Fließtext gehört
  const WEG = "table, figure, figcaption, .infobox, .thumb, .navbox, .metadata, .mw-editsection, .reference, " +
    "ol.references, .references, .reflist, .mw-references-wrap, .hatnote, .toc, #toc, nav, aside, script, style, " +
    "noscript, pre, code, math, svg, sup, .noprint, .fb-vl, .fb-markfeld, [aria-hidden='true']";
  const SPZ = 0.075;       // Sekunden je Zeichen, bis die ersten Stücke gemessen sind

  let lauf = null;         // laufendes Vorlesen, siehe starten()
  let markFeld = null;     // Feld „Vorlesen“ neben markiertem Text
  let lautstaerke = 1;     // nur für Fieldbook, die Lautstärke von Windows bleibt unberührt
  try { const v = parseFloat(localStorage.getItem("vlLautstaerke")); if (v >= 0 && v <= 1) lautstaerke = v; } catch { }

  const stimmen = () => (OW.status && OW.status.stimmen) || [];
  const kannVorlesen = () => stimmen().length > 0;

  function artikelDok() {
    try {
      const innen = rahmen.contentDocument.getElementById("content_iframe");
      const w = (innen || rahmen).contentWindow;
      if (!/^\/kiwix\/content\/[^/]+\/./.test(w.location.pathname) || /\.pdf$/i.test(w.location.pathname)) return null;
      return w.document && w.document.body ? w.document : null;
    } catch { return null; }
  }

  // Sprache am Text erkennen (nach „Auf Deutsch“ ist ein englischer Artikel deutsch), sonst laut Seite
  function spracheVon(text, doc) {
    const w = (" " + text.toLowerCase() + " ").replace(/[^a-zäöüß]+/g, " ");
    const z = (re) => (w.match(re) || []).length;
    const de = z(/ (der|die|das|und|ist|nicht|mit|ein|eine|auf|sich|den|von|zu|im|auch) /g) + (/[äöüß]/.test(w) ? 2 : 0);
    const en = z(/ (the|and|is|of|to|in|that|with|for|are|was|it|on|as|this|by) /g);
    if (de > en) return "de";
    if (en > de) return "en";
    const l = doc && doc.documentElement.lang;
    return l ? l.slice(0, 2).toLowerCase() : "de";
  }

  // ------------------------------------------------ Texte sammeln

  const sauber = (t) => t.replace(/\[\d+\]|\[[a-z]\]/gi, "").replace(/\s+/g, " ").trim();

  // Text eines Blocks ohne das, was übersprungen wird (nur zum Prüfen, ob etwas zu lesen da ist)
  function blockText(e) {
    if (!e.querySelector(WEG)) return sauber(e.textContent);
    const k = e.cloneNode(true);
    k.querySelectorAll(WEG).forEach(x => x.remove());
    return sauber(k.textContent);
  }

  // Wörter mit ihrer Stelle im Dokument (für die Markierung beim Lesen). bereich: nur innerhalb dieser Markierung.
  // Ein Wort, das über zwei Textknoten geht (z. B. „SiO“ + tiefgestellte „2“), bleibt ein Wort.
  function woerter(root, bereich) {
    const doc = root.ownerDocument || root;
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest(WEG)) return NodeFilter.FILTER_REJECT;
      if (bereich && !bereich.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    } });
    const aus = [];
    let anschluss = false, n;
    while ((n = tw.nextNode())) {
      const t = n.data;
      let a = 0, b = t.length;
      if (bereich) { if (n === bereich.startContainer) a = bereich.startOffset; if (n === bereich.endContainer) b = bereich.endOffset; }
      const re = /\S+/g;
      re.lastIndex = a;
      let m;
      while ((m = re.exec(t)) && m.index < b) {
        const s = m.index, e = Math.min(s + m[0].length, b), letztes = aus[aus.length - 1];
        if (anschluss && s === a && letztes) { letztes.text += t.slice(s, e); letztes.endNode = n; letztes.end = e; }
        else aus.push({ text: t.slice(s, e), startNode: n, start: s, endNode: n, end: e });
        anschluss = false;
      }
      const letztes = aus[aus.length - 1];
      anschluss = !!(letztes && letztes.endNode === n && letztes.end === b && b === t.length);
    }
    return aus.filter(w => !/^\[(\d+|[a-z])\]$/i.test(w.text));
  }

  // Alle vorlesbaren Blöcke des Artikels in Lesereihenfolge (innerste Blöcke, keine Listen in Listen doppelt)
  function bloecke(doc) {
    return [...doc.body.querySelectorAll(BLOCK)].filter(e => {
      if (e.closest(WEG)) return false;
      if (e.matches("li") && e.querySelector("p")) return false;
      if (e.parentElement && e.parentElement.closest("li, blockquote, dd") && !e.matches("li")) return false;
      if (e.offsetParent === null && getComputedStyle(e).position !== "fixed") return false;   // versteckt
      return blockText(e).length > 1;
    });
  }

  // Wörter in Stücke teilen: an Satzenden ab etwa 200 Zeichen, spätestens bei 450 (erstes Wort kommt schneller)
  function stuecke(ws) {
    const aus = [];
    let akt = [], len = 0;
    for (const w of ws) {
      akt.push(w);
      len += w.text.length + 1;
      if ((len >= 200 && /[.!?:;]["“”»)]*$/.test(w.text)) || len >= 450) { aus.push(akt); akt = []; len = 0; }
    }
    if (akt.length) aus.push(akt);
    return aus;
  }

  // Ein Stück zum Vorlesen; gewichte[i] = Anteil der Sprechdauer bis zum Ende von Wort i
  function teil(el, ws, abschnitt) {
    const text = ws.map(w => w.text).join(" ");
    const g = ws.map(w => w.text.length + 1 + (/[.!?]["“”»)]*$/.test(w.text) ? 6 : /[,;:]$/.test(w.text) ? 3 : 0));
    const summe = g.reduce((a, b) => a + b, 0);
    let s = 0;
    return { el, woerter: ws, text, abschnitt, gewichte: g.map(x => (s += x) / summe) };
  }

  // Ab einer Überschrift (oder einem Block) bis zum Ende des Artikels, gegliedert nach Abschnitten
  function ab(doc, start) {
    const alle = bloecke(doc);
    let i = alle.indexOf(start);
    if (i < 0) i = alle.findIndex(e => start.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (i < 0) return { teile: [], abschnitte: [] };
    const teile = [], abschnitte = [];
    for (const e of alle.slice(i)) {
      if (!abschnitte.length || e.matches(UEBERSCHRIFT)) abschnitte.push({ titel: e.matches(UEBERSCHRIFT) ? blockText(e) : (doc.title || "") });
      for (const ws of stuecke(woerter(e))) teile.push(teil(e, ws, abschnitte.length - 1));
    }
    return { teile, abschnitte };
  }

  // ------------------------------------------------ Lautsprecher an den Überschriften

  function stil(doc) {
    if (doc.getElementById("fb-vl-stil")) return;
    const s = doc.createElement("style");
    s.id = "fb-vl-stil";
    s.textContent = `
      /* dezent: blass und ohne Rahmen, kräftig grün erst, wenn die Maus über der Überschrift ist */
      .fb-vl { all: unset; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle;
        width: 1.6rem !important; height: 1.6rem !important; margin: 0 .35rem 0 -.2rem !important; border-radius: 6px !important;
        cursor: pointer; color: var(--fb-text2, #888) !important; opacity: .35; border: 0 !important;
        background: transparent !important; position: relative; top: -.1em; transition: opacity .15s; }
      :is(h1, h2, h3, h4):hover > .fb-vl, .fb-vl:focus-visible { opacity: 1; color: var(--fb-akzent, #6f9a52) !important; }
      .fb-vl:hover, .fb-vl:focus-visible { background: rgba(111,154,82,.15) !important; }
      .fb-vl svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2;
        stroke-linecap: round; stroke-linejoin: round; }
      /* dreifache Klasse: stärker als die Regel in design.css, die im Dunkeln alle Hintergründe durchsichtig macht */
      html .fb-vl-jetzt.fb-vl-jetzt.fb-vl-jetzt { background-color: rgba(111,154,82,.13) !important;
        box-shadow: 0 0 0 4px rgba(111,154,82,.13) !important; border-radius: 3px; }
      /* Gleitende Wortmarkierung: halbdurchsichtig über dem Text, Klicks gehen durch */
      .fb-vl-gleiter { position: absolute; z-index: 2147482000; pointer-events: none; border-radius: 4px; opacity: 0;
        background: color-mix(in srgb, var(--fb-akzent, #6f9a52) 38%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--fb-akzent, #6f9a52) 55%, transparent); }
      .fb-markfeld { all: unset; position: absolute; z-index: 2147483000; display: flex; gap: 6px; }
      .fb-vl-markiert { all: unset; display: inline-flex; align-items: center;
        gap: 6px; padding: 5px 10px; border-radius: 6px; cursor: pointer; font: 600 14px "Segoe UI", sans-serif !important;
        background: var(--fb-akzent, #4f7a38) !important; color: var(--fb-bg, #fff) !important; box-shadow: 0 3px 12px rgba(0,0,0,.35); }
      .fb-vl-markiert:hover { filter: brightness(1.08); }
      .fb-vl-markiert svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2;
        stroke-linecap: round; stroke-linejoin: round; }`;
    doc.head.append(s);
  }

  const lautsprecher = (doc) => {
    const s = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("aria-hidden", "true");
    const u = doc.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "/symbole.svg#volume-2");
    s.append(u);
    return s;
  };

  function symboleSetzen() {
    const doc = artikelDok();
    if (!doc) return;
    doc.querySelectorAll(".fb-vl").forEach(x => x.remove());
    if (!kannVorlesen()) return;
    stil(doc);
    const alle = bloecke(doc);
    alle.forEach((h, i) => {
      if (!h.matches(UEBERSCHRIFT)) return;
      // Überschriften ohne Text danach (z. B. „Einzelnachweise“ mit nur Quellen) bekommen kein Symbol
      const n = alle[i + 1];
      const stufe = (e) => /^h[1-6]$/i.test(e.tagName) ? +e.tagName[1] : 9;
      if (stufe(h) > 1 && (!n || stufe(n) <= stufe(h))) return;
      const titel = /^h1$/i.test(h.tagName) ? "Von Anfang an vorlesen" : "Ab hier vorlesen";
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "fb-vl";
      b.title = titel;
      b.setAttribute("aria-label", titel);
      b.append(lautsprecher(doc));
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); const x = ab(doc, h); starten(x.teile, x.abschnitte, doc); });
      h.prepend(b);
    });
  }

  // ------------------------------------------------ Markierten Text vorlesen

  function markFeldWeg() { if (markFeld) { markFeld.remove(); markFeld = null; } }

  // Neben markiertem Text: „Vorlesen“ (wenn eine Stimme da ist) und „Merken“ (Merkliste, js/merkliste.js)
  function markierungPruefen(doc) {
    markFeldWeg();
    const sel = doc.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const text = sel.toString();
    if (sauber(text).length < 2) return;
    const bereich = sel.getRangeAt(0).cloneRange();
    const r = bereich.getBoundingClientRect();
    if (!r.width && !r.height) return;
    stil(doc);
    const feld = doc.createElement("div");
    feld.className = "fb-markfeld";
    if (kannVorlesen()) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "fb-vl-markiert";
      b.append(lautsprecher(doc), "Vorlesen");
      // mousedown nicht weitergeben, sonst hebt der Klick die Markierung auf, bevor er ankommt
      b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        markFeldWeg();
        let root = bereich.commonAncestorContainer;
        if (root.nodeType !== 1) root = root.parentElement;
        const ws = woerter(root, bereich);
        doc.getSelection().removeAllRanges();   // sonst überdeckt die blaue Markierung das gelesene Wort
        starten(stuecke(ws).map(x => teil(null, x, 0)), [{ titel: "Markierter Text" }], doc, true);
      });
      feld.append(b);
    }
    const merken = MerkAnsicht.merkKnopf(doc, text, () => {
      const a = Bibliothek.artikel();
      return a ? Object.assign({ bereich: "bibliothek" }, a) : null;
    }, "fb-vl-markiert");
    if (merken) feld.append(merken);
    if (!feld.childNodes.length) return;
    const w = doc.defaultView;
    feld.style.top = (r.bottom + w.scrollY + 8) + "px";
    feld.style.left = Math.max(8, Math.min(r.left + w.scrollX, w.scrollX + doc.documentElement.clientWidth - 230)) + "px";
    doc.body.append(feld);
    markFeld = feld;
  }

  function dokVorbereiten() {
    const doc = artikelDok();
    if (!doc || doc.fbVorlesen) return;
    doc.fbVorlesen = true;
    doc.addEventListener("mouseup", (e) => { if (!(e.target.closest && e.target.closest(".fb-markfeld"))) setTimeout(() => markierungPruefen(doc), 10); });
    doc.addEventListener("keyup", (e) => { if (e.shiftKey) markierungPruefen(doc); });
    doc.addEventListener("mousedown", (e) => { if (!(e.target.closest && e.target.closest(".fb-markfeld"))) markFeldWeg(); });
    // Selbst scrollen (Mausrad, Wischen, Tasten, Bildlaufleiste): nicht mehr zum gelesenen Wort zurückspringen
    const selbst = () => { if (lauf && lauf.doc === doc && lauf.folgen) { lauf.folgen = false; leisteZeichnen(); } };
    doc.addEventListener("wheel", selbst, { passive: true });
    doc.addEventListener("touchmove", selbst, { passive: true });
    doc.addEventListener("keydown", (e) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key)) selbst(); });
    doc.addEventListener("mousedown", (e) => { if (e.target === doc.documentElement || e.clientX >= doc.documentElement.clientWidth) selbst(); });
  }

  // ------------------------------------------------ Leiste unten

  // Fest unter dem Artikel, so breit wie er (der Artikel wird dafür etwas kürzer):
  // links Pause und Weiter, in der Mitte Abschnitt und Zeitleiste, rechts Lautstärke und Schließen
  const leiste = el("div", { class: "vl-leiste", hidden: true, role: "region", "aria-label": "Vorlesen" });
  const titelZ = el("span", { class: "vl-titel" });
  const status = el("span", { class: "vl-status", "aria-live": "polite" });
  const zeitJetzt = el("span", { class: "vl-zeit-wert" }, "0:00");
  const zeitGesamt = el("span", { class: "vl-zeit-wert" }, "0:00");
  const spulen = el("input", { type: "range", class: "vl-regler vl-spulen", min: "0", max: "1000", value: "0", step: "1", "aria-label": "Stelle im Abschnitt" });
  const pauseK = el("button", { class: "vl-rund vl-haupt", type: "button" });
  const weiterK = el("button", { class: "vl-rund", type: "button", title: "Nächster Absatz", "aria-label": "Nächster Absatz" }, sym("skip-forward"));
  const stoppK = el("button", { class: "vl-rund", type: "button", title: "Vorlesen beenden", "aria-label": "Vorlesen beenden" }, sym("x"));
  const laut = el("input", { type: "range", class: "vl-regler vl-laut", min: "0", max: "100", step: "1", value: String(Math.round(lautstaerke * 100)),
    "aria-label": "Lautstärke beim Vorlesen", title: "Lautstärke nur für Fieldbook" });
  const zeitZeile = el("div", { class: "vl-zeit" }, zeitJetzt, spulen, zeitGesamt);
  const knoepfe = el("div", { class: "vl-knoepfe" }, pauseK, weiterK);
  const rechts = el("div", { class: "vl-rechts" }, el("span", { class: "vl-laut-feld" }, sym("volume-2"), laut), stoppK);
  // Erscheint, wenn man selbst weggescrollt hat
  const zurK = el("button", { class: "vl-zur", type: "button", hidden: true, title: "Zum gerade gelesenen Wort scrollen" }, sym("arrow-down"), "Zur Stelle");
  zurK.addEventListener("click", () => zurStelle());
  leiste.append(knoepfe, el("div", { class: "vl-mitte" }, el("div", { class: "vl-kopf" }, titelZ, status, zurK), zeitZeile), rechts);
  koerper.append(leiste);
  // Gefüllter Teil der Regler (CSS-Variable --fort)
  const fuellen = (r) => r.style.setProperty("--fort", (r.value - r.min) / (r.max - r.min) * 100 + "%");
  fuellen(laut);

  pauseK.addEventListener("click", () => {
    if (!lauf) return;
    lauf.pausiert = !lauf.pausiert;
    if (lauf.audio) lauf.pausiert ? lauf.audio.pause() : lauf.audio.play().catch(() => { });
    leisteZeichnen();
  });
  weiterK.addEventListener("click", () => {
    if (!lauf) return;
    // zum nächsten Absatz springen (nicht nur zum nächsten Stück desselben Absatzes)
    const jetzt = lauf.teile[lauf.i];
    let n = lauf.i + 1;
    while (n < lauf.teile.length && jetzt.el && lauf.teile[n].el === jetzt.el) n++;
    lauf.pausiert = false;
    spielen(lauf, n, 0);
  });
  stoppK.addEventListener("click", stopp);
  laut.addEventListener("input", () => {
    lautstaerke = laut.value / 100;
    fuellen(laut);
    if (lauf && lauf.audio) lauf.audio.volume = lautstaerke;
    try { localStorage.setItem("vlLautstaerke", String(lautstaerke)); } catch { }
  });
  // Spulen: beim Ziehen nur die Zeit zeigen, beim Loslassen springen
  spulen.addEventListener("input", () => {
    if (!lauf) return;
    lauf.zieht = true;
    fuellen(spulen);
    const a = abschnittVon(lauf);
    zeitJetzt.textContent = zeit(spulen.value / 1000 * a.zeichen * lauf.spz);
  });
  spulen.addEventListener("change", () => {
    if (!lauf) return;
    lauf.zieht = false;
    springen(lauf, spulen.value / 1000);
  });

  const zeit = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

  // Abschnitt des aktuellen Stücks: erstes und letztes Stück, Zeichen gesamt
  function abschnittVon(l) {
    const nr = l.teile[l.i].abschnitt;
    let von = l.i, bis = l.i;
    while (von > 0 && l.teile[von - 1].abschnitt === nr) von--;
    while (bis < l.teile.length - 1 && l.teile[bis + 1].abschnitt === nr) bis++;
    let zeichen = 0, vorher = 0;
    for (let k = von; k <= bis; k++) { if (k < l.i) vorher += l.teile[k].text.length; zeichen += l.teile[k].text.length; }
    return { nr, von, bis, zeichen, vorher };
  }

  // Leiste so breit und dort, wo der Artikel steht (viele Pakete haben eine Höchstbreite und stehen mittig).
  // Gemessen an Text, Bildern und Tabellen des Artikels; ohne Messung füllt sie die Spalte.
  function breiteAnpassen() {
    let links = null, rechts = null;
    try {
      const doc = artikelDok();
      if (doc) {
        const innen = rahmen.contentDocument.getElementById("content_iframe");
        const versatz = rahmen.getBoundingClientRect().left + (innen ? innen.getBoundingClientRect().left : 0) - koerper.getBoundingClientRect().left;
        const els = [...bloecke(doc).slice(0, 80), ...doc.body.querySelectorAll("figure, .thumb, table, img, .infobox")];
        for (const e of els) {
          const r = e.getBoundingClientRect();
          if (r.width < 40 || r.height < 4 || getComputedStyle(e).position === "fixed") continue;
          links = links === null ? r.left : Math.min(links, r.left);
          rechts = rechts === null ? r.right : Math.max(rechts, r.right);
        }
        if (links !== null) { links += versatz; rechts += versatz; }
      }
    } catch { links = null; }
    const voll = koerper.clientWidth;
    if (links === null || rechts - links < 320 || rechts - links > voll - 8) {
      leiste.style.marginLeft = ""; leiste.style.width = ""; leiste.classList.remove("vl-schmal");
      return;
    }
    // Etwas Luft links und rechts, aber nie über den Rand der Spalte
    links = Math.max(0, links - 16); rechts = Math.min(voll, rechts + 16);
    leiste.style.marginLeft = Math.round(links) + "px";
    leiste.style.width = Math.round(rechts - links) + "px";
    leiste.classList.add("vl-schmal");
  }
  window.addEventListener("resize", () => { if (!leiste.hidden) breiteAnpassen(); });

  function leisteZeichnen() {
    if (!lauf) { leiste.hidden = true; return; }
    const war = leiste.hidden;
    leiste.hidden = false;
    if (war) breiteAnpassen();
    zeitZeile.hidden = knoepfe.hidden = false;
    pauseK.replaceChildren(sym(lauf.pausiert ? "play" : "pause"));
    pauseK.title = lauf.pausiert ? "Fortsetzen" : "Pause";
    pauseK.setAttribute("aria-label", pauseK.title);
    pauseK.disabled = !lauf.audio;
    pauseK.classList.toggle("vl-laedt", !lauf.audio);
    weiterK.hidden = lauf.markiert;
    zurK.hidden = lauf.folgen !== false;
    titelZ.textContent = lauf.abschnitte[lauf.teile[lauf.i].abschnitt].titel;
    status.textContent = !lauf.audio ? "Wird vorbereitet …" : lauf.pausiert ? "Angehalten" : "";
    fortschritt();
  }

  // Zeit und Spulregler: Dauer aus der Textlänge geschätzt, mit der gemessenen Sprechgeschwindigkeit
  function fortschritt() {
    const l = lauf;
    if (!l || l.zieht) return;
    const a = abschnittVon(l), t = l.teile[l.i];
    const anteil = l.audio && l.audio.duration ? Math.min(1, l.audio.currentTime / l.audio.duration) : 0;
    const pos = a.vorher + anteil * t.text.length;
    zeitJetzt.textContent = zeit(pos * l.spz);
    zeitGesamt.textContent = zeit(a.zeichen * l.spz);
    spulen.value = String(a.zeichen ? Math.round(pos / a.zeichen * 1000) : 0);
    fuellen(spulen);
  }

  function springen(l, f) {
    const a = abschnittVon(l);
    let ziel = f * a.zeichen, n = a.von;
    while (n < a.bis && ziel >= l.teile[n].text.length) { ziel -= l.teile[n].text.length; n++; }
    const rest = Math.min(0.98, ziel / l.teile[n].text.length);
    if (n === l.i && l.audio && l.audio.duration) { l.audio.currentTime = rest * l.audio.duration; fortschritt(); return; }
    spielen(l, n, rest);
  }

  function hinweis(...saetze) {
    lauf = null;
    leiste.hidden = false;
    breiteAnpassen();
    titelZ.textContent = "";
    status.replaceChildren(...saetze.flatMap((s, i) => i ? [el("br"), s] : [s]));
    knoepfe.hidden = zeitZeile.hidden = zurK.hidden = true;
    clearTimeout(hinweis.uhr);
    hinweis.uhr = setTimeout(() => { if (!lauf) leiste.hidden = true; }, 6000);
  }

  // ------------------------------------------------ Markierungen im Artikel

  function absatzZeigen(l, t) {
    const e = t && t.el;
    if (l.markiertEl !== e) {
      if (l.markiertEl) l.markiertEl.classList.remove("fb-vl-jetzt");
      l.markiertEl = e;
      if (e) e.classList.add("fb-vl-jetzt");
    }
  }

  // Gerade gesprochenes Wort markieren: ein weiches Feld über dem Text gleitet von Wort zu Wort (statt zu springen).
  // Innerhalb einer Zeile gleitet es so lange, wie das Wort dauert (höchstens 0,25 s); in eine neue Zeile springt es
  // ohne Gleiten, damit es nicht quer über den Text fährt.
  function gleiterVon(l) {
    if (l.gleiter && l.gleiter.isConnected) return l.gleiter;
    const g = l.doc.createElement("fb-vl-gleiter");   // eigenes Element: design.css macht alle div im Dunkeln durchsichtig
    g.className = "fb-vl-gleiter"; g.style.display = "block";
    g.setAttribute("aria-hidden", "true");
    l.doc.body.append(g);
    l.gleiter = g;
    return g;
  }

  function wortZeigen(l, w, dauer) {
    if (!w) { if (l.gleiter) l.gleiter.remove(); l.gleiter = null; l.wort = null; return; }
    if (l.wort === w) return;
    l.wort = w;
    try {
      const W = l.doc.defaultView;
      const r = l.doc.createRange();
      r.setStart(w.startNode, w.start);
      r.setEnd(w.endNode, w.end);
      const b = r.getClientRects()[0] || r.getBoundingClientRect();
      if (!b || !b.height) return;
      const g = gleiterVon(l);
      // Lage im Dokument (der Gleiter liegt im Body; ist der verschoben oder positioniert, das abziehen)
      const op = g.offsetParent;
      const pr = op ? op.getBoundingClientRect() : { left: -W.scrollX, top: -W.scrollY };
      const x = b.left - pr.left - (op ? op.clientLeft - op.scrollLeft : 0) - 3;
      const y = b.top - pr.top - (op ? op.clientTop - op.scrollTop : 0) - 1;
      const neueZeile = l.gleiterY == null || Math.abs(y - l.gleiterY) > 4;
      const t = neueZeile ? 0 : Math.max(0.08, Math.min(0.25, dauer || 0.15));
      g.style.transition = neueZeile ? "opacity .12s" : "left " + t + "s ease-out, width " + t + "s ease-out";
      g.style.left = x + "px"; g.style.top = y + "px";
      g.style.width = (b.width + 6) + "px"; g.style.height = (b.height + 2) + "px";
      g.style.opacity = "1";
      l.gleiterY = y;
      // mitrollen, wenn das Wort aus dem sichtbaren Bereich läuft – aber nicht, wenn man selbst gescrollt hat
      const h = W.innerHeight, sichtbar = b.top >= 0 && b.bottom <= h - 20;
      if (!l.folgen && sichtbar) { l.folgen = true; leisteZeichnen(); }   // selbst zurück zur Stelle gescrollt
      if (l.folgen && (b.top < 0 || b.bottom > h - 60)) {
        const ziel = W.scrollY + b.top - h * 0.35;
        W.scrollTo({ top: ziel, behavior: Math.abs(b.top - h / 2) > h * 1.5 ? "auto" : "smooth" });
      }
    } catch { }
  }

  // Knopf „Zur Stelle“: wieder zum gelesenen Wort und ab da mitrollen
  function zurStelle() {
    if (!lauf) return;
    lauf.folgen = true;
    const w = lauf.wort;
    lauf.wort = null;
    if (w) wortZeigen(lauf, w);
    leisteZeichnen();
  }

  // Läuft, solange vorgelesen wird: Wort, Zeit und Regler nachführen
  function schleife(l) {
    if (lauf !== l) return;
    const a = l.audio, t = l.teile[l.i];
    if (a && a.duration && t) {
      let k = 0, dauer;
      if (t.zeiten) {
        // genaue Zeiten: das letzte Wort, das schon begonnen hat
        const s = a.currentTime;
        for (let i = 0; i < t.zeiten.length; i++) if (t.zeiten[i] && t.zeiten[i][0] <= s + 0.03) k = i;
        if (t.zeiten[k]) dauer = t.zeiten[k][1] - t.zeiten[k][0];
      } else {
        // altes Piper: Dauer nach Wortlänge und Satzzeichen geschätzt
        const f = a.currentTime / a.duration;
        while (k < t.gewichte.length - 1 && t.gewichte[k] < f) k++;
        dauer = (t.gewichte[k] - (k ? t.gewichte[k - 1] : 0)) * a.duration;
      }
      wortZeigen(l, t.woerter[k], dauer);
      fortschritt();
    }
    requestAnimationFrame(() => schleife(l));
  }

  // ------------------------------------------------ Wiedergabe

  // Audio für Stück n holen (oder das schon vorbereitete Versprechen nehmen)
  function holen(l, n) {
    if (n >= l.teile.length) return null;
    if (!l.vorrat.has(n)) {
      const p = fetch("/api/vorlesen", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sprache: l.sprache, text: l.teile[n].text }), signal: l.abbruch.signal })
        .then(async r => {
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.fehler || ("Fehler " + r.status)); }
          // Neues Piper: genaue Zeit jedes Wortes [start, ende] in Sekunden (null = stumm, z. B. „–“)
          try { const z = JSON.parse(r.headers.get("X-Wortzeiten") || "null"); if (Array.isArray(z) && z.length === l.teile[n].woerter.length) l.teile[n].zeiten = z; } catch { }
          return URL.createObjectURL(await r.blob());
        });
      p.catch(() => { });
      l.vorrat.set(n, p);
    }
    return l.vorrat.get(n);
  }

  async function spielen(l, n, rest) {
    if (lauf !== l) return;
    if (l.audio) { l.audio.onended = null; l.audio.pause(); l.audio = null; }
    if (n >= l.teile.length) { stopp(); return; }
    l.i = n;
    absatzZeigen(l, l.teile[n]);
    wortZeigen(l, l.teile[n].woerter[0]);
    leisteZeichnen();
    let url;
    try { url = await holen(l, n); }
    catch (e) {
      if (lauf !== l) return;
      stopp();
      hinweis("Vorlesen hat nicht geklappt.", String(e && e.message || e));
      return;
    }
    if (lauf !== l || l.i !== n) return;
    holen(l, n + 1);   // nächstes Stück schon vorbereiten
    const a = new Audio(url);
    a.volume = lautstaerke;
    await new Promise(res => { a.onloadedmetadata = res; a.onerror = res; });
    if (lauf !== l || l.i !== n) return;
    // Sprechgeschwindigkeit messen, damit die geschätzte Dauer genauer wird
    if (a.duration && isFinite(a.duration) && !l.gemessen.has(n)) {
      l.gemessen.add(n);
      l.sek += a.duration; l.zch += l.teile[n].text.length;
      l.spz = l.sek / l.zch;
      if (rest && a.duration) a.currentTime = rest * a.duration;
    }
    else if (rest && a.duration) a.currentTime = rest * a.duration;
    l.audio = a;
    a.onended = () => { if (lauf === l && l.audio === a) spielen(l, n + 1, 0); };
    if (!l.pausiert) await a.play().catch(() => { });
    leisteZeichnen();
  }

  function starten(teile, abschnitte, doc, markiert) {
    stopp();
    if (!teile.length) return;
    const sprache = spracheVon(teile.slice(0, 6).map(t => t.text).join(" "), doc);
    if (!stimmen().includes(sprache)) {
      const name = sprache === "de" ? "Deutsch" : sprache === "en" ? "Englisch" : sprache;
      hinweis("Für " + name + " ist keine Stimme zum Vorlesen da.", el("a", { href: "#inhalte?zu=vorlesen" }, "Unter Inhalte → Sprachen laden"));
      return;
    }
    lauf = { teile, abschnitte, i: 0, sprache, doc, markiert: !!markiert, audio: null, pausiert: false, zieht: false,
      vorrat: new Map(), abbruch: new AbortController(), spz: SPZ, sek: 0, zch: 0, gemessen: new Set(), wort: null, folgen: true, gleiter: null, gleiterY: null };
    spielen(lauf, 0, 0);
    schleife(lauf);
  }

  function stopp() {
    const l = lauf;
    lauf = null;
    if (l) {
      l.abbruch.abort();
      if (l.audio) { l.audio.onended = null; l.audio.pause(); }
      absatzZeigen(l, null);
      wortZeigen(l, null);
      for (const p of l.vorrat.values()) p.then(u => URL.revokeObjectURL(u), () => { });
    }
    leiste.hidden = true;
  }

  // ------------------------------------------------ Seitenwechsel

  function neueSeite() {
    stopp();
    markFeldWeg();
    dokVorbereiten();
    symboleSetzen();
  }
  rahmen.addEventListener("load", () => {
    try {
      const w = rahmen.contentWindow;
      w.addEventListener("hashchange", () => setTimeout(neueSeite, 50));
      const innen = w.document.getElementById("content_iframe");
      if (innen) innen.addEventListener("load", neueSeite);
    } catch { }
    neueSeite();
  });
  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#lesen")) stopp();
  });
  // Status kommt evtl. erst nach dem ersten Artikel: dann die Lautsprecher nachträglich setzen
  const warteAufStatus = setInterval(() => { if (OW.status) { clearInterval(warteAufStatus); symboleSetzen(); } }, 500);

  return { stopp };
})();
