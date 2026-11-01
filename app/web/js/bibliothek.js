// Bibliothek: Regal aller Pakete, Suche über alle Pakete, Lesen.
"use strict";

const Bibliothek = (() => {
  // Darstellung: Kacheln oder Liste, gilt für Kategorien und Pakete
  let ansicht = "kacheln";
  try { if (localStorage.getItem("ow-bib-ansicht") === "liste") ansicht = "liste"; } catch { }
  let letzteParams = new URLSearchParams();

  function zeigeAnsichtKnoepfe() {
    for (const b of document.querySelectorAll("[data-bib-ansicht]")) b.setAttribute("aria-pressed", String(b.dataset.bibAnsicht === ansicht));
  }
  for (const b of document.querySelectorAll("[data-bib-ansicht]")) {
    b.addEventListener("click", () => {
      ansicht = b.dataset.bibAnsicht;
      try { localStorage.setItem("ow-bib-ansicht", ansicht); } catch { }
      zeigeAnsichtKnoepfe();
      zeichneRegal(letzteParams);
    });
  }
  zeigeAnsichtKnoepfe();

  const WEITERE = { id: "sonstiges", icon: "package", titel: "Weitere Pakete", text: "Selbst hinzugefügte Pakete" };
  const kategorien = () => (OW.kategorien || []).concat([WEITERE]);
  const anzahlText = (n) => n === 1 ? "1 Paket" : n + " Pakete";

  async function zeigen(params) {
    letzteParams = params;
    const q = params.get("q") || "";
    $("#bib-suche-feld").value = q;
    const regal = $("#regal");
    regal.innerHTML = "";
    $("#bib-kopf").innerHTML = "";
    const buecher = await Kiwix.buecher();
    if (!buecher.length) {
      const s = OW.status || {};
      // Pakete sind da, aber die Bibliothek läuft (noch) nicht: das ist kein "nicht installiert"
      if (s.wissen > 0) {
        regal.append(el("div", { class: "karte-box" },
          s.bibliothekFehler ? el("p", { class: "fehlerbox", style: "margin-top:0" }, s.bibliothekFehler)
                             : el("p", { style: "margin-top:0" }, s.wissen + " Wissenspakete sind installiert. Die Bibliothek wird gerade gestartet …"),
          el("button", { class: "knopf knopf-klein", onclick: async () => { OW.buecher = null; await aktualisiereStatus(); zeigen(params); } }, "Erneut versuchen")));
        if (!s.bibliothekFehler) setTimeout(async () => { if (location.hash.startsWith("#bibliothek")) { OW.buecher = null; await aktualisiereStatus(); zeigen(params); } }, 3000);
      } else regal.append(el("div", { class: "karte-box" }, "Es ist noch keine Bibliothek installiert. ", el("a", { href: "#inhalte" }, "Wissen herunterladen")));
      $("#bib-treffer").innerHTML = "";
      return;
    }
    if (q) suchen(q); else $("#bib-treffer").innerHTML = "";
    zeichneRegal(params);
  }

  // Übersicht der Kategorien oder die Pakete einer Kategorie
  async function zeichneRegal(params) {
    const buecher = await Kiwix.buecher();
    if (!buecher.length) return;
    const regal = $("#regal");
    const kopf = $("#bib-kopf");
    regal.innerHTML = "";
    kopf.innerHTML = "";
    $("#bib-unten").innerHTML = "";
    regal.className = "regal " + ansicht;
    const katId = params.get("kat");
    const k = katId && kategorien().find(x => x.id === katId);
    const paket = params.get("paket") && buecher.find(x => x.id === params.get("paket"));

    if (paket) { zeichnePaket(paket, params); return; }
    if (k) {
      kopf.append(el("a", { class: "knopf knopf-klein", href: "#bibliothek" }, "← Alle Kategorien"),
        el("div", {}, el("h2", {}, sym(k.icon), k.titel), el("small", {}, k.text)));
      for (const b of buecher.filter(x => x.kategorien.includes(k.id))) regal.append(paketEintrag(b));
      return;
    }
    if (params.get("q")) kopf.append(el("h2", {}, "Kategorien"));
    for (const kat of kategorien()) {
      const n = buecher.filter(x => x.kategorien.includes(kat.id)).length;
      if (!n) continue;
      regal.append(el("a", { class: "eintrag kat", href: "#bibliothek?kat=" + kat.id },
        symFeld(kat.icon, "gross"),
        el("div", { class: "e-text" }, el("b", {}, kat.titel), el("small", {}, kat.text)),
        el("span", { class: "e-zahl" }, anzahlText(n))));
    }
  }

  // Link ins Lesefenster; extra z. B. "&zufall=1" oder "&suche=…"
  const leseLink = (b, pfad, titel, extra) =>
    "#lesen?url=" + encodeURIComponent(b.start + (pfad ? "/" + pfad : "")) + "&titel=" + encodeURIComponent(titel || b.titel) + (extra || "");

  // Eigene Startseite eines Pakets: Suche, Zufall, Kacheln zu Übersichtsseiten und (iFixit) nur Zweige mit Anleitungen
  function zeichnePaket(b, params) {
    const kopf = $("#bib-kopf"), regal = $("#regal"), unten = $("#bib-unten");
    const kat = kategorien().find(x => x.id === b.kategorien[0]);
    kopf.append(el("a", { class: "knopf knopf-klein", href: kat ? "#bibliothek?kat=" + kat.id : "#bibliothek" }, "← " + (kat ? kat.titel : "Alle Kategorien")),
      el("div", {}, el("h2", {}, b.titel), el("small", {}, b.text)));
    const aktionen = el("div", { class: "paket-aktionen" });
    if (b.durchsuchen) {
      const feld = el("input", { type: "search", placeholder: "In „" + b.titel.replace(/ \(.*\)$/, "") + "“ suchen …", "aria-label": "In diesem Paket suchen" });
      aktionen.append(el("form", { class: "paket-suche", onsubmit: (e) => {
        e.preventDefault();
        const q = feld.value.trim();
        if (q) location.hash = leseLink(b, "", b.titel, "&suche=" + encodeURIComponent(q));
      } }, feld, el("button", { class: "knopf knopf-haupt", type: "submit" }, "Suchen")));
    }
    aktionen.append(el("a", { class: "knopf", href: leseLink(b, "", b.titel, "&zufall=1") }, sym("shuffle"), "Zufälliger Artikel"),
      el("a", { class: "knopf", href: leseLink(b) }, sym("house"), "Startseite im Paket"));
    kopf.append(aktionen);
    regal.className = "regal kacheln";
    for (const kachel of (b.startseite.kacheln || [])) {
      regal.append(el("a", { class: "eintrag kat", href: leseLink(b, kachel.pfad, kachel.titel) },
        kachel.icon ? symFeld(kachel.icon, "gross") : null,
        el("div", { class: "e-text" }, el("b", {}, kachel.titel), kachel.text ? el("small", {}, kachel.text) : null)));
    }
    if (b.startseite.ifixit) zeichneIfixit(b, params.get("knoten") || "");
  }

  async function zeichneIfixit(b, knoten) {
    const regal = $("#regal"), unten = $("#bib-unten");
    const hier = location.hash;
    const r = await api("ifixit?buch=" + encodeURIComponent(b.id) + "&pfad=" + encodeURIComponent(knoten)).catch(e => ({ fehler: e.message }));
    if (location.hash !== hier) return;
    unten.innerHTML = "";
    if (r.status === "laeuft") {
      unten.append(el("p", { class: "hinweis" }, "Die Übersicht wird einmalig erstellt, das dauert ein paar Minuten … (" + (r.gelesen || 0) + " Seiten gelesen). Suche und Zufall gehen schon."));
      setTimeout(() => { if (location.hash === hier) zeichneIfixit(b, knoten); }, 3000);
      return;
    }
    if (r.fehler) { unten.append(el("p", { class: "fehlerbox" }, "Übersicht nicht verfügbar: " + r.fehler)); return; }
    const link = (pfad) => "#bibliothek?paket=" + encodeURIComponent(b.id) + (pfad ? "&knoten=" + encodeURIComponent(pfad) : "");
    const anz = (n) => n === 1 ? "1 Anleitung" : n.toLocaleString("de-DE") + " Anleitungen";
    unten.append(el("h3", { class: "ifixit-weg" },
      el("a", { href: link("") }, "Alle Bereiche"), ...r.weg.flatMap(w => [" › ", w.pfad === r.pfad ? w.titel : el("a", { href: link(w.pfad) }, w.titel)])));
    if (r.kinder.length) {
      const liste = el("div", { class: "regal kacheln" });
      for (const k of r.kinder)
        liste.append(el("a", { class: "eintrag", href: link(k.pfad) },
          el("div", { class: "e-text" }, el("b", {}, k.titel), el("small", {}, anz(k.anzahl)))));
      unten.append(liste);
    }
    if (r.anleitungen.length) {
      unten.append(el("h3", {}, r.kinder.length ? "Anleitungen direkt hier" : anz(r.anleitungen.length)),
        ...r.anleitungen.map(a => el("a", { class: "treffer", href: leseLink(b, a.pfad, a.titel) }, el("b", {}, a.titel))));
    }
    // Kacheln aus pakete.json nur auf der obersten Ebene zeigen
    if (knoten) regal.innerHTML = "";
  }

  function paketEintrag(b) {
    const liste = ansicht === "liste";
    const text = b.text || "";
    const ziel = b.startseite ? "#bibliothek?paket=" + encodeURIComponent(b.id) : "#lesen?url=" + encodeURIComponent(b.start) + "&titel=" + encodeURIComponent(b.titel);
    return el("a", { class: "eintrag", href: ziel },
      el("img", { class: "e-bild", src: b.bild || "icon.svg", alt: "", loading: "lazy" }),
      el("div", { class: "e-text" }, el("b", {}, b.titel),
        el("small", {}, (b.englisch ? "Englisch · " : "") + (liste ? text : text.slice(0, 90) + (text.length > 90 ? " …" : "")))),
      liste ? el("span", { class: "e-zahl" }, "Öffnen") : null);
  }

  async function suchen(q) {
    const ziel = $("#bib-treffer");
    ziel.innerHTML = '<p class="hinweis">Suche …</p>';
    const buecher = (await Kiwix.buecher()).filter(b => b.durchsuchen);
    const gruppen = await Promise.all(buecher.map(async b => {
      const [titel, voll] = await Promise.all([Kiwix.vorschlaege(b, q, 4).catch(() => []), Kiwix.suche(b, q, 4).catch(() => [])]);
      const gesehen = new Set();
      const liste = [];
      for (const t of titel.concat(voll)) {
        const k = decodeURIComponent(t.url).toLowerCase();
        if (gesehen.has(k)) continue;
        gesehen.add(k);
        liste.push(t);
      }
      return { b, liste: liste.slice(0, 6) };
    }));
    ziel.innerHTML = "";
    const kopf = el("div", { class: "knopfreihe", style: "margin:0 0 16px" },
      el("a", { class: "knopf knopf-haupt", href: "#fragen", onclick: () => setTimeout(() => { $("#frage-feld").value = q; }, 60) }, sym("message-circle"), "Die KI dazu fragen"));
    if (OW.status && OW.status.karten && OW.status.karten.length)
      kopf.append(el("a", { class: "knopf", href: "#karten", onclick: () => setTimeout(() => Karten.sucheOrt(q), 300) }, sym("map"), "Auf der Karte suchen"));
    ziel.append(kopf);
    let gefunden = 0;
    for (const { b, liste } of gruppen) {
      if (!liste.length) continue;
      gefunden += liste.length;
      ziel.append(el("div", { class: "treffer-gruppe" }, el("h3", {}, b.titel),
        ...liste.map(t => el("a", { class: "treffer", href: "#lesen?url=" + encodeURIComponent(t.url) + "&titel=" + encodeURIComponent(t.titel) },
          el("b", {}, t.titel), t.auszug ? el("small", {}, t.auszug.slice(0, 200)) : null))));
    }
    if (!gefunden) ziel.append(el("p", { class: "hinweis" }, "Keine Treffer für „" + q + "“."));
  }

  $("#bib-suche").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#bib-suche-feld").value.trim();
    location.hash = "#bibliothek" + (q ? "?q=" + encodeURIComponent(q) : "");
  });

  // "Zurück" geht wie die Zurück-Taste der Maus eine Seite im Lesefenster zurück, von der ersten Seite
  // aus zur Seite, von der man gekommen ist (z. B. Bibliotheksübersicht). Ohne eigenen Verlaufseintrag
  // (Seite direkt geöffnet) springt er direkt zur Herkunft.
  let leseStart = 0, herkunft = "#bibliothek", warLesen = false;
  window.addEventListener("hashchange", (e) => {
    const jetztLesen = location.hash.startsWith("#lesen");
    if (jetztLesen && !warLesen) {
      leseStart = history.length;
      const alt = new URL(e.oldURL).hash;
      herkunft = alt && !alt.startsWith("#lesen") ? alt : "#bibliothek";
    }
    warLesen = jetztLesen;
  });
  $("#lese-zurueck").addEventListener("click", () => {
    if (leseStart && history.length > 1) history.back();
    else location.hash = herkunft;
  });

  Uebersetzer.anbinden();

  // Leseleiste: Startseite, Zufall und Suche über die Funktionen des Kiwix-Viewers im Lesefenster
  function viewer() {
    try { const w = $("#lese-rahmen").contentWindow; return w && w.gotoMainPageOfCurrentBook ? w : null; } catch { return null; }
  }
  // Paket, das gerade im Lesefenster offen ist (aus "/kiwix/viewer#paket/Artikel" oder "/kiwix/content/paket/…")
  function aktuellesPaket() {
    try {
      const l = $("#lese-rahmen").contentWindow.location;
      const m = l.hash.match(/^#([^/]+)/) || l.pathname.match(/^\/kiwix\/content\/([^/]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }
  async function leisteAnpassen() {
    const id = aktuellesPaket();
    const b = id && (await Kiwix.buecher()).find(x => x.id === id);
    $("#lese-suche").hidden = !(b && b.durchsuchen);
    $("#lese-suche-feld").placeholder = b ? "In „" + b.titel.replace(/ \(.*\)$/, "") + "“ suchen …" : "In diesem Paket suchen …";
  }
  // PDF-Links (z. B. Medizin-Handbücher) wollen ein neues Fenster öffnen, was je nach Browser zum
  // Download wird. Stattdessen das PDF im Lesefenster zeigen; "Zurück" führt dann zur Liste.
  function pdfImLesefenster(innen) {
    try {
      const doc = innen.contentDocument;
      if (!doc || doc.pdfLinksAngepasst) return;
      doc.pdfLinksAngepasst = true;
      doc.addEventListener("click", (e) => {
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const url = new URL(a.href, doc.baseURI);
        if (url.origin !== location.origin || !/\.pdf$/i.test(url.pathname)) return;
        e.preventDefault();
        e.stopPropagation();
        innen.contentWindow.location.href = url.href;
      }, true);
    } catch { }
  }
  // Beim Wechsel zu einem anderen Paket ändert sich im Viewer oft nur der Hash, ohne neues "load"
  $("#lese-rahmen").addEventListener("load", () => {
    leisteAnpassen();
    try {
      const w = $("#lese-rahmen").contentWindow;
      w.addEventListener("hashchange", leisteAnpassen);
      const innen = w.document.getElementById("content_iframe");
      if (innen) { innen.addEventListener("load", () => pdfImLesefenster(innen)); pdfImLesefenster(innen); }
    } catch { }
  });
  $("#lese-start").addEventListener("click", () => { const w = viewer(); if (w) w.gotoMainPageOfCurrentBook(); });
  $("#lese-zufall").addEventListener("click", () => { const w = viewer(); if (w) w.gotoRandomPage(); });
  $("#lese-suche").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#lese-suche-feld").value.trim();
    const w = viewer();
    if (!q || !w) return;
    // Suchfeld des Viewers füllen und seine Suche starten, dann zeigt Kiwix die Trefferliste im Lesefenster
    w.document.getElementById("kiwixsearchbox").value = q;
    w.performSearch();
  });

  function lesen(params) {
    const url = params.get("url") || "";
    if (!url.startsWith("/kiwix/")) return;
    $("#uebersetzen-knopf").hidden = !Uebersetzer.verfuegbar();
    if (!leseStart) { leseStart = history.length; warLesen = true; }
    const rahmen = $("#lese-rahmen");
    // Ein neues Buch ohne zusätzlichen Verlaufseintrag laden (sonst führt "Zurück" ins vorher gelesene Buch
    // statt zur Übersicht). Links innerhalb des Artikels bleiben mit "Zurück" erreichbar.
    let aktuell = null;
    try { const l = rahmen.contentWindow.location; aktuell = l.href === "about:blank" ? null : l.pathname + l.search + l.hash; } catch { }
    if (aktuell !== url) {
      if (aktuell) rahmen.contentWindow.location.replace(url);
      else rahmen.setAttribute("src", url);
    }
    $("#lese-titel").textContent = params.get("titel") || "";
    $("#lese-neu").href = url;
    // Von der Paket-Startseite: zufälligen Artikel zeigen oder suchen, sobald der Viewer bereit ist
    const suche = params.get("suche"), zufall = params.get("zufall");
    if (suche || zufall) wennViewerBereit((w) => {
      if (zufall) w.gotoRandomPage();
      else { w.document.getElementById("kiwixsearchbox").value = suche; w.performSearch(); }
    });
  }

  function wennViewerBereit(fn, versuche) {
    const w = viewer();
    const innen = w && w.document.getElementById("content_iframe");
    // Erst wenn die Startseite des Pakets fertig geladen ist, sonst überschreibt sie Zufall und Suche wieder
    let geladen = false;
    try { geladen = innen.contentDocument.readyState === "complete" && innen.contentWindow.location.pathname.indexOf("/content/") >= 0; } catch { }
    if (w && geladen) { setTimeout(() => fn(w), 300); return; }
    if ((versuche || 0) < 50) setTimeout(() => wennViewerBereit(fn, (versuche || 0) + 1), 200);
  }

  // Videos und Töne im Lesefenster anhalten (auch in den Rahmen des Kiwix-Viewers), damit sie nach
  // dem Wechsel zu einer anderen Seite nicht unsichtbar weiterlaufen
  function anhalten(w) {
    try {
      w = w || $("#lese-rahmen").contentWindow;
      w.document.querySelectorAll("video, audio").forEach(m => m.pause());
      for (let i = 0; i < w.frames.length; i++) anhalten(w.frames[i]);
    } catch { }
  }

  return { zeigen, lesen, anhalten };
})();
