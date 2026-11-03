// Bibliothek: Regal aller Pakete, Suche über alle Pakete, Lesen.
"use strict";

const Bibliothek = (() => {
  // Welche Kategorien und Pakete aufgeklappt sind; bleibt erhalten, wenn man aus dem Lesefenster zurückkommt
  const offen = new Set();
  // Zuletzt gezeigter Bereich im iFixit-Baum je Paket
  const ifixitStelle = {};

  const WEITERE = { id: "sonstiges", icon: "package", titel: "Weitere Pakete", text: "Selbst hinzugefügte Pakete" };
  const kategorien = () => (OW.kategorien || []).concat([WEITERE]);
  const anzahlText = (n) => n === 1 ? "1 Paket" : n + " Pakete";

  async function zeigen(params) {
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
    zeichneRegal(params, buecher);
  }

  // Zeile, die beim Anklicken nach unten aufklappt. Der Inhalt wird erst beim ersten Öffnen gebaut.
  function klappe(schluessel, klasse, kopfInhalt, inhalt) {
    const knopf = el("button", { type: "button", class: "eintrag klapp-kopf", "aria-expanded": "false" },
      ...kopfInhalt, el("span", { class: "klapp-pfeil", "aria-hidden": "true" }));
    const innen = el("div", { class: "klapp-innen" });
    const box = el("div", { class: "klapp " + klasse }, knopf, el("div", { class: "klapp-huelle" }, innen));
    let gebaut = false;
    function setzen(auf) {
      if (auf && !gebaut) { innen.append(inhalt()); gebaut = true; }
      box.classList.toggle("auf", auf);
      knopf.setAttribute("aria-expanded", String(auf));
      if (auf) offen.add(schluessel); else offen.delete(schluessel);
    }
    knopf.addEventListener("click", () => setzen(!box.classList.contains("auf")));
    if (offen.has(schluessel)) setzen(true);
    return box;
  }

  // Alle Kategorien als Liste; jede klappt ihre Pakete auf, jedes Paket seine Suche und Einstiege
  function zeichneRegal(params, buecher) {
    const regal = $("#regal"), kopf = $("#bib-kopf");
    regal.innerHTML = "";
    kopf.innerHTML = "";
    // Alte Links (#bibliothek?kat=… oder ?paket=…) öffnen die passende Stelle
    if (params.get("kat")) offen.add("k:" + params.get("kat"));
    const p = params.get("paket") && buecher.find(x => x.id === params.get("paket"));
    if (p) { const k = p.kategorien[0] || "sonstiges"; offen.add("k:" + k); offen.add("p:" + k + ":" + p.id); }
    if (params.get("q")) kopf.append(el("h2", {}, "Kategorien"));
    for (const kat of kategorien()) {
      const pakete = buecher.filter(x => x.kategorien.includes(kat.id));
      if (!pakete.length) continue;
      regal.append(klappe("k:" + kat.id, "klapp-kat",
        [symFeld(kat.icon, "gross"),
         el("span", { class: "e-text" }, el("b", {}, kat.titel), el("small", {}, kat.text)),
         el("span", { class: "e-zahl" }, anzahlText(pakete.length))],
        () => el("div", { class: "klapp-liste" }, pakete.map(b => paketZeile(b, kat.id)))));
    }
  }

  // Link ins Lesefenster; extra z. B. "&zufall=1" oder "&suche=…"
  const leseLink = (b, pfad, titel, extra) =>
    "#lesen?url=" + encodeURIComponent(b.start + (pfad ? "/" + pfad : "")) + "&titel=" + encodeURIComponent(titel || b.titel) + (extra || "");

  function paketZeile(b, katId) {
    return klappe("p:" + katId + ":" + b.id, "klapp-paket",
      [el("img", { class: "e-bild", src: b.bild || "icon.svg", alt: "", loading: "lazy" }),
       el("span", { class: "e-text" }, el("b", {}, b.titel), el("small", {}, (b.englisch ? "Englisch · " : "") + (b.text || "")))],
      () => paketInhalt(b));
  }

  // Aufgeklapptes Paket: Suche, Öffnen, Zufall, Einstiege zu Übersichtsseiten und (iFixit) der Geräte-Baum
  function paketInhalt(b) {
    const box = el("div", { class: "paket-innen" });
    const aktionen = el("div", { class: "paket-aktionen" });
    if (b.durchsuchen) {
      const feld = el("input", { type: "search", placeholder: "In „" + b.titel.replace(/ \(.*\)$/, "") + "“ suchen …", "aria-label": "In diesem Paket suchen" });
      aktionen.append(el("form", { class: "paket-suche", onsubmit: (e) => {
        e.preventDefault();
        const q = feld.value.trim();
        if (q) location.hash = leseLink(b, "", b.titel, "&suche=" + encodeURIComponent(q));
      } }, feld, el("button", { class: "knopf", type: "submit" }, "Suchen")));
    }
    const st = b.startseite || {};
    // Pakete mit eigener Fieldbook-Startseite (Klexikon) öffnen dort statt auf der Startseite des Pakets
    aktionen.append(el("a", { class: "knopf knopf-haupt", href: st.eigene ? "#paketstart?buch=" + encodeURIComponent(b.id) : leseLink(b) }, sym("book-open"), "Öffnen"),
      el("a", { class: "knopf", href: leseLink(b, "", b.titel, "&zufall=1") }, sym("shuffle"), "Zufälliger Artikel"));
    box.append(aktionen);
    if ((st.kacheln || []).length)
      box.append(el("div", { class: "paket-themen" },
        st.kacheln.map(k => el("a", { class: "knopf knopf-klein", href: leseLink(b, k.pfad, k.titel) }, k.icon ? sym(k.icon) : null, k.titel))));
    if (st.ifixit) {
      const baum = el("div", { class: "ifixit-baum" });
      box.append(baum);
      zeichneIfixit(b, baum, ifixitStelle[b.id] || "");
    }
    return box;
  }

  // Geräte-Baum von iFixit, nur Zweige mit Anleitungen; man bewegt sich darin, ohne die Seite zu wechseln
  async function zeichneIfixit(b, ziel, knoten) {
    ifixitStelle[b.id] = knoten;
    const r = await api("ifixit?buch=" + encodeURIComponent(b.id) + "&pfad=" + encodeURIComponent(knoten)).catch(e => ({ fehler: e.message }));
    if (ifixitStelle[b.id] !== knoten) return;
    ziel.innerHTML = "";
    if (r.status === "laeuft") {
      ziel.append(el("p", { class: "hinweis" }, "Die Übersicht wird einmalig erstellt, das dauert ein paar Minuten … (" + (r.gelesen || 0) + " Seiten gelesen). Suche und Zufall gehen schon."));
      setTimeout(() => { if (ziel.isConnected) zeichneIfixit(b, ziel, knoten); }, 3000);
      return;
    }
    if (r.fehler) { ziel.append(el("p", { class: "fehlerbox" }, "Übersicht nicht verfügbar: " + r.fehler)); return; }
    const gehe = (pfad, ...inhalt) => el("button", { type: "button", onclick: () => zeichneIfixit(b, ziel, pfad) }, ...inhalt);
    const anz = (n) => n === 1 ? "1 Anleitung" : n.toLocaleString("de-DE") + " Anleitungen";
    ziel.append(el("h3", { class: "ifixit-weg" },
      gehe("", "Alle Bereiche"), ...r.weg.flatMap(w => [" › ", w.pfad === r.pfad ? w.titel : gehe(w.pfad, w.titel)])));
    if (r.kinder.length)
      ziel.append(el("div", { class: "ifixit-zweige" },
        r.kinder.map(k => gehe(k.pfad, el("b", {}, k.titel), el("small", {}, anz(k.anzahl))))));
    if (r.anleitungen.length)
      ziel.append(el("h3", {}, r.kinder.length ? "Anleitungen direkt hier" : anz(r.anleitungen.length)),
        ...r.anleitungen.map(a => el("a", { class: "treffer", href: leseLink(b, a.pfad, a.titel) }, el("b", {}, a.titel))));
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
  $("#lese-start").addEventListener("click", async () => {
    const id = aktuellesPaket();
    const b = id && (await Kiwix.buecher()).find(x => x.id === id);
    if (b && b.startseite && b.startseite.eigene) { location.hash = "#paketstart?buch=" + encodeURIComponent(id); return; }
    const w = viewer(); if (w) w.gotoMainPageOfCurrentBook();
  });
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
      verdeckenBisGeladen(rahmen);
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

  // Bis der neue Artikel da ist, das Lesefenster ausblenden: Sonst blitzt erst die leere weiße Seite
  // (oder kurz der vorige Artikel) auf. Im Kiwix-Viewer wird auf den Artikel im inneren Rahmen gewartet.
  // Ändert sich im Viewer nur der Hash, gibt es kein "load" des äußeren Rahmens, dafür eines des inneren.
  let verdeckt = 0;
  function verdeckenBisGeladen(rahmen) {
    const lauf = ++verdeckt;
    rahmen.style.visibility = "hidden";
    const zeigen = () => { if (lauf === verdeckt) rahmen.style.visibility = ""; };
    setTimeout(zeigen, 5000);
    const pruefe = (n) => {
      if (lauf !== verdeckt) return;
      let fertig = true;
      try {
        const innen = rahmen.contentDocument.getElementById("content_iframe");
        if (innen) fertig = innen.contentDocument.readyState === "complete" && innen.contentWindow.location.href !== "about:blank";
      } catch { }
      if (fertig || n > 50) zeigen(); else setTimeout(() => pruefe(n + 1), 100);
    };
    const geladen = () => { rahmen.removeEventListener("load", geladen); if (innenAlt) innenAlt.removeEventListener("load", geladen); pruefe(0); };
    rahmen.addEventListener("load", geladen);
    let innenAlt = null;
    try { innenAlt = rahmen.contentDocument.getElementById("content_iframe"); } catch { }
    if (innenAlt) innenAlt.addEventListener("load", geladen);
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
