// Karten: MapLibre + PMTiles, komplett offline. Ortssuche über GeoNames, Einrichtungen aus den Kartendaten.
"use strict";

const Karten = (() => {
  let karte = null, markierung = null, poiMarker = [];
  let libsGeladen = null;

  const KATEGORIEN = [
    { id: "hospital", icon: "hospital", titel: "Arzt / Klinik", arten: ["hospital", "clinic", "doctors"] },
    { id: "pharmacy", icon: "pill", titel: "Apotheke", arten: ["pharmacy"] },
    { id: "water", icon: "droplet", titel: "Trinkwasser", arten: ["drinking_water", "water_point", "spring"] },
    { id: "shelter", icon: "house", titel: "Unterkunft", arten: ["alpine_hut", "shelter", "hotel", "hostel", "camp_site", "wilderness_hut", "guest_house", "chalet"] },
    { id: "police", icon: "shield", titel: "Polizei", arten: ["police", "fire_station"] },
    { id: "food", icon: "shopping-cart", titel: "Lebensmittel", arten: ["supermarket", "convenience", "bakery", "marketplace"] },
    { id: "fuel", icon: "fuel", titel: "Tankstelle", arten: ["fuel", "charging_station"] },
  ];

  function ladeSkript(src) {
    return new Promise((ok, fehler) => { const s = el("script", { src }); s.onload = ok; s.onerror = fehler; document.head.append(s); });
  }
  function ladeBibliotheken() {
    if (!libsGeladen) {
      if (!document.querySelector('link[href="vendor/maplibre-gl.css"]')) document.head.append(el("link", { rel: "stylesheet", href: "vendor/maplibre-gl.css" }));
      // Scheitert das Laden, nicht für immer merken: der nächste Versuch lädt neu
      libsGeladen = Promise.all([ladeSkript("vendor/maplibre-gl.js"), ladeSkript("vendor/pmtiles.js"), ladeSkript("vendor/basemaps.js")])
        .catch((e) => { libsGeladen = null; throw e; });
    }
    return libsGeladen;
  }

  async function zeigen(p) {
    await zeigenOhneSprung();
    // #karten?z=sonne (z. B. aus Vorsorge „Strom weg“): Sonne und Mond gleich aufklappen
    if (karte && p && p.get("z") === "sonne") Sonne.oeffnen();
  }

  async function zeigenOhneSprung() {
    const s = OW.status || await aktualisiereStatus();
    const leer = $("#karte-leer");
    if (!s.karten.length || !s.kartenAssets) {
      $("#karte-wrap").hidden = true;
      leer.hidden = false;
      leer.innerHTML = "";
      leer.append(el("h1", {}, "Karten"), el("div", { class: "karte-box" }, "Es sind noch keine Karten installiert.", el("br"), el("a", { href: "#inhalte?zu=karten" }, "Karten unter „Inhalte“ laden")));
      return;
    }
    leer.hidden = true;
    try { await ladeBibliotheken(); }
    catch (e) {
      $("#karte-wrap").hidden = true;
      leer.hidden = false;
      leer.innerHTML = "";
      leer.append(el("h1", {}, "Karten"), fehlerBox("Die Karte konnte nicht geladen werden. Bitte noch einmal versuchen.", zeigenOhneSprung, "Erneut versuchen", e && e.message));
      return;
    }
    $("#karte-wrap").hidden = false;
    const stand = s.karten.map(k => k.id).join(","), geaendert = stand !== kartenStand;
    if (geaendert) { await ladeKartenliste(s); kartenStand = stand; speicherGeladen = ladeEinrichtungen(); }
    if (!karte) erstelle();
    else { if (geaendert) neuZeichnen(); setTimeout(() => karte.resize(), 50); }
  }

  // Alle installierten Karten bilden zusammen eine nahtlose Karte: Für jede Kachel wird die erste Datei
  // genommen, die sie enthält. pmtiles extract kopiert ganze Kacheln, deshalb ist jede gefundene Kachel
  // vollständig, auch an den Grenzen. Gezeichnet wird nur eine Quelle, also nicht mehr als mit einer Karte.
  let kartenStand = "", kartenListe = [], maxZoom = 15, sprung = false;
  const originale = {};
  async function ladeKartenliste(s) {
    const flaeche = (k) => (k.bbox[2] - k.bbox[0]) * (k.bbox[3] - k.bbox[1]);
    // Kleinste Karten zuerst (meist das Land, in dem man gerade ist), die Weltkarte zuletzt
    const neu = s.karten.slice().sort((a, b) => flaeche(a) - flaeche(b));
    await Promise.all(neu.map(async (k) => {
      const h = await kartenDatei(k.id).getHeader().catch(() => null);
      k.minZoom = h ? h.minZoom : 0; k.maxZoom = h ? h.maxZoom : (k.maxzoom || 15);
    }));
    kartenListe = neu;
    maxZoom = Math.max(...kartenListe.map(k => k.maxZoom));
  }

  // Kacheln, die keine Datei enthält, sind leer (dort ist dann nur der Hintergrund zu sehen).
  // Lesefehler werden nicht verschluckt: sie werfen, damit MapLibre die Kachel später neu lädt.
  async function holeKachel(z, x, y, signal) {
    const n = 2 ** z, lon = (v) => v / n * 360 - 180;
    const lat = (v) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) * 180 / Math.PI;
    const w = lon(x), o = lon(x + 1), nord = lat(y), sued = lat(y + 1);
    for (const k of kartenListe) {
      if (z > k.maxZoom || z < k.minZoom || o < k.bbox[0] || w > k.bbox[2] || nord < k.bbox[1] || sued > k.bbox[3]) continue;
      if (signal && signal.aborted) throw new DOMException("Abgebrochen", "AbortError");
      const r = await kartenDatei(k.id).getZxy(z, x, y, signal);
      if (r && r.data) return r.data;
    }
    return null;
  }

  function neuZeichnen() {
    karte.setStyle(stil());
    // Beim Stilwechsel mit Diff kommt kein style.load: eigene Ebene danach wieder anlegen
    karte.once("styledata", () => { ortsnamenEbene(); ladeOrtsnamen(); });
    fuelleSprungliste();
    zoomGrenze();
  }

  // Unsichtbare Wand: Beim Verschieben bleibt die Kartenmitte in Karten, die die aktuelle Zoomstufe haben.
  // So ist höchstens der halbe Bildschirm grau, statt dass die Karte herauszoomt. Die Mitte wird direkt
  // im Transform gesetzt, nicht mit jumpTo: jumpTo würde das Ziehen mit gedrückter Maus abbrechen.
  // Unter Zoom 8 gilt die Wand nicht je Land, sondern für das Rechteck um alle Länder: Lücken zwischen Ländern
  // (z. B. Deutschland und Schweden ohne Dänemark) sind dort nur ein schmaler grauer Streifen, und man soll
  // herausgezoomt von einem Land ins andere kommen. Mit Weltkarte gibt es dort keine Wand.
  let wandBis = 0, wandTimer = null, wandArt = "";
  function wand() {
    const z = karte.getZoom(), c = karte.getCenter();
    if (sprung || !originale.jumpTo) return;
    const drin = (b) => c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3];
    let rechtecke;
    if (z < 8) {
      if (!kartenListe.length || kartenListe.some(k => k.id === "welt")) return;
      rechtecke = [[Math.min(...kartenListe.map(k => k.bbox[0])), Math.min(...kartenListe.map(k => k.bbox[1])),
        Math.max(...kartenListe.map(k => k.bbox[2])), Math.max(...kartenListe.map(k => k.bbox[3]))]];
    } else {
      rechtecke = kartenListe.filter(k => k.maxZoom >= maxZoom || z < k.maxZoom + 0.99).map(k => k.bbox);
    }
    if (!rechtecke.length || rechtecke.some(drin)) return;
    let best = null, abstand = Infinity;
    for (const b of rechtecke) {
      const lng = Math.min(Math.max(c.lng, b[0]), b[2]), lat = Math.min(Math.max(c.lat, b[1]), b[3]);
      const d = (lng - c.lng) ** 2 + (lat - c.lat) ** 2;
      if (d < abstand) { abstand = d; best = [lng, lat]; }
    }
    if (karte.transform && karte.transform.setCenter) { karte.transform.setCenter(new maplibregl.LngLat(best[0], best[1])); karte.triggerRepaint(); }
    else originale.jumpTo({ center: best });
    // Hinweis zeigen, solange man gegen die Wand drückt, und noch kurz danach (nicht beim Zoomen am Rand)
    if (karte.isZooming()) return;
    wandArt = z < 8 ? "rand" : "wand";
    wandBis = Date.now() + 4000;
    clearTimeout(wandTimer);
    wandTimer = setTimeout(zeigeHinweis, 4100);
    zeigeHinweis();
  }

  // Wo nur eine gröbere Karte liegt (Weltkarte, „Platz sparen“), wäre beim Hineinzoomen alles grau.
  // Deshalb dort nur bis knapp unter die nächste Zoomstufe zoomen lassen und einen Hinweis zeigen.
  let amZoomEnde = false;
  function zoomGrenze() {
    const c = karte.getCenter();
    const hier = kartenListe.filter(k => c.lng >= k.bbox[0] && c.lng <= k.bbox[2] && c.lat >= k.bbox[1] && c.lat <= k.bbox[3]);
    const genau = hier.length ? Math.max(...hier.map(k => k.maxZoom)) : maxZoom;
    const grenze = genau >= maxZoom ? 22 : genau + 0.99;
    if (karte.getZoom() > grenze) originale.jumpTo({ zoom: grenze });
    if (karte.getMaxZoom() !== grenze) karte.setMaxZoom(grenze);
    amZoomEnde = grenze < 22 && karte.getZoom() >= grenze - 0.1;
    zeigeHinweis();
  }

  let hinweisArt = "";
  function zeigeHinweis() {
    const hinweis = $("#karte-zoomhinweis");
    const art = Date.now() < wandBis ? wandArt : amZoomEnde ? "zoom" : "";
    hinweis.hidden = !art;
    if (art === hinweisArt) return;
    hinweisArt = art;
    hinweis.innerHTML = "";
    const inhalte = el("a", { href: "#inhalte?zu=karten" }, "Inhalte");
    if (art === "wand" && kartenListe.some(k => k.id === "welt"))
      hinweis.append("Hier endet die genaue Karte.", el("br"), "Zoom etwas heraus, um weiterzuschieben,", el("br"), "oder lade das Land unter ", inhalte, ".");
    else if (art === "wand" || art === "rand") hinweis.append("Hier endet die geladene Karte.", el("br"), "Weitere Länder kannst du unter ", inhalte, " herunterladen.");
    if (art === "zoom") hinweis.append("Für diese Gegend gibt es keine genauere Karte.", el("br"), "Unter ", inhalte, " kannst du das Land herunterladen.");
  }

  function dunkel() {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function stil() {
    const flavor = dunkel() ? "dark" : "light";
    return {
      version: 8,
      glyphs: location.origin + "/karten-assets/fonts/{fontstack}/{range}.pbf",
      sprite: location.origin + "/karten-assets/sprites/v4/" + flavor,
      sources: {
        protomaps: {
          type: "vector",
          // Die Zahl hinter "fieldbook://" ändert sich mit den installierten Karten, damit keine alten Kacheln bleiben
          tiles: ["fieldbook://" + encodeURIComponent(kartenStand || "x") + "/{z}/{x}/{y}"],
          minzoom: 0, maxzoom: maxZoom,
          attribution: '© <a href="https://openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> · Protomaps',
        },
      },
      layers: schnellstrassen(basemaps.layers("protomaps", basemaps.namedFlavor(flavor), { lang: "de" })),
    };
  }

  // Schnellstraßen (OSM „trunk“) wie Autobahnen zeichnen, nur etwas schmaler. Im Original gehören sie zu den
  // Hauptstraßen und sind herausgezoomt kaum zu sehen; so verschwand z. B. die E4 nördlich von Gävle, die dort
  // als Schnellstraße eingetragen ist (Nutzer, 14. Nov. 2026). Die Daten stecken ab Zoom 6 in den Kacheln.
  function schnellstrassen(layers) {
    const AUTOBAHN = JSON.stringify(["==", "kind", "highway"]), HAUPT = JSON.stringify(["==", "kind", "major_road"]);
    const ersetze = (f, alt, neu) => Array.isArray(f) ? (JSON.stringify(f) === alt ? neu : f.map(x => ersetze(x, alt, neu))) : f;
    const schmaler = (w) => {
      if (!Array.isArray(w) || w[0] !== "interpolate") return w;
      const neu = w.slice(0, 3);
      for (let i = 3; i + 1 < w.length; i += 2)
        neu.push(w[i], typeof w[i + 1] === "number" ? ["case", ["==", ["get", "kind_detail"], "trunk"], w[i + 1] * 0.75, w[i + 1]] : w[i + 1]);
      return neu;
    };
    for (const l of layers) {
      if (l["source-layer"] !== "roads" || !l.filter) continue;
      const f = JSON.stringify(l.filter);
      if (f.includes(AUTOBAHN)) {
        l.filter = ersetze(l.filter, AUTOBAHN, ["any", ["==", "kind", "highway"], ["==", "kind_detail", "trunk"]]);
        if (l.paint) for (const k of ["line-width", "line-gap-width"]) if (l.paint[k]) l.paint[k] = schmaler(l.paint[k]);
      } else if (f.includes(HAUPT)) {
        l.filter = ersetze(l.filter, HAUPT, ["all", ["==", "kind", "major_road"], ["!=", "kind_detail", "trunk"]]);
      }
    }
    return layers;
  }

  function erstelle() {
    maplibregl.addProtocol("fieldbook", async (params, abbruch) => {
      const [z, x, y] = params.url.split("/").slice(-3).map(Number);
      const data = await holeKachel(z, x, y, abbruch && abbruch.signal);
      return { data: data ? new Uint8Array(data) : new Uint8Array(0) };
    });

    let gemerkt = null;
    try { gemerkt = JSON.parse(localStorage.getItem("karteAnsicht") || "null"); } catch { }
    const start = kartenListe.find(k => k.id !== "welt") || kartenListe[0];
    const [w, sd, o, n] = start.bbox;

    karte = new maplibregl.Map({
      container: "karte",
      style: stil(),
      bounds: gemerkt ? undefined : [[w, sd], [o, n]],
      center: gemerkt ? gemerkt.center : undefined,
      zoom: gemerkt ? gemerkt.zoom : undefined,
      attributionControl: { compact: true },
      fadeDuration: 0, // keine Einblendungen: spart Rechenzeit ohne Grafikkarte
    });
    Routen.verbinden(karte);
    karte.on("click", kartenKlick);
    karte.on("dblclick", () => clearTimeout(klickTimer));
    // Rechtsklick irgendwo entfernt die rote Markierung (Nutzer, 15. Nov. 2026); gemerkte Orte bleiben
    karte.on("contextmenu", (e) => {
      if (e.originalEvent) e.originalEvent.preventDefault();
      clearTimeout(klickTimer);
      markierungWeg();
    });
    karte.addControl(new maplibregl.NavigationControl(), "bottom-right");
    karte.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    karte.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), "bottom-right");
    // Sprünge per Ortssuche, Springen zu …, Route: Zoomgrenze vorher lösen (sonst bliebe man z. B. beim
    // Sprung von der Weltkarte nach München auf grober Stufe hängen); geprüft wird erst am Ziel
    for (const f of ["flyTo", "fitBounds", "jumpTo"]) {
      const original = originale[f] = karte[f].bind(karte);
      karte[f] = (...a) => { sprung = true; karte.setMaxZoom(22); return original(...a); };
    }
    karte.on("load", zoomGrenze);
    karte.on("zoom", () => { if (!sprung) zoomGrenze(); });
    karte.on("move", wand);
    karte.on("moveend", () => {
      sprung = false;
      zoomGrenze();
      try { localStorage.setItem("karteAnsicht", JSON.stringify({ center: karte.getCenter().toArray(), zoom: karte.getZoom() })); } catch { }
    });
    // Bei aktiver Umkreissuche nach dem Verschieben neu suchen
    karte.on("moveend", nachBewegung);
    karte.on("style.load", ortsnamenEbene);
    karte.on("load", ladeOrtsnamen);
    karte.on("moveend", () => { clearTimeout(ortsnamenTimer); ortsnamenTimer = setTimeout(ladeOrtsnamen, 250); });
    fuelleSprungliste();
    meineOrteLaden();

    // Kategorien
    const chips = $("#poi-chips");
    chips.innerHTML = "";
    for (const k of KATEGORIEN) {
      chips.append(el("button", { class: "chip", "data-id": k.id, onclick: (e) => zeigePois(k, e.currentTarget) }, sym(k.icon), k.titel));
    }
  }

  // Bei mehreren Karten: zu einem Land springen (alle sind ohnehin gleichzeitig zu sehen)
  function fuelleSprungliste() {
    const sel = $("#karten-region");
    sel.hidden = kartenListe.length < 2;
    sel.innerHTML = "";
    sel.append(el("option", { value: "" }, "Springen zu …"));
    for (const k of kartenListe.slice().sort((a, b) => a.titel.localeCompare(b.titel, "de"))) sel.append(el("option", { value: k.id }, k.titel));
    sel.onchange = () => {
      const r = kartenListe.find(k => k.id === sel.value);
      sel.value = "";
      if (r) karte.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { animate: false });
    };
  }

  // ------------------------------------------------ Ortssuche

  let suchTimer = null;
  $("#ort-feld").addEventListener("input", () => { clearTimeout(suchTimer); suchTimer = setTimeout(() => sucheOrt($("#ort-feld").value), 250); });
  $("#ort-suche").addEventListener("submit", (e) => { e.preventDefault(); sucheOrt($("#ort-feld").value); });

  let ortLauf = 0;
  async function sucheOrt(q) {
    q = (q || "").trim();
    const nr = ++ortLauf;
    $("#ort-feld").value = q;
    const ziel = $("#ort-treffer");
    if (q.length < 2) { ziel.innerHTML = ""; return; }
    // Eigene Orte stehen ganz oben
    const klein = q.toLocaleLowerCase("de");
    const eigene = meineOrte.filter(o => (o.name + " " + (o.notiz || "") + " " + (o.kategorie || "")).toLocaleLowerCase("de").includes(klein)).slice(0, 5);
    if (!OW.status.orte) {
      ziel.replaceChildren(...eigene.map(meinTreffer));
      if (!eigene.length) ziel.innerHTML = '<div class="leer">Ortsliste nicht installiert.</div>';
      return;
    }
    const liste = await api("orte?q=" + encodeURIComponent(q)).catch(() => null);
    if (nr !== ortLauf) return; // inzwischen neu gesucht
    ziel.replaceChildren(...eigene.map(meinTreffer));
    if (!liste && eigene.length) return;
    if (!liste) { ziel.append(el("div", { class: "leer" }, "Die Ortssuche ist gerade nicht erreichbar.")); return; }
    if (!liste.length && !eigene.length) { ziel.append(el("div", { class: "leer" }, "Nichts gefunden.")); return; }
    for (const o of liste.slice(0, 12)) {
      ziel.append(el("button", { onclick: () => geheZu(o) },
        el("b", {}, o.name), " ", el("small", {}, o.art + " · " + o.land + (o.name !== o.original ? " · " + o.original : "") + (o.einwohner > 0 ? " · " + o.einwohner.toLocaleString("de-DE") + " Einw." : ""))));
    }
  }

  // Markierter Punkt: gesuchter Ort oder Klick in die Karte. Sonne und Mond rechnet mit ihm, solange er
  // im sichtbaren Ausschnitt liegt, sonst mit der Kartenmitte.
  let punktGesetzt = null; // { lat, lon, text, name }
  function punkt() {
    if (!karte || !punktGesetzt) return null;
    return karte.getBounds().contains([punktGesetzt.lon, punktGesetzt.lat]) ? punktGesetzt : null;
  }

  // „Route planen“ übernimmt den markierten Punkt als Ziel; die Markierung weicht dann dem Ziel-Marker
  function punktFuerRoute() {
    const p = punktGesetzt;
    if (p) markierungWeg();
    return p;
  }

  function markiere(lat, lon, text, popupInhalt, popupAuf, name) {
    if (markierung) markierung.remove();
    punktGesetzt = { lat, lon, text, name: name || "Punkt auf der Karte" };
    markierung = new maplibregl.Marker({ color: "#b3261e" }).setLngLat([lon, lat])
      .setPopup(new maplibregl.Popup({ offset: 24, maxWidth: "340px" }).setDOMContent(popupInhalt)).addTo(karte);
    if (popupAuf) markierung.togglePopup();
    Sonne.neu();
  }

  function markierungWeg() {
    if (markierung) markierung.remove();
    markierung = null;
    punktGesetzt = null;
    Sonne.neu();
  }

  function geheZu(o) {
    $("#ort-treffer").innerHTML = "";
    const zoom = o.art === "Hauptstadt" || o.art === "Stadt" ? 11 : o.art === "Ort" ? 13 : 14;
    karte.flyTo({ center: [o.lon, o.lat], zoom, speed: 1.6 });
    markiere(o.lat, o.lon, "bei " + o.name, popupText(o.name + " (" + o.art + ")", o.lat, o.lon, null, o.name), false, o.name);
  }

  // Koordinaten zum Durchsagen (z. B. beim Notruf): 48,1374° N · 11,5755° O
  function koordinaten(lat, lon) {
    const f = (x) => Math.abs(x).toLocaleString("de-DE", { minimumFractionDigits: 4, maximumFractionDigits: 4 }) + "°";
    return f(lat) + (lat >= 0 ? " N" : " S") + " · " + f(lon) + (lon >= 0 ? " O" : " W");
  }

  // Mit Stadt: Stadt fett oben, darunter Stadtteil bzw. „2 km südlich von …“.
  // vorschlag = Name, mit dem „Ort merken“ das Namensfeld füllt.
  function popupText(titel, lat, lon, stadt, vorschlag) {
    const box = el("div", { class: "punkt-popup" });
    const ansicht = () => box.replaceChildren(el("b", {}, stadt || titel), stadt ? el("span", {}, titel) : "",
      el("small", {}, koordinaten(lat, lon)),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "punkt-weg", onclick: () => Routen.vonHier({ lat, lon, name: titel }) }, sym("map-pin"), "Route von hier"),
        el("button", { type: "button", class: "punkt-weg", onclick: () => Routen.zuZiel({ lat, lon, name: titel }) }, sym("compass"), "Route hierhin")),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "punkt-weg", onclick: () => box.replaceChildren(ortFormular(
          { name: vorschlag || "", notiz: "" },
          (w) => { markierungWeg(); ortNeu(w, lat, lon); },
          ansicht)) }, sym("bookmark"), "Ort merken")),
      // Entfernen per Rechtsklick in die Karte (statt eigenem Knopf)
      el("small", { class: "punkt-tipp" }, "Rechtsklick in die Karte entfernt die Markierung."));
    ansicht();
    return box;
  }

  // ------------------------------------------------ Meine Orte
  // Selbst gemerkte Orte: grüne Stecknadeln, Liste im Kartenfeld, oben in der Ortssuche.
  // Gespeichert in daten/orte/meine-orte.json (wandert beim Kopieren des Ordners mit).

  // Kategorien: freier Text je Ort (o.kategorie). Ausblenden: einzelner Ort (o.aus) oder ganze Kategorie
  // (Name in kategorienAus, "" = ohne Kategorie). Ausgeblendete Orte haben keine Stecknadel, stehen aber in der Liste.
  let meineOrte = [], kategorienAus = [], meineMarker = [], listeAuf = false, losePopup = null;
  const gruppenOffen = new Set(); // aufgeklappte Kategorien in der Liste ("" = ohne Kategorie)

  async function meineOrteLaden() {
    const d = await api("meineorte").catch(() => null);
    meineOrte = d && Array.isArray(d.orte) ? d.orte : [];
    kategorienAus = d && Array.isArray(d.kategorienAus) ? d.kategorienAus : [];
    meineOrteZeichnen();
  }

  async function meineOrteSpeichern() {
    meineOrteZeichnen();
    const benutzt = new Set(meineOrte.map(o => o.kategorie || ""));
    kategorienAus = kategorienAus.filter(k => benutzt.has(k));
    const r = await api("meineorte", { orte: meineOrte, kategorienAus }).catch(() => null);
    if (!r || !r.ok) zeigeMeldung("Die Orte ließen sich nicht speichern.");
  }

  function zeigeMeldung(text) {
    const h = $("#karte-zoomhinweis");
    h.textContent = text;
    h.hidden = false;
    setTimeout(() => { h.hidden = true; }, 4000);
  }

  function ortNeu(w, lat, lon) {
    const o = { id: Date.now().toString(36), name: w.name, notiz: w.notiz, lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
    if (w.farbe) o.farbe = w.farbe;
    if (w.kategorie) o.kategorie = w.kategorie;
    // Neuer Ort in einer ausgeblendeten Kategorie: Kategorie wieder zeigen, sonst wäre er gleich unsichtbar
    kategorienAus = kategorienAus.filter(k => k !== (o.kategorie || ""));
    meineOrte.push(o);
    meineOrteSpeichern();
    const m = meineMarker.find(x => x.ort === o);
    if (m) m.marker.togglePopup();
  }

  // Gedeckte Farben für die Stecknadeln (gespeichert wird nur der Name; ohne Farbe = Moosgrün des Designs)
  const ORT_FARBEN = [
    { name: "", titel: "Moosgrün" },
    { name: "blau", titel: "Blau", wert: "#5f7f99" },
    { name: "rot", titel: "Ziegelrot", wert: "#a8604d" },
    { name: "ocker", titel: "Ocker", wert: "#b08d4f" },
    { name: "violett", titel: "Violett", wert: "#82698c" },
    { name: "grau", titel: "Grau", wert: "#7b817b" },
  ];

  function ortFarbe(o) {
    const f = ORT_FARBEN.find(x => x.name && x.name === o.farbe);
    return f ? f.wert : akzentFarbe();
  }

  function alleKategorien() {
    return [...new Set(meineOrte.map(o => o.kategorie).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  }

  function istSichtbar(o) {
    return !o.aus && !kategorienAus.includes(o.kategorie || "");
  }

  // Kategorie-Feld mit Dropdown: Pfeil zeigt alle vorhandenen Kategorien, beim Tippen nur die passenden
  function katFeld(feld) {
    const alle = alleKategorien();
    const liste = el("div", { class: "ort-kat-liste", hidden: true });
    const zu = () => { liste.hidden = true; };
    const zeigen = (gefiltert) => {
      const q = feld.value.trim().toLocaleLowerCase("de");
      const treffer = gefiltert && q ? alle.filter(k => k.toLocaleLowerCase("de").includes(q) && k.toLocaleLowerCase("de") !== q) : alle;
      liste.replaceChildren(...treffer.map(k => el("button", { type: "button",
        onmousedown: (e) => e.preventDefault(), // Feld behält den Fokus
        onclick: () => { feld.value = k; zu(); } }, k)));
      liste.hidden = !treffer.length;
    };
    feld.addEventListener("input", () => zeigen(true));
    feld.addEventListener("blur", zu);
    feld.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !liste.hidden) { e.stopPropagation(); zu(); }
      if (e.key === "ArrowDown" && liste.hidden) { e.preventDefault(); zeigen(false); }
    });
    const pfeil = alle.length ? el("button", { type: "button", class: "ort-kat-auf", title: "Vorhandene Kategorien", "aria-label": "Vorhandene Kategorien",
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { if (liste.hidden) { zeigen(false); feld.focus(); } else zu(); } }, sym("chevron-down")) : null;
    return el("div", { class: "ort-kat" }, feld, pfeil, liste);
  }

  // Formular für Name, Kategorie, Notiz und Farbe (neu oder bearbeiten); speichern bekommt { name, notiz, farbe, kategorie }
  function ortFormular(wert, speichern, abbrechen) {
    let farbe = ORT_FARBEN.some(x => x.name === wert.farbe) ? wert.farbe : "";
    const name = el("input", { type: "text", value: wert.name, placeholder: "Name, z. B. Treffpunkt Familie", maxlength: "80" });
    const kategorie = el("input", { type: "text", value: wert.kategorie || "", placeholder: "Kategorie (freiwillig), z. B. Familie", maxlength: "40", autocomplete: "off" });
    const katBox = katFeld(kategorie);
    const notiz = el("textarea", { rows: "2", placeholder: "Notiz (freiwillig)", maxlength: "500" });
    notiz.value = wert.notiz || "";
    const los = (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      // gleiche Kategorie in anderer Schreibweise zusammenführen („familie“ → „Familie“)
      let k = kategorie.value.trim();
      const gleich = alleKategorien().find(x => x.toLocaleLowerCase("de") === k.toLocaleLowerCase("de"));
      if (gleich) k = gleich;
      speichern({ name: n, notiz: notiz.value.trim(), farbe, kategorie: k });
    };
    const punkte = ORT_FARBEN.map(x => el("button", { type: "button", class: "ort-farbe" + (x.name === farbe ? " an" : ""),
      title: x.titel, "aria-label": x.titel, "aria-pressed": String(x.name === farbe),
      style: "background:" + (x.wert || akzentFarbe()),
      onclick: (e) => {
        farbe = x.name;
        for (const p of punkte) { const an = p === e.currentTarget; p.classList.toggle("an", an); p.setAttribute("aria-pressed", String(an)); }
      } }));
    const f = el("form", { class: "ort-formular", onsubmit: los }, name, katBox, notiz,
      el("div", { class: "ort-farben", role: "group", "aria-label": "Farbe" }, ...punkte),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "submit", class: "knopf knopf-klein knopf-haupt" }, "Speichern"),
        el("button", { type: "button", class: "punkt-weg", onclick: abbrechen }, "Abbrechen")));
    setTimeout(() => { name.focus(); name.select(); }, 0);
    return f;
  }

  function akzentFarbe() {
    return getComputedStyle(document.documentElement).getPropertyValue("--akzent").trim() || "#5f7f3a";
  }

  function meinPopup(o) {
    const box = el("div", { class: "punkt-popup" });
    const ansicht = () => box.replaceChildren(el("b", {}, o.name), o.kategorie ? el("small", {}, o.kategorie) : "", o.notiz ? el("span", { class: "ort-notiz" }, o.notiz) : "",
      el("small", {}, koordinaten(o.lat, o.lon)),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "punkt-weg", onclick: () => Routen.vonHier({ lat: o.lat, lon: o.lon, name: o.name }) }, sym("map-pin"), "Route von hier"),
        el("button", { type: "button", class: "punkt-weg", onclick: () => Routen.zuZiel({ lat: o.lat, lon: o.lon, name: o.name }) }, sym("compass"), "Route hierhin")),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "punkt-weg", onclick: () => box.replaceChildren(ortFormular(o,
          (w) => {
            o.name = w.name; o.notiz = w.notiz;
            if (w.farbe) o.farbe = w.farbe; else delete o.farbe;
            if (w.kategorie) o.kategorie = w.kategorie; else delete o.kategorie;
            if (losePopup) { losePopup.remove(); losePopup = null; }
            meineOrteSpeichern();
            const m = meineMarker.find(x => x.ort === o);
            if (m) m.marker.togglePopup();
          }, ansicht)) }, sym("pencil"), "Bearbeiten"),
        el("button", { type: "button", class: "punkt-weg", onclick: loeschFrage }, sym("trash-2"), "Löschen")));
    const loeschFrage = () => box.replaceChildren(el("b", {}, o.name), el("span", {}, "Diesen Ort wirklich löschen?"),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "knopf knopf-klein", onclick: () => { meineOrte = meineOrte.filter(x => x !== o); if (losePopup) { losePopup.remove(); losePopup = null; } meineOrteSpeichern(); } }, "Löschen"),
        el("button", { type: "button", class: "punkt-weg", onclick: ansicht }, "Abbrechen")));
    ansicht();
    return box;
  }

  function meineOrteZeichnen() {
    for (const m of meineMarker) m.marker.remove();
    meineMarker = [];
    if (karte) {
      for (const o of meineOrte) {
        if (!istSichtbar(o)) continue;
        const marker = new maplibregl.Marker({ color: ortFarbe(o) }).setLngLat([o.lon, o.lat])
          .setPopup(new maplibregl.Popup({ offset: 24, maxWidth: "340px" }).setDOMContent(meinPopup(o))).addTo(karte);
        marker.getElement().classList.add("mein-ort");
        marker.getElement().title = o.name;
        meineMarker.push({ ort: o, marker });
      }
    }
    // Liste im Kartenfeld
    const box = $("#meine-orte");
    // Auch leer da und aufklappbar, damit man weiß, dass man Orte merken kann (Nutzer, 15. Nov. 2026)
    box.hidden = false;
    const sortiert = meineOrte.slice().sort((a, b) => a.name.localeCompare(b.name, "de"));
    const kats = alleKategorien();
    let inhalt = [];
    if (listeAuf) {
      if (!kats.length) inhalt = sortiert.map(o => meineZeile(o));
      else {
        // Gruppen nach Kategorie, Orte ohne Kategorie zuletzt
        for (const k of kats.concat(sortiert.some(o => !o.kategorie) ? [""] : [])) {
          const orte = sortiert.filter(o => (o.kategorie || "") === k);
          const aus = kategorienAus.includes(k);
          const offen = gruppenOffen.has(k);
          inhalt.push(el("div", { class: "mein-gruppe" + (aus ? " aus" : "") + (offen ? " offen" : ""), "data-kat": k },
            el("button", { type: "button", class: "mein-gruppe-auf", "aria-expanded": String(offen),
              onclick: () => {
                if (offen) gruppenOffen.delete(k); else gruppenOffen.add(k);
                meineOrteZeichnen();
                if (!offen) gruppeZeigen(k);
              } },
              sym("chevron-right"), el("span", {}, k || "Ohne Kategorie"), el("small", {}, String(orte.length))),
            augeKnopf(aus, aus ? "Kategorie wieder zeigen" : "Ganze Kategorie ausblenden", () => {
              kategorienAus = aus ? kategorienAus.filter(x => x !== k) : kategorienAus.concat([k]);
              meineOrteSpeichern();
            })));
          if (offen) inhalt.push(...orte.map(o => meineZeile(o, aus)));
        }
      }
    }
    box.replaceChildren(
      el("button", { type: "button", class: "meine-orte-kopf" + (listeAuf ? " auf" : ""), "aria-expanded": String(listeAuf),
        onclick: () => { // beim Öffnen alle Kategorien zu
          listeAuf = !listeAuf; gruppenOffen.clear(); meineOrteZeichnen();
          if (listeAuf) imKastenZeigen($(".karte-panel"), box, box);
        } },
        sym("bookmark"), el("span", {}, "Meine Orte"), el("small", {}, String(meineOrte.length)), sym("chevron-down")),
      !listeAuf ? "" : meineOrte.length ? el("div", { class: "ort-treffer meine-liste" }, ...inhalt)
        : el("div", { class: "sperr-kasten" }, el("p", {}, "Noch keine eigenen Orte.", el("br"),
          "Klick in die Karte oder such einen Ort und wähl dann „Ort merken“.")));
  }

  // Aufgeklappte Kategorie in der Leiste ganz zeigen (Kopf bis letzter Ort)
  function gruppeZeigen(k) {
    const kopf = [...document.querySelectorAll("#meine-orte .mein-gruppe")].find(g => g.dataset.kat === k);
    if (!kopf) return;
    let letzter = kopf;
    while (letzter.nextElementSibling && letzter.nextElementSibling.classList.contains("mein-zeile")) letzter = letzter.nextElementSibling;
    imKastenZeigen($(".karte-panel"), kopf, letzter);
  }

  // Durchgestrichenes Auge: blassgrau, solange sichtbar; kräftig, wenn ausgeblendet
  function augeKnopf(aus, titel, klick) {
    return el("button", { type: "button", class: "auge" + (aus ? " an" : ""), title: titel, "aria-label": titel, "aria-pressed": String(aus),
      onclick: (e) => { e.stopPropagation(); klick(); } }, sym("eye-off"));
  }

  // Zeile in der Liste „Meine Orte“: Ort (Klick fliegt hin) und Auge zum Ausblenden
  function meineZeile(o, kategorieAus) {
    return el("div", { class: "mein-zeile" + (o.aus || kategorieAus ? " aus" : "") }, meinTreffer(o),
      augeKnopf(!!o.aus, o.aus ? "Ort wieder zeigen" : "Ort ausblenden", () => {
        if (o.aus) delete o.aus; else o.aus = true;
        meineOrteSpeichern();
      }));
  }

  function meinTreffer(o) {
    return el("button", { type: "button", onclick: () => zuMeinemOrt(o) }, farbSym(sym("bookmark"), o), " ", el("b", {}, o.name),
      o.notiz ? [" ", el("small", {}, o.notiz.length > 60 ? o.notiz.slice(0, 60) + " …" : o.notiz)] : null);
  }

  function farbSym(s, o) {
    if (o.farbe) s.style.color = ortFarbe(o);
    return s;
  }

  function zuMeinemOrt(o) {
    $("#ort-treffer").innerHTML = "";
    karte.flyTo({ center: [o.lon, o.lat], zoom: Math.max(karte.getZoom(), 14), speed: 1.6 });
    const m = meineMarker.find(x => x.ort === o);
    if (m && !m.marker.getPopup().isOpen()) m.marker.togglePopup();
    // Ausgeblendeter Ort: ohne Stecknadel, nur das Fenster an der Stelle zeigen
    if (!m) {
      if (losePopup) losePopup.remove();
      losePopup = new maplibregl.Popup({ maxWidth: "340px" }).setLngLat([o.lon, o.lat]).setDOMContent(meinPopup(o)).addTo(karte);
    }
  }

  // Klick in die Karte (außer beim Routenplanen): Punkt markieren, nächsten Ort nennen.
  // Kurz warten, damit ein Doppelklick (Hineinzoomen) keinen Punkt setzt.
  let klickTimer = null, klickNr = 0;
  function kartenKlick(e) {
    if (Routen.offen) return;
    const ziel = e.originalEvent && e.originalEvent.target;
    if (ziel && ziel.closest && ziel.closest(".maplibregl-marker, .maplibregl-popup")) return;
    // Sperrung einzeichnen oder anklicken (auch ohne Routenplanung, bei aufgeklappter Liste)
    if (Sperrungen.klick(e)) return;
    clearTimeout(klickTimer);
    const { lat, lng: lon } = e.lngLat;
    klickTimer = setTimeout(async () => {
      const nr = ++klickNr;
      const nah = OW.status.orte ? await api("ortnah?lat=" + lat.toFixed(5) + "&lon=" + lon.toFixed(5)).catch(() => null) : null;
      if (nr !== klickNr) return;
      let titel = "Punkt auf der Karte", text = "am markierten Punkt", vorschlag = "";
      if (nah && nah.name) {
        vorschlag = (nah.km < 1 ? "" : "Bei ") + nah.name;
        const km = nah.km.toLocaleString("de-DE", { maximumFractionDigits: nah.km < 10 ? 1 : 0 });
        if (nah.km < 1) { titel = nah.name; text = "bei " + nah.name; }
        else titel = text = km + " km " + nah.richtung + " von " + nah.name;
      }
      // Mit offenem „Sonne und Mond“ zeigt der Kasten den Ort, das Fenster an der Markierung bleibt zu
      markiere(lat, lon, text, popupText(titel, lat, lon, nah && nah.stadt, vorschlag), !Sonne.offen, titel);
    }, 250);
  }

  // ------------------------------------------------ Zusätzliche Ortsnamen
  // In dünn besiedelten Gegenden (z. B. Nordschweden) enthalten die Kartendaten bei mittlerem Zoom kaum Orte.
  // Aus der Ortsliste (GeoNames) kommt deshalb je Feld eines festen Rasters der wichtigste Ort dazu (Stufe =
  // gerundeter Zoom + 1, also Felder von etwa 180 bis 360 Pixeln). Das Raster hängt an der Weltkarte, nicht am Ausschnitt: Beim
  // Verschieben bleibt alles stehen, beim Hineinzoomen kommen nur Orte dazu (Nutzer, 14. Nov. 2026: mit Feldern
  // am Ausschnitt sprangen die Namen beim Schieben, und 110 Pixel waren zu viele). Die Ebene liegt unter den
  // Ortsnamen der Karte: Wo die Karte selbst Namen hat, haben diese Vorrang, und die zusätzlichen fallen wegen
  // Überlappung weg. Ab Zoom 11 hat die Karte alle Orte selbst.
  const ORTSNAMEN_VON = 5, ORTSNAMEN_BIS = 11;
  let ortsnamenTimer = null, ortsnamenAbbruch = null, ortsnamenSchluessel = "", ortsnamenDaten = { type: "FeatureCollection", features: [] };

  function ortsnamenEbene() {
    if (karte.getSource("ortsnamen")) return;
    const f = basemaps.namedFlavor(dunkel() ? "dark" : "light");
    karte.addSource("ortsnamen", { type: "geojson", data: ortsnamenDaten });
    karte.addLayer({
      id: "ortsnamen", type: "symbol", source: "ortsnamen", minzoom: ORTSNAMEN_VON, maxzoom: ORTSNAMEN_BIS,
      layout: {
        "icon-image": "townspot", "icon-size": 0.55,
        "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10.5, 10, 12],
        "text-variable-anchor": ["left", "right", "top", "bottom"], "text-radial-offset": 0.45, "text-justify": "auto",
        "text-padding": 4, "symbol-sort-key": ["-", 0, ["get", "rang"]],
      },
      paint: { "text-color": f.city_label, "text-opacity": 0.8, "icon-opacity": 0.8, "text-halo-color": f.city_label_halo, "text-halo-width": 1 },
    }, karte.getLayer("places_subplace") ? "places_subplace" : undefined);
  }

  async function ladeOrtsnamen() {
    if (!karte || !OW.status || !OW.status.orte) return;
    const z = karte.getZoom();
    if (z < ORTSNAMEN_VON || z >= ORTSNAMEN_BIS) return;
    if (ortsnamenAbbruch) ortsnamenAbbruch.abort();
    const abbruch = ortsnamenAbbruch = new AbortController();
    const b = karte.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => v.toFixed(4)).join(",");
    try {
      const r = await fetch("/api/ortsnamen?bbox=" + bbox + "&stufe=" + (Math.floor(z + 0.5) + 1), { signal: abbruch.signal });
      if (!r.ok) return;
      const liste = await r.json();
      // Unverändert (z. B. nur ein Stück verschoben): nichts neu setzen, sonst ordnet MapLibre die Namen neu an
      const schluessel = liste.map(o => o.name + o.lat).sort().join("|");
      if (schluessel === ortsnamenSchluessel && karte.getSource("ortsnamen")) return;
      ortsnamenSchluessel = schluessel;
      ortsnamenDaten = { type: "FeatureCollection", features: liste.map(o => ({ type: "Feature", properties: { name: o.name, rang: o.rang }, geometry: { type: "Point", coordinates: [o.lon, o.lat] } })) };
      const q = karte.getSource("ortsnamen");
      if (q) q.setData(ortsnamenDaten);
    } catch { /* abgebrochen oder Server weg: Karte bleibt wie sie ist */ }
  }

  // ------------------------------------------------ Einrichtungen in der Nähe

  // Gesucht wird im sichtbaren Ausschnitt, direkt in der Kartendatei (die Einrichtungen stecken nur in den
  // detailliertesten Kacheln). Sind dort weniger als WENIG, geht es in Ringen um die Mitte nach außen. Sehr große
  // Ausschnitte werden auf die Mitte begrenzt. Nach dem Verschieben der Karte wird neu gesucht.
  // WENIG: unter so vielen Treffern im Ausschnitt wird im größeren Umkreis weitergesucht.
  // Obergrenze 20 km: ein Ring liest dann rund 2500 Kacheln, mehr wäre auf schwachen Laptops zu langsam.
  const MAX_KM = 25, RINGE_KM = [2, 5, 10, 20], WENIG = 3, LISTE = 25, MARKER = 150;
  let suchLauf = 0, aktiveKat = null, eigeneBewegung = false, nachsuchen = null;

  function zeigePois(kat, knopf) {
    const warAktiv = knopf.classList.contains("aktiv");
    $$(".chip").forEach(c => c.classList.remove("aktiv"));
    aktiveKat = null;
    suchLauf++;
    markerWeg();
    $("#poi-treffer").innerHTML = "";
    if (warAktiv) return;
    knopf.classList.add("aktiv");
    aktiveKat = kat;
    suchen();
  }

  function markerWeg() { poiMarker.forEach(m => m.remove()); poiMarker = []; }

  // Live: nach dem Verschieben oder Zoomen neu suchen (nicht nach eigenen Kamerafahrten)
  function nachBewegung(e) {
    // Vom Nutzer ausgelöste Bewegung (originalEvent) zählt immer; ein hängender Merker blockiert sie nicht
    if (e && e.originalEvent) eigeneBewegung = false;
    else if (eigeneBewegung) { eigeneBewegung = false; return; }
    if (!aktiveKat) return;
    clearTimeout(nachsuchen);
    nachsuchen = setTimeout(suchen, 350);
  }

  async function suchen() {
    const kat = aktiveKat;
    if (!kat) return;
    const ziel = $("#poi-treffer");
    const lauf = ++suchLauf;
    if (karte.getZoom() < 8) {
      markerWeg();
      ziel.innerHTML = "";
      ziel.append(el("div", { class: "leer" }, "Bitte zuerst einen Ort suchen oder näher heranzoomen."));
      return;
    }
    const mitte = karte.getCenter();
    const b = karte.getBounds();
    let w = b.getWest(), s = b.getSouth(), o = b.getEast(), n = b.getNorth();
    // Sehr großer Ausschnitt: nur die Mitte durchsuchen, sonst wären es zehntausende Kacheln
    let begrenzt = false;
    const halb = MAX_KM / 2, dLat = halb / 111.32, dLon = halb / (111.32 * Math.cos(mitte.lat * Math.PI / 180));
    if (o - w > 2 * dLon || n - s > 2 * dLat) {
      begrenzt = true;
      w = Math.max(w, mitte.lng - dLon); o = Math.min(o, mitte.lng + dLon);
      s = Math.max(s, mitte.lat - dLat); n = Math.min(n, mitte.lat + dLat);
    }
    const kopf = ziel.querySelector(".leer");
    if (kopf) kopf.textContent = "Suche …"; else ziel.append(el("div", { class: "leer" }, "Suche …"));

    let liste = [], radius = 0, imAusschnitt = 0, z = 15;
    const name = (p) => p.name || kat.titel;
    const passend = (pois) => {
      const m = new Map();
      for (const p of pois) {
        if (!kat.arten.includes(p.kind)) continue;
        const key = name(p) + p.lon.toFixed(4) + p.lat.toFixed(4);
        if (!m.has(key)) m.set(key, { name: name(p), lon: p.lon, lat: p.lat, dist: entfernung(mitte.lat, mitte.lng, p.lat, p.lon) });
      }
      return [...m.values()];
    };
    // Zoomstufe der Karte, die die Mitte enthält (die Liste ist nach Größe sortiert, kleinste zuerst);
    // die Kacheln selbst kommen wie beim Zeichnen aus der ersten Datei, die sie hat
    const quelle = kartenListe.find(k => k.id !== "welt" && mitte.lng >= k.bbox[0] && mitte.lng <= k.bbox[2] && mitte.lat >= k.bbox[1] && mitte.lat <= k.bbox[3])
      || kartenListe.find(k => k.id === "welt") || kartenListe[0];
    try {
      z = quelle.maxZoom;
      await speicherGeladen;
      if (lauf !== suchLauf) return;
      const erste =await poisImBereich(z, w, s, o, n, lauf);
      if (!erste) return; // inzwischen neu gesucht
      // Dazu alles, was schon gelesen wurde und im ganzen Ausschnitt liegt: so verschwindet beim
      // Verschieben nichts, was eben noch gefunden war (kostet nichts, die Kacheln sind im Speicher)
      const bw = b.getWest(), bs = b.getSouth(), bo = b.getEast(), bn = b.getNorth();
      liste = passend(erste.concat(bekanntePois(z))).filter(p => p.lon >= bw && p.lon <= bo && p.lat >= bs && p.lat <= bn);
      imAusschnitt = liste.length;
      // Im Ausschnitt (fast) nichts: in Ringen um die Mitte weitersuchen, bis genug da sind.
      // Ringe, die ganz im Ausschnitt liegen, bringen nichts Neues und werden übersprungen.
      if (imAusschnitt < WENIG) {
        const kmLat = 111.32, kmLon = 111.32 * Math.cos(mitte.lat * Math.PI / 180);
        const innen = Math.min(mitte.lng - w, o - mitte.lng) * kmLon, innenNS = Math.min(mitte.lat - s, n - mitte.lat) * kmLat;
        const imBild = new Set(liste.map(p => p.name + p.lon + p.lat));
        for (const r of RINGE_KM) {
          if (r <= Math.min(innen, innenNS) * 0.9) continue;
          if (lauf !== suchLauf) return;
          radius = r;
          const ring = await poisImBereich(z, mitte.lng - r / kmLon, mitte.lat - r / kmLat, mitte.lng + r / kmLon, mitte.lat + r / kmLat, lauf);
          if (!ring) return;
          // Treffer im Ausschnitt behalten, auch wenn sie in einer Ecke knapp außerhalb des Kreises liegen
          const neu = passend(ring).filter(p => p.dist <= r && !imBild.has(p.name + p.lon + p.lat));
          liste = liste.filter(p => imBild.has(p.name + p.lon + p.lat)).concat(neu);
          if (liste.length >= WENIG) break;
        }
        if (liste.length === imAusschnitt) radius = 0; // außen nichts dazu gekommen
      }
    } catch (e) {
      if (lauf === suchLauf) { ziel.innerHTML = ""; ziel.append(el("div", { class: "leer" }, "Suche nicht möglich: " + e.message)); }
      return;
    }
    if (lauf !== suchLauf) return; // inzwischen neu gesucht

    markerWeg();
    ziel.innerHTML = "";
    liste.sort((a, b) => a.dist - b.dist);
    if (!liste.length) {
      // Platz sparend geladene Karten enthalten kleine Einrichtungen (Trinkwasser, Apotheke …) gar nicht
      ziel.append(el("div", { class: "leer" }, quelle.id === "welt"
        ? "Die Weltkarte ist zu grob für Einrichtungen. Bitte eine Länderkarte wählen."
        : z < 15 ? "Nichts gefunden. Diese Karte enthält nur wenige Details (Zoomstufe " + z + ") und deshalb keine kleinen Einrichtungen. Unter „Inhalte“ kannst du sie löschen und neu herunterladen."
        : ["Im Ausschnitt und im Umkreis von " + RINGE_KM[RINGE_KM.length - 1] + " km nichts gefunden.", el("br"), "Karte auf einen anderen Ort schieben."]));
      return;
    }
    const anzahl = liste.length;
    ziel.append(el("div", { class: "leer" }, radius
      ? [(imAusschnitt ? "Im Ausschnitt nur " + imAusschnitt + "." : "Im Ausschnitt nichts."), el("br"), "Deshalb im größeren Umkreis gesucht.", el("br"),
         (anzahl === 1 ? "Das nächste" : "Die " + Math.min(anzahl, LISTE) + " nächsten") + " im Umkreis von " + radius + " km:"]
      : [(anzahl > LISTE ? "Die " + LISTE + " nächsten von " + anzahl : String(anzahl)) + " im Ausschnitt" + (begrenzt ? "." : ""),
         begrenzt && el("br"), begrenzt && "Durchsucht sind die mittleren " + MAX_KM + " km und Gegenden, in denen die Karte schon war."]));
    for (const p of liste.slice(0, MARKER)) {
      const m = new maplibregl.Marker({ color: "#1f6f6b", scale: 0.8 }).setLngLat([p.lon, p.lat]).setPopup(new maplibregl.Popup({ offset: 20 }).setText(p.name)).addTo(karte);
      poiMarker.push(m);
      p.marker = m;
    }
    for (const p of liste.slice(0, LISTE)) {
      ziel.append(el("button", { onclick: () => {
        eigeneBewegung = true;
        karte.flyTo({ center: [p.lon, p.lat], zoom: Math.max(karte.getZoom(), 15) });
        if (!p.marker.getPopup().isOpen()) p.marker.togglePopup();
      } }, el("b", {}, p.name), " ", el("small", {}, (p.dist < 1 ? Math.round(p.dist * 1000) + " m" : p.dist.toFixed(1).replace(".", ",") + " km") + " von der Kartenmitte")));
    }
    // Nur wenn außerhalb gesucht wurde: so weit herauszoomen, dass die nächsten 5 zu sehen sind (nie hineinzoomen)
    if (radius) {
      const rahmen = new maplibregl.LngLatBounds([mitte.lng, mitte.lat], [mitte.lng, mitte.lat]);
      liste.slice(0, 5).forEach(p => rahmen.extend([p.lon, p.lat]));
      const links = innerWidth > 800 ? 380 : 40; // Platz für die Suchleiste links
      eigeneBewegung = true;
      karte.fitBounds(rahmen, { padding: { top: 60, bottom: 60, left: links, right: 60 }, maxZoom: karte.getZoom(), duration: 700 });
    }
  }

  const dateien = {};
  function kartenDatei(id) {
    return dateien[id] || (dateien[id] = new pmtiles.PMTiles(location.origin + "/karten/" + id + ".pmtiles"));
  }

  // Gelesene Kacheln merken, damit das Nachsuchen beim Verschieben nur die neuen Kacheln lesen muss.
  // Gemerkt werden nur Einrichtungen der Schnellsuchen; die meisten Kacheln sind dann leer und kosten kaum Platz.
  // Dauerhaft liegen sie in einer Datei im Zwischenspeicher (/api/einrichtungen), so muss jede Gegend nur
  // einmal gelesen werden, auch über einen Neustart hinweg. SPEICHER_V erhöhen, wenn sich KATEGORIEN ändert.
  const kachelSpeicher = new Map(), LEER = [], SPEICHER_V = 1;
  const MERKEN = new Set(KATEGORIEN.flatMap(k => k.arten));
  let speicherGeladen = Promise.resolve(), zuSenden = [], sendeTimer = null;

  async function ladeEinrichtungen() {
    const stand = kartenStand;
    let text = "";
    try { const r = await fetch("/api/einrichtungen?v=" + SPEICHER_V); if (r.ok) text = await r.text(); } catch (e) { return; }
    if (stand !== kartenStand) return;
    for (const zeile of text.split("\n")) {
      if (!zeile) continue;
      const tab = zeile.indexOf("\t");
      if (tab < 0) { kachelSpeicher.set(stand + "/" + zeile, LEER); continue; }
      try {
        const pois = JSON.parse(zeile.slice(tab + 1)).map(([kind, name, lon, lat]) => ({ kind, name, lon, lat }));
        kachelSpeicher.set(stand + "/" + zeile.slice(0, tab), pois);
      } catch (e) { /* kaputte Zeile (z. B. nach Absturz beim Schreiben): Kachel wird neu gelesen */ }
    }
  }

  function merkeKachel(zxy, pois) {
    zuSenden.push(pois.length ? zxy + "\t" + JSON.stringify(pois.map(p => [p.kind, p.name || "", +p.lon.toFixed(6), +p.lat.toFixed(6)])) : zxy);
    clearTimeout(sendeTimer);
    sendeTimer = setTimeout(sendeKacheln, 1500);
  }

  function sendeKacheln() {
    clearTimeout(sendeTimer);
    if (!zuSenden.length) return;
    const text = zuSenden.join("\n");
    zuSenden = [];
    fetch("/api/einrichtungen?v=" + SPEICHER_V, { method: "POST", body: text }).catch(() => { });
  }
  addEventListener("pagehide", () => { if (zuSenden.length) navigator.sendBeacon("/api/einrichtungen?v=" + SPEICHER_V, zuSenden.join("\n")); zuSenden = []; });

  // Alle Einrichtungen aus schon gelesenen Kacheln dieser Zoomstufe
  function bekanntePois(z) {
    const vorne = kartenStand + "/" + z + "/", pois = [];
    for (const [key, liste] of kachelSpeicher) if (liste.length && key.startsWith(vorne)) for (const p of liste) pois.push(p);
    return pois;
  }

  // Alle Einrichtungen (Ebene "pois") aus den Kacheln, die den Bereich abdecken
  // Gibt null zurück, wenn inzwischen neu gesucht wurde (lauf !== suchLauf)
  async function poisImBereich(z, w, s, o, n, lauf) {
    const anzahl = 2 ** z, rad = Math.PI / 180;
    const kx = (l) => Math.floor((l + 180) / 360 * anzahl);
    const ky = (b) => Math.floor((1 - Math.log(Math.tan(b * rad) + 1 / Math.cos(b * rad)) / Math.PI) / 2 * anzahl);
    // Ländliche Kacheln sind meist leer, im hohen Norden braucht ein 20-km-Ring über 6000 davon.
    // Notbremse für den Arbeitsspeicher; die Datei bleibt, nach dem nächsten Öffnen ist alles wieder da.
    if (kachelSpeicher.size > 400000) kachelSpeicher.clear();
    const pois = [], fehlend = [];
    for (let x = kx(w); x <= kx(o); x++)
      for (let y = ky(n); y <= ky(s); y++) {
        const key = kartenStand + "/" + z + "/" + x + "/" + y;
        if (kachelSpeicher.has(key)) pois.push(...kachelSpeicher.get(key));
        else fehlend.push([x, y, key]);
      }
    // Nicht alle auf einmal anfragen, sonst stauen sich hunderte Anfragen
    for (let i = 0; i < fehlend.length; i += 12) {
      if (lauf !== suchLauf) return null;
      await Promise.all(fehlend.slice(i, i + 12).map(async ([x, y, key]) => {
        const data = await holeKachel(z, x, y);
        let gefunden = data ? kachelPois(new Uint8Array(data), z, x, y).filter(p => MERKEN.has(p.kind)) : LEER;
        if (!gefunden.length) gefunden = LEER;
        if (!key.startsWith(kartenStand + "/")) return; // Karten inzwischen geändert
        kachelSpeicher.set(key, gefunden);
        merkeKachel(z + "/" + x + "/" + y, gefunden);
        pois.push(...gefunden);
      }));
    }
    if (lauf !== suchLauf) return null;
    return pois;
  }

  // Minimaler Leser für Vektorkacheln (Mapbox Vector Tile, Protobuf): nur Punkte der Ebene "pois"
  const dekoder = new TextDecoder();
  function kachelPois(buf, z, tx, ty) {
    let pos = 0;
    const varint = () => { let v = 0, s = 1, b; do { b = buf[pos++]; v += (b & 127) * s; s *= 128; } while (b >= 128); return v; };
    const ueberspringe = (typ) => { if (typ === 0) varint(); else if (typ === 1) pos += 8; else if (typ === 2) pos += varint(); else if (typ === 5) pos += 4; };
    const text = (ende) => dekoder.decode(buf.subarray(pos, ende));
    const gepackt = (ende) => { const a = []; while (pos < ende) a.push(varint()); return a; };
    const ergebnis = [];
    while (pos < buf.length) {
      const kopf = varint(), feld = kopf >> 3, typ = kopf & 7;
      if (feld !== 3 || typ !== 2) { ueberspringe(typ); continue; }
      // Ebene
      const ende = varint() + pos;
      let name = "", extent = 4096;
      const keys = [], werte = [], features = [];
      while (pos < ende) {
        const k = varint(), f = k >> 3, t = k & 7;
        if (f === 1 && t === 2) {
          const e = varint() + pos; name = text(e); pos = e;
          if (name !== "pois") { pos = ende; break; } // andere Ebene: Rest nicht decodieren
        }
        else if (f === 3 && t === 2) { const e = varint() + pos; keys.push(text(e)); pos = e; }
        else if (f === 5 && t === 0) extent = varint();
        else if (f === 2 && t === 2) { const l = varint(); features.push([pos, pos + l]); pos += l; }
        else if (f === 4 && t === 2) {
          const e = varint() + pos;
          let wert = null;
          while (pos < e) {
            const vk = varint(), vf = vk >> 3, vt = vk & 7;
            if (vf === 1 && vt === 2) { const ve = varint() + pos; wert = text(ve); pos = ve; }
            else ueberspringe(vt);
          }
          werte.push(wert);
        }
        else ueberspringe(t);
      }
      if (name !== "pois") { pos = ende; continue; }
      for (const [fa, fe] of features) {
        pos = fa;
        let tags = [], geom = [], art = 0;
        while (pos < fe) {
          const k = varint(), f = k >> 3, t = k & 7;
          if (f === 2 && t === 2) tags = gepackt(varint() + pos);
          else if (f === 4 && t === 2) geom = gepackt(varint() + pos);
          else if (f === 3 && t === 0) art = varint();
          else ueberspringe(t);
        }
        if (art !== 1 || geom.length < 3) continue; // nur Punkte
        const p = {};
        for (let i = 0; i + 1 < tags.length; i += 2) p[keys[tags[i]]] = werte[tags[i + 1]];
        const zz = (v) => (v >>> 1) ^ -(v & 1);
        const px = tx + zz(geom[1]) / extent, py = ty + zz(geom[2]) / extent;
        const n = 2 ** z;
        ergebnis.push({
          kind: p.kind, name: p["name:de"] || p.name,
          lon: px / n * 360 - 180,
          lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * py / n))) * 180 / Math.PI,
        });
      }
      pos = ende;
    }
    return ergebnis;
  }

  function entfernung(lat1, lon1, lat2, lon2) {
    const r = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  // Hell/Dunkel gewechselt: Kartenstil anpassen
  // (ohne Diff, sonst gehen die Routen-Ebenen verloren; style.load zeichnet die Route neu)
  function themaGeaendert() { if (karte) { karte.setStyle(stil(), { diff: false }); meineOrteZeichnen(); } }

  return { zeigen, sucheOrt, themaGeaendert, punkt, punktFuerRoute, get karte() { return karte; } };
})();
