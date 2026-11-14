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

  async function berechnen() {
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
    const url = "/route/brouter?lonlats=" + start.lon.toFixed(6) + "," + start.lat.toFixed(6) + "|" + ziel.lon.toFixed(6) + "," + ziel.lat.toFixed(6) +
      "&profile=" + profil.brouter + "&alternativeidx=0&format=geojson";
    try {
      const r = await fetch(url, { signal: mein.signal });
      const text = await r.text();
      if (nr !== anfrageNr) return;
      if (r.status === 503) throw new Error("Die Routenplanung ist noch nicht eingerichtet. Unter Inhalte kannst du sie laden.");
      if (!r.ok || text.trim()[0] !== "{") throw new Error(fehlerText(text));
      geojson = JSON.parse(text);
      if (!geojson.features || !geojson.features.length) throw new Error("Keine Route gefunden. Start oder Ziel liegt vielleicht abseits von Wegen: Punkt näher an eine Straße oder einen Weg setzen.");
      zeichneLinie();
      const pr = (geojson.features[0] || {}).properties || {};
      const meter = +pr["track-length"] || 0;
      let sek = +pr["total-time"] || 0;
      if (!sek) sek = meter / 1000 / profil.kmh * 3600;
      // Nur „filtered ascend“ ist der Anstieg; „plain-ascend“ ist bloß Höhe Ziel minus Höhe Start
      // und wird bergab negativ (zeigte „-7 m bergauf“, wenn der Anstieg 0 war)
      const hoch = Math.max(0, +pr["filtered ascend"] || 0);
      if (profil.id === "fuss") sek = gehzeit(meter, hoch, geojson.features[0].geometry.coordinates);
      if (status) status.textContent = "";
      if (erg) {
        erg.innerHTML = "";
        erg.append(el("div", { class: "routen-ergebnis" },
          el("div", {}, el("b", {}, (meter / 1000).toLocaleString("de-DE", { maximumFractionDigits: meter < 10000 ? 1 : 0 }) + " km"), el("small", {}, "Strecke")),
          el("div", {}, el("b", {}, dauerKurz(sek)), el("small", {}, "Dauer ca.")),
          el("div", {}, el("b", {}, Math.round(hoch) + " m"), el("small", {}, "bergauf"))));
      }
      const b = new maplibregl.LngLatBounds();
      for (const c of geojson.features[0].geometry.coordinates) b.extend([c[0], c[1]]);
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
        k.addLayer({ id: "route-rand", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 } });
        k.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#1f6f6b", "line-width": 5 } });
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
    const k = karte();
    if (k && k.getLayer("route")) { k.removeLayer("route"); k.removeLayer("route-rand"); k.removeSource("route"); }
  }

  // Wird von karten.js aufgerufen, sobald die Karte existiert
  function verbinden(k) {
    k.on("click", kartenKlick);
    k.on("style.load", () => { if (geojson) zeichneLinie(); });
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

  return { verbinden, zuZiel, vonHier, get offen() { return offen; } };
})();
