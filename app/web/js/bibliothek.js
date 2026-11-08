// Bibliothek: Regal aller Pakete, Suche über alle Pakete, Lesen.
"use strict";

const Bibliothek = (() => {
  // Welche Kategorien aufgeklappt sind; bleibt erhalten, wenn man aus dem Lesefenster zurückkommt
  const offen = new Set();

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
    if (q) suchen(q, params.get("buch")); else $("#bib-treffer").innerHTML = "";
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
      // Zugeklappt heißt: auch alles darin ist zu, beim nächsten Öffnen beginnt man oben
      if (!auf) for (const kind of innen.querySelectorAll(".klapp.auf")) if (kind._setzen) kind._setzen(false);
      box.classList.toggle("auf", auf);
      knopf.setAttribute("aria-expanded", String(auf));
      if (auf) offen.add(schluessel); else offen.delete(schluessel);
    }
    box._setzen = setzen;
    knopf.addEventListener("click", () => {
      const auf = !box.classList.contains("auf");
      if (auf) {
        // Nur ein Eintrag je Ebene offen: die anderen klappen zu
        const vorher = knopf.getBoundingClientRect().top;
        for (const nachbar of box.parentElement.children) {
          if (nachbar !== box && nachbar.classList.contains("auf") && nachbar._setzen) nachbar._setzen(false);
        }
        nachOben(knopf, vorher);
      }
      setzen(auf);
    });
    if (offen.has(schluessel)) setzen(true);
    return box;
  }

  // Alle Kategorien als Liste; jede klappt ihre Pakete auf, ein Klick aufs Paket öffnet es
  function zeichneRegal(params, buecher) {
    const regal = $("#regal"), kopf = $("#bib-kopf");
    regal.innerHTML = "";
    kopf.innerHTML = "";
    // Alte Links (#bibliothek?kat=… oder ?paket=…) öffnen die passende Stelle
    const p = params.get("paket") && buecher.find(x => x.id === params.get("paket"));
    if (params.get("kat") || p) offen.clear();
    if (params.get("kat")) offen.add("k:" + params.get("kat"));
    if (p) offen.add("k:" + (p.kategorien[0] || "sonstiges"));
    if (params.get("q")) kopf.append(el("h2", {}, "Kategorien"));
    for (const kat of kategorien()) {
      const pakete = buecher.filter(x => x.kategorien[0] === kat.id);
      if (!pakete.length) continue;
      regal.append(klappe("k:" + kat.id, "klapp-kat",
        [symFeld(kat.icon, "gross"),
         el("span", { class: "e-text" }, el("b", {}, kat.titel), el("small", {}, kat.text)),
         el("span", { class: "e-zahl" }, anzahlText(pakete.length))],
        () => el("div", { class: "klapp-liste" }, pakete.map(paketZeile))));
    }
  }

  // Link ins Lesefenster; extra z. B. "&zufall=1" oder "&suche=…"
  const leseLink = (b, pfad, titel, extra) =>
    "#lesen?url=" + encodeURIComponent(b.start + (pfad ? "/" + pfad : "")) + "&titel=" + encodeURIComponent(titel || b.titel) + (extra || "");

  // Wohin „Öffnen“ führt: Pakete mit eigener Fieldbook-Startseite (Klexikon, iFixit) dorthin, sonst ins Lesefenster
  const eigeneStartseite = (b) => !!(b.startseite && (b.startseite.eigene || b.startseite.ifixit));
  const oeffnenLink = (b) => eigeneStartseite(b) ? "#paketstart?buch=" + encodeURIComponent(b.id) : leseLink(b);

  // Ein Klick auf das Paket öffnet es; Suche und Zufall stehen dann oben im Lesefenster
  function paketZeile(b) {
    return el("a", { class: "eintrag paket-zeile", href: oeffnenLink(b) },
      el("img", { class: "e-bild", src: b.bild || "icon.svg", alt: "", loading: "lazy" }),
      el("span", { class: "e-text" }, el("b", {}, b.titel), el("small", {}, (b.englisch ? "Englisch · " : "") + (b.text || ""))),
      el("span", { class: "paket-pfeil", "aria-hidden": "true" }));
  }

  // Suche in den PDF-Büchern eines Pakets: Kiwix findet darin nichts, deshalb über die Bibliothekssuche
  const pdfSucheLink = (id, q) => "#bibliothek?q=" + encodeURIComponent(q) + "&buch=" + encodeURIComponent(id);
  // Treffer öffnen im Lesefenster, Stellen aus PDF-Büchern im PDF-Leser auf der gefundenen Seite
  function trefferLink(t) {
    const pdf = t.pdf && t.pdf.match(/^([^#]+)#page=(\d+)$/);
    if (pdf) return "#pdf?url=" + encodeURIComponent(pdf[1]) + "&seite=" + pdf[2] + "&titel=" + encodeURIComponent(t.titel.replace(/, Seite \d+$/, ""));
    return "#lesen?url=" + encodeURIComponent(t.url) + "&titel=" + encodeURIComponent(t.titel);
  }

  // Profilseiten von Mitgliedern (iFixit „/User/123/…“, Stack Exchange „/users/123/…“): nie Wissen, nur Namen.
  // Dazu die Blätterseiten der Foren („users_page=80“, „questions/tagged/water_page=7“): nur Listen ohne Titel
  const NUTZERSEITE = /\/users?\/\d+\/|_page=\d/i;
  const FUELLWOERTER = new Set(("der die das den dem des ein eine einen einem einer und oder mit von für fur auf aus bei " +
    "im in an zu zum zur wie was wo ich man mache machen kann the a an of and or to in on for with how what is").split(" "));
  // Suchwörter in Kleinbuchstaben ohne Füllwörter. Bei Mehrzahl auch der Wortstamm („Wunden“ → „wunde“,
  // „Verbrennungen“ → „verbrennung“), aber nur durch Abschneiden von -en (wenn 5 Buchstaben bleiben), -n oder -s.
  // Kiwix kürzt selbst stärker („Bowline“ → „bowlin“, „backen“ → „back“) und findet so Nachnamen oder englische
  // Wörter, die mit dem Suchwort nichts zu tun haben.
  function suchWoerter(q) {
    const alle = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const woerter = alle.filter(w => w.length > 1 && !FUELLWOERTER.has(w));
    return (woerter.length ? woerter : alle).map(w => {
      if (w.length < 6) return w;
      if (w.endsWith("en") && w.length - 2 >= 5) return w.slice(0, -2);
      return /[ns]$/.test(w) ? w.slice(0, -1) : w;
    });
  }
  // Wortanfang im Text: „wasser“ passt auf „Wasser“ und „Wasserfilter“, aber nicht auf „Abwasser“
  // (zusammengesetzte Wörter hinten dran gingen nur mit Silbentrennung; lieber zu streng als Unsinn)
  const wortAnfang = (text, w) => {
    const t = " " + text.toLowerCase();
    let i = -1;
    while ((i = t.indexOf(w, i + 1)) >= 0) if (!/[\p{L}\p{N}]/u.test(t[i - 1])) return true;
    return false;
  };
  // Passt ein Treffer? 2 = Suchwort im Titel, 1 = nur im Textauszug, 0 = weglassen.
  // Bis zu zwei Suchwörter müssen alle vorkommen, bei mehr zwei Drittel.
  function passt(woerter, t) {
    if (!woerter.length) return 1;
    const titel = t.titel || "";
    const beides = titel + " " + (t.auszug || "");
    const noetig = woerter.length <= 2 ? woerter.length : Math.ceil(woerter.length * 2 / 3);
    if (woerter.filter(w => wortAnfang(titel, w)).length >= noetig) return 2;
    return woerter.filter(w => wortAnfang(beides, w)).length >= noetig ? 1 : 0;
  }

  // q: Suchbegriff; nurBuch: nur in diesem Paket suchen (Suchfeld eines PDF-Pakets), dann mit mehr Treffern
  async function suchen(q, nurBuch) {
    const ziel = $("#bib-treffer");
    ziel.innerHTML = '<p class="hinweis">Suche …</p>';
    let buecher = (await Kiwix.buecher()).filter(b => b.durchsuchen);
    if (nurBuch) buecher = buecher.filter(b => b.id === nurBuch);
    // Mehr holen als gezeigt wird: Der Filter unten wirft schwache Treffer weg
    const anzahl = nurBuch ? 20 : 8;
    const woerter = suchWoerter(q);
    // Zählen, wie viele Abfragen scheitern: scheitern alle, ist das kein „keine Treffer“
    let fehlgeschlagen = 0;
    const gruppen = await Promise.all(buecher.map(async b => {
      const [titel, voll] = await Promise.all([Kiwix.vorschlaege(b, q, anzahl).catch(() => { fehlgeschlagen++; return []; }),
        Kiwix.suche(b, q, anzahl).catch(() => { fehlgeschlagen++; return []; })]);
      const gesehen = new Set();
      const liste = [];
      let imTitel = false;
      for (const t of titel.concat(voll)) {
        const k = decodeURIComponent(t.url).toLowerCase();
        if (gesehen.has(k) || NUTZERSEITE.test(k)) continue;
        gesehen.add(k);
        const wertung = passt(woerter, t);
        if (!wertung) continue;
        if (wertung === 2) imTitel = true;
        liste.push(t);
      }
      return { b, imTitel, liste: liste.slice(0, nurBuch ? 15 : 6) };
    }));
    // Pakete, bei denen das Suchwort im Titel eines Treffers steht, zuerst (sonst Reihenfolge wie im Regal)
    gruppen.sort((x, y) => (y.imTitel ? 1 : 0) - (x.imTitel ? 1 : 0));
    ziel.innerHTML = "";
    const kopf = el("div", { class: "knopfreihe", style: "margin:0 0 16px" });
    // Suche in einem Paket: zurück zum Paket und Suche über alle Pakete
    const eins = nurBuch && buecher[0];
    if (eins) kopf.append(el("a", { class: "knopf", href: leseLink(eins) }, sym("book-open"), "Zurück zum Paket"),
      el("a", { class: "knopf", href: "#bibliothek?q=" + encodeURIComponent(q) }, sym("search"), "In allen Paketen suchen"));
    kopf.append(el("a", { class: "knopf knopf-haupt", href: "#fragen", onclick: () => setTimeout(() => { $("#frage-feld").value = q; }, 60) }, sym("message-circle"), "Die KI dazu fragen"));
    if (!eins && OW.status && OW.status.karten && OW.status.karten.length)
      kopf.append(el("a", { class: "knopf", href: "#karten", onclick: () => setTimeout(() => Karten.sucheOrt(q), 300) }, sym("map"), "Auf der Karte suchen"));
    ziel.append(kopf);
    let gefunden = 0;
    for (const { b, liste } of gruppen) {
      if (!liste.length) continue;
      gefunden += liste.length;
      // Jedes Paket als eigener Kasten mit Bild und Namen, damit man sieht, wo das nächste anfängt
      ziel.append(el("section", { class: "treffer-gruppe" },
        el("div", { class: "treffer-kopf" },
          el("img", { class: "e-bild", src: b.bild || "icon.svg", alt: "" }),
          el("h3", {}, b.titel, b.englisch ? el("small", {}, "Englisch") : null),
          el("span", { class: "treffer-zahl" }, liste.length === 1 ? "1 Treffer" : liste.length + " Treffer")),
        ...liste.map(t => el("a", { class: "treffer", href: trefferLink(t) },
          el("b", {}, t.titel), t.auszug ? el("small", {}, t.auszug.slice(0, 200)) : null))));
    }
    if (!gefunden && buecher.length && fehlgeschlagen === buecher.length * 2) {
      ziel.append(fehlerBox("Die Suche ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.", () => suchen(q, nurBuch)));
    } else if (!gefunden) {
      // PDF-Bücher sind erst durchsuchbar, wenn Fieldbook ihren Text einmal ausgelesen hat
      const pdfTexte = (OW.status && OW.status.pdfTexte) || {};
      const unfertig = eins && eins.pdf && pdfTexte[eins.id] !== true;
      ziel.append(el("p", { class: "hinweis" }, "Keine Treffer für „" + q + "“" + (eins ? " in „" + eins.titel + "“." : "."),
        unfertig ? el("br") : null, unfertig ? "Fieldbook liest die Bücher dieses Pakets gerade noch für die Suche ein." : null));
    }
  }

  $("#bib-suche").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#bib-suche-feld").value.trim();
    location.hash = "#bibliothek" + (q ? "?q=" + encodeURIComponent(q) : "");
  });

  // "Zurück" geht wie die Zurück-Taste der Maus eine Seite im Lesefenster zurück, von der ersten Seite
  // aus zur Seite, von der man gekommen ist (z. B. Bibliotheksübersicht). Ohne eigenen Verlaufseintrag
  // (Seite direkt geöffnet) springt er direkt zur Herkunft.
  let herkunft = "#bibliothek", warLesen = false;
  window.addEventListener("hashchange", (e) => {
    const jetztLesen = location.hash.startsWith("#lesen");
    // Aus dem PDF-Leser zurück: Das PDF wurde von hier aus geöffnet, die Herkunft bleibt, wie sie war
    if (jetztLesen && !warLesen && !e.oldURL.includes("#pdf")) {
      const alt = new URL(e.oldURL).hash;
      herkunft = alt && !alt.startsWith("#lesen") ? alt : "#bibliothek";
    }
    warLesen = jetztLesen;
  });
  // Nicht nach history.length entscheiden: Die schrumpft, wenn man zurückgeht und dann Neues öffnet
  $("#lese-zurueck").addEventListener("click", () => {
    const z = schritteZurueck();
    if (z.imRahmen || (window.navigation ? navigation.currentEntry.index > 0 : history.length > 1)) history.go(-z.n);
    else location.hash = herkunft;
  });
  // Wie viele Verlaufseinträge zurück? Manche Pakete ändern beim Laden selbst die Sprungmarke ihrer Seite
  // („home#list--0“ in den PDF-Paketen) und legen dabei einen Eintrag an, der nichts sichtbar ändert. Solche
  // Einträge (gleiche Seite, nur andere Sprungmarke) überspringt „Zurück“, damit jeder Klick etwas bewirkt.
  // Sind alle früheren Einträge des Artikels nur solche, geht es gleich zur Seite davor (z. B. Bibliothek).
  // imRahmen: Das Ziel ist ein früherer Artikel im Lesefenster (sonst die Seite vor dem Lesefenster).
  function schritteZurueck() {
    try {
      const rahmen = $("#lese-rahmen");
      const innen = rahmen.contentDocument.getElementById("content_iframe") || rahmen;
      const nav = innen.contentWindow.navigation;
      const eintraege = nav.entries(), i = nav.currentEntry.index;
      const ohneMarke = (u) => (u || "").split("#")[0];
      let n = 1;
      while (i - n >= 0 && ohneMarke(eintraege[i - n].url) === ohneMarke(eintraege[i].url)) n++;
      // Links zwischen Artikeln laufen meist über den Viewer (seine Adresse ändert sich, der Artikelrahmen
      // wird nur ersetzt): Hat der Viewer frühere Einträge, gibt es auch einen früheren Artikel
      const viewerNav = rahmen.contentWindow.navigation;
      return { n, imRahmen: i - n >= 0 || (innen !== rahmen && viewerNav.currentEntry.index > 0) };
    } catch { return { n: 1, imRahmen: false }; }
  }
  // Art der letzten Navigation: Bei Zurück/Vor ("traverse") stellt der Browser das Lesefenster selbst wieder her
  let navArt = "";
  if (window.navigation) navigation.addEventListener("navigate", (e) => { navArt = e.navigationType; });

  Uebersetzer.anbinden();

  // Leseleiste: Startseite, Zufall und Suche über die Funktionen des Kiwix-Viewers im Lesefenster
  function viewer() {
    try { const w = $("#lese-rahmen").contentWindow; return w && w.gotoMainPageOfCurrentBook ? w : null; } catch { return null; }
  }
  // Paket, das gerade im Lesefenster offen ist (aus "/kiwix/viewer#paket/Artikel" oder "/kiwix/content/paket/…")
  // Zuerst der innere Rahmen des Viewers: Die Trefferliste einer Suche in einem anderen Paket
  // („/kiwix/search?books.name=…“) ändert den Hash des Viewers nicht
  function aktuellesPaket() {
    try {
      const innen = $("#lese-rahmen").contentDocument.getElementById("content_iframe");
      const il = innen && innen.contentWindow.location;
      const m = il && (il.pathname.match(/^\/kiwix\/content\/([^/]+)/) ||
        (il.pathname === "/kiwix/search" && il.search.match(/[?&]books\.name=([^&]+)/)));
      if (m) return decodeURIComponent(m[1]);
    } catch { }
    try {
      const l = $("#lese-rahmen").contentWindow.location;
      const m = l.hash.match(/^#([^/]+)/) || l.pathname.match(/^\/kiwix\/content\/([^/]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }
  // Name oben im Lesefenster: Führt ein Link in ein anderes Paket (z. B. von Wikivoyage in die Wikipedia),
  // steht dort dessen Name; zurück im ersten Paket wieder der ursprüngliche Titel
  let startPaket = null, startTitel = "";
  async function leisteAnpassen() {
    const id = aktuellesPaket();
    const b = id && (await Kiwix.buecher()).find(x => x.id === id);
    if (b) $("#lese-titel").textContent = id === startPaket ? startTitel : b.titel;
    $("#lese-suche").hidden = !(b && b.durchsuchen);
    $("#lese-zufall").hidden = !!(b && b.pdf);
    $("#lese-suche-feld").placeholder = b ? "In „" + b.titel.replace(/ \(.*\)$/, "") + "“ suchen …" : "In diesem Paket suchen …";
    adresseMerken();
  }
  // Die Adresse oben folgt dem Artikel im Lesefenster: Neu laden zeigt dann denselben Artikel statt der
  // Startseite des Pakets. replaceState legt keinen Verlaufseintrag an und löst kein "hashchange" aus.
  // Zufall und Suche fallen dabei weg (sonst käme beim Neuladen ein anderer Artikel).
  function adresseMerken() {
    if (!location.hash.startsWith("#lesen")) return;
    let url;
    try {
      const l = $("#lese-rahmen").contentWindow.location;
      if (l.href === "about:blank") return;
      url = l.pathname + l.search + l.hash;
    } catch { return; }
    if (!url.startsWith("/kiwix/")) return;
    const neu = "#lesen?url=" + encodeURIComponent(url) + "&titel=" + encodeURIComponent($("#lese-titel").textContent || "");
    if (neu !== location.hash) history.replaceState(history.state, "", neu);
  }
  // PDF-Links (z. B. Medizin-Handbücher) wollen ein neues Fenster öffnen, was je nach Browser zum
  // Download wird. Stattdessen öffnet sich der eigene PDF-Leser (js/pdfleser.js); "Zurück" führt zur Liste.
  // Außerdem: Treffer auf Suchseiten im Rahmen öffnen (siehe unten).
  function pdfImLesefenster(innen) {
    try {
      const doc = innen.contentDocument;
      if (!doc || doc.pdfLinksAngepasst) return;
      doc.pdfLinksAngepasst = true;
      doc.addEventListener("click", (e) => {
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const url = new URL(a.href, doc.baseURI);
        // Treffer einer Suche führen über den Viewer („/kiwix/viewer#paket/Artikel“). Der merkt sich die
        // Trefferliste nicht, „Zurück“ landete dann auf der Startseite des Pakets. Deshalb den Artikel direkt
        // im Rahmen öffnen: Dann führt „Zurück“ wieder zur Trefferliste.
        if (innen.contentWindow.location.pathname === "/kiwix/search" && url.origin === location.origin &&
            url.pathname === "/kiwix/viewer" && url.hash.length > 1 && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.button === 0) {
          e.preventDefault();
          e.stopPropagation();
          innen.contentWindow.location.href = "/kiwix/content/" + url.hash.slice(1);
          return;
        }
        if (url.origin !== location.origin || !/\.pdf$/i.test(url.pathname)) return;
        e.preventDefault();
        e.stopPropagation();
        const seite = (url.hash.match(/page=(\d+)/) || [])[1];
        location.hash = "#pdf?url=" + encodeURIComponent(url.pathname) + (seite ? "&seite=" + seite : "");
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
      if (innen) { innen.addEventListener("load", () => { pdfImLesefenster(innen); leisteAnpassen(); }); pdfImLesefenster(innen); }
    } catch { }
  });
  $("#lese-start").addEventListener("click", async () => {
    const id = aktuellesPaket();
    const b = id && (await Kiwix.buecher()).find(x => x.id === id);
    if (b && eigeneStartseite(b)) { location.hash = oeffnenLink(b); return; }
    const w = viewer(); if (w) w.gotoMainPageOfCurrentBook();
  });
  $("#lese-zufall").addEventListener("click", () => { const w = viewer(); if (w) w.gotoRandomPage(); });
  $("#lese-suche").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#lese-suche-feld").value.trim();
    // PDF-Pakete: Kiwix findet in den Büchern nichts, gesucht wird im ausgelesenen Text
    const id = aktuellesPaket();
    const b = q && id && (await Kiwix.buecher()).find(x => x.id === id);
    if (b && b.pdf) { location.hash = pdfSucheLink(id, q); return; }
    const w = viewer();
    if (!q || !w) return;
    // Suchfeld des Viewers füllen und seine Suche starten, dann zeigt Kiwix die Trefferliste im Lesefenster
    w.document.getElementById("kiwixsearchbox").value = q;
    w.performSearch();
  });

  function lesen(params) {
    let url = params.get("url") || "";
    if (!url.startsWith("/kiwix/")) return;
    // Artikel-Links aus Kochen, Suche, KI usw. zeigen direkt auf „/kiwix/content/paket/…“. Ohne den Viewer
    // drumherum gehen Suche, Zufall und Startseite der Leseleiste nicht, deshalb im Viewer öffnen.
    const direkt = url.match(/^\/kiwix\/content\/([^/?#]+\/[^?]*)$/);
    if (direkt && !/\.pdf(#|$)/i.test(direkt[1])) url = "/kiwix/viewer#" + direkt[1];
    $("#uebersetzen-knopf").hidden = !Uebersetzer.verfuegbar();
    warLesen = true;
    const rahmen = $("#lese-rahmen");
    // Ein neues Buch ohne zusätzlichen Verlaufseintrag laden (sonst führt "Zurück" ins vorher gelesene Buch
    // statt zur Übersicht). Links innerhalb des Artikels bleiben mit "Zurück" erreichbar.
    let aktuell = null;
    try { const l = rahmen.contentWindow.location; aktuell = l.href === "about:blank" ? null : l.pathname + l.search + l.hash; } catch { }
    // Zurück aus dem PDF-Leser oder Vor: Der Browser zeigt den Artikel von damals schon wieder, neu laden
    // würde ihn ersetzen und einen leeren Schritt im Verlauf hinterlassen. Beim Öffnen dagegen immer laden:
    // Die Adresse des Viewers verrät nicht, ob er gerade z. B. eine Trefferliste zeigt.
    const zurueckGekommen = navArt === "traverse" && aktuell;
    if (!zurueckGekommen) {
      verdeckenBisGeladen(rahmen);
      // Gleiche Adresse: replace wäre wirkungslos (nur die Sprungmarke), deshalb neu laden
      if (aktuell === url) rahmen.contentWindow.location.reload();
      else if (aktuell) rahmen.contentWindow.location.replace(url);
      else rahmen.setAttribute("src", url);
    }
    startTitel = params.get("titel") || "";
    const p = url.match(/^\/kiwix\/viewer#([^/]+)/) || url.match(/^\/kiwix\/content\/([^/]+)/);
    startPaket = p ? decodeURIComponent(p[1]) : null;
    $("#lese-titel").textContent = startTitel;
    $("#lese-neu").href = url;
    // Von der Paket-Startseite: zufälligen Artikel zeigen oder suchen, sobald der Viewer bereit ist.
    // Die Startseite des Pakets wird dabei ersetzt (location.replace statt gotoRandomPage/performSearch des
    // Viewers, die einen Verlaufseintrag anlegen): Sonst führte der erste Klick auf „Zurück“ nur zu ihr.
    const suche = params.get("suche"), zufall = params.get("zufall");
    if ((suche || zufall) && startPaket) wennViewerBereit((w) => {
      const innen = w.document.getElementById("content_iframe");
      const buch = encodeURIComponent(startPaket);
      if (suche) w.document.getElementById("kiwixsearchbox").value = suche;
      innen.contentWindow.location.replace(zufall ? "/kiwix/random?content=" + buch
        : "/kiwix/search?books.name=" + buch + "&pattern=" + encodeURIComponent(suche));
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
