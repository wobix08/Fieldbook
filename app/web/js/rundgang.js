// Rundgang durch Fieldbook: Kapitel mit Schritten aus app/config/rundgang.json. Ein Kästchen zeigt auf einen Knopf
// und erklärt ihn, alles drumherum wird abgedunkelt. Der Rundgang läuft im Übungsmodus: Solange das Cookie
// „fb-uebung=1“ gesetzt ist, antwortet der Server mit Beispieldaten (app/web/uebung, „Uebung“ in Server.cs).
// Wo der Rundgang gerade steht, liegt in sessionStorage; fehlt das, wird ein übrig gebliebenes Cookie entfernt.
"use strict";

const Rundgang = (() => {
  const SPEICHER = "fb-rundgang";
  const ABSTAND = 14;      // Abstand zwischen Ziel und Kästchen
  const RAND = 12;         // Mindestabstand zum Fensterrand
  let konfig = null;
  let zustand = null;      // { kapitel, schritt, zurueck, seite }
  let lauf = 0;            // zählt Schritte, damit ein alter Schritt nicht in einen neuen hineinmalt
  let richtung = 1;        // zuletzt vor (1) oder zurück (-1): ein unsichtbarer, optionaler Schritt wird in dieser Richtung übersprungen
  let ziel = null;         // Element, auf das gerade gezeigt wird
  let teile = null;        // { licht, kasten, pfeil, … }
  // Aufgabe des Schritts („aktion“ in rundgang.json): Der Schritt wartet, bis man selbst getan hat, was dasteht.
  // klick: auf dieses Element geklickt · sichtbar: dieses Element ist zu sehen (z. B. aufgeklapptes Thema) ·
  // adresse: Adresse passt zum Muster · artikel: im Lesefenster ist ein Artikel offen, dessen Pfad zum Muster passt
  let aufgabe = null;      // { aktion, nr, geklickt, warSchon }

  const cookieAn = () => /(?:^|;\s*)fb-uebung=1(?:;|$)/.test(document.cookie);
  function cookieSetzen(an) {
    document.cookie = an ? "fb-uebung=1; path=/; SameSite=Strict" : "fb-uebung=; path=/; SameSite=Strict; max-age=0";
  }
  function lesen() { try { return JSON.parse(sessionStorage.getItem(SPEICHER) || "null"); } catch { return null; } }
  function speichern() { try { sessionStorage.setItem(SPEICHER, JSON.stringify(zustand)); } catch { } }
  function vergessen() { try { sessionStorage.removeItem(SPEICHER); } catch { } }

  async function laden() {
    if (!konfig) konfig = await ladeKonfig("rundgang");
    return konfig;
  }
  async function kapitelListe() { return (await laden()).kapitel || []; }

  // Übersicht aller Kapitel als Fenster (vor der Einrichtung und während des ersten Downloads):
  // ein Satz je Bereich, man springt direkt in das Kapitel, das einen interessiert
  async function uebersicht() {
    let liste;
    try { liste = await kapitelListe(); }
    catch { dialog("Rundgang", "Der Rundgang konnte nicht geladen werden.", [{ text: "OK", wert: 1, haupt: true }]); return; }
    dialog("Rundgang durch Fieldbook", el("div", {},
      el("p", { style: "margin-top:0" }, "Jedes Kapitel zeigt einen Bereich mit Beispielinhalten.", el("br"), "Du probierst alles selbst aus, deine eigenen Inhalte bleiben unverändert."),
      el("div", { class: "rundgang-liste" }, ...liste.map(k => el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, k.titel), el("small", {}, k.text)),
        el("button", { type: "button", class: "knopf knopf-klein", onclick: (e) => starten(k.id, e.currentTarget) }, "Ansehen")))),
      el("p", { class: "hinweis klein", style: "margin-bottom:0" }, "Den kompletten Rundgang kannst du jederzeit in den Einstellungen unter „Rundgang durch Fieldbook“ erneut starten.")),
      [{ text: "Schließen", wert: 0 }]);
  }

  // Startet ein Kapitel. Die Seite lädt dazu neu: Was die Bereiche schon zwischengespeichert haben
  // (Bücher, Merkliste, eigene Dateien), kommt danach aus der Übung statt aus den echten Daten.
  async function starten(kapitelId, knopf) {
    // Kapitel mit „laden“ brauchen Beispieldaten, die nicht in der ZIP sind (Karten: Beispielkarte, etwa 4 MB).
    // Sie werden einmal vor dem ersten Start geladen und bleiben im Zwischenspeicher.
    const k = ((await laden()).kapitel || []).find(x => x.id === kapitelId);
    if (k && k.laden && !(await beispielLaden(k, knopf))) return;
    // „Auf Deutsch“ merkt sich der Browser (uebersetzer.js). Im Rundgang beginnt es aus, am Ende kommt der alte Stand zurück.
    // Die Backofen-Auswahl auf der Seite Kochen (kochen.js) genauso: im Rundgang „Herd mit Backofen“, danach der alte Wert.
    let uebersetzen = null, ofen = null;
    try { uebersetzen = localStorage.getItem("ow-uebersetzen"); ofen = localStorage.getItem("ow-ofen"); } catch { }
    zustand = { kapitel: kapitelId, schritt: 0, zurueck: location.hash || "#start", seite: null, uebersetzen, ofen };
    speichern();
    try { localStorage.setItem("ow-uebersetzen", "0"); localStorage.removeItem("ow-ofen"); } catch { }
    if (!lesen()) { dialog("Rundgang", "Der Rundgang lässt sich in diesem Browser gerade nicht starten.", [{ text: "OK", wert: 1, haupt: true }]); zustand = null; return; }
    cookieSetzen(true);
    // Merkliste und „Zuletzt gelesen“ der Übung auf den Anfang setzen
    await fetch("/api/uebung/neu", { method: "POST" }).catch(() => { });
    location.reload();
  }

  async function beispielLaden(k, knopf) {
    const pfad = "uebung/" + k.laden;
    const da = await api(pfad).catch(() => null);
    if (da && da.da) return true;
    const vorher = knopf ? [...knopf.childNodes] : null;
    if (knopf) { knopf.disabled = true; knopf.replaceChildren(el("span", { class: "ladekreis" }), "Lädt …"); }
    const r = await api(pfad, {}).catch(() => null);
    if (knopf) { knopf.disabled = false; knopf.replaceChildren(...vorher); }
    if (r && r.ok) return true;
    dialog("Rundgang", (k.ladenFehler || "Die Beispieldaten für dieses Kapitel konnten nicht geladen werden.") +
      " Dafür braucht Fieldbook einmal Internet. Bitte versuche es später noch einmal.", [{ text: "OK", wert: 1, haupt: true }]);
    return false;
  }

  // Beendet den Rundgang und kehrt mit echten Daten zurück (wieder mit Neuladen, aus demselben Grund)
  function beenden(seite) {
    const z = zustand;
    zustand = null;
    vergessen();
    cookieSetzen(false);
    try {
      if (z && "uebersetzen" in z) {
        if (z.uebersetzen == null) localStorage.removeItem("ow-uebersetzen");
        else localStorage.setItem("ow-uebersetzen", z.uebersetzen);
      }
      if (z && "ofen" in z) {
        if (z.ofen == null) localStorage.removeItem("ow-ofen");
        else localStorage.setItem("ow-ofen", z.ofen);
      }
    } catch { }
    history.replaceState(null, "", seite || (z && z.zurueck) || "#start");
    location.reload();
  }

  const ansichtVon = (h) => String(h || "").replace(/^#/, "").split("?")[0];
  const kapitelJetzt = () => konfig && zustand && (konfig.kapitel || []).find(k => k.id === zustand.kapitel);

  // Rechteck im Fenster, auch für Elemente im Artikel (der liegt in zwei Rahmen ineinander)
  function rechteck(e) {
    const r = e.getBoundingClientRect();
    let x = r.left, y = r.top, w = e.ownerDocument.defaultView;
    try {
      while (w && w !== window && w.frameElement) {
        const f = w.frameElement, fr = f.getBoundingClientRect();
        x += fr.left + f.clientLeft;
        y += fr.top + f.clientTop;
        w = w.parent;
      }
    } catch { }
    return { left: x, top: y, right: x + r.width, bottom: y + r.height, width: r.width, height: r.height };
  }
  function sichtbar(e) {
    if (!e || !e.isConnected || e.closest("[hidden]")) return false;
    const r = rechteck(e);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  }
  // Ziel eines Schritts: „ziel“ im Fenster oder „rahmenZiel“ im Artikel des Lesefensters
  function zielSuchen(s) {
    if (s.rahmenZiel) { const doc = rahmenDoc(); return doc ? doc.querySelector(s.rahmenZiel) : null; }
    // Mehrere Treffer (z. B. „#neuer-chat, #verlauf-knopf“, je nach Fensterbreite ist nur einer zu sehen): der sichtbare
    // „zielText“: nur Elemente, deren Text zum Muster passt (z. B. die Stelle „Ölwechsel:“ im PDF)
    const alle = [...document.querySelectorAll(s.ziel)].filter(e => !s.zielText || new RegExp(s.zielText).test(e.textContent));
    return alle.find(sichtbar) || alle[0] || null;
  }
  // Wartet, bis das Ziel da und zu sehen ist (Seiten bauen sich erst nach dem Laden auf), höchstens 6 s
  async function warteAuf(s, nr) {
    // Optionale Schritte fallen schneller weg (z. B. Vorlese-Leiste, wenn gerade nichts vorgelesen wird)
    for (let i = 0, n = s.optional ? 35 : 60; i < n; i++) {
      if (nr !== lauf) return null;
      let e = null;
      try { e = zielSuchen(s); } catch { return null; }
      // Im Artikel ggf. erst hinscrollen (sichtbar verlangt, dass es im Fenster liegt)
      if (e && s.rahmenZiel && e.isConnected && !sichtbar(e)) { try { e.scrollIntoView({ block: "center" }); } catch { } }
      // Genauso in Leisten, die selbst scrollen (z. B. Sperrungen unten in der Kartenleiste)
      else if (e && e.isConnected && !e.closest("[hidden]") && !sichtbar(e)) { try { e.scrollIntoView({ block: "nearest" }); } catch { } }
      if (sichtbar(e)) {
        // Warten, bis das Ziel stillsteht (Aufklappen und Scrollen sind vorbei), höchstens 2 s:
        // sonst springt der Rahmen hinterher und zuckt
        let vorher = "", ruhig = 0;
        for (let k = 0; k < 40 && ruhig < 3; k++) {
          await new Promise(r => setTimeout(r, 50));
          if (nr !== lauf) return null;
          const r = rechteck(e), jetzt = [r.left, r.top, r.width, r.height].map(Math.round).join();
          ruhig = jetzt === vorher ? ruhig + 1 : 0;
          vorher = jetzt;
        }
        // Noch weg (z. B. nach dem Neuladen rollt die Seite beim Aufbauen wieder nach oben): weiter versuchen
        if (sichtbar(e)) return e;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  function bauen() {
    if (teile) return teile;
    const licht = el("div", { class: "fu-licht", "aria-hidden": "true" });
    const pfeil = el("div", { class: "fu-pfeil", "aria-hidden": "true" });
    const kapitel = el("span", { class: "fu-kapitel" });
    const zu = el("button", { type: "button", class: "fu-zu", title: "Rundgang beenden", "aria-label": "Rundgang beenden", onclick: () => beenden() }, sym("x"));
    const titel = el("h3", { id: "fu-titel" });
    const text = el("p", { class: "fu-text" });
    const hinweis = el("p", { class: "fu-hinweis", role: "alert", hidden: true });
    // Sperre: vier unsichtbare Flächen um die markierte Stelle. Bei einer Aufgabe bleibt nur die Stelle selbst frei,
    // sonst ist alles gesperrt (nur Kästchen und Streifen gehen). Ein Klick daneben stupst das Kästchen an.
    const sperren = [0, 1, 2, 3].map(() => el("div", { class: "fu-sperre", "aria-hidden": "true",
      onmousedown: (e) => { e.preventDefault(); stupsen(); }, onclick: (e) => e.preventDefault() }));
    const zahl = el("span", { class: "fu-zahl" });
    const dran = el("span", { class: "fu-dran", hidden: true }, el("span", { class: "fu-punkt", "aria-hidden": "true" }), "Du bist dran");
    const zurueck = el("button", { type: "button", class: "knopf knopf-klein", onclick: () => gehe(-1) }, "Zurück");
    const weiter = el("button", { type: "button", class: "knopf knopf-klein knopf-haupt", onclick: () => gehe(1) }, "Weiter");
    const extra = el("button", { type: "button", class: "knopf knopf-klein", hidden: true });
    const kasten = el("div", { class: "fu-kasten", role: "dialog", "aria-labelledby": "fu-titel", "aria-live": "polite" },
      pfeil,
      el("div", { class: "fu-kopf" }, kapitel, zu),
      titel, text, hinweis,
      el("div", { class: "fu-fuss" }, zahl, el("span", { class: "fu-knoepfe" }, zurueck, extra, dran, weiter)));
    const streifen = el("div", { class: "fu-streifen", role: "status" },
      sym("compass"),
      el("span", {}, el("b", {}, "Übungsmodus"), " · Beispieldaten, deine Inhalte bleiben unverändert"),
      el("button", { type: "button", class: "knopf knopf-klein", onclick: () => beenden() }, "Rundgang beenden"));
    document.body.append(...sperren, licht, kasten, streifen);
    teile = { licht, kasten, pfeil, kapitel, titel, text, hinweis, sperren, zahl, zurueck, weiter, extra, dran };

    // Mitwandern, wenn die Seite scrollt, sich die Fenstergröße ändert oder die Seite sich umbaut
    const neu = () => requestAnimationFrame(platzieren);
    addEventListener("resize", neu);
    addEventListener("scroll", neu, true);
    setInterval(() => { platzieren(); aufgabePruefen(); rahmenSperren(); }, 250);
    // „nurKlick“: In der freien Stelle geht während der Aufgabe nur dieser Knopf, andere Knöpfe dort stupsen das
    // Kästchen an (z. B. im Ort-Fenster nur „Ort merken“, nicht „Route von hier“ oder „Entfernung messen“)
    const knopfSperren = (e) => {
      const s = aufgabe && !aufgabe.fertig && kapitelJetzt() && kapitelJetzt().schritte[zustand.schritt];
      if (!s || !s.nurKlick || !e.target.closest) return;
      const k = e.target.closest("button, a, [role='button'], input, select, textarea, label");
      if (!k || k.closest(s.nurKlick) || !k.closest(s.ziel)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "mousedown") stupsen();
    };
    document.addEventListener("mousedown", knopfSperren, true);
    document.addEventListener("click", knopfSperren, true);
    // Klicks fürs Warten auf „klick“: vor der Seite selbst (capture), die Seite darf trotzdem tun, was sie tut
    document.addEventListener("click", (e) => {
      if (!aufgabe || !aufgabe.aktion.klick || !e.target.closest) return;
      try { if (e.target.closest(aufgabe.aktion.klick)) aufgabe.geklickt = true; } catch { }
    }, true);
    // Ereignisse der Seite fürs Warten auf „ereignis“ („merkliste“: etwas wurde gemerkt, auch aus dem Artikel heraus)
    document.addEventListener("merkliste", () => { if (aufgabe && aufgabe.aktion.ereignis === "merkliste") aufgabe.ereignis = true; });
    document.addEventListener("keydown", (e) => {
      if (!zustand || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowRight") { e.preventDefault(); gehe(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); gehe(-1); }
    });
    return teile;
  }

  // Klick neben die markierte Stelle: Kästchen wackelt kurz und sagt, was zu tun ist
  let hinweisTimer = null, gleitTimer = null;
  function stupsen() {
    if (!teile) return;
    const aufgabeOffen = !!(aufgabe && !aufgabe.fertig);
    const s = kapitelJetzt() && kapitelJetzt().schritte[zustand.schritt];
    hinweisZeigen(aufgabeOffen ? (s && s.hinweis) || "Klicke auf die hell markierte Stelle." : "Klicke auf „Weiter“, wenn du so weit bist.");
  }
  // Gelber Hinweis im Kästchen, Kästchen wackelt; bleibt: verschwindet nicht nach 4 s (aufgabePruefen nimmt ihn weg)
  function hinweisZeigen(text, bleibt) {
    const { kasten, hinweis } = teile;
    hinweis.replaceChildren(...zeilen(text));
    hinweis.hidden = false;
    kasten.classList.remove("fu-stups");
    void kasten.offsetWidth;   // Animation neu starten
    kasten.classList.add("fu-stups");
    clearTimeout(hinweisTimer);
    if (!bleibt) hinweisTimer = setTimeout(() => { if (!(aufgabe && aufgabe.fehlZeigt)) hinweis.hidden = true; platzieren(); }, 4000);
    platzieren();
  }

  // Im Lesefenster liegt der Artikel in einem eigenen Rahmen, dort greift die Sperre nicht.
  // Bei einer Aufgabe „artikel“ gehen dort nur Links zum gesuchten Artikel, andere stupsen an.
  function rahmenSperren() {
    let doc;
    try { doc = $("#lese-rahmen").contentDocument.getElementById("content_iframe").contentDocument; } catch { return; }
    if (!doc || doc.fuGesperrt) return;
    doc.fuGesperrt = true;
    doc.addEventListener("click", (e) => {
      const a = aufgabe;
      if (!zustand || !a || a.fertig) return;
      const link = e.target.closest && e.target.closest("a[href]");
      if (!link) return;
      // Bei einer Aufgabe „artikel“ gehen Links zum gesuchten Artikel, sonst führt im Artikel kein Link weg
      let pfad = "";
      try { pfad = decodeURIComponent(new URL(link.href, doc.baseURI).pathname); } catch { }
      if (a.aktion.artikel && new RegExp(a.aktion.artikel).test(pfad)) return;
      e.preventDefault();
      e.stopPropagation();
      stupsen();
    }, true);
  }

  function gehe(schritte) {
    const kap = kapitelJetzt();
    if (!kap) return;
    const n = zustand.schritt + schritte;
    if (n < 0) return;
    // Vorwärts nur über die Aufgabe selbst (Pfeiltaste überspringt sie nicht)
    if (schritte > 0 && aufgabe && !aufgabe.warSchon && !aufgabe.fertig) return;
    if (n >= kap.schritte.length) { beenden(); return; }
    richtung = schritte < 0 ? -1 : 1;
    zustand.schritt = n;
    zeigeSchritt();
  }

  async function zeigeSchritt() {
    const nr = ++lauf;
    const kap = kapitelJetzt();
    if (!kap) { beenden(); return; }
    const s = kap.schritte[zustand.schritt];
    if (!s) { beenden(); return; }
    // Schritte nur für einen bestimmten Stand („wenn“: stimme / ohneStimme), sonst in Laufrichtung überspringen
    // „zurueckWeg“: Mit „Zurück“ wird der Schritt übersprungen (z. B. eine Rückfrage, die dann nicht mehr offen ist)
    if ((s.wenn && !bedingungGilt(s.wenn)) || (s.zurueckWeg && richtung < 0)) {
      const n = zustand.schritt + richtung;
      if (n >= 0 && n < kap.schritte.length) { zustand.schritt = n; zeigeSchritt(); }
      else if (n >= kap.schritte.length) beenden();
      return;
    }
    const t = bauen();
    // Seite wechseln: nur, wenn der Schritt eine andere Adresse will oder man woanders hingeklickt hat
    // (das Lesefenster schreibt seine Adresse selbst um, sonst lüde der Artikel bei jedem Schritt neu)
    // Seite wechseln: Normalerweise nur, wenn man in einer anderen Ansicht ist (nach einer Aufgabe ist man meist schon
    // richtig, z. B. im Artikel, den man selbst angeklickt hat). „springen“: immer genau diese Adresse öffnen.
    aufgabe = null;
    // „Zurück“ nimmt zurück, was man in diesem Schritt getan hat (Nutzer, 17. Nov. 2026: nie eine Sackgasse):
    // wieder die Adresse, auf der man im Schritt angekommen war, dazu „aufraeumen“ (Merkliste, Ort, Route …)
    const zurueck = richtung < 0;
    const adressen = zustand.adressen || (zustand.adressen = {});
    const gemerkt = typeof adressen[zustand.schritt] === "string" ? { hash: adressen[zustand.schritt] } : adressen[zustand.schritt];
    // Aufräumen mit „vorher“ kommt vor dem Öffnen der Adresse (z. B. Notiz wieder unter altem Namen, gesicherte Seite weg)
    const aufr = [].concat(s.aufraeumen || []);
    if (zurueck && aufr.some(a => a && a.vorher)) {
      await aufraeumen(aufr.filter(a => a && a.vorher), kap);
      if (nr !== lauf) return;
    }
    if (zurueck && (gemerkt || s.seite)) {
      const a = gemerkt ? gemerkt.hash : s.seite;
      // Neue Adresse: erst das Lesefenster seinen Artikel laden lassen, dann den Rahmen zurücksetzen
      if (location.hash !== a) { location.hash = a; await new Promise(r => setTimeout(r, 800)); }
      if (s.seite) zustand.seite = s.seite;
      // Im Lesefenster ändert sich die Adresse nicht mit (z. B. Suche im Paket): Inhalt dort auch zurück
      if (gemerkt && gemerkt.innen) await innenZurueck(gemerkt.innen, nr);
      if (nr !== lauf) return;
    } else if (s.seite) {
      const wechseln = s.springen ? s.seite !== zustand.seite : ansichtVon(location.hash) !== ansichtVon(s.seite);
      if (wechseln && location.hash !== s.seite) location.hash = s.seite;
      zustand.seite = s.seite;
    }
    speichern();
    if (zurueck && aufr.some(a => !(a && a.vorher))) {
      t.kasten.classList.add("fu-wartet");
      await aufraeumen(aufr.filter(a => !(a && a.vorher)), kap);
      if (nr !== lauf) return;
    }
    // „vorfuellen“: erledigt beim Ankommen (auch mit „Zurück“), was man sonst selbst tun müsste
    // (erstehilfe-geuebt: alle Übungen abgehakt, erstehilfe-fertig: Quiz beantwortet, Lektion abgeschlossen)
    for (const v of [].concat(s.vorfuellen || [])) {
      if (v === "erstehilfe-geuebt" || v === "erstehilfe-fertig") ErsteHilfe.uebungVorfuellen(v.slice(11));
    }
    punktSetzen(s.punkt, s.zoom, nr);

    t.kasten.classList.add("fu-wartet");
    t.hinweis.hidden = true;
    ziel = null;
    const hatZiel = !!(s.ziel || s.rahmenZiel);
    const gefunden = hatZiel ? await warteAuf(s, nr) : null;
    if (nr !== lauf) return;
    if (hatZiel && !gefunden && s.optional) {
      const n = zustand.schritt + richtung;
      if (n >= 0 && n < kap.schritte.length) { zustand.schritt = n; zeigeSchritt(); }
      else if (n >= kap.schritte.length) beenden();
      return;
    }
    ziel = gefunden;
    // Adresse beim Ankommen merken: „Zurück“ zu diesem Schritt öffnet genau sie wieder
    if (!zurueck) { adressen[zustand.schritt] = { hash: location.hash, innen: innenAdresse() }; speichern(); }

    const letzter = zustand.schritt === kap.schritte.length - 1;
    t.kapitel.textContent = "Rundgang · " + kap.titel;
    t.titel.textContent = s.titel || "";
    // Aus dem Einrichtungs-Assistenten gestartet: Am Ende geht es dorthin zurück statt zu „KI einrichten“ usw.
    const ausEinrichtung = (zustand.zurueck || "").startsWith("#setup");
    t.text.replaceChildren(...zeilen(s.text || ""),
      // „warnung“: gelb hervorgehoben unter dem Text (z. B. Blinken und Epilepsie)
      ...(s.warnung ? [el("span", { class: "fu-warnung" }, sym("triangle-alert"), el("span", {}, ...zeilen(s.warnung)))] : []),
      ...(letzter ?[el("br"), el("small", { class: "fu-ende" }, "Alle Kapitel findest du jederzeit in den Einstellungen unter „Rundgang durch Fieldbook“.")] : []));
    t.zahl.textContent = (zustand.schritt + 1) + " von " + kap.schritte.length;
    t.zurueck.hidden = zustand.schritt === 0;
    t.weiter.textContent = letzter ? (ausEinrichtung ? "Zurück zur Einrichtung" : "Fertig") : "Weiter";
    t.extra.hidden = !(letzter && kap.ende) || ausEinrichtung;
    if (letzter && kap.ende && !ausEinrichtung) {
      t.extra.textContent = kap.ende.text;
      t.extra.onclick = () => beenden(kap.ende.seite);
    }

    if (ziel) {
      const r = rechteck(ziel);
      const kopf = $(".kopf");
      const oben = kopf ? kopf.getBoundingClientRect().bottom : 0;
      // Unten liegt der Streifen „Übungsmodus“ über der Seite: Ein Ziel dahinter zählt als nicht zu sehen
      const streifen = $(".fu-streifen");
      const unten = streifen ? streifen.getBoundingClientRect().top : innerHeight;
      if (r.top < oben + RAND || r.bottom > unten - RAND) {
        ziel.scrollIntoView({ block: "center", behavior: wenigBewegung() ? "auto" : "smooth" });
        await new Promise(res => setTimeout(res, wenigBewegung() ? 50 : 400));
        if (nr !== lauf) return;
      }
    }
    // Aufgabe: kein „Weiter“, der Schritt geht von selbst weiter, sobald sie erledigt ist.
    // War sie beim Ankommen schon erledigt (z. B. mit „Zurück“ hierher), gibt es doch „Weiter“.
    if (s.aktion) {
      aufgabe = { aktion: s.aktion, nr, geklickt: false, start: stand(), karte: {} };
      aufgabe.warSchon = erfuellt(aufgabe);
      if (s.aktion.karte) karteBeobachten();
    }
    const warten = !!(aufgabe && !aufgabe.warSchon);
    t.weiter.hidden = warten;
    t.dran.hidden = !warten;
    t.licht.classList.toggle("fu-aktion", warten);
    // „ueberspringen“: Knopf, mit dem man eine offene Aufgabe auslassen darf (z. B. Lichtzeichen bei Epilepsie)
    if (!letzter && s.ueberspringen) {
      t.extra.hidden = !warten;
      t.extra.textContent = s.ueberspringen;
      t.extra.onclick = () => { if (aufgabe) aufgabe.fertig = true; gehe(1); };
    }
    // War das Kästchen ausgeblendet (Seitenwechsel), erscheint es direkt am neuen Platz, statt dorthin zu gleiten
    const warWeg = t.kasten.classList.contains("fu-weg");
    t.kasten.classList.remove("fu-wartet");
    const h = document.documentElement;
    clearTimeout(gleitTimer);
    if (warWeg) h.classList.remove("fu-gleitet");
    else {
      h.classList.add("fu-gleitet");
      gleitTimer = setTimeout(() => h.classList.remove("fu-gleitet"), 350);
    }
    platzieren();
    if (!warten) t.weiter.focus({ preventScroll: true });
    else if (ziel) {
      // Suchfeld gleich zum Schreiben bereit
      const feld = ziel.matches("input") ? ziel : ziel.querySelector("input[type=search], input[type=text]");
      if (feld) feld.focus({ preventScroll: true });
    }
  }

  // Bedingung prüfen: Alle angegebenen Teile müssen zutreffen (klick, sichtbar, adresse, artikel, enthaelt)
  function rahmenDoc() {
    try { return $("#lese-rahmen").contentDocument.getElementById("content_iframe").contentDocument; } catch { return null; }
  }
  function pruefe(x, a) {
    try {
      if (x.klick && !a.geklickt) return false;
      if (x.ereignis && !a.ereignis) return false;
      if (x.karte && !x.karte.every(k => a.karte && a.karte[k])) return false;
      if (x.sichtbar && !sichtbar($(x.sichtbar))) return false;
      // „da“: vorhanden und nicht ausgeblendet, darf aber außerhalb des Fensters liegen (z. B. unten in der Kartenleiste)
      if (x.da) { const e = $(x.da); if (!e || !e.isConnected || e.closest("[hidden]")) return false; }
      // „text“: { Auswahl: Muster } – Inhalt (bei Eingabefeldern der Wert) passt zum Muster, z. B. Notiz nicht leer
      if (x.text && !Object.keys(x.text).every(k => { const e = $(k); return e && new RegExp(x.text[k]).test("value" in e ? e.value : e.textContent); })) return false;
      if (x.adresse && !new RegExp(x.adresse).test(decodeURIComponent(location.hash))) return false;
      if (x.artikel || x.enthaelt) {
        const doc = rahmenDoc();
        if (!doc) return false;
        if (x.artikel && !new RegExp(x.artikel).test(decodeURIComponent(doc.defaultView.location.pathname))) return false;
        if (x.enthaelt && !doc.querySelector(x.enthaelt)) return false;
      }
      return true;
    } catch { return false; }
  }
  const erfuellt = (a) => pruefe(a.aktion, a);

  // Adresse im Artikelrahmen des Lesefensters (leer außerhalb des Lesefensters)
  function innenAdresse() {
    if (!location.hash.startsWith("#lesen")) return "";
    try { return rahmenDoc().defaultView.location.href; } catch { return ""; }
  }
  // Artikelrahmen auf eine gemerkte Adresse zurücksetzen, Suchfeld passend dazu (höchstens etwa 5 s warten)
  async function innenZurueck(adresse, nr) {
    for (let i = 0; i < 50 && nr === lauf; i++) {
      const doc = rahmenDoc();
      if (doc && doc.defaultView.location.href !== "about:blank" && doc.readyState === "complete") {
        if (doc.defaultView.location.href !== adresse) doc.defaultView.location.href = adresse;
        const feld = $("#lese-suche-feld");
        if (feld) { let q = ""; try { q = new URL(adresse).searchParams.get("pattern") || ""; } catch { } feld.value = q; }
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // „aufraeumen“ beim Zurückgehen (Liste oder ein Eintrag): nimmt zurück, was die Aufgabe des Schritts bewirkt hat.
  // Namen: merkliste (alles Gemerkte weg), merkstellen (nur gemerkte Textstellen), vorlesen (anhalten),
  // erstehilfe-fertig / erstehilfe-geuebt (Lektionen bzw. Häkchen im Übungs-Lernstand wieder offen),
  // uebersetzen (wieder Original), sperrungen, kiAn (Beispiel-KI wieder an), { ki: n } (nur die ersten n Fragen im Chat bleiben);
  // { klick, wenn }: Element anklicken (z. B. Aufgeklapptes zuklappen),
  // falls da und „wenn“ zutrifft; { feld, wert }: Eingabefeld auf diesen Wert (löst „input“ aus); { karte: Zustand }: Karte, Ort und Route wie in diesem Schritt (Karten.uebungZustand);
  // { gespraech: Zustand }: Übersetzer wie in diesem Schritt (Gespraech.uebungZurueck)
  async function aufraeumen(liste, kap) {
    const warte = async (sel, ms) => {
      for (let i = 0; i < ms / 50; i++) { const e = $(sel); if (e) return e; await new Promise(r => setTimeout(r, 50)); }
      return $(sel);
    };
    for (const a of [].concat(liste)) {
      try {
        if (a === "sperrungen") await Sperrungen.uebungLeeren();
        else if (a === "merkliste" || a === "merkstellen") {
          for (const x of await Merkliste.liste(true)) if (a === "merkliste" || x.stelle) await Merkliste.aendern({ aktion: "entfernen", id: x.id });
        }
        else if (a === "vorlesen") Vorlesen.stopp();
        else if (a === "erstehilfe-fertig" || a === "erstehilfe-geuebt") ErsteHilfe.uebungZurueck(a.slice(11));
        else if (a === "uebersetzen") {
          if (Uebersetzer.istAn()) { const k = await warte("#uebersetzen-knopf", 1500); if (k) k.click(); else Uebersetzer.setzeAn(false); }
        }
        else if (a === "kiAn") { if (OW.status && OW.status.sparmodus) await schalteKi(true); }
        else if (typeof a.ki === "number") Fragen.uebungZurueck(a.ki);
        else if (a.klick) { const e = await warte(a.klick, 600); if (e && (!a.wenn || $(a.wenn))) e.click(); }
        else if (a.feld) {
          // Eingabefeld wieder auf den alten Wert, die Seite rechnet wie nach einer Eingabe neu
          const e = await warte(a.feld, 600);
          // Auswahllisten hören auf „change“, Eingabefelder auf „input“
          if (e && e.value !== String(a.wert)) {
            e.value = String(a.wert);
            e.dispatchEvent(new Event("input", { bubbles: true }));
            e.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        else if (a === "kochen") Kochen.uebungLeeren();   // Kochen: Zutaten und Rezepte weg
        else if (a.ofen) await Kochen.uebungOfen(a.ofen); // Kochen: Backofen-Auswahl zurück, Rezepte neu
        else if (a.karte) await Karten.uebungZustand(a.karte, kap.beispiel || {});
        else if (a.eigene) await eigeneZurueck(a.eigene, !!a.vorher);   // Eigene Unterlagen: datei, notiz, notizName, notizText, webseite
        else if (a.gespraech) Gespraech.uebungZurueck(a.gespraech);   // Übersetzer: { verlauf, modus, getauscht, feld }
      } catch { }
    }
  }

  // Kapitel Eigene Unterlagen: im Rundgang Angelegtes zurücknehmen (liegt nur im Speicher des Servers).
  // Eine offene Notiz speichert vorher, sonst schriebe sie den alten Text danach wieder zurück.
  // „vorher“ (vor dem Öffnen der Adresse des Schritts): danach öffnet der Rundgang die Notiz selbst neu.
  async function eigeneZurueck(was, vorher) {
    const notiz = () => location.hash.startsWith("#notiz?") ? new URLSearchParams(location.hash.slice(7)) : null;
    if (notiz()) await Notizen.zeigen(notiz());
    await api("eigene/uebung-zurueck", { was });
    Eigene.geaendert();
    if (!vorher && notiz()) await Notizen.zeigen(notiz());
  }

  // Aufgabe „karte“ (["verschoben", "gezoomt"]): Hat man die Karte selbst bewegt? Nur Bewegungen mit der Maus zählen,
  // nicht das Hinfliegen der Karte beim Laden. MapLibre gibt beim Mausrad-Zoom kein originalEvent mit, deshalb
  // zählen Mausrad und Doppelklick selbst; „zoomend“ mit originalEvent kommt von den Knöpfen + und −.
  const beobachtet = new WeakSet();
  function karteBeobachten() {
    const k = typeof Karten !== "undefined" ? Karten.karte : null;
    if (!k) { setTimeout(() => { if (aufgabe && aufgabe.aktion.karte) karteBeobachten(); }, 300); return; }
    if (beobachtet.has(k)) return;
    beobachtet.add(k);
    const merke = (was) => (e) => { if (e && e.originalEvent && aufgabe && aufgabe.karte) aufgabe.karte[was] = true; };
    k.on("dragstart", merke("verschoben"));
    for (const n of ["wheel", "dblclick", "zoomend"]) k.on(n, merke("gezoomt"));
  }

  // „punkt“ ([lon, lat]): Ring auf der Karte, auf den der Schritt zeigt (ziel ".fu-kartenpunkt"); Klicks gehen durch ihn
  // hindurch in die Karte. Die Karte springt dorthin (Zoomstufe „zoom“).
  let punktMarker = null;
  function punktSetzen(p, zoom, nr) {
    if (punktMarker) { punktMarker.remove(); punktMarker = null; }
    if (!p) return;
    const k = typeof Karten !== "undefined" ? Karten.karte : null;
    // Karte noch nicht fertig (z. B. nach dem Neuladen): kurz warten, solange der Schritt noch gilt
    if (!k || typeof maplibregl === "undefined") {
      if (nr === lauf) setTimeout(() => { if (nr === lauf) punktSetzen(p, zoom, nr); }, 300);
      return;
    }
    k.jumpTo({ center: p, zoom: zoom || Math.max(k.getZoom(), 15) });
    punktMarker = new maplibregl.Marker({ element: el("div", { class: "fu-kartenpunkt" }) }).setLngLat(p).addTo(k);
  }
  // Echter Stand dieses Laptops (der Status ist auch in der Übung echt, nur die Bibliothek ist Beispiel)
  function bedingungGilt(wenn) {
    const stimme = !!(OW.status && (OW.status.stimmen || []).length);
    if (wenn === "stimme") return stimme;
    if (wenn === "ohneStimme") return !stimme;
    const uebersetzer = typeof Uebersetzer !== "undefined" && Uebersetzer.verfuegbar();
    if (wenn === "uebersetzer") return uebersetzer;
    if (wenn === "ohneUebersetzer") return !uebersetzer;
    return true;
  }
  // Wo man gerade ist (Adresse und Artikel im Lesefenster): Nach „Zurück“ ist die Aufgabe schon erledigt,
  // weiter geht es dann erst, wenn man sie neu macht und sich dabei etwas ändert
  function stand() {
    const doc = rahmenDoc();
    let innen = "";
    try { innen = doc ? doc.defaultView.location.href : ""; } catch { }
    return location.hash + "|" + innen;
  }
  function aufgabePruefen() {
    const a = aufgabe;
    if (!a || a.fertig || a.nr !== lauf) return;
    const ok = erfuellt(a) && (!a.warSchon || stand() !== a.start);
    // Falsch gemacht (z. B. Suche ohne den gesuchten Treffer): nach kurzer Zeit Hinweis zeigen, solange es so bleibt
    const s = kapitelJetzt() && kapitelJetzt().schritte[zustand.schritt];
    // Fehler mit Adresse oder Artikel zählen erst, wenn man seit dem Ankommen etwas geöffnet hat
    const f = a.aktion.fehl;
    const fehl = !ok && f && ((!f.adresse && !f.artikel) || stand() !== a.start) && pruefe(f, a);
    if (fehl) {
      if (!a.fehlSeit) a.fehlSeit = Date.now();
      else if (!a.fehlZeigt && Date.now() - a.fehlSeit > 1200 && s && s.fehlhinweis) { a.fehlZeigt = true; hinweisZeigen(s.fehlhinweis, true); }
    } else {
      a.fehlSeit = 0;
      if (a.fehlZeigt) { a.fehlZeigt = false; teile.hinweis.hidden = true; platzieren(); }
    }
    if (!ok) return;
    a.fertig = true;
    teile.hinweis.hidden = true;
    // Kurz stehen lassen, damit man sieht, was der Klick bewirkt hat
    setTimeout(() => { if (a.nr === lauf) gehe(1); }, (s && s.danach) || 600);
  }

  // Sperrflächen: mit Loch (Rechteck der markierten Stelle) oder ohne (alles gesperrt)
  function sperreSetzen(loch) {
    const vb = innerWidth, vh = innerHeight;
    const [a, b, c, d] = teile.sperren;
    const setze = (e, l, o, w, h) => Object.assign(e.style, { left: l + "px", top: o + "px", width: Math.max(0, w) + "px", height: Math.max(0, h) + "px" });
    if (!loch) { setze(a, 0, 0, vb, vh); setze(b, 0, 0, 0, 0); setze(c, 0, 0, 0, 0); setze(d, 0, 0, 0, 0); return; }
    const l = Math.max(0, loch.left), o = Math.max(0, loch.top), r = Math.min(vb, loch.right), u = Math.min(vh, loch.bottom);
    setze(a, 0, 0, vb, o);              // oben
    setze(b, 0, u, vb, vh - u);         // unten
    setze(c, 0, o, l, u - o);           // links
    setze(d, r, o, vb - r, u - o);      // rechts
  }

  // Lichtkegel um das Ziel und Kästchen daneben (unten, sonst oben, rechts, links; passt nichts: unten im Fenster)
  // „betonen“ (CSS-Auswahl): diese Elemente zusätzlich mit einem Ring über der Abdunklung zeigen, z. B. die
  // Trinkwasser-Punkte auf der Karte. Nur, was im Fenster und auf der Karte liegt; Karte bewegt sich: Ringe wandern mit.
  let ringe = [], ringBox = null, ringKarte = null, oben = [];
  function betonenZeichnen() {
    if (!teile || !zustand) return;
    const s = kapitelJetzt() && kapitelJetzt().schritte[zustand.schritt];
    const wartet = teile.kasten.classList.contains("fu-wartet") || teile.kasten.classList.contains("fu-weg");
    let elemente = [], kreise = [], linien = [];
    const k = typeof Karten !== "undefined" ? Karten.karte : null;
    if (k && ringKarte !== k && s && (s.betonen || s.betonenRoute)) { ringKarte = k; k.on("move", () => requestAnimationFrame(betonenZeichnen)); }
    // „betonenRoute“: Die berechnete Route bleibt auf der Karte hell (Linie als Loch in der Abdunklung)
    if (s && s.betonenRoute && !wartet && k && k.getSource("route")) {
      let daten = null;
      try { daten = k.getSource("route").serialize().data; } catch { }
      const teileVon = (g) => !g ? [] : g.type === "FeatureCollection" ? g.features.flatMap(f => teileVon(f.geometry))
        : g.type === "Feature" ? teileVon(g.geometry) : g.type === "LineString" ? [g.coordinates]
        : g.type === "MultiLineString" ? g.coordinates : [];
      const kr = rechteck(k.getContainer());
      for (const kette of teileVon(daten)) {
        const punkte = kette.map(c => { const p = k.project(c); return { x: p.x + kr.left, y: p.y + kr.top }; });
        if (punkte.length > 1) linien.push(punkte);
      }
    }
    if (s && s.betonen && !wartet) {
      // Stecknadel muss frei auf der Karte liegen: nicht unter Kopfzeile oder Kartenleiste
      const feld = $("#karte") ? rechteck($("#karte")) : null;
      const verdeckt = [".kopf", ".karte-panel"].map(x => $(x)).filter(e => e && sichtbar(e)).map(rechteck);
      const drin = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      const flaechen = [];
      for (const e of document.querySelectorAll(s.betonen)) {
        if (!sichtbar(e)) continue;
        const r = rechteck(e), x = r.left + r.width / 2, y = r.top + r.height / 2;
        // (auch nicht unterhalb der Kartenleiste: Die Ringe werden rechts von ihr abgeschnitten)
        if ((feld && !drin(feld, x, y)) || verdeckt.some(v => drin(v, x, y) || (v.top > 0 && x <= v.right && v.left <= (feld ? feld.left : 0) + 1))) continue;
        elemente.push(e);
        flaechen.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
      // Übereinanderliegende Punkte (z. B. Startpunkt der Route und der gemerkte Ort an derselben Stelle) zählen als
      // eine Fläche: ein Kringel um beide, so groß wie um eine einzelne Stecknadel
      for (let weiter = true; weiter;) {
        weiter = false;
        for (let i = 0; i < flaechen.length && !weiter; i++) for (let j = i + 1; j < flaechen.length; j++) {
          const a = flaechen[i], b = flaechen[j];
          if (a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top) continue;
          flaechen[i] = { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
          flaechen.splice(j, 1);
          weiter = true;
          break;
        }
      }
      // Kreis um die ganze Fläche mit etwas Luft; kleine Punkte bekommen trotzdem einen gut sichtbaren Ring
      for (const f of flaechen) kreise.push({ x: (f.left + f.right) / 2, y: (f.top + f.bottom) / 2,
        r: Math.max(Math.max(f.right - f.left, f.bottom - f.top) / 2 + 10, 28) });
      // Überschneiden sich Kreise, werden sie zu einem großen Kreis, der alle umschließt (bis nichts mehr überlappt)
      for (let weiter = true; weiter;) {
        weiter = false;
        for (let i = 0; i < kreise.length && !weiter; i++) for (let j = i + 1; j < kreise.length; j++) {
          const a = kreise[i], b = kreise[j], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d >= a.r + b.r) continue;
          if (d + b.r <= a.r) { kreise.splice(j, 1); weiter = true; break; }
          if (d + a.r <= b.r) { kreise.splice(i, 1); weiter = true; break; }
          const r = (d + a.r + b.r) / 2, t = (r - a.r) / d;
          kreise[i] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r };
          kreise.splice(j, 1);
          weiter = true;
          break;
        }
      }
    }
    // Betonte Elemente liegen über der Abdunklung, damit man sie gut erkennt
    for (const e of oben) if (!elemente.includes(e)) e.classList.remove("fu-oben");
    for (const e of elemente) e.classList.add("fu-oben");
    oben = elemente;
    // Ringe liegen in einem Rahmen über der freien Karte (unter der Kopfzeile, rechts der Kartenleiste) und werden
    // an dessen Rand abgeschnitten
    if (!ringBox) ringBox = document.body.appendChild(el("div", { class: "fu-ringe", "aria-hidden": "true" }));
    ringBox.hidden = !kreise.length;
    let box = { left: 0, top: 0 };
    if (kreise.length || linien.length) {
      const feld = rechteck($("#karte")), kopf = $(".kopf"), leiste = $(".karte-panel");
      box = { left: Math.max(feld.left, leiste && sichtbar(leiste) ? rechteck(leiste).right : 0), top: Math.max(feld.top, kopf ? rechteck(kopf).bottom : 0) };
      Object.assign(ringBox.style, { left: box.left + "px", top: box.top + "px", width: Math.max(0, feld.right - box.left) + "px", height: Math.max(0, feld.bottom - box.top) + "px" });
    }
    while (ringe.length < kreise.length) ringe.push(ringBox.appendChild(el("div", { class: "fu-ring" })));
    ringe.forEach((ring, i) => {
      const k = kreise[i];
      ring.hidden = !k;
      if (k) Object.assign(ring.style, { left: (k.x - k.r - box.left) + "px", top: (k.y - k.r - box.top) + "px", width: 2 * k.r + "px", height: 2 * k.r + "px" });
    });
    dunkelZeichnen(kreise, box, linien);
  }

  // Mit Kreisen dunkelt nicht der Schatten des Lichtkegels ab, sondern eine SVG-Fläche mit Löchern: für den Lichtkegel
  // und für jeden Kreis bzw. die Route (auf die freie Karte begrenzt). So ist es in den Kreisen hell wie an der markierten Stelle.
  let dunkel = null;
  function dunkelZeichnen(kreise, box, linien) {
    const h = document.documentElement;
    // (SVG kennt die Eigenschaft „hidden“ nicht, deshalb das Attribut setzen)
    if (!kreise.length && !linien.length) { h.classList.remove("fu-maske"); if (dunkel) dunkel.setAttribute("hidden", ""); return; }
    const ns = "http://www.w3.org/2000/svg";
    const mach = (name, attr) => { const e = document.createElementNS(ns, name); for (const k in attr) e.setAttribute(k, attr[k]); return e; };
    if (!dunkel) {
      dunkel = mach("svg", { class: "fu-dunkel", "aria-hidden": "true" });
      // Unter dem Lichtkegel (dessen grüner Rand bleibt sichtbar), über der Seite
      teile.licht.before(dunkel);
    }
    const vb = innerWidth, vh = innerHeight;
    dunkel.setAttribute("viewBox", "0 0 " + vb + " " + vh);
    const maske = mach("mask", { id: "fu-maske", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: vb, height: vh });
    maske.append(mach("rect", { x: 0, y: 0, width: vb, height: vh, fill: "white" }));
    const l = teile.licht;
    if (!l.classList.contains("fu-ohne")) {
      const r = l.getBoundingClientRect();
      maske.append(mach("rect", { x: r.left, y: r.top, width: r.width, height: r.height, rx: 10, fill: "black" }));
    }
    const feld = $("#karte") ? rechteck($("#karte")) : { right: vb, bottom: vh };
    const innen = mach("svg", { x: box.left, y: box.top, width: Math.max(0, feld.right - box.left), height: Math.max(0, feld.bottom - box.top) });
    for (const k of kreise) innen.append(mach("circle", { cx: k.x - box.left, cy: k.y - box.top, r: k.r, fill: "black" }));
    for (const punkte of linien) innen.append(mach("polyline", { points: punkte.map(p => (p.x - box.left) + "," + (p.y - box.top)).join(" "),
      fill: "none", stroke: "black", "stroke-width": 26, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    maske.append(innen);
    dunkel.replaceChildren(maske, mach("rect", { x: 0, y: 0, width: vb, height: vh, fill: "rgba(8, 10, 8, .62)", mask: "url(#fu-maske)" }));
    dunkel.removeAttribute("hidden");
    h.classList.add("fu-maske");
  }

  function platzieren() {
    if (!teile || !zustand) return;
    // Nach dem Platzieren, weil die Abdunklung das Loch des Lichtkegels braucht
    requestAnimationFrame(betonenZeichnen);
    const { licht, kasten, pfeil } = teile;
    // Läuft das Vorlesen, bleibt die Leiste unten frei bedienbar (Anhalten jederzeit): Sie zählt als Fensterrand,
    // Kästchen und Streifen „Übungsmodus“ stehen darüber
    const vl = $(".vl-leiste"), vlDa = !!(vl && ziel !== vl && sichtbar(vl));
    const vb = innerWidth, vh = vlDa ? rechteck(vl).top : innerHeight;
    const streifen = $(".fu-streifen");
    if (streifen) streifen.style.bottom = vl && sichtbar(vl) ? (innerHeight - rechteck(vl).top + 8) + "px" : "";
    // Das Kästchen bleibt über dem Streifen, sonst verdeckt er dessen Knöpfe („Zurück“, „Weiter“)
    const kvh = streifen && streifen.offsetHeight ? Math.min(vh, streifen.getBoundingClientRect().top) : vh;
    const kb = kasten.offsetWidth, kh = kasten.offsetHeight;
    // Ziel weg (z. B. woanders hingeklickt): Kästchen in die Mitte, alles leicht abgedunkelt
    let r = ziel && sichtbar(ziel) ? rechteck(ziel) : null;
    // „mit“: ein weiteres Element gehört zur markierten Stelle, z. B. die Vorschlagsliste unter einem Suchfeld
    const s = kapitelJetzt() && kapitelJetzt().schritte[zustand.schritt];
    const mit = r && s && s.mit ? $(s.mit) : null;
    if (mit && sichtbar(mit)) {
      const m = rechteck(mit), left = Math.min(r.left, m.left), top = Math.min(r.top, m.top), right = Math.max(r.right, m.right), bottom = Math.max(r.bottom, m.bottom);
      r = { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    const offen =!!(r && aufgabe && !aufgabe.fertig && !kasten.classList.contains("fu-wartet"));
    sperreSetzen(offen ? r : null);
    // Zwischen zwei Schritten bleibt der Rahmen stehen, bis das neue Ziel feststeht (sonst blitzt er kurz weg)
    if (kasten.classList.contains("fu-wartet")) return;
    // Aufgabe erledigt und dabei die Seite gewechselt (z. B. Klick auf „Karten“): Kästchen bis zum nächsten Schritt
    // ausblenden, statt es kurz in die Mitte springen zu lassen
    // (auch schon, bevor die Prüfung alle 250 ms die Aufgabe als erledigt markiert hat)
    // Der grüne Rahmen verschwindet dabei auch (nur die Abdunklung bleibt) und erscheint direkt am neuen Ziel
    if (!r && aufgabe && (aufgabe.fertig || (!aufgabe.warSchon && erfuellt(aufgabe)))) {
      kasten.classList.add("fu-weg");
      pfeil.hidden = true;
      Object.assign(licht.style, { left: vb / 2 + "px", top: vh / 2 + "px", width: "0px", height: "0px" });
      licht.classList.add("fu-ohne");
      licht.classList.remove("fu-aktion");
      return;
    }
    kasten.classList.remove("fu-weg");
    if (!r) {
      Object.assign(licht.style, { left: vb / 2 + "px", top: vh / 2 + "px", width: "0px", height: "0px" });
      licht.classList.add("fu-ohne");
      kasten.style.left = Math.max(RAND, (vb - kb) / 2) + "px";
      kasten.style.top = Math.max(RAND, (vh - kh) / 2) + "px";
      pfeil.hidden = true;
      return;
    }
    licht.classList.remove("fu-ohne");
    const pad = 6;
    // Sehr große Ziele (z. B. das Lesefenster) nur bis zum Fensterrand ausleuchten
    const l = Math.max(r.left - pad, 2), o = Math.max(r.top - pad, 2);
    const rr = Math.min(r.right + pad, vb - 2), u = Math.min(r.bottom + pad, vh - 2);
    Object.assign(licht.style, { left: l + "px", top: o + "px", width: Math.max(0, rr - l) + "px", height: Math.max(0, u - o) + "px" });

    let x, y, seite;
    // „kasten“: "rechts" stellt das Kästchen oben bündig rechts daneben (springt nicht, wenn darunter eine Liste aufgeht)
    if (s && s.kasten === "rechts" && rr + ABSTAND + kb <= vb - RAND) { seite = "rechts"; x = rr + ABSTAND; y = Math.min(Math.max(o, RAND), kvh - RAND - kh); }
    else if (u + ABSTAND + kh <= kvh - RAND) { seite = "unten"; y = u + ABSTAND; }
    else if (o - ABSTAND - kh >= RAND) { seite = "oben"; y = o - ABSTAND - kh; }
    else if (rr + ABSTAND + kb <= vb - RAND) { seite = "rechts"; x = rr + ABSTAND; }
    else if (l - ABSTAND - kb >= RAND) { seite = "links"; x = l - ABSTAND - kb; }
    else { seite = "innen"; y = kvh - RAND - kh - 56; }
    const mx = (l + rr) / 2, my = (o + u) / 2;
    const oben = s && s.kasten === "rechts" && seite === "rechts";
    if (oben) { /* y steht schon */ }
    else if (seite === "rechts" || seite === "links") y = Math.min(Math.max(my - kh / 2, RAND), kvh - RAND - kh);
    else x = Math.min(Math.max(mx - kb / 2, RAND), vb - RAND - kb);
    kasten.style.left = x + "px";
    kasten.style.top = y + "px";

    pfeil.hidden = seite === "innen";
    pfeil.dataset.seite = seite;
    if (seite === "unten" || seite === "oben") { pfeil.style.left = Math.min(Math.max(mx - x, 20), kb - 20) + "px"; pfeil.style.top = ""; }
    else { pfeil.style.top = (oben ? Math.min(Math.max(ziel ? rechteck(ziel).top + rechteck(ziel).height / 2 - y : 24, 20), kh - 20) : Math.min(Math.max(my - y, 20), kh - 20)) + "px"; pfeil.style.left = ""; }
  }

  // Beim Laden der Seite: läuft ein Rundgang, weitermachen; sonst Reste aufräumen
  async function init() {
    zustand = lesen();
    if (!cookieAn()) { if (zustand) { zustand = null; vergessen(); } return; }
    if (!zustand) { cookieSetzen(false); location.reload(); return; }
    document.documentElement.classList.add("uebung");
    try { await laden(); }
    catch { beenden(); return; }
    zeigeSchritt();
  }

  return { init, starten, beenden, kapitelListe, uebersicht, aktiv: () => !!zustand, kapitel: () => (zustand || lesen() || {}).kapitel };
})();
