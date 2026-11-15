// Routenplanung auf der Karte mit BRouter (offline).
"use strict";

const Routen = (() => {
  const PROFILE = [
    { id: "fuss", icon: "footprints", titel: "Zu Fuß", brouter: "hiking-mountain", kmh: 4.5 },
    { id: "rad", icon: "bike", titel: "Rad", brouter: "trekking", kmh: 15 },
    { id: "auto", icon: "car", titel: "Auto", brouter: "car-fast", kmh: 60 },
  ];
  let offen = false, profil = PROFILE[0], start = null, ziel = null, wartetAuf = null;
  let markerStart = null, markerZiel = null, geojson = null, anfrageNr = 0, abbruch = null;
  let laufendBei = null; // Start der laufenden Berechnung („lon,lat“), zum Stoppen
  // Ziel zuerst festgelegt („Route hierhin“ oder Markierung beim Öffnen): weitere Klicks in die Karte versetzen
  // dann den Start, sonst immer das Ziel (Nutzer, 14. Nov. 2026). Tauschen dreht das mit um.
  let festesZiel = false;
  const feldPruefer = {}; // pro Feld die Funktion "getippten Namen übernehmen"

  const karte = () => Karten.karte;

  $("#routen-knopf").addEventListener("click", () => { offen ? schliessen() : oeffnen(); });

  function oeffnen() {
    offen = true;
    $("#routen-knopf").classList.add("aktiv");
    $("#routen-knopf").replaceChildren(sym("x"), "Route schließen");
    $("#ort-suche").hidden = true;
    $("#ort-treffer").innerHTML = "";
    // Vorher in die Karte geklickt oder einen Ort gesucht: dieser Punkt ist das Ziel, es fehlt nur noch der Start
    const vorher = OW.status && OW.status.routen && !start && !ziel ? Karten.punktFuerRoute() : null;
    if (vorher) { ziel = { lon: vorher.lon, lat: vorher.lat, name: vorher.name }; festesZiel = true; zeichneMarker(); }
    if (!start) wartetAuf = "start";
    zeichnePanel();
    Sperrungen.zeigen(!!(OW.status && OW.status.routen));
    if (vorher) { const f = $("#routen-panel .punkt input"); if (f) f.focus(); }
  }

  // Start und Ziel tauschen; noch nicht übernommener Text in den Feldern wandert mit
  function tauschen() {
    const felder = document.querySelectorAll("#routen-panel .punkt input");
    const texte = [felder[0] ? felder[0].value : "", felder[1] ? felder[1].value : ""];
    const alt = start; start = ziel; ziel = alt;
    festesZiel = !festesZiel;
    wartetAuf = !start ? "start" : !ziel ? "ziel" : null;
    zeichneMarker();
    zeichnePanel();
    const neu = document.querySelectorAll("#routen-panel .punkt input");
    if (neu.length === 2) { neu[0].value = texte[1]; neu[1].value = texte[0]; }
    berechnen();
  }

  function schliessen() {
    offen = false;
    $("#routen-knopf").classList.remove("aktiv");
    $("#routen-knopf").replaceChildren(sym("compass"), "Route planen");
    $("#ort-suche").hidden = false;
    $("#routen-panel").hidden = true;
    loeschen();
    Sperrungen.zeigen(false);
  }

  function zeichnePanel() {
    const p = $("#routen-panel");
    p.hidden = false;
    p.innerHTML = "";
    const s = OW.status || {};
    if (!s.routen) {
      p.append(el("div", { class: "routen-hinweis" },
        (s.routenKacheln && s.routenKacheln.length) ? "Die Routenplanung startet gerade oder konnte nicht starten. " :
          "Die Routenplanung ist noch nicht eingerichtet. ", el("a", { href: "#inhalte?zu=karten" }, "Routenplanung unter „Inhalte“ laden")));
      return;
    }
    p.append(el("div", { class: "profile" }, ...PROFILE.map(pr =>
      el("button", { type: "button", class: pr === profil ? "aktiv" : "", onclick: () => { profil = pr; zeichnePanel(); berechnen(); } }, sym(pr.icon), pr.titel))));
    // mousedown ohne Fokuswechsel: sonst übernimmt blur erst den getippten Text und zeichnet neu
    const tausch = el("button", { type: "button", class: "punkte-tauschen", title: "Start und Ziel tauschen", "aria-label": "Start und Ziel tauschen", onclick: tauschen }, sym("arrow-up-down"));
    tausch.addEventListener("mousedown", e => e.preventDefault());
    p.append(el("div", { class: "punkte" }, el("div", { class: "punkte-felder" }, punktFeld("A", "Start", start, "start"), punktFeld("B", "Ziel", ziel, "ziel")), tausch));
    zeigeAktiv();
    p.append(el("div", { class: "routen-hinweis", id: "routen-status" },
      wartetAuf === "start" ? "Start suchen oder in die Karte klicken." :
        wartetAuf === "ziel" ? "Ziel suchen oder in die Karte klicken." : ""));
    p.append(el("button", { type: "button", class: "knopf knopf-klein", onclick: () => { alleUebernehmen(); } }, "Route berechnen"));
    p.append(el("div", { id: "routen-ergebnis" }));
    if (start || ziel) p.append(el("button", { type: "button", class: "knopf knopf-klein", onclick: () => { loeschen(); zeichnePanel(); } }, "Neue Route"));
  }

  function punktFeld(marke, titel, wert, art) {
    const feld = el("input", { type: "search", placeholder: titel + " suchen …", value: wert ? wert.name : "", autocomplete: "off" });
    const treffer = el("div", { class: "ort-treffer" });
    // Klick auf einen Vorschlag: mousedown darf dem Feld den Fokus nicht nehmen,
    // sonst kommt blur (und die Auto-Übernahme) vor dem click
    treffer.addEventListener("mousedown", e => e.preventDefault());
    let t = null, letzte = null; // letzte = { q, versprechen } der zuletzt gestarteten Suche

    // Sucht Orte zu q (gleiche Anfrage wird nur einmal gestellt) und zeigt die Vorschläge an
    function suchen(q) {
      if (letzte && letzte.q === q) return letzte.versprechen;
      const versprechen = (async () => {
        if (q.length < 2 || !OW.status.orte) return [];
        const liste = await api("orte?q=" + encodeURIComponent(q)).catch(() => null);
        // Fehlgeschlagene Suche nicht merken: die nächste Eingabe fragt neu an
        if (!liste && letzte && letzte.versprechen === versprechen) letzte = null;
        if (feld.isConnected && feld.value.trim() === q) {
          treffer.innerHTML = "";
          if (!liste) treffer.append(el("div", { class: "leer" }, "Die Ortssuche ist gerade nicht erreichbar."));
          else for (const o of liste.slice(0, 8)) {
            treffer.append(el("button", { type: "button", onclick: () => { treffer.innerHTML = ""; waehle(o, false); } },
              el("b", {}, o.name), " ", el("small", {}, o.art + " · " + o.land)));
          }
        }
        return liste;
      })();
      letzte = { q, versprechen };
      return versprechen;
    }

    function waehle(o, ohnePanel) {
      const punkt = { lon: o.lon, lat: o.lat, name: o.name };
      feld.value = o.name;
      setze(art, punkt, ohnePanel);
      karte().flyTo({ center: [o.lon, o.lat], zoom: Math.max(karte().getZoom(), 12) });
    }

    // Übernimmt den besten Vorschlag zum getippten Text (falls noch kein Ort gewählt ist)
    async function uebernehmen() {
      const q = feld.value.trim();
      if (!q) return;
      const aktuell = art === "start" ? start : ziel;
      if (aktuell && aktuell.name === q) return;
      clearTimeout(t);
      const liste = await suchen(q);
      if (!feld.isConnected || feld.value.trim() !== q) return; // inzwischen anders getippt oder neu gezeichnet
      const jetzt = art === "start" ? start : ziel;
      if (jetzt && jetzt.name === q) return;
      if (!liste || !liste.length) {
        const st = $("#routen-status");
        if (st) st.replaceChildren(!OW.status.orte ? "Die Ortssuche ist noch nicht eingerichtet." : "Zu „" + q + "“ wurde kein Ort gefunden.", el("br"),
          "Bitte anders schreiben oder den Punkt in der Karte anklicken.");
        return;
      }
      // Liegt der Fokus in einem anderen Feld, würde ein Neuzeichnen das Tippen dort stören
      const f = document.activeElement;
      const fokusWoanders = f && f !== feld && f.tagName === "INPUT" && f.closest("#routen-panel");
      treffer.innerHTML = "";
      waehle(liste[0], !!fokusWoanders);
    }
    feldPruefer[art] = uebernehmen;

    // Ins Feld klicken macht es zum Feld, das Klicks in die Karte ändern (auch danach noch)
    feld.addEventListener("focus", () => { wartetAuf = art; festesZiel = art === "start"; zeigeAktiv(); const st = $("#routen-status"); if (st) st.textContent = titel + " suchen oder in die Karte klicken."; });
    feld.addEventListener("blur", () => { uebernehmen(); });
    feld.addEventListener("keydown", async e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (art === "start" && !ziel) { await uebernehmen(); const z = document.querySelectorAll("#routen-panel .punkt input")[1]; if (z && !ziel) z.focus(); return; }
      await alleUebernehmen();
    });
    feld.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const q = feld.value.trim();
        treffer.innerHTML = "";
        suchen(q);
      }, 250);
    });
    return el("div", { class: "punkt", "data-art": art }, el("span", { class: "p-marke" }, marke), feld, treffer);
  }

  // Welches Feld ändert der nächste Klick in die Karte?
  function aktivesFeld() {
    return wartetAuf || (!start ? "start" : !ziel ? "ziel" : festesZiel ? "start" : "ziel");
  }

  // Dieses Feld leicht grün hinterlegen (im Grün der Routenlinie)
  function zeigeAktiv() {
    const a = aktivesFeld();
    document.querySelectorAll("#routen-panel .punkt").forEach(p => p.classList.toggle("aktiv", p.dataset.art === a));
  }

  // Übernimmt getippte Namen in beiden Feldern (wartet auf laufende Suchen) und berechnet dann die Route
  async function alleUebernehmen() {
    const vorher = anfrageNr;
    if (feldPruefer.start) await feldPruefer.start();
    if (feldPruefer.ziel) await feldPruefer.ziel();
    // Hat das Übernehmen schon eine Berechnung gestartet (setze), nicht noch eine auslösen
    if (start && ziel) { if (anfrageNr === vorher) berechnen(); }
    else {
      const st = $("#routen-status");
      if (st && !st.textContent) st.replaceChildren(!start ? "Der Start fehlt noch." : "Das Ziel fehlt noch.", el("br"), "Bitte einen Ort eingeben oder in die Karte klicken.");
    }
  }

  // Klick in die Karte setzt Start bzw. Ziel
  function kartenKlick(e) {
    if (!offen || !OW.status.routen) return;
    // Sperrungen zuerst: Einzeichnen, Klick auf eine Sperrung oder auf die gewählte Strecke („Hier sperren“)
    if (Sperrungen.klick(e)) return;
    // Klick auf eine blasse Ausweichstrecke wählt sie aus, statt Start oder Ziel zu versetzen
    const alt = altUnter(e);
    if (alt) { waehleStrecke(alt.properties.nr); return; }
    const art = aktivesFeld();
    setze(art, { lon: e.lngLat.lng, lat: e.lngLat.lat, name: "Punkt auf der Karte" });
  }

  function setze(art, punkt, ohnePanel) {
    if (art === "start") start = punkt; else ziel = punkt;
    wartetAuf = !start ? "start" : !ziel ? "ziel" : null;
    zeichneMarker();
    if (!ohnePanel) zeichnePanel();
    berechnen();
  }

  function zeichneMarker() {
    const k = karte();
    const mach = (alt, punkt, farbe, art) => {
      if (!punkt) { if (alt) alt.remove(); return null; }
      if (alt) { alt.setLngLat([punkt.lon, punkt.lat]); return alt; }
      // Start: weißer Kreis mit dunklem Rand (mittig auf dem Punkt), Ziel: rote Stecknadel
      const opt = art === "start" ? { element: el("div", { class: "routen-start", title: "Start" }), anchor: "center" } : { color: farbe };
      const m = new maplibregl.Marker(Object.assign(opt, { draggable: true })).setLngLat([punkt.lon, punkt.lat]).addTo(k);
      m.on("dragend", () => {
        const ll = m.getLngLat();
        const neu = { lon: ll.lng, lat: ll.lat, name: "Punkt auf der Karte" };
        if (art === "start") start = neu; else ziel = neu;
        zeichnePanel();
        berechnen();
      });
      return m;
    };
    markerStart = mach(markerStart, start, null, "start");
    markerZiel = mach(markerZiel, ziel, "#b3261e", "ziel");
  }

  function abgedeckt(p) {
    const kacheln = OW.status.routenKacheln || [];
    const lon = Math.floor(p.lon / 5) * 5, lat = Math.floor(p.lat / 5) * 5;
    const name = (lon < 0 ? "W" + (-lon) : "E" + lon) + "_" + (lat < 0 ? "S" + (-lat) : "N" + lat);
    return kacheln.includes(name);
  }

  // sanft: nach einer Sperrung nur dann neu einpassen, wenn die neue Strecke aus dem Bild ragt
  async function berechnen(sanft) {
    if (!start || !ziel) return;
    const erg = $("#routen-ergebnis");
    const status = $("#routen-status");
    if (!abgedeckt(start) || !abgedeckt(ziel)) {
      if (status) status.replaceChildren("Für diesen Ort fehlen die Wegedaten.", el("br"),
        el("a", { href: "#inhalte?zu=karten" }, "Routenplanung für dieses Gebiet unter „Inhalte“ laden"));
      return;
    }
    const nr = ++anfrageNr;
    if (abbruch) abbruch.abort(); // alte Anfrage vor der neuen abbrechen
    const mein = abbruch = new AbortController();
    laufendBei = start.lon.toFixed(6) + "," + start.lat.toFixed(6);
    const laeuft = () => el("span", { class: "ladekreis" });
    if (status) status.replaceChildren(laeuft(), "Route wird berechnet …");
    // Lange Strecken (quer durch mehrere Länder) brauchen ein paar Minuten
    setTimeout(() => {
      if (nr === anfrageNr && status && status.textContent === "Route wird berechnet …")
        status.replaceChildren(laeuft(), "Route wird berechnet …", el("br"), "Lange Strecken brauchen ein paar Minuten.");
    }, 8000);
    try {
      // Erst die normale Strecke zeigen; zu Fuß und mit dem Rad danach im Hintergrund die flache suchen, damit der
      // Vergleich schon vor dem Haken dasteht und der Haken dann ohne neues Rechnen umschaltet (Nutzer, 15. Nov. 2026)
      const normal = await holeRoute(0, "", mein.signal);
      if (nr !== anfrageNr) return;
      normalRoute = normal;
      flachRoute = FLACH[profil.id] ? "sucht" : null;
      vergleich = [];
      geojson = vorschlag = normal;
      strecken = null; streckenOffen = false; streckenExtra = ""; streckenNr++;
      zeichneLinie();
      if (status) status.textContent = "";
      zeigeErgebnis();
      flachLauf = FLACH[profil.id] ? flachSuchen(nr, mein.signal) : null;
      const b = new maplibregl.LngLatBounds();
      for (const c of geojson.features[0].geometry.coordinates) b.extend([c[0], c[1]]);
      const sicht = karte().getBounds();
      if (sanft && sicht.contains(b.getSouthWest()) && sicht.contains(b.getNorthEast())) return;
      // Route passend einpassen, dann ein Stück weiter weg (Nutzer: nicht ganz bildschirmfüllend)
      const kam = karte().cameraForBounds(b, { padding: { top: 60, bottom: 60, left: innerWidth > 800 ? 380 : 40, right: 60 }, maxZoom: 16 });
      if (kam) karte().fitBounds(b, { padding: { top: 60, bottom: 60, left: innerWidth > 800 ? 380 : 40, right: 60 }, maxZoom: Math.min(16, kam.zoom - 0.6) });
      else karte().fitBounds(b, { padding: 60, maxZoom: 16 });
    } catch (e) {
      if (nr !== anfrageNr) return;
      if (!status) return;
      if (e instanceof TypeError) status.replaceChildren("Die Routenplanung ist gerade nicht erreichbar.", el("br"), "Bitte versuche es gleich noch einmal.");
      else status.replaceChildren(...zeilen(e.message));
    } finally {
      if (nr === anfrageNr) laufendBei = null;
    }
  }

  // Laufende Berechnung wirklich beenden: Abbrechen im Browser allein reicht nicht, BRouter rechnet sonst
  // minutenlang weiter. BRouter rechnet nur eine Route gleichzeitig (Server.cs), eine Mini-Anfrage
  // (Start bis Start) verdrängt deshalb die laufende.
  // ---------------------------------------------------------------- Strecke holen, Ergebnis zeigen
  // Möglichst wenig bergauf: Zu Fuß schaltet die Höhen-Einstellung des Wanderprofils ein (Abstieg kaum bestraft),
  // beim Rad achtet das Profil schon selbst auf Höhenmeter, hier nur stärker gewichtet. Getestet 15. Nov. 2026.
  const FLACH = {
    fuss: "&profile:consider_elevation=1&profile:uphillcostvalue=30&profile:downhillcostvalue=3&profile:uphillcutoffvalue=1",
    rad: "&profile:uphillcost=100",
  };
  let flach = false;           // Schalter „Möglichst wenig bergauf“ (gilt, bis man ihn ausschaltet)
  let normalRoute = null;      // Strecke ohne Schalter
  let flachRoute = null;       // Strecke mit Schalter; "sucht", "keine" (nicht wirklich flacher) oder null (Auto)
  let vergleich = [];          // Sätze zum Vergleich der flachen mit der normalen Strecke
  let flachLauf = null;        // laufende Suche nach der flachen Strecke (BRouter rechnet nur eine Route zugleich)
  let vorschlag = null;        // Strecke, die der Schalter gerade vorschlägt (Anfang der Liste „Weitere Strecken“)

  // Meter auf Straßen mit Autoverkehr (Bundes-, Landes- und Kreisstraßen) laut den Weg-Angaben von BRouter
  function strassenMeter(g) {
    const m = ((g.features[0] || {}).properties || {}).messages;
    if (!m || m.length < 2) return 0;
    const iD = m[0].indexOf("Distance"), iT = m[0].indexOf("WayTags");
    if (iD < 0 || iT < 0) return 0;
    let s = 0;
    for (const z of m.slice(1)) if (/(^|\s)highway=(trunk|primary|secondary|tertiary)(_link)?(\s|$)/.test(z[iT] || "")) s += +z[iD] || 0;
    return s;
  }

  async function flachSuchen(nr, signal) {
    let f = null;
    try { f = await holeRoute(0, FLACH[profil.id], signal); } catch (e) { /* dann gibt es eben keine */ }
    if (nr !== anfrageNr) return;
    const wn = werteVon(normalRoute), wf = f && werteVon(f);
    // Nur nehmen, wenn sie wirklich flacher ist (BRouter rechnet mit Kosten, nicht mit Höhenmetern)
    if (wf && wf.hoch < wn.hoch - Math.max(20, wn.hoch * 0.05)) {
      flachRoute = f;
      const dl = wf.meter - wn.meter;
      // Zweite Zeile: Länge und Dauer, „aber“ wenn das eine besser und das andere schlechter ist
      const dt = wf.sek - wn.sek;
      const laenge = Math.abs(dl) < 100 ? "Etwa gleich lang" : kmText(Math.abs(dl)) + (dl > 0 ? " länger" : " kürzer");
      const dauer = Math.abs(dt) < 120 ? "etwa gleich schnell" : dauerKurz(Math.abs(dt)) + (dt < 0 ? " schneller" : " langsamer");
      const gegen = (dl >= 100 && dt <= -120) || (dl <= -100 && dt >= 120);
      vergleich = [Math.round(wn.hoch - wf.hoch) + " m weniger bergauf.", laenge + (gegen ? ", aber " : " und ") + dauer + "."];
      if (strassenMeter(f) - strassenMeter(normalRoute) >= 500) vergleich.push("Führt dafür mehr über Straßen mit Autoverkehr.");
      // Haken schon gesetzt und keine andere Strecke aus der Liste gewählt: gleich die flache zeigen
      if (flach && geojson === vorschlag) { flachUmschalten(); return; }
    } else { flachRoute = "keine"; vergleich = ["Einen Weg mit deutlich weniger bergauf gibt es hier nicht."]; }
    zeigeErgebnis();
  }

  // Haken gesetzt oder entfernt: zwischen normaler und flacher Strecke wechseln, ohne neu zu rechnen
  function flachUmschalten() {
    const neu = flach && flachRoute && typeof flachRoute === "object" ? flachRoute : normalRoute;
    if (!neu) return;
    geojson = vorschlag = neu;
    streckenExtra = neu === normalRoute ? "" : FLACH[profil.id];
    strecken = null; streckenNr++;
    zeichneLinie();
    zeigeErgebnis();
    if (streckenOffen) weitereHolen();
  }
  let strecken = null;         // weitere Strecken [{ g, w }], null = noch nicht geholt
  let streckenOffen = false, streckenExtra = "", streckenNr = 0;

  async function holeRoute(alt, extra, signal) {
    const url = "/route/brouter?lonlats=" + start.lon.toFixed(6) + "," + start.lat.toFixed(6) + "|" + ziel.lon.toFixed(6) + "," + ziel.lat.toFixed(6) +
      "&profile=" + profil.brouter + "&alternativeidx=" + alt + "&format=geojson" + extra;
    // Gespeicherte Sperrungen in der Nähe umfahren
    const sperr = Sperrungen.param(profil.id, start, ziel);
    const r = await fetch(url + sperr, { signal });
    const text = await r.text();
    if (r.status === 503) throw new Error("Die Routenplanung ist noch nicht eingerichtet. Unter Inhalte kannst du sie laden.");
    const g = r.ok && text.trim()[0] === "{" ? JSON.parse(text) : null;
    if (!g || !g.features || !g.features.length) {
      const t = g ? "Keine Route gefunden." : fehlerText(text);
      // Mit Sperrungen kann es sein, dass sie jeden Weg versperren
      if (sperr && /^Keine Route gefunden/.test(t)) throw new Error("Keine Route gefunden. Vielleicht versperren die Sperrungen jeden Weg. Unter „Sperrungen“ kannst du einzelne ausschalten.");
      throw new Error(g ? "Keine Route gefunden. Start oder Ziel liegt vielleicht abseits von Wegen: Punkt näher an eine Straße oder einen Weg setzen." : t);
    }
    return g;
  }

  function werteVon(g) {
    const pr = (g.features[0] || {}).properties || {};
    const meter = +pr["track-length"] || 0;
    let sek = +pr["total-time"] || 0;
    if (!sek) sek = meter / 1000 / profil.kmh * 3600;
    // Nur „filtered ascend“ ist der Anstieg; „plain-ascend“ ist bloß Höhe Ziel minus Höhe Start
    // und wird bergab negativ (zeigte „-7 m bergauf“, wenn der Anstieg 0 war)
    const hoch = Math.max(0, +pr["filtered ascend"] || 0);
    if (profil.id === "fuss") sek = gehzeit(meter, hoch, g.features[0].geometry.coordinates);
    return { meter, sek, hoch };
  }

  const kmText = (m) => (m / 1000).toLocaleString("de-DE", { maximumFractionDigits: m < 10000 ? 1 : 0 }) + " km";

  function zeigeErgebnis() {
    zeichneAlternativen();
    const erg = $("#routen-ergebnis");
    if (!erg || !geojson) return;
    const w = werteVon(geojson);
    erg.innerHTML = "";
    erg.append(el("div", { class: "routen-ergebnis" },
      el("div", {}, el("b", {}, kmText(w.meter)), el("small", {}, "Strecke")),
      el("div", {}, el("b", {}, dauerKurz(w.sek)), el("small", {}, "Dauer ca.")),
      el("div", {}, el("b", {}, Math.round(w.hoch) + " m"), el("small", {}, "bergauf"))));
    const gesperrt = Sperrungen.anzahl(profil.id, start, ziel);
    if (gesperrt) erg.append(el("div", { class: "routen-hinweis sperr-beachtet" }, sym("ban"),
      gesperrt === 1 ? "Eine Sperrung in der Nähe wird gemieden." : gesperrt + " Sperrungen in der Nähe werden gemieden."));
    const profilBox = hoehenprofil(geojson.features[0].geometry.coordinates, w.meter);
    if (profilBox) erg.append(profilBox);
    // Schalter und weitere Strecken (die Liste erst nach einem Klick, damit der Kasten nicht überladen wird)
    const optionen = el("div", { class: "routen-optionen" });
    if (FLACH[profil.id]) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = flach;
      cb.disabled = flachRoute === "keine";
      cb.addEventListener("change", () => { flach = cb.checked; flachUmschalten(); });
      // Der Vergleich steht direkt unter dem Schalter, schon bevor man den Haken setzt (Nutzer, 15. Nov. 2026).
      // Sein Platz ist immer gleich hoch, damit beim Suchen und Umschalten nichts springt.
      const hinweis = flachRoute === "sucht"
        ? [el("span", { class: "ladekreis" }), "Weg mit wenig bergauf wird gesucht …"]
        : vergleich.flatMap((s, i) => i ? [el("br"), s] : [s]);
      optionen.append(el("div", { class: "routen-flach" },
        el("label", { class: "schalter" + (cb.disabled ? " aus" : "") }, cb, el("span", {}, "Möglichst wenig bergauf")),
        el("div", { class: "routen-hinweis routen-vergleich" }, ...hinweis)));
    }
    optionen.append(el("button", { type: "button", class: "knopf knopf-klein", "aria-expanded": String(streckenOffen),
      onclick: () => { streckenOffen = !streckenOffen; if (streckenOffen && !strecken) weitereHolen(); zeigeErgebnis(); } },
      streckenOffen ? "Weitere Strecken ausblenden" : "Weitere Strecken zeigen"));
    erg.append(optionen);
    if (streckenOffen) erg.append(streckenListe());
  }

  // Bis zu drei Ausweichstrecken von BRouter (nacheinander, BRouter rechnet nur eine Route zugleich)
  async function weitereHolen() {
    const nr = streckenNr;
    // Erst die Suche nach der flachen Strecke abwarten: eine zweite Anfrage würde sie bei BRouter verdrängen
    if (flachLauf) { try { await flachLauf; } catch (e) { } }
    if (nr !== streckenNr) return;
    const erste = geojson;
    const liste = [{ g: erste, w: werteVon(erste) }];
    for (let alt = 1; alt <= 3; alt++) {
      let g;
      try { g = await holeRoute(alt, streckenExtra); } catch (e) { break; }
      if (nr !== streckenNr) return;
      const w = werteVon(g);
      // Fast gleiche Strecken nur einmal
      if (!liste.some(x => Math.abs(x.w.meter - w.meter) < Math.max(50, w.meter * 0.01) && Math.abs(x.w.hoch - w.hoch) < 10)) liste.push({ g, w });
    }
    if (nr !== streckenNr) return;
    strecken = liste;
    zeigeErgebnis();
  }

  function streckenListe() {
    if (!strecken) return el("div", { class: "routen-hinweis" }, el("span", { class: "ladekreis" }), "Weitere Strecken werden gesucht …");
    if (strecken.length < 2) return el("div", { class: "routen-hinweis" }, "Es gibt hier keine andere sinnvolle Strecke.");
    return el("div", { class: "strecken-liste" }, strecken.map((s, i) =>
      el("button", { type: "button", class: "strecke" + (s.g === geojson ? " aktiv" : ""), "aria-pressed": String(s.g === geojson),
        onclick: () => waehleStrecke(i) },
        el("b", {}, i === 0 ? "Vorschlag" : "Strecke " + (i + 1)),
        el("span", {}, kmText(s.w.meter) + " · " + dauerKurz(s.w.sek) + " · " + Math.round(s.w.hoch) + " m bergauf"))));
  }

  function waehleStrecke(i) {
    if (!strecken || !strecken[i]) return;
    geojson = strecken[i].g;
    altHover(null);
    zeichneLinie();
    zeigeErgebnis();
  }

  // Die nicht gewählten Strecken der Liste blass auf der Karte, als Vorschlag zum Anklicken (Nutzer, 15. Nov. 2026)
  const ALT_LAGEN = ["route-alt-treffer", "route-alt", "route-alt-rand"];
  function zeichneAlternativen() {
    const k = karte();
    if (!k) return;
    const zeigen = offen && streckenOffen && strecken && strecken.length > 1 && geojson;
    const daten = { type: "FeatureCollection", features: !zeigen ? [] : strecken
      .map((s, i) => ({ type: "Feature", properties: { nr: i }, geometry: s.g.features[0].geometry }))
      .filter(f => strecken[f.properties.nr].g !== geojson) };
    try {
      if (k.getSource("route-alt")) { k.getSource("route-alt").setData(daten); return; }
      if (!zeigen) return;
      k.addSource("route-alt", { type: "geojson", data: daten, promoteId: "nr" });
      // Unter der gewählten Strecke, damit die immer obenauf liegt
      const vor = k.getLayer("route-rand") ? "route-rand" : Sperrungen.ersteLage();
      const rund = { "line-cap": "round", "line-join": "round" };
      k.addLayer({ id: "route-alt-rand", type: "line", source: "route-alt", layout: rund,
        paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.55, 0.18] } }, vor);
      k.addLayer({ id: "route-alt", type: "line", source: "route-alt", layout: rund,
        paint: { "line-color": "#1f6f6b", "line-width": 4, "line-dasharray": [1.2, 1.2], "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0.65] } }, vor);
      // Unsichtbare breite Linie, damit man die Strecke leicht trifft
      k.addLayer({ id: "route-alt-treffer", type: "line", source: "route-alt", layout: rund,
        paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 } }, vor);
    } catch (e) { /* Stil lädt gerade neu: style.load zeichnet gleich nach */ }
  }

  function alternativenWeg() {
    const k = karte();
    if (!k || !k.getSource("route-alt")) return;
    altHover(null);
    for (const id of ALT_LAGEN) if (k.getLayer(id)) k.removeLayer(id);
    k.removeSource("route-alt");
  }

  // Welche blasse Strecke liegt unter der Maus?
  function altUnter(e) {
    const k = karte();
    if (!k || !k.getLayer("route-alt-treffer")) return null;
    const f = k.queryRenderedFeatures(e.point, { layers: ["route-alt-treffer"] });
    return f.length ? f[0] : null;
  }

  let altHoverId = null;
  function altHover(f) {
    const k = karte();
    const id = f ? f.id : null;
    if (id === altHoverId || !k) return;
    const quelle = k.getSource("route-alt");
    if (altHoverId !== null && quelle) k.setFeatureState({ source: "route-alt", id: altHoverId }, { hover: false });
    altHoverId = (id !== null && id !== undefined && quelle) ? id : null;
    if (altHoverId !== null) k.setFeatureState({ source: "route-alt", id: altHoverId }, { hover: true });
    // Den Mauszeiger setzt sperrungen.js (kennt auch Strecke und Sperrungen unter der Maus)
  }

  function stoppen() {
    if (abbruch) { abbruch.abort(); abbruch = null; }
    if (!laufendBei) return;
    fetch("/route/brouter?lonlats=" + laufendBei + "|" + laufendBei + "&profile=car-fast&alternativeidx=0&format=geojson", { keepalive: true }).catch(() => {});
    laufendBei = null;
  }
  // Fenster oder Tab geschlossen, neu geladen
  window.addEventListener("pagehide", stoppen);

  function fehlerText(t) {
    if (/not mapped|no.*segment|datafile/i.test(t)) return "Für diesen Ort fehlen die Wegedaten.";
    if (/no route|not found|operation killed|target island|from-position/i.test(t)) return "Keine Route gefunden. Start oder Ziel liegt vielleicht abseits von Wegen: Punkt näher an eine Straße oder einen Weg setzen.";
    if (/timeout after/i.test(t)) return "Die Strecke ist zu lang, die Berechnung hat über 10 Minuten gedauert. Bitte eine kürzere Strecke wählen.";
    return "Route konnte nicht berechnet werden: " + t.slice(0, 160);
  }

  // Gehzeit nach der Wanderformel (DIN 33466): 4 km/h, 300 Hm/h bergauf, 500 Hm/h bergab;
  // die kleinere der beiden Zeiten zählt zur Hälfte
  function gehzeit(meter, hoch, koordinaten) {
    let runter = 0;
    for (let i = 1; i < koordinaten.length; i++) {
      const d = (koordinaten[i - 1][2] || 0) - (koordinaten[i][2] || 0);
      if (d > 0) runter += d;
    }
    const strecke = meter / 1000 / 4;
    const hoehe = hoch / 300 + runter / 500;
    return (Math.max(strecke, hoehe) + Math.min(strecke, hoehe) / 2) * 3600;
  }

  // ---------------------------------------------------------------- Höhenprofil
  // Fläche unter der Höhenlinie über der Strecke. Mit der Maus darüber zeigt ein Punkt auf der Karte die Stelle,
  // oben stehen Kilometer und Höhe. BRouter liefert die Höhe als dritten Wert jeder Koordinate (aus SRTM-Daten).
  let profilPunkt = null;   // Markierung auf der Karte beim Drüberfahren
  function profilPunktWeg() { if (profilPunkt) { profilPunkt.remove(); profilPunkt = null; } }

  function abstand(a, b) {
    const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  }

  function hoehenprofil(koord, meter) {
    profilPunktWeg();
    if (!koord || koord.length < 2 || !koord.every(c => typeof c[2] === "number")) return null;
    // Strecke bis zu jedem Punkt; auf die Länge von BRouter skaliert (die zählt etwas genauer)
    const dist = [0];
    for (let i = 1; i < koord.length; i++) dist.push(dist[i - 1] + abstand(koord[i - 1], koord[i]));
    const gesamt = dist[dist.length - 1] || 1;
    const faktor = meter > 0 ? meter / gesamt : 1;
    for (let i = 0; i < dist.length; i++) dist[i] *= faktor;
    const laenge = dist[dist.length - 1];
    const hoehen = koord.map(c => c[2]);
    const max = Math.max(...hoehen), min = Math.min(...hoehen);
    // Flache Strecken nicht wie Gebirge aussehen lassen: mindestens 60 m Höhenspanne zeigen
    const spanne = Math.max(60, max - min);
    const unten = Math.max(0, (max + min) / 2 - spanne / 2 - spanne * 0.08), oben = unten + spanne * 1.16;
    const W = 300, H = 100;
    const x = (d) => d / laenge * W, y = (h) => H - (h - unten) / (oben - unten) * H;
    // Höchstens etwa 400 Stützpunkte für die Linie
    const schritt = Math.max(1, Math.floor(koord.length / 400));
    const pts = [];
    for (let i = 0; i < koord.length; i += schritt) pts.push(x(dist[i]).toFixed(1) + "," + y(hoehen[i]).toFixed(1));
    pts.push(W + "," + y(hoehen[hoehen.length - 1]).toFixed(1));
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const flaeche = document.createElementNS(ns, "polygon");
    flaeche.setAttribute("points", "0," + H + " " + pts.join(" ") + " " + W + "," + H);
    flaeche.setAttribute("class", "hp-flaeche");
    const linie = document.createElementNS(ns, "polyline");
    linie.setAttribute("points", pts.join(" "));
    linie.setAttribute("class", "hp-linie");
    svg.append(flaeche, linie);

    // Bergab und steilste Stelle (Steigung über mindestens 100 m gemessen, sonst täuschen Messfehler)
    let runter = 0, steil = 0;
    for (let i = 1; i < hoehen.length; i++) { const d = hoehen[i - 1] - hoehen[i]; if (d > 0) runter += d; }
    for (let i = 0, j = 0; i < koord.length; i++) {
      while (j < koord.length - 1 && dist[j] - dist[i] < 100) j++;
      if (dist[j] - dist[i] >= 100) steil = Math.max(steil, Math.abs(hoehen[j] - hoehen[i]) / (dist[j] - dist[i]) * 100);
    }

    const km = (m) => (m / 1000).toLocaleString("de-DE", { maximumFractionDigits: laenge < 10000 ? 1 : 0 }) + " km";
    const info = el("span", { class: "hp-info" });
    const strich = el("div", { class: "hp-strich", hidden: true });
    const punkt = el("div", { class: "hp-punkt", hidden: true });
    // Skala in eigener Spalte links (über der Fläche würde sie die Linie verdecken), an der Höhe von max und min
    const feld = el("div", { class: "hp-feld" }, svg, strich, punkt);
    const skala = el("div", { class: "hp-skala" },
      el("span", { style: "top:" + (y(max) / H * 100) + "%" }, Math.round(max) + " m"),
      el("span", { style: "top:" + (y(min) / H * 100) + "%" }, Math.round(min) + " m"));

    function zeigeStelle(clientX) {
      const r = feld.getBoundingClientRect();
      const anteil = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const d = anteil * laenge;
      let lo = 0, hi = dist.length - 1;   // nächster Punkt zur Strecke d
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (dist[m] < d) lo = m; else hi = m; }
      const i = d - dist[lo] < dist[hi] - d ? lo : hi;
      const links = (dist[i] / laenge * 100) + "%";
      strich.style.left = punkt.style.left = links;
      punkt.style.top = (y(hoehen[i]) / H * 100) + "%";
      strich.hidden = punkt.hidden = false;
      info.textContent = km(dist[i]) + " · " + Math.round(hoehen[i]) + " m Höhe";
      const k = karte();
      if (!k) return;
      if (!profilPunkt) profilPunkt = new maplibregl.Marker({ element: el("div", { class: "hp-kartenpunkt" }) }).setLngLat([koord[i][0], koord[i][1]]).addTo(k);
      else profilPunkt.setLngLat([koord[i][0], koord[i][1]]);
    }
    function versteckeStelle() {
      strich.hidden = punkt.hidden = true;
      info.textContent = "";
      profilPunktWeg();
    }
    feld.addEventListener("pointermove", (e) => zeigeStelle(e.clientX));
    feld.addEventListener("pointerdown", (e) => zeigeStelle(e.clientX));
    feld.addEventListener("pointerleave", versteckeStelle);

    return el("div", { class: "hoehenprofil" },
      el("div", { class: "hp-kopf" }, el("b", {}, "Höhenprofil"), info),
      el("div", { class: "hp-raster" }, skala, feld, el("span"),
        el("div", { class: "hp-achse" }, el("span", {}, "0 km"), el("span", {}, km(laenge)))),
      el("div", { class: "hp-zahlen" },
        el("span", {}, "Bergab ", el("b", {}, Math.round(runter) + " m")),
        el("span", {}, "Höchster Punkt ", el("b", {}, Math.round(max) + " m")),
        steil >= 1 ? el("span", {}, "Steilste Stelle etwa ", el("b", {}, Math.round(steil) + " %")) : null));
  }

  function dauerKurz(sek) {
    const m = Math.round(sek / 60);
    if (m < 60) return m + " Min.";
    return Math.floor(m / 60) + " Std. " + (m % 60) + " Min.";
  }

  function zeichneLinie() {
    const k = karte();
    if (!k || !geojson) return;
    // Während eines Stilwechsels wirft addSource; style.load zeichnet danach neu.
    // (isStyleLoaded wäre auch beim Laden von Kacheln false und würde die Route verschlucken.)
    try {
      if (k.getSource("route")) k.getSource("route").setData(geojson);
      else {
        k.addSource("route", { type: "geojson", data: geojson });
        // Unter den Sperrungen, damit die sichtbar bleiben
        const vor = Sperrungen.ersteLage();
        k.addLayer({ id: "route-rand", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 } }, vor);
        k.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#1f6f6b", "line-width": 5 } }, vor);
      }
    } catch (e) { /* Stil lädt gerade neu: style.load zeichnet die Route gleich nach */ }
  }

  function loeschen() {
    start = ziel = null;
    festesZiel = false;
    geojson = null;
    wartetAuf = offen ? "start" : null;
    anfrageNr++;
    stoppen();
    if (markerStart) { markerStart.remove(); markerStart = null; }
    if (markerZiel) { markerZiel.remove(); markerZiel = null; }
    profilPunktWeg();
    strecken = null; streckenOffen = false; streckenNr++;
    normalRoute = null; flachRoute = null; vergleich = []; flachLauf = null;
    alternativenWeg();
    const k = karte();
    if (k && k.getLayer("route")) { k.removeLayer("route"); k.removeLayer("route-rand"); k.removeSource("route"); }
  }

  // Wird von karten.js aufgerufen, sobald die Karte existiert
  function verbinden(k) {
    k.on("click", kartenKlick);
    k.on("style.load", () => { if (geojson) { zeichneLinie(); zeichneAlternativen(); } });
    k.on("mousemove", e => { if (offen) altHover(altUnter(e)); });
    // Danach, damit Sperrungen den Mauszeiger zuletzt setzt
    Sperrungen.verbinden(k);
  }

  // „Route hierhin“ an einem eigenen Ort: Routenplanung öffnen, Ort als Ziel setzen
  function zuZiel(punkt) {
    if (!offen) oeffnen();
    festesZiel = true;
    setze("ziel", punkt);
    if (!start) { const f = $("#routen-panel .punkt input"); if (f) f.focus(); }
  }

  // „Route von hier“: Ort als Start setzen, das Ziel fehlt noch.
  // Die Markierung vorher abräumen, sonst würde oeffnen() sie als Ziel übernehmen.
  function vonHier(punkt) {
    if (!offen) { Karten.punktFuerRoute(); oeffnen(); }
    festesZiel = false;
    setze("start", punkt);
    if (!ziel) { const f = document.querySelectorAll("#routen-panel .punkt input")[1]; if (f) f.focus(); }
  }

  return { verbinden, zuZiel, vonHier, get offen() { return offen; },
    // für sperrungen.js
    get strecke() { return offen && geojson ? geojson.features[0].geometry.coordinates : null; },
    get profilId() { return profil.id; },
    get profilBrouter() { return profil.brouter; },
    get altHover() { return altHoverId !== null; },
    neuBerechnen() { if (offen && start && ziel) berechnen(true); } };
})();
