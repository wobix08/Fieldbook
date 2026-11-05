// Eigener PDF-Leser für die PDF-Bücher in Paketen (Medizin-Handbücher, Knoten, Wasser …).
// Zwei Ansichten: „Seite“ zeigt das Buch wie gedruckt (im dunklen Design mit hellen Linien auf dunklem Grund,
// Fotos bleiben unverändert), „Text“ zeigt den Text der Seiten in Fieldbook-Schrift.
// Adresse: #pdf?url=/kiwix/content/<paket>/files/<datei>.pdf&seite=3&ansicht=text
"use strict";

const PdfLeser = (() => {
  // Fieldbook-Farben im dunklen Design (Grund und Schrift), wie in app.css
  const GRUND = [22, 23, 21], SCHRIFT = [247, 245, 241];

  // buchLauf zählt geöffnete Bücher, lauf jeden Neuaufbau (Ansicht, Fenstergröße, Design):
  // Arbeiten eines älteren Laufs werden verworfen
  let doc = null, url = "", lauf = 0, buchLauf = 0;
  let seiten = [];          // je Seite: { box, canvas, stand, text }
  let ansicht = "seite", aktuelleSeite = 1, original = false;
  let beobachter = null, textBeobachter = null;
  let warteschlange = new Set(), zeichenLauf = 0;
  let imAufbau = false;     // solange Seiten aufgebaut werden, zählt Scrollen nicht als Lesen
  // Größe der Seiten in der Seitenansicht (1 = so breit, wie es ins Fenster passt), gemerkt für alle Bücher
  const STUFEN = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let zoom = 1;
  try { const z = parseFloat(localStorage.getItem("pdfZoom")); if (STUFEN.includes(z)) zoom = z; } catch { }

  const flaeche = () => $("#pdf-flaeche");
  const dunkel = () => document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const dunkleSeiten = () => dunkel() && !original;

  // ---------------------------------------------------------------- Öffnen

  async function zeigen(params) {
    const neuUrl = params.get("url") || "";
    if (!/^\/kiwix\/content\/[^/]+\/.+\.pdf$/i.test(neuUrl)) { location.replace("#bibliothek"); return; }
    const neueSeite = Math.max(1, parseInt(params.get("seite"), 10) || 1);
    const neueAnsicht = params.get("ansicht") === "text" ? "text" : "seite";
    if (neuUrl === url && doc) {
      // Dasselbe Buch (z. B. Zurück im Verlauf): nur neu aufbauen, wenn nötig
      if (neueAnsicht !== ansicht || verlassen.war) {
        verlassen.war = false;
        ansicht = neueAnsicht;
        leisteAufbauen();
        aufbauen(neueSeite);
      } else if (neueSeite !== aktuelleSeite) springe(neueSeite);
      return;
    }
    url = neuUrl;
    original = false;          // „Original“ gilt nur für das gerade offene Buch
    suchText = null; suchbegriff = ""; trefferZu();
    ansicht = neueAnsicht;
    aktuelleSeite = neueSeite;
    const meinBuch = ++buchLauf;
    lauf++;
    // Die Seiten des vorigen Buchs gelten nicht mehr (sonst überschreibt deren Scrollen die gewünschte Seite)
    imAufbau = true;
    if (beobachter) beobachter.disconnect();
    if (textBeobachter) textBeobachter.disconnect();
    for (let i = 1; i <= seiten.length; i++) freigeben(i);
    seiten = [];
    warteschlange = new Set();
    leisteAufbauen();
    $("#pdf-titel").textContent = params.get("titel") || "";
    $("#pdf-neu").href = url;
    flaeche().replaceChildren(el("p", { class: "pdf-hinweis" }, "Buch wird geöffnet …"));
    if (doc) { try { doc.destroy(); } catch { } doc = null; }
    try {
      const lib = await PdfText.bibliothek();
      const d = await lib.getDocument({ url, isEvalSupported: false }).promise;
      if (meinBuch !== buchLauf) { d.destroy(); return; }
      doc = d;
    } catch (e) {
      if (meinBuch === buchLauf) flaeche().replaceChildren(el("p", { class: "pdf-hinweis" }, "Das Buch konnte nicht geöffnet werden.", el("br"), e.message));
      return;
    }
    titelSuchen(meinBuch);
    aufbauen(neueSeite);
  }

  // Titel aus der Bücherliste des Pakets, wenn er nicht in der Adresse steht
  async function titelSuchen(meinBuch) {
    if ($("#pdf-titel").textContent) return;
    const m = url.match(/^\/kiwix\/content\/([^/]+)\/files\/(.+)$/);
    if (!m) return;
    try {
      const liste = await PdfText.pdfsIm(decodeURIComponent(m[1]));
      const datei = decodeURIComponent(m[2]);
      const b = liste.find(x => x.datei === datei);
      if (b && meinBuch === buchLauf) $("#pdf-titel").textContent = b.titel;
    } catch { }
  }

  // ---------------------------------------------------------------- Suche im ganzen Buch
  // Beim ersten Suchen liest Fieldbook den Text aller Seiten einmal aus (pdf.js, wenige Millisekunden je Seite)
  // und merkt ihn sich, solange das Buch offen ist. Treffer erscheinen als Liste unter der Leiste; ein Klick
  // springt zur Seite, dort ist der Begriff markiert.

  let suchText = null, suchbegriff = "", suchLauf = 0;
  const suchForm = (t) => t.toLowerCase().replace(/\s+/g, " ");

  function trefferliste() {
    let l = $("#pdf-treffer");
    if (!l) {
      l = el("div", { id: "pdf-treffer", class: "pdf-trefferliste", hidden: true });
      $("#pdf-flaeche").before(l);
    }
    return l;
  }
  function trefferZu() { const l = $("#pdf-treffer"); if (l) l.hidden = true; }
  // Klick neben die Liste schließt sie
  document.addEventListener("pointerdown", (e) => {
    const l = $("#pdf-treffer");
    if (l && !l.hidden && !l.contains(e.target) && !e.target.closest(".pdf-suche")) trefferZu();
  });

  async function suchen(roh) {
    const q = (roh || "").trim();
    suchbegriff = q;
    const l = trefferliste();
    alleMarkieren();
    if (q.length < 2 || !doc) { l.hidden = true; return; }
    const mein = ++suchLauf, meinDoc = doc;
    l.hidden = false;
    // Text aller Seiten (einmal je Buch)
    if (!suchText || suchText.doc !== doc) {
      const texte = [];
      for (let i = 1; i <= meinDoc.numPages; i++) {
        if (mein !== suchLauf || meinDoc !== doc) return;
        if (i % 20 === 1) l.replaceChildren(el("div", { class: "pdf-treffer-kopf" }, "Durchsuche das Buch … Seite " + i + " von " + meinDoc.numPages));
        const p = await meinDoc.getPage(i);
        const inh = await p.getTextContent();
        texte.push(inh.items.map(it => it.str || "").join(" ").replace(/(\w)- (\w)/g, "$1$2"));
      }
      suchText = { doc: meinDoc, texte, klein: texte.map(suchForm) };
    }
    if (mein !== suchLauf) return;
    const n = suchForm(q), treffer = [];
    suchText.klein.forEach((t, i) => {
      let pos = t.indexOf(n), anzahl = 0, erste = pos;
      while (pos >= 0) { anzahl++; pos = t.indexOf(n, pos + n.length); }
      if (anzahl) treffer.push({ seite: i + 1, anzahl, erste });
    });
    const gesamt = treffer.reduce((a, t) => a + t.anzahl, 0);
    const kopf = el("div", { class: "pdf-treffer-kopf" },
      gesamt ? gesamt + (gesamt === 1 ? " Treffer" : " Treffer") + " auf " + treffer.length + (treffer.length === 1 ? " Seite" : " Seiten") : "Nichts gefunden.",
      el("button", { class: "pdf-treffer-zu", title: "Liste schließen", onclick: trefferZu }, "×"));
    const zeilen = treffer.slice(0, 200).map(t => {
      const roh = suchText.texte[t.seite - 1].replace(/\s+/g, " ");
      const von = Math.max(0, t.erste - 60), bis = Math.min(roh.length, t.erste + n.length + 80);
      const vor = roh.slice(von, t.erste), wort = roh.slice(t.erste, t.erste + n.length), nach = roh.slice(t.erste + n.length, bis);
      return el("button", { class: "pdf-treffer", onclick: () => { trefferZu(); springe(t.seite); } },
        el("b", {}, "Seite " + t.seite), t.anzahl > 1 ? el("small", {}, " · " + t.anzahl + "×") : null,
        el("span", {}, (von > 0 ? "… " : "") + vor, el("mark", {}, wort), nach + (bis < roh.length ? " …" : "")));
    });
    l.replaceChildren(kopf, ...zeilen);
  }

  // Den Suchbegriff auf einer gezeichneten Seite markieren (Seiten- und Textansicht)
  function markieren(box) {
    box.querySelectorAll("mark.pdf-markiert").forEach(m => m.replaceWith(...m.childNodes));
    box.normalize();
    if (suchbegriff.length < 2) return;
    const n = suchbegriff.toLowerCase();
    const gang = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const knotenListe = [];
    while (gang.nextNode()) knotenListe.push(gang.currentNode);
    for (const t of knotenListe) {
      const text = t.nodeValue, klein = text.toLowerCase();
      let pos = klein.indexOf(n);
      if (pos < 0 || t.parentElement.closest(".pdf-seitenmarke")) continue;
      const frag = document.createDocumentFragment();
      let ab = 0;
      while (pos >= 0) {
        frag.append(text.slice(ab, pos), el("mark", { class: "pdf-markiert" }, text.slice(pos, pos + n.length)));
        ab = pos + n.length;
        pos = klein.indexOf(n, ab);
      }
      frag.append(text.slice(ab));
      t.replaceWith(frag);
    }
  }
  function alleMarkieren() { for (const s of seiten) if (s.stand === 2) markieren(s.box); }

  // ---------------------------------------------------------------- Auf Deutsch
  // Übersetzt den Text jeder gezeichneten Seite (Kästen der Seitenansicht, Absätze der Textansicht) mit dem
  // Offline-Übersetzer. Stellen, die das Bild des Drucks zeigen, bleiben im Original. Der Schalter gilt wie
  // bei Artikeln für alle Bücher und wird gemerkt. Ausschalten baut die Seiten neu auf (wieder im Original).

  const deutsch = () => typeof Uebersetzer !== "undefined" && Uebersetzer.verfuegbar() && Uebersetzer.istAn();
  let offen = 0, fehlend = new Set();

  function deutschAnzeigen() {
    const k = $("#pdf-deutsch");
    k.hidden = !(typeof Uebersetzer !== "undefined" && Uebersetzer.verfuegbar());
    k.setAttribute("aria-pressed", String(deutsch()));
    k.classList.toggle("knopf-haupt", deutsch());
    const st = $("#pdf-uebersetzen-status");
    if (!deutsch()) st.textContent = "";
    else if (offen > 0) st.textContent = "Übersetze …";
    // Fertig: der hervorgehobene Knopf zeigt es schon (die Leiste ist knapp), nur fehlende Sprachen nennen
    else st.textContent = fehlend.size ? [...fehlend].join(", ") + " ist nicht installiert" : "";
  }

  // Einzeilige Stellen dürfen nach dem Übersetzen breiter werden, so weit rechts daneben Platz frei ist
  // (bis zum nächsten Kasten auf gleicher Höhe oder zum Seitenrand)
  function breiterMachen(e) {
    if (!e.classList.contains("pdf-einzeilig")) return;
    const x = e.offsetLeft, y = e.offsetTop, h = e.offsetHeight, rechts = e.offsetLeft + e.offsetWidth;
    const seite = e.closest(".pdf-seite");
    let grenze = (seite ? seite.clientWidth : rechts) - 8;
    for (const n of e.parentElement.children) {
      if (n === e) continue;
      const ny = n.offsetTop, nh = n.offsetHeight, nx = n.offsetLeft;
      if (ny < y + h && ny + nh > y && nx >= rechts - 2) grenze = Math.min(grenze, nx - 6);
    }
    if (grenze > rechts) e.style.width = (grenze - x) + "px";
  }

  async function seiteUebersetzen(s) {
    if (!deutsch()) return;
    const textansicht = s.box.classList.contains("pdf-textseite");
    const elemente = textansicht
      ? [...s.box.querySelectorAll("p:not(.pdf-ohne-text), h2, h3")]
      : [...s.box.querySelectorAll(".pdf-kasten:not(.pdf-unsichtbar)")];
    if (!elemente.length) return;
    offen++;
    deutschAnzeigen();
    try {
      // Deutscher Text ist länger: in der Seitenansicht neu einpassen, notfalls etwas kleiner als sonst
      const r = await Uebersetzer.elementeUebersetzen(elemente, textansicht ? null : (e) => { breiterMachen(e); einpassen(e, 0.6); });
      r.fehlt.forEach(c => fehlend.add(c));
    } catch (e) {
      $("#pdf-uebersetzen-status").textContent = "Übersetzer konnte nicht starten: " + e.message;
    } finally { offen--; }
    deutschAnzeigen();
  }

  $("#pdf-deutsch").addEventListener("click", () => {
    Uebersetzer.setzeAn(!Uebersetzer.istAn());
    fehlend = new Set();
    deutschAnzeigen();
    if (deutsch()) { for (const s of seiten) if (s.stand === 2) seiteUebersetzen(s); }
    else aufbauen(aktuelleSeite);          // zurück zum Original: Seiten neu aufbauen
  });

  // ---------------------------------------------------------------- Leiste

  function leisteAufbauen() {
    const mitte = $("#pdf-mitte");
    mitte.replaceChildren(
      // Der Schalter kennt nur seine Anfangsstellung: nach jedem Umschalten neu bauen, sonst geht es nicht zurück
      stufenSchalter([{ id: "seite", text: "Seite" }, { id: "text", text: "Text" }], ansicht, (id) => {
        ansicht = id;
        leisteAufbauen();
        adresseMerken();
        aufbauen(aktuelleSeite);
      }, "Ansicht"),
      el("form", { class: "pdf-seitenwahl", onsubmit: (e) => { e.preventDefault(); springe(parseInt($("#pdf-seite").value, 10) || 1); } },
        el("span", {}, "Seite"),
        el("input", { id: "pdf-seite", type: "number", min: "1", value: String(aktuelleSeite), "aria-label": "Seite" }),
        el("span", { id: "pdf-anzahl" }, doc ? "von " + doc.numPages : "")),
      ansicht === "seite" ? el("div", { class: "pdf-zoom", role: "group", "aria-label": "Größe der Seiten" },
        el("button", { type: "button", class: "knopf", title: "Kleiner", "aria-label": "Kleiner", disabled: zoom <= STUFEN[0],
          onclick: () => zoomSetzen(STUFEN[Math.max(0, STUFEN.indexOf(zoom) - 1)]) }, "−"),
        el("button", { type: "button", class: "knopf pdf-zoom-wert", title: "Zurück auf Fensterbreite", onclick: () => zoomSetzen(1) },
          Math.round(zoom * 100) + " %"),
        el("button", { type: "button", class: "knopf", title: "Größer", "aria-label": "Größer", disabled: zoom >= STUFEN[STUFEN.length - 1],
          onclick: () => zoomSetzen(STUFEN[Math.min(STUFEN.length - 1, STUFEN.indexOf(zoom) + 1)]) }, "+")) : null,
      el("form", { class: "lese-suche pdf-suche", role: "search", onsubmit: (e) => { e.preventDefault(); suchen($("#pdf-suche-feld").value); } },
        el("input", { type: "search", id: "pdf-suche-feld", placeholder: "Im Buch suchen …", "aria-label": "Im ganzen Buch suchen", value: suchbegriff,
          // Zurück ins Feld: die letzte Trefferliste wieder zeigen
          onfocus: (e) => { const l = $("#pdf-treffer"); if (l && l.childNodes.length && e.target.value.trim() === suchbegriff && suchbegriff) l.hidden = false; } })));
    const o = $("#pdf-original");
    o.checked = original;
    $("#pdf-original-box").hidden = ansicht !== "seite";
    deutschAnzeigen();
  }

  function seiteAnzeigen(n) {
    aktuelleSeite = n;
    const f = $("#pdf-seite");
    if (f && document.activeElement !== f) f.value = String(n);
    adresseMerken();
  }

  // Adresse folgt der Seite, ohne Verlaufseintrag (Neu laden zeigt dieselbe Stelle)
  function adresseMerken() {
    if (!location.hash.startsWith("#pdf")) return;
    const p = new URLSearchParams(location.hash.split("?")[1] || "");
    p.set("seite", String(aktuelleSeite));
    if (ansicht === "text") p.set("ansicht", "text"); else p.delete("ansicht");
    const neu = "#pdf?" + p.toString();
    if (neu !== location.hash) history.replaceState(history.state, "", neu);
  }

  // ---------------------------------------------------------------- Aufbau der Seiten

  async function aufbauen(startSeite) {
    if (!doc) return;
    const meinLauf = ++lauf;
    if (beobachter) beobachter.disconnect();
    if (textBeobachter) textBeobachter.disconnect();
    warteschlange = new Set();
    for (const s of seiten) if (s.canvas) { s.canvas.width = 0; s.canvas.height = 0; }
    $("#pdf-anzahl").textContent = "von " + doc.numPages;
    $("#pdf-seite").max = String(doc.numPages);
    $("#pdf-original-box").hidden = ansicht !== "seite";

    // Größe aller Platzhalter nach der ersten Seite; jede Seite passt ihre Höhe beim Zeichnen an
    const erste = await doc.getPage(1);
    if (meinLauf !== lauf) return;
    const v1 = erste.getViewport({ scale: 1 });
    const breite = seitenBreite();
    const hoehe = Math.round(breite * v1.height / v1.width);

    const liste = el("div", { class: ansicht === "text" ? "pdf-text" : "pdf-seiten" + (dunkleSeiten() ? " dunkel" : "") });
    // Noch leere Textseiten bekommen eine geschätzte Höhe, sonst lägen Dutzende im Ladebereich
    const textHoehe = Math.round(Math.min(hoehe, 1200) * 0.55);
    seiten = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const box = ansicht === "text"
        ? el("section", { class: "pdf-textseite", "data-seite": String(i), style: "min-height:" + textHoehe + "px" }, el("div", { class: "pdf-seitenmarke" }, "Seite " + i))
        : el("div", { class: "pdf-seite", "data-seite": String(i), style: "width:" + breite + "px;height:" + hoehe + "px" });
      seiten.push({ box, canvas: null, stand: 0 });
      liste.append(box);
    }
    // Solange aufgebaut wird, zählt das Scrollen nicht als Lesen (die Fläche springt dabei hin und her)
    imAufbau = true;
    ziel = 0;
    flaeche().replaceChildren(liste);
    flaeche().scrollTop = 0;
    flaeche().onscroll = () => requestAnimationFrame(seiteBeimScrollen);

    if (ansicht === "text") {
      // Zuerst die Startseite füllen, dann die Umgebung beim Scrollen
      await textLaden(startSeite, meinLauf);
      if (meinLauf !== lauf) return;
      textBeobachter = new IntersectionObserver((eintraege) => {
        for (const e of eintraege) if (e.isIntersecting) textLaden(+e.target.dataset.seite, meinLauf);
      }, { root: flaeche(), rootMargin: "1500px 0px" });
      seiten.forEach(s => textBeobachter.observe(s.box));
    } else {
      beobachter = new IntersectionObserver((eintraege) => {
        for (const e of eintraege) {
          const n = +e.target.dataset.seite;
          if (e.isIntersecting) { warteschlange.add(n); naechsteZeichnen(); }
          else { warteschlange.delete(n); freigeben(n); }
        }
      }, { root: flaeche(), rootMargin: "1200px 0px" });
      seiten.forEach(s => beobachter.observe(s.box));
    }
    springe(startSeite);
    // Breiter als das Fenster: seitlich in die Mitte
    flaeche().scrollLeft = Math.max(0, (flaeche().scrollWidth - flaeche().clientWidth) / 2);
    imAufbau = false;
    // Tastatur (Pfeile, Bild auf/ab) scrollt gleich das Buch, ohne erst hineinzuklicken
    if (!document.activeElement || document.activeElement === document.body) flaeche().focus({ preventScroll: true });
  }

  function seitenBreite() {
    const f = flaeche();
    return Math.round(Math.max(320, Math.min(900, (f.clientWidth || 900) - 48)) * zoom);
  }

  // Vergrößern und Verkleinern: neu zeichnen (scharf, nicht bloß hochgezogen), an derselben Seite bleiben
  function zoomSetzen(z) {
    if (z === zoom) return;
    zoom = z;
    try { localStorage.setItem("pdfZoom", String(z)); } catch { }
    leisteAufbauen();
    aufbauen(aktuelleSeite);
  }

  // Sprungziel: Bis die Seite gezeichnet ist, ändern sich die Höhen darüber noch. Deshalb nach dem Zeichnen
  // noch einmal hinspringen, außer man hat inzwischen selbst gescrollt.
  let ziel = 0;
  function springe(n) {
    n = Math.min(Math.max(1, n), seiten.length || 1);
    const s = seiten[n - 1];
    if (!s) return;
    ziel = n;
    flaeche().scrollTop = s.box.offsetTop - 12;
    seiteAnzeigen(n);
  }
  function zielHalten() {
    if (ziel && seiten[ziel - 1]) flaeche().scrollTop = seiten[ziel - 1].box.offsetTop - 12;
  }
  for (const art of ["wheel", "touchstart", "pointerdown"]) $("#pdf-flaeche").addEventListener(art, () => { ziel = 0; }, { passive: true });
  // Tasten scrollen auch, wenn der Fokus nicht in der Fläche liegt (außer beim Tippen der Seitenzahl)
  window.addEventListener("keydown", (e) => {
    if (!location.hash.startsWith("#pdf")) return;
    if (e.key === "Escape") trefferZu();
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "")) ziel = 0;
  });

  // Welche Seite steht oben im Fenster?
  function seiteBeimScrollen() {
    if (imAufbau) return;
    const oben = flaeche().scrollTop + 60;
    let n = 1;
    for (let i = 0; i < seiten.length; i++) { if (seiten[i].box.offsetTop <= oben) n = i + 1; else break; }
    if (n !== aktuelleSeite) seiteAnzeigen(n);
  }

  // ---------------------------------------------------------------- Seitenansicht

  // Immer die Seite zeichnen, die der aktuellen am nächsten ist. Je Aufbau läuft eine Schleife. Nach einem
  // Neuaufbau (oder Buchwechsel) beginnt eine neue; die alte hört auf, auch wenn ihr Zeichnen nie fertig wird
  // (beim Schließen eines Buchs mitten im Zeichnen kann das passieren).
  async function naechsteZeichnen() {
    if (zeichenLauf === lauf) return;          // für diesen Aufbau läuft schon eine
    const mein = zeichenLauf = lauf;
    try {
      while (warteschlange.size && mein === lauf) {
        const n = [...warteschlange].sort((a, b) => Math.abs(a - aktuelleSeite) - Math.abs(b - aktuelleSeite))[0];
        warteschlange.delete(n);
        if (seiten[n - 1] && !seiten[n - 1].stand) await zeichnen(n, mein).catch(e => console.warn("PDF-Seite " + n, e));
      }
    } finally { if (zeichenLauf === mein) zeichenLauf = 0; }
  }

  function freigeben(n) {
    const s = seiten[n - 1];
    if (!s || !s.canvas) return;
    s.canvas.width = 0; s.canvas.height = 0;
    s.box.replaceChildren();
    s.canvas = null; s.stand = 0;
  }

  // Eine Seite nachbauen: Zeichnungen, Linien und Bilder als Bild (ohne Schrift), der Text als echter Text
  // in Kästen an der Stelle der Absätze, in Fieldbook-Schrift. Stellen, an denen der Text nicht sauber
  // hineinpasst (Tabellen, schräger Text, zu eng), zeigt das Bild der gedruckten Seite; bei zu vielen solchen
  // Stellen, bei eingescannten Seiten und in der Ansicht „Original“ die ganze Seite. Der Text liegt dort
  // unsichtbar darüber, damit man ihn trotzdem markieren kann.
  async function zeichnen(n, meinLauf) {
    const s = seiten[n - 1];
    s.stand = 1;
    const vorher = s.box.offsetHeight;
    const zeit = [performance.now()];          // Messpunkte (stehen zum Prüfen an der Seite)
    const page = await doc.getPage(n);
    if (meinLauf !== lauf) return;
    const breite = seitenBreite();
    const v1 = page.getViewport({ scale: 1 });
    const css = breite / v1.width;
    // Sehr große Seiten nicht in voller Schärfe: ein Bild über 3600 Pixel Breite kostet zu viel Speicher
    const dpr = Math.min(2, window.devicePixelRatio || 1, 3600 / breite);
    const vp = page.getViewport({ scale: css * dpr });
    const vpCss = page.getViewport({ scale: css });
    const neueLeinwand = () => el("canvas", { width: String(Math.floor(vp.width)), height: String(Math.floor(vp.height)) });

    // Die gedruckte Seite, wie sie ist
    const voll = neueLeinwand();
    const vollCtx = voll.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: vollCtx, viewport: vp }).promise;
    if (meinLauf !== lauf || s.stand !== 1) { voll.width = 0; return; }
    const rand = leererRand(vollCtx, voll.width, voll.height);
    const inhalt = await page.getTextContent();
    const bilder = await bildBereiche(page, vp, vollCtx, voll.width, voll.height);
    if (meinLauf !== lauf || s.stand !== 1) { voll.width = 0; return; }

    // Textkästen aufbauen und ausmessen (dafür muss die Schicht im Dokument stehen; sie liegt absolut,
    // die Höhe der Seite ändert sich dabei noch nicht)
    const schicht = el("div", { class: "pdf-textschicht" });
    s.box.replaceChildren(schicht);
    zeit.push(performance.now());
    const kaesten = kaestenBauen(inhalt.items, stilVon(page), vpCss, schicht);
    zeit.push(performance.now());
    const zeichen = kaesten.reduce((a, k) => a + k.text.length, 0);
    const schwer = kaesten.filter(k => k.schwierig).reduce((a, k) => a + k.text.length, 0);
    // Eingescannte Seite: ein Bild bedeckt fast die ganze Seite und der Text liegt (unsichtbar) darauf
    const scan = bilder.some(b => b.w * b.h > voll.width * voll.height * 0.75) && zeichen > 0;
    let ganzesBild = original || scan || !zeichen || schwer > zeichen * 0.4;
    // Zum Prüfen: warum diese Seite so aussieht (sichtbar in den Entwicklerwerkzeugen)
    s.box.dataset.art = original ? "original" : scan ? "scan" : !zeichen ? "ohne-text" : ganzesBild ? "zu-schwierig" : "nachgebaut";
    s.box.dataset.schwierig = kaesten.filter(k => k.schwierig).length + " von " + kaesten.length;

    // Bild der Seite: ganz gedruckt oder Grafik ohne Schrift plus die schwierigen Stellen aus dem Druck
    let leinwand = voll, ctx = vollCtx;
    if (!ganzesBild) {
      leinwand = neueLeinwand();
      ctx = leinwand.getContext("2d", { willReadFrequently: true });
      await page.render({ canvasContext: ohneSchrift(ctx), viewport: vp }).promise;
      if (meinLauf !== lauf || s.stand !== 1) { voll.width = 0; leinwand.width = 0; return; }
      const f = voll.width / breite;
      // Manche PDFs malen Schrift als Linien statt als Schrift: dann steht sie auch ohne Schrift noch im Bild
      // und erschiene doppelt. Steht in den Textbereichen noch mehr als die Hälfte der Tinte, ganze Seite als Bild.
      if (tinte(ctx, kaesten, f) > tinte(vollCtx, kaesten, f) * 0.5) {
        leinwand.width = 0;
        leinwand = voll; ctx = vollCtx;
        ganzesBild = true;
        s.box.dataset.art = "schrift-als-linien";
      }
    }
    if (!ganzesBild) {
      const f = voll.width / breite;
      for (const k of kaesten) if (k.schwierig) {
        const x = Math.max(0, Math.floor(k.x * f) - 3), y = Math.max(0, Math.floor(k.y * f) - 3);
        const w = Math.min(leinwand.width - x, Math.ceil(k.w * f) + 6), h = Math.min(leinwand.height - y, Math.ceil(k.h * f) + 6);
        if (w > 0 && h > 0) ctx.drawImage(voll, x, y, w, h, x, y, w, h);
      }
      voll.width = 0;
      bildtexteVerbreitern(ctx, kaesten, bilder, f);
    }
    zeit.push(performance.now());
    if (dunkleSeiten()) abdunkeln(ctx, leinwand, bilder.filter(b => b.foto));
    zeit.push(performance.now());
    // Textfarbe je Kasten nach dem Grund darunter (dunkle Schrift auf hellem Grund und umgekehrt)
    for (const k of kaesten) {
      const unsichtbar = ganzesBild || k.schwierig;
      k.el.classList.toggle("pdf-unsichtbar", unsichtbar);
      if (!unsichtbar) k.el.classList.toggle("pdf-hell", grundDunkel(ctx, leinwand, k, leinwand.width / breite));
    }

    // Leeren Rand oben und unten abschneiden (eingescannte Bücher haben oft viel davon)
    if (rand) {
      const neu = el("canvas", { width: String(leinwand.width), height: String(rand.unten - rand.oben) });
      neu.getContext("2d").drawImage(leinwand, 0, rand.oben, leinwand.width, rand.unten - rand.oben, 0, 0, leinwand.width, rand.unten - rand.oben);
      leinwand.width = 0;
      leinwand = neu;
      schicht.style.top = -Math.round(rand.oben * breite / neu.width) + "px";
    }
    const hoehe = Math.round(leinwand.height * breite / leinwand.width);
    leinwand.style.width = breite + "px";
    leinwand.style.height = hoehe + "px";
    // Wird eine Seite oberhalb der Leseposition niedriger, rutscht alles darunter nach oben: ausgleichen
    const fl = flaeche();
    const ueber = s.box.offsetTop + vorher <= fl.scrollTop + 4;
    s.box.style.height = hoehe + "px";
    s.box.prepend(leinwand);
    if (ueber) fl.scrollTop += hoehe - vorher;
    zielHalten();
    s.canvas = leinwand;
    s.stand = 2;
    markieren(s.box);
    seiteUebersetzen(s);
    zeit.push(performance.now());
    s.box.dataset.ms = ["Druck+Text", "Kästen", "Grafik", "Dunkel", "Rest"].map((t, i) => t + " " + Math.round(zeit[i + 1] - zeit[i])).join(" · ");
    page.cleanup();
  }

  // Bildtexte (Absatz direkt unter einem Bild, deutlich schmaler als das Bild) so breit wie das Bild machen:
  // liest sich besser und passt eher. Liegt der Text auf einem farbigen Feld (grauer Kasten unter dem Foto),
  // wird das Feld in Bildbreite neu gemalt. Eine Schrittnummer neben der ersten Zeile („1“) kommt fett vor den
  // Text. Würde der breitere Kasten oder das Feld etwas anderes berühren, bleibt alles, wie es ist.
  // ctx: Grafik ohne Schrift (Gerätepixel), f: Gerätepixel je CSS-Pixel.
  function bildtexteVerbreitern(ctx, kaesten, bilder, f) {
    const istNummer = (k) => /^\(?\d{1,3}[.)]?$/.test(k.text.trim());
    const schneidet = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const rechteck = (k) => ({ x: k.x, y: k.y, w: k.w, h: k.el.offsetHeight });
    const bilderCss = bilder.map(b => ({ x: b.x / f, y: b.y / f, w: b.w / f, h: b.h / f }));
    const mitte = (k) => ({ x: k.x + k.w / 2, y: k.y + k.el.offsetHeight / 2 });
    const innen = (p, r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
    let pixel = null;
    const erledigt = new Set();
    for (const k of kaesten.slice().sort((a, b) => a.y - b.y)) {
      if (k.schwierig || k.art !== "p" || istNummer(k) || erledigt.has(k) || !kaesten.includes(k)) continue;
      const zh = +k.el.dataset.zh;
      const b = bilderCss.find(b => k.y - (b.y + b.h) > -2 && k.y - (b.y + b.h) < zh * 2.5 &&
        k.x > b.x - zh && k.x + k.w < b.x + b.w + zh && k.w < b.w * 0.9);
      if (!b) continue;
      if (!pixel) pixel = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      let feld = feldFinden(pixel, k, f);
      // Unklarer Grund (weder Papier noch ein sauberes Feld): lieber nichts ändern
      if (!feld) continue;
      if (feld === "papier") feld = null;
      // Das Feld muss unter dem Bild liegen und darf nicht breiter sein als das Bild
      if (feld && (feld.y / f < b.y + b.h - 6 || feld.w / f > b.w + 2)) continue;
      const feldCss = feld ? { x: feld.x / f, y: feld.y / f, w: feld.w / f, h: feld.h / f } : null;
      // Mehrere Absätze im selben Feld werden gemeinsam verbreitert (von oben nach unten)
      const absaetze = feldCss
        ? kaesten.filter(n => n === k || (n.art === "p" && !n.schwierig && !istNummer(n) && n.y > k.y && innen(mitte(n), feldCss))).sort((a, c) => a.y - c.y)
        : [k];
      // Schrittnummern links oder rechts neben der ersten Zeile eines Absatzes
      const nummern = absaetze.map(a => kaesten.find(n => istNummer(n) && !n.schwierig && Math.abs(n.y - a.y) < zh &&
        (Math.abs(n.x + n.w - a.x) < zh * 3 || Math.abs(n.x - (a.x + a.w)) < zh * 3)));
      const rand = feldCss ? Math.max(3, Math.min(k.x - feldCss.x, 12)) : 0;
      const x = b.x + rand, w = b.w - 2 * rand;
      const neuFeld = feldCss ? { x: b.x, y: feldCss.y, w: b.w, h: feldCss.h } : null;
      const bereich = neuFeld || { x, y: k.y, w, h: k.h };
      const beteiligt = new Set(absaetze.concat(nummern.filter(Boolean)));
      if (kaesten.some(n => !beteiligt.has(n) && schneidet(rechteck(n), bereich))) continue;
      if (feld) {
        ctx.fillStyle = "rgb(" + feld.farbe.join(",") + ")";
        // nicht ins Foto darüber malen
        const oben = Math.max(feld.y - 1, Math.ceil((b.y + b.h) * f));
        ctx.fillRect(Math.round(b.x * f), oben, Math.round(b.w * f), feld.y + feld.h + 1 - oben);
        pixel = null;
      }
      // Abstände zwischen den Absätzen wie im Druck, nach oben aufgerückt, weil die Absätze jetzt kürzer sind
      const abstaende = absaetze.map((a, i) => i ? Math.max(0, a.y - (absaetze[i - 1].y + absaetze[i - 1].h)) : 0);
      let y = k.y;
      absaetze.forEach((a, i) => {
        const nr = nummern[i];
        if (nr && kaesten.includes(nr)) {
          a.el.prepend(el("b", {}, nr.text.trim() + " "));
          a.text = nr.text.trim() + " " + a.text;
          nr.el.remove();
          kaesten.splice(kaesten.indexOf(nr), 1);
        }
        y += abstaende[i];
        a.x = x; a.y = y; a.w = w;
        // Der letzte Absatz im Feld darf bis zu dessen Unterkante reichen
        if (neuFeld && i === absaetze.length - 1) a.h = Math.max(a.h, neuFeld.y + neuFeld.h - a.y - 2);
        a.el.style.left = a.x.toFixed(1) + "px";
        a.el.style.top = a.y.toFixed(1) + "px";
        a.el.style.width = (a.w + 2).toFixed(1) + "px";
        a.el.dataset.h = a.h.toFixed(1);
        a.el.dataset.bildtext = feld ? "feld" : "ja";
        einpassen(a.el, 0.74);
        y += a.el.offsetHeight;
        erledigt.add(a);
      });
    }
  }

  // Einfarbiges, nicht weißes Feld unter einem Textkasten (in der Grafik ohne Schrift): Farbe und Lage in
  // Gerätepixeln; "papier" bei weißem Grund, null bei unklarem Grund. Vom Kasten aus nach links, rechts, oben
  // und unten, solange die Farbe gleich bleibt.
  function feldFinden(pixel, k, f) {
    const W = pixel.width, H = pixel.height, d = pixel.data;
    const x = Math.max(0, Math.floor(k.x * f)), y = Math.max(0, Math.floor(k.y * f));
    const w = Math.max(1, Math.min(W - x, Math.floor(k.w * f))), h = Math.max(1, Math.min(H - y, Math.floor(k.el.offsetHeight * f)));
    const proben = [];
    // Proben aus dem Inneren des Kastens (sein Rand darf etwas über das Feld hinausragen)
    for (let i = 0; i < 15; i++) for (let j = 0; j < 10; j++) {
      const p = ((y + Math.floor(h * (0.15 + 0.7 * (j + 0.5) / 10))) * W + x + Math.floor(w * (0.1 + 0.8 * (i + 0.5) / 15))) * 4;
      proben.push([d[p], d[p + 1], d[p + 2]]);
    }
    const median = (c) => proben.map(p => p[c]).sort((a, b) => a - b)[proben.length >> 1];
    const farbe = [median(0), median(1), median(2)];
    if (Math.min(...farbe) > 232) return "papier";
    const gleichP = (p) => Math.abs(d[p] - farbe[0]) < 12 && Math.abs(d[p + 1] - farbe[1]) < 12 && Math.abs(d[p + 2] - farbe[2]) < 12;
    const gleich = (xx, yy) => xx >= 0 && yy >= 0 && xx < W && yy < H && gleichP((yy * W + xx) * 4);
    if (proben.filter(p => Math.abs(p[0] - farbe[0]) < 12 && Math.abs(p[1] - farbe[1]) < 12 && Math.abs(p[2] - farbe[2]) < 12).length < proben.length * 0.75) return null;
    // Startpunkt in der Mitte; liegt er auf einer Streifenlinie, ein paar Pixel daneben
    const cx = x + (w >> 1);
    const cy = [0, 3, -3, 6, -6, 9, -9].map(v => y + (h >> 1) + v).find(yy => gleich(cx, yy));
    if (cy === undefined) return null;
    // Feine Linien im Feld (manche Felder sind in Streifen gemalt) bis 4 Pixel überspringen
    const bisRand = (xx, yy, dx, dy) => {
      let letzt = dx ? xx : yy;
      for (let luecke = 0; luecke <= 4;) {
        xx += dx; yy += dy;
        if (gleich(xx, yy)) { letzt = dx ? xx : yy; luecke = 0; } else luecke++;
      }
      return letzt;
    };
    const l = bisRand(cx, cy, -1, 0), r = bisRand(cx, cy, 1, 0), o = bisRand(cx, cy, 0, -1), u = bisRand(cx, cy, 0, 1);
    // Das Feld muss den Kasten fast ganz enthalten und oben wie unten durchgehend dieselbe Farbe haben
    if (l > x + w * 0.1 || r < x + w * 0.9 || o > y + h * 0.3 || u < y + h * 0.7) return null;
    // (je die beste von einigen Zeilen, falls eine genau auf einer Streifenlinie liegt)
    for (const ziel of [Math.round(o + (u - o) * 0.1), Math.round(u - (u - o) * 0.1)]) {
      let bester = 0;
      for (let yy = ziel - 4; yy <= ziel + 4; yy += 2) {
        let n = 0, gut = 0;
        for (let xx = l; xx <= r; xx += 3) { n++; if (gleich(xx, yy)) gut++; }
        bester = Math.max(bester, gut / n);
      }
      if (bester < 0.9) return null;
    }
    return { x: l, y: o, w: r - l + 1, h: u - o + 1, farbe };
  }

  // Wie viel dunkle Tinte (Punkte, Stichprobe) liegt in den gut lesbaren Textkästen?
  function tinte(ctx, kaesten, f) {
    let n = 0;
    for (const k of kaesten) {
      if (k.schwierig) continue;
      const x = Math.max(0, Math.floor(k.x * f)), y = Math.max(0, Math.floor(k.y * f));
      const w = Math.max(1, Math.min(ctx.canvas.width - x, Math.floor(k.w * f))), h = Math.max(1, Math.min(ctx.canvas.height - y, Math.floor(k.h * f)));
      const d = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] < 384) n++;
    }
    return n;
  }

  // Zeichenfläche, auf der Schrift nicht gemalt wird (pdf.js malt Schrift mit fillText/strokeText)
  function ohneSchrift(ctx) {
    return new Proxy(ctx, {
      get(t, k) {
        if (k === "fillText" || k === "strokeText") return () => { };
        const w = Reflect.get(t, k);
        return typeof w === "function" ? w.bind(t) : w;
      },
      set(t, k, w) { return Reflect.set(t, k, w); },
    });
  }

  // Ist der Grund unter einem Kasten dunkel? (Mittelwert einiger Punkte)
  function grundDunkel(ctx, leinwand, k, f) {
    const x = Math.max(0, Math.floor(k.x * f)), y = Math.max(0, Math.floor(k.y * f));
    const w = Math.max(1, Math.min(leinwand.width - x, Math.floor(k.w * f))), h = Math.max(1, Math.min(leinwand.height - y, Math.floor(k.h * f)));
    const d = ctx.getImageData(x, y, w, h).data;
    let summe = 0, n = 0;
    const schritt = Math.max(1, Math.floor(d.length / 4 / 3000)) * 4;
    for (let i = 0; i < d.length; i += schritt) { summe += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
    return n > 0 && summe / n < 115;
  }

  // Leere Zeilen oben und unten (fast weißes Papier). Nur, wenn es sich lohnt, sonst null.
  function leererRand(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    // Ganz außen liegen bei Scans oft Flecken und Schatten vom Buchrücken: die nicht mitzählen
    const x1 = Math.floor(w * 0.05), x2 = Math.ceil(w * 0.95);
    const leer = (y) => {
      for (let x = x1; x < x2; x += 3) {
        const i = (y * w + x) * 4;
        if (d[i] < 225 || d[i + 1] < 225 || d[i + 2] < 225) return false;
      }
      return true;
    };
    let oben = 0, unten = h;
    while (oben < h && leer(oben)) oben++;
    while (unten > oben && leer(unten - 1)) unten--;
    if (unten <= oben) return null;                       // ganz leere Seite: so lassen
    const luft = Math.round(h * 0.03);
    oben = Math.max(0, oben - luft);
    unten = Math.min(h, unten + luft);
    return (oben + (h - unten)) > h * 0.08 ? { oben, unten } : null;
  }

  // Dunkles Design: Hell wird dunkel und dunkel hell, in den Fieldbook-Farben. Der Farbton bleibt erhalten
  // (rote Warnungen bleiben rot). Fotos bleiben, wie sie sind; Strichzeichnungen und eingescannte Seiten
  // (viel weißes Papier) werden wie Text behandelt.
  function abdunkeln(ctx, canvas, fotos) {
    const bild = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const p = bild.data;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], g = p[i + 1], b = p[i + 2];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const t = 1 - y / 255;                       // 0 = weißes Papier, 1 = schwarze Schrift
      // Grauwerte genau in den Fieldbook-Farben, Farbiges mit gleichem Abstand zum Grau (Farbton bleibt)
      p[i] = GRUND[0] + t * (SCHRIFT[0] - GRUND[0]) + (r - y);
      p[i + 1] = GRUND[1] + t * (SCHRIFT[1] - GRUND[1]) + (g - y);
      p[i + 2] = GRUND[2] + t * (SCHRIFT[2] - GRUND[2]) + (b - y);
    }
    // Fotos wieder einsetzen
    const originale = fotos.map(f => ({ f, d: ctx.getImageData(f.x, f.y, f.w, f.h) }));
    ctx.putImageData(bild, 0, 0);
    for (const o of originale) ctx.putImageData(o.d, o.f.x, o.f.y);
  }

  // Wo liegen Bilder auf der Seite, und sind es Fotos? Die Lage steht in der Befehlsliste der Seite
  // (Verschiebungen und Bild-Befehle), ob Foto oder Zeichnung, sagt der Anteil an weißem Papier im Bild
  // (gemessen auf der gedruckten Seite in ctx). Ergebnis: alle Bilder, Fotos mit foto: true.
  async function bildBereiche(page, vp, ctx, w, h) {
    const lib = await PdfText.bibliothek();
    const OPS = lib.OPS, Util = lib.Util;
    const ops = await page.getOperatorList();
    const stapel = [];
    let m = [1, 0, 0, 1, 0, 0];
    const bereiche = [];
    const bildBefehle = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject].filter(x => x !== undefined));
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === OPS.save) stapel.push(m);
      else if (fn === OPS.restore) m = stapel.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) m = Util.transform(m, a);
      else if (fn === OPS.paintFormXObjectBegin) { stapel.push(m); if (a && a[0]) m = Util.transform(m, a[0]); }
      else if (fn === OPS.paintFormXObjectEnd) m = stapel.pop() || [1, 0, 0, 1, 0, 0];
      else if (bildBefehle.has(fn)) {
        // Bilder füllen das Einheitsquadrat der aktuellen Verschiebung
        const g = Util.transform(vp.transform, m);
        const ecken = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => Util.applyTransform([x, y], g));
        const xs = ecken.map(e => e[0]), ys = ecken.map(e => e[1]);
        const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
        const x2 = Math.min(w, Math.ceil(Math.max(...xs))), y2 = Math.min(h, Math.ceil(Math.max(...ys)));
        if (x2 - x > 8 && y2 - y > 8) bereiche.push({ x, y, w: x2 - x, h: y2 - y });
      }
    }
    // Manche Abbildungen bestehen aus vielen Kacheln: aneinandergrenzende Bilder zu einem zusammenfassen,
    // sonst gilt eine einzelne dunkle Kachel einer Zeichnung als Foto
    const nah = (a, b) => a.x <= b.x + b.w + 3 && b.x <= a.x + a.w + 3 && a.y <= b.y + b.h + 3 && b.y <= a.y + a.h + 3;
    let zusammen = true;
    while (zusammen) {
      zusammen = false;
      for (let i = 0; i < bereiche.length && !zusammen; i++) {
        for (let j = i + 1; j < bereiche.length; j++) {
          const a = bereiche[i], b = bereiche[j];
          if (!nah(a, b)) continue;
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          bereiche[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          bereiche.splice(j, 1);
          zusammen = true;
          break;
        }
      }
    }
    // Fotos: nicht winzig (mindestens 2 % der Seite) und wenig weißes Papier
    for (const b of bereiche) {
      if (b.w * b.h < w * h * 0.02) continue;
      const d = ctx.getImageData(b.x, b.y, b.w, b.h).data;
      let weiss = 0, n = 0;
      const schritt = Math.max(1, Math.floor(d.length / 4 / 20000)) * 4;
      for (let i = 0; i < d.length; i += schritt) {
        n++;
        if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) weiss++;
      }
      b.foto = n > 0 && weiss / n < 0.45;
    }
    return bereiche;
  }

  // ---------------------------------------------------------------- Textansicht

  async function textLaden(n, meinLauf) {
    const s = seiten[n - 1];
    if (!s || s.stand) return;
    s.stand = 1;
    const page = await doc.getPage(n);
    const inhalt = await page.getTextContent();
    await page.getOperatorList();             // lädt die Schriften, deren Namen fett/kursiv verraten
    if (meinLauf !== lauf) return;
    const bloecke = textBloecke(inhalt.items, stilVon(page));
    // Zeichnungen gibt es nur in der Seitenansicht: von jeder Seite aus direkt dorthin
    const alsSeite = () => { ansicht = "seite"; aktuelleSeite = n; leisteAufbauen(); adresseMerken(); aufbauen(n); };
    const teile = [el("div", { class: "pdf-seitenmarke" }, "Seite " + n + " · ",
      el("button", { class: "pdf-als-seite", onclick: alsSeite }, "mit Bildern ansehen"))];
    if (!bloecke.length) {
      teile.push(el("p", { class: "pdf-ohne-text" }, "Auf dieser Seite steht kein Text, nur Bilder (oder sie ist eingescannt).", el("br"),
        el("button", { class: "knopf knopf-klein", onclick: alsSeite }, "Als Seite ansehen")));
    }
    for (const b of bloecke) teile.push(el(b.art, {}, ...knoten(b.teile)));
    // Steht die Seite über der aktuellen Stelle, verschiebt ihr Text alles darunter: ausgleichen
    const f = flaeche();
    const vorher = s.box.offsetHeight, ueber = s.box.offsetTop < f.scrollTop;
    s.box.style.minHeight = "";
    s.box.replaceChildren(...teile);
    if (ueber) f.scrollTop += s.box.offsetHeight - vorher;
    zielHalten();
    s.stand = 2;
    markieren(s.box);
    seiteUebersetzen(s);
  }

  // Schriftstil je Schrift der Seite (fett, kursiv) aus dem Namen der Schrift, z. B. „Times-BoldItalic“.
  // Die Namen kennt pdf.js erst, wenn die Seite gemalt oder ihre Befehlsliste geladen ist.
  function stilVon(page) {
    const merk = {};
    return (id) => {
      if (!(id in merk)) {
        let name = "";
        try { if (id && page.commonObjs.has(id)) { const o = page.commonObjs.get(id); name = (o && (o.name || o.loadedName)) || ""; } } catch { }
        merk[id] = { fett: /bold|black|heavy|semibold|demi/i.test(name), kursiv: /italic|oblique/i.test(name) };
      }
      return merk[id];
    };
  }

  // Textstücke einer Seite zu Zeilen zusammensetzen, in der Reihenfolge des PDFs (meist die Lesereihenfolge,
  // bei Spalten erst die linke Spalte ganz). Nach Höhe auf der Seite zu sortieren würde nebeneinanderliegende
  // Spalten Zeile für Zeile mischen. Je Zeile: Grundlinie y, Schrifthöhe h, links/rechts, Text, Stücke mit
  // Stil (fett, kursiv, hochgestellt), ob ganz fett, und ob sie große Lücken hat (Tabelle) oder schräg steht.
  function zeilenAus(items, stil) {
    const zeilen = [];
    let z = null;
    const anhaengen = (zz, t, art) => {
      const letzt = zz.teile[zz.teile.length - 1];
      if (letzt && letzt.fett === art.fett && letzt.kursiv === art.kursiv && letzt.hoch === art.hoch) letzt.t += t;
      else zz.teile.push({ t, fett: art.fett, kursiv: art.kursiv, hoch: art.hoch });
    };
    for (const it of items) {
      if (typeof it.str !== "string" || !it.transform) continue;
      const t = it.transform;
      const s = { x: t[4], y: t[5], h: Math.abs(t[3]) || Math.hypot(t[2], t[3]) || it.height || 10, w: it.width || 0, s: it.str };
      if (s.s.trim() === "") { if (z && it.hasEOL) z.ende = true; continue; }
      const schraeg = Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01;
      const st = stil ? stil(it.fontName) : { fett: false, kursiv: false };
      // Gleiche Zeile: gleiche Grundlinie und weiter rechts (ein Stück weiter links beginnt eine neue Zeile).
      // Hoch- oder tiefgestellte kleine Zeichen (Fußnoten-Zahlen, ²) gehören zur Zeile davor.
      const hoch = z && s.h < z.h * 0.85 && Math.abs(s.y - z.y) < z.h * 0.6 && Math.abs(s.x - z.rechts) < z.h;
      const gleich = z && (hoch || (!z.ende && Math.abs(z.y - s.y) < Math.max(2, Math.min(z.h, s.h) * 0.5))) && s.x > z.rechts - s.h;
      const art = { fett: st.fett, kursiv: st.kursiv, hoch: !!(hoch && s.y > z.y + z.h * 0.15) };
      if (gleich) {
        const luecke = s.x - z.rechts;
        if (luecke > s.h * 1.5) z.luecke = true;
        const text = z.teile.map(x => x.t).join("");
        if (luecke > s.h * 0.15 && !/\s$/.test(text) && !/^\s/.test(s.s) && !art.hoch) anhaengen(z, " ", { fett: false, kursiv: false, hoch: false });
        anhaengen(z, s.s, art);
        z.stuecke.push({ x: s.x, r: s.x + s.w, h: s.h, s: s.s });
        z.rechts = Math.max(z.rechts, s.x + s.w);
        if (!art.hoch) z.h = Math.max(z.h, s.h);
        z.schraeg = z.schraeg || schraeg;
      } else {
        z = { y: s.y, h: s.h, links: s.x, rechts: s.x + s.w, teile: [], stuecke: [{ x: s.x, r: s.x + s.w, h: s.h, s: s.s }], schraeg };
        anhaengen(z, s.s, art);
        zeilen.push(z);
      }
      if (it.hasEOL) z.ende = true;
    }
    for (const zz of zeilen) {
      zz.text = zz.teile.map(x => x.t).join("").replace(/\s+/g, " ").trim();
      // Punktlinien wie im Inhaltsverzeichnis („Okra ........ 4-14“) sind eine Art Tabelle
      if (/(\.\s?){6,}|…{2,}|_{6,}/.test(zz.text)) zz.luecke = true;
      const echt = zz.teile.filter(x => x.t.trim());
      zz.fett = echt.length > 0 && echt.every(x => x.fett);
    }
    return zeilen.filter(zz => zz.text);
  }

  // Zeilen zu Absätzen gruppieren: großer Abstand, Sprung nach oben oder weit zur Seite (nächste Spalte,
  // Kasten, Bildtext), Satzende vor einer kurzen Zeile. Große Schrift oder eine kurze, ganz fette Zeile wird
  // zur Überschrift (h2/h3); mehrzeilige Überschriften bleiben zusammen.
  function gruppieren(zeilen) {
    if (!zeilen.length) return [];
    const hoehen = zeilen.map(z => z.h).sort((a, b) => a - b);
    const normal = hoehen[Math.floor(hoehen.length / 2)];
    const breiteste = Math.max(...zeilen.map(z => z.rechts - z.links));
    const gruppen = [];
    let akt = null;
    for (let i = 0; i < zeilen.length; i++) {
      const z = zeilen[i], vor = zeilen[i - 1];
      const abstand = vor ? vor.y - z.y : 0;
      const gross = z.h > normal * 1.25 && z.text.length < 140;
      const fettTitel = z.fett && z.text.length < 100 && !(vor && vor.fett && akt && akt.art === "p");
      const titel = gross || fettTitel;
      const titelWeiter = akt && akt.art !== "p" && vor && z.fett === vor.fett && Math.abs(z.h - vor.h) < z.h * 0.1 &&
        abstand > 0 && abstand < z.h * 1.6 && z.text.length < 100 && Math.abs(z.links - vor.links) < breiteste * 0.5;
      // Aufzählungspunkte („•“, „1.“, „a)“) beginnen immer einen eigenen Absatz
      const punkt = /^([•●▪◦‣■□➢►\-–]\s|\(?\d{1,2}[.)]\s|\(?[a-z][.)]\s)/.test(z.text);
      const neu = !akt || punkt || (!titelWeiter && (titel || akt.art !== "p" ||
        abstand > Math.max(z.h, vor.h) * 1.75 || abstand < -z.h * 0.5 ||
        Math.abs(z.links - vor.links) > breiteste * 0.5 ||
        Math.abs(z.h - vor.h) > Math.min(z.h, vor.h) * 0.25 ||
        (/[.!?:]["”’)]?$/.test(vor.text) && (vor.rechts - vor.links) < breiteste * 0.75)));
      if (neu) {
        akt = { art: z.h > normal * 1.7 ? "h2" : titel ? "h3" : "p", zeilen: [z] };
        gruppen.push(akt);
      } else akt.zeilen.push(z);
    }
    return gruppen;
  }

  // Stücke einer Gruppe: Zeilen verbinden, am Zeilenende getrennte Wörter wieder zusammenfügen
  function verbinden(zeilen) {
    const teile = [];
    for (const z of zeilen) {
      const zt = z.teile.map(x => Object.assign({}, x));
      while (zt.length && !zt[0].t.trim()) zt.shift();
      if (!zt.length) continue;
      zt[0].t = zt[0].t.replace(/^\s+/, "");
      const letzt = teile[teile.length - 1];
      if (letzt) {
        if (/[A-Za-zÀ-ÿ]-$/.test(letzt.t) && /^[a-zà-ÿ]/.test(zt[0].t)) letzt.t = letzt.t.slice(0, -1);
        else if (!/\s$/.test(letzt.t)) letzt.t += " ";
      }
      teile.push(...zt);
    }
    for (const x of teile) x.t = x.t.replace(/\s+/g, " ");
    if (teile.length) teile[teile.length - 1].t = teile[teile.length - 1].t.replace(/\s+$/, "");
    return teile;
  }
  const nurText = (teile) => teile.map(x => x.t).join("");

  // Stücke als Knoten: fett, kursiv und hochgestellt wie im Buch
  function knoten(teile) {
    return teile.map(x => {
      let n = document.createTextNode(x.t);
      if (x.hoch) n = el("sup", {}, n);
      if (x.kursiv) n = el("i", {}, n);
      if (x.fett) n = el("b", {}, n);
      return n;
    });
  }

  // Textansicht: Überschriften und Absätze ohne Seitenzahlen und Kopfzeilen
  function textBloecke(items, stil) {
    const nur = zeilenAus(items, stil).filter(z => !/^\d{1,4}$/.test(z.text));   // Seitenzahlen weglassen
    if (!nur.length) return [];
    const hoehen = nur.map(z => z.h).sort((a, b) => a - b);
    const normal = hoehen[Math.floor(hoehen.length / 2)];
    // Kopf- und Fußzeilen des Buchs („46 KNOTS AND SPLICES“) weglassen: ganz oben oder unten, mit Seitenzahl,
    // in Großbuchstaben und nicht größer als der Text. Große Kapitelüberschriften („CHAPTER 3“) bleiben.
    const kopfzeile = (z) => z && nur.length > 1 && z.text.length < 70 && z.h <= normal * 1.15 &&
      /^(\d{1,4}\s+\D+|\D+\s+\d{1,4})$/.test(z.text) && z.text === z.text.toUpperCase();
    if (kopfzeile(nur[0])) nur.shift();
    if (kopfzeile(nur[nur.length - 1])) nur.pop();
    return gruppieren(nur).map(g => ({ art: g.art, teile: verbinden(g.zeilen) }));
  }

  // Einpassen: Schrift kleiner, solange der Kasten höher ist als der Absatz im Druck oder (einzeilig) breiter.
  // min: kleinster Anteil der ursprünglichen Größe. Ergebnis: ob es passt.
  function einpassen(e, min) {
    const gr = +e.dataset.gr, zh = +e.dataset.zh, h = +e.dataset.h;
    const zuGross = () => e.offsetHeight > h * 1.04 + 2 || e.scrollWidth > e.clientWidth + 1;
    let f = 1;
    e.style.fontSize = gr + "px";
    e.style.lineHeight = zh + "px";
    while (zuGross() && f > min) {
      f -= 0.04;
      e.style.fontSize = (gr * f).toFixed(2) + "px";
      e.style.lineHeight = (zh * f).toFixed(2) + "px";
    }
    return !zuGross();
  }

  // Seitenansicht: je Absatz ein Kasten an seiner Stelle auf der Seite (Maße in CSS-Pixeln der Seite).
  // Der Text bricht im Kasten neu um; passt er nicht, wird die Schrift bis auf etwa drei Viertel verkleinert.
  // Schwierig (dann zeigt diese Stelle das Bild des Drucks): Tabelle, schräger Text, passt auch klein nicht,
  // überlappt einen anderen Kasten.
  // Schrittnummer vor dem Absatz („1  White strand …“, die weiteren Zeilen beginnen erst beim Text): Sie steht
  // im Druck oft außerhalb des Textkastens (graues Feld unter einem Bild). Sie wird ein eigener kleiner Kasten,
  // sonst finge der Absatz schon bei der Nummer an und wäre breiter als im Druck.
  function nummerAbtrennen(g) {
    const z = g.zeilen[0], st = z.stuecke;
    if (g.art !== "p" || !st || st.length < 2 || !/^\(?\d{1,3}[.)]?$/.test(st[0].s.trim())) return [g];
    const textX = st[1].x;
    if (textX - st[0].r < Math.min(st[0].h, st[1].h) * 0.25) return [g];
    if (g.zeilen.slice(1).some(zz => zz.links < textX - zz.h * 0.6)) return [g];
    const teile = z.teile.map(x => Object.assign({}, x));
    const nr = st[0].s.trim();
    teile[0].t = teile[0].t.replace(/^\s*/, "").slice(nr.length).replace(/^\s+/, "");
    if (!teile[0].t) teile.shift();
    if (!teile.length) return [g];
    const rest = st.slice(1);
    const h = Math.max(...rest.map(x => x.h));
    const ohne = Object.assign({}, z, { links: textX, h, teile, text: z.text.slice(z.text.indexOf(nr) + nr.length).trim(), stuecke: rest });
    const nummer = Object.assign({}, z, { links: st[0].x, rechts: st[0].r, h: st[0].h, teile: [{ t: nr, fett: z.teile[0].fett, kursiv: z.teile[0].kursiv, hoch: false }], text: nr, stuecke: [st[0]], luecke: false });
    return [{ art: "p", zeilen: [nummer] }, { art: "p", zeilen: [ohne].concat(g.zeilen.slice(1)) }];
  }

  function kaestenBauen(items, stil, vp, schicht) {
    const kaesten = [];
    const gruppen = [].concat(...gruppieren(zeilenAus(items, stil)).map(nummerAbtrennen));
    for (const g of gruppen) {
      const zs = g.zeilen;
      const links = Math.min(...zs.map(z => z.links)), rechts = Math.max(...zs.map(z => z.rechts));
      const oben = Math.max(...zs.map(z => z.y + z.h * 0.88)), unten = Math.min(...zs.map(z => z.y - z.h * 0.24));
      const p1 = vp.convertToViewportPoint(links, oben), p2 = vp.convertToViewportPoint(rechts, unten);
      const teile = verbinden(zs);
      const k = {
        x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]),
        teile, text: nurText(teile), art: g.art,
        schwierig: zs.some(z => z.luecke || z.schraeg),
      };
      const hoehen = zs.map(z => z.h).sort((a, b) => a - b);
      const groesse = hoehen[Math.floor(hoehen.length / 2)] * vp.scale * 0.9;
      const abstand = zs.length > 1 ? (zs[0].y - zs[zs.length - 1].y) / (zs.length - 1) * vp.scale : groesse * 1.25;
      const zeilenHoehe = Math.max(groesse * 1.05, abstand);
      k.el = el("div", { class: "pdf-kasten" + (g.art !== "p" ? " pdf-kasten-titel" : "") + (zs.length === 1 ? " pdf-einzeilig" : "") }, ...knoten(teile));
      k.el.style.cssText = "left:" + k.x.toFixed(1) + "px;top:" + k.y.toFixed(1) + "px;width:" + (k.w + 2).toFixed(1) + "px;" +
        "font-size:" + groesse.toFixed(2) + "px;line-height:" + zeilenHoehe.toFixed(2) + "px";
      schicht.append(k.el);
      // Maße merken: Nach dem Übersetzen wird der (meist längere) deutsche Text noch einmal eingepasst
      k.el.dataset.gr = groesse.toFixed(2);
      k.el.dataset.zh = zeilenHoehe.toFixed(2);
      k.el.dataset.h = k.h.toFixed(1);
      if (!einpassen(k.el, 0.74)) k.schwierig = true;
      kaesten.push(k);
    }
    // Überlappen sich zwei Kästen, sind beide schwierig
    const r = kaesten.map(k => ({ x: k.el.offsetLeft, y: k.el.offsetTop, w: k.el.offsetWidth, h: k.el.offsetHeight }));
    for (let i = 0; i < kaesten.length; i++) for (let j = i + 1; j < kaesten.length; j++) {
      const a = r[i], b = r[j];
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 3 && iy > 3) { kaesten[i].schwierig = true; kaesten[j].schwierig = true; }
    }
    return kaesten;
  }

  // ---------------------------------------------------------------- Bedienung

  $("#pdf-zurueck").addEventListener("click", () => {
    // Gibt es eine Seite von Fieldbook davor (Paket, KI-Antwort …), dorthin; direkt geöffnet zur Bibliothek.
    // Nicht nach history.length entscheiden: Die schrumpft, wenn man zurückgeht und Neues öffnet.
    if (window.navigation ? navigation.currentEntry.index > 0 : history.length > 1) history.back();
    else location.hash = "#bibliothek";
  });
  $("#pdf-original").addEventListener("change", (e) => {
    original = e.target.checked;
    aufbauen(aktuelleSeite);
  });
  // Neue Fenstergröße: Seiten neu zeichnen (verzögert, damit es beim Ziehen nicht ruckelt)
  let groesseTimer = null;
  window.addEventListener("resize", () => {
    if (!location.hash.startsWith("#pdf") || ansicht !== "seite") return;
    clearTimeout(groesseTimer);
    groesseTimer = setTimeout(() => aufbauen(aktuelleSeite), 300);
  });

  function themaGeaendert() {
    if (!location.hash.startsWith("#pdf") || !doc) return;
    $("#pdf-original-box").hidden = ansicht !== "seite";
    if (ansicht === "seite") aufbauen(aktuelleSeite);
  }

  // Beim Verlassen Speicher freigeben (Seitenbilder können groß sein)
  function verlassen() {
    if (!doc) return;
    if (beobachter) beobachter.disconnect();
    if (textBeobachter) textBeobachter.disconnect();
    for (let i = 1; i <= seiten.length; i++) freigeben(i);
    verlassen.war = true;
  }

  return { zeigen, themaGeaendert, verlassen };
})();
