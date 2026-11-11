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

  async function zeigen() {
    const s = OW.status || await aktualisiereStatus();
    const leer = $("#karte-leer");
    if (!s.karten.length || !s.kartenAssets) {
      $("#karte-wrap").hidden = true;
      leer.hidden = false;
      leer.innerHTML = "";
      leer.append(el("h1", {}, "Karten"), el("div", { class: "karte-box" }, "Es sind noch keine Karten installiert.", el("br"), el("a", { href: "#inhalte?zu=karten" }, "Karten herunterladen")));
      return;
    }
    leer.hidden = true;
    try { await ladeBibliotheken(); }
    catch (e) {
      $("#karte-wrap").hidden = true;
      leer.hidden = false;
      leer.innerHTML = "";
      leer.append(el("h1", {}, "Karten"), fehlerBox("Die Karte konnte nicht geladen werden. Bitte noch einmal versuchen.", zeigen, "Erneut versuchen", e && e.message));
      return;
    }
    $("#karte-wrap").hidden = false;
    const stand = s.karten.map(k => k.id).join(","), geaendert = stand !== kartenStand;
    if (geaendert) { await ladeKartenliste(s); kartenStand = stand; }
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
      layers: basemaps.layers("protomaps", basemaps.namedFlavor(flavor), { lang: "de" }),
    };
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
    fuelleSprungliste();

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
    if (!OW.status.orte) { ziel.innerHTML = '<div class="leer">Ortsliste nicht installiert.</div>'; return; }
    const liste = await api("orte?q=" + encodeURIComponent(q)).catch(() => null);
    if (nr !== ortLauf) return; // inzwischen neu gesucht
    ziel.innerHTML = "";
    if (!liste) { ziel.append(el("div", { class: "leer" }, "Die Ortssuche ist gerade nicht erreichbar.")); return; }
    if (!liste.length) { ziel.append(el("div", { class: "leer" }, "Nichts gefunden.")); return; }
    for (const o of liste.slice(0, 12)) {
      ziel.append(el("button", { onclick: () => geheZu(o) },
        el("b", {}, o.name), " ", el("small", {}, o.art + " · " + o.land + (o.name !== o.original ? " · " + o.original : "") + (o.einwohner > 0 ? " · " + o.einwohner.toLocaleString("de-DE") + " Einw." : ""))));
    }
  }

  function geheZu(o) {
    $("#ort-treffer").innerHTML = "";
    const zoom = o.art === "Hauptstadt" || o.art === "Stadt" ? 11 : o.art === "Ort" ? 13 : 14;
    karte.flyTo({ center: [o.lon, o.lat], zoom, speed: 1.6 });
    if (markierung) markierung.remove();
    markierung = new maplibregl.Marker({ color: "#b3261e" }).setLngLat([o.lon, o.lat])
      .setPopup(new maplibregl.Popup({ offset: 24 }).setText(o.name + " (" + o.art + ")")).addTo(karte);
  }

  // ------------------------------------------------ Einrichtungen in der Nähe

  // Gesucht wird im sichtbaren Ausschnitt, direkt in der Kartendatei (die Einrichtungen stecken nur in den
  // detailliertesten Kacheln). Ist dort nichts, geht es in Ringen um die Mitte nach außen. Sehr große
  // Ausschnitte werden auf die Mitte begrenzt. Nach dem Verschieben der Karte wird neu gesucht.
  const MAX_KM = 25, RINGE_KM = [2, 5, 10], LISTE = 25, MARKER = 150;
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

    let liste = [], radius = 0, z = 15;
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
      const erste = await poisImBereich(z, w, s, o, n, lauf);
      if (!erste) return; // inzwischen neu gesucht
      liste = passend(erste).filter(p => p.lon >= w && p.lon <= o && p.lat >= s && p.lat <= n);
      // Im Ausschnitt nichts: in Ringen um die Mitte weitersuchen
      if (!liste.length) {
        for (radius of RINGE_KM) {
          if (lauf !== suchLauf) return;
          const rLat = radius / 111.32, rLon = radius / (111.32 * Math.cos(mitte.lat * Math.PI / 180));
          const ring = await poisImBereich(z, mitte.lng - rLon, mitte.lat - rLat, mitte.lng + rLon, mitte.lat + rLat, lauf);
          if (!ring) return;
          liste = passend(ring).filter(p => p.dist <= radius);
          if (liste.length) break;
        }
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
        : "Im Ausschnitt und im Umkreis von " + RINGE_KM[RINGE_KM.length - 1] + " km nichts gefunden. Karte auf einen anderen Ort schieben."));
      return;
    }
    const anzahl = liste.length;
    ziel.append(el("div", { class: "leer" }, radius
      ? "Im Ausschnitt nichts. " + (anzahl === 1 ? "Das nächste" : "Die nächsten") + " im Umkreis von " + radius + " km:"
      : (anzahl > LISTE ? "Die " + LISTE + " nächsten von " + anzahl : String(anzahl)) + " im Ausschnitt" +
        (begrenzt ? " (nur die mittleren " + MAX_KM + " km, für mehr näher heranzoomen)" : "")));
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

  // Gelesene Kacheln merken, damit das Nachsuchen beim Verschieben nur die neuen Kacheln lesen muss
  const kachelSpeicher = new Map();

  // Alle Einrichtungen (Ebene "pois") aus den Kacheln, die den Bereich abdecken
  // Gibt null zurück, wenn inzwischen neu gesucht wurde (lauf !== suchLauf)
  async function poisImBereich(z, w, s, o, n, lauf) {
    const anzahl = 2 ** z, rad = Math.PI / 180;
    const kx = (l) => Math.floor((l + 180) / 360 * anzahl);
    const ky = (b) => Math.floor((1 - Math.log(Math.tan(b * rad) + 1 / Math.cos(b * rad)) / Math.PI) / 2 * anzahl);
    if (kachelSpeicher.size > 4000) kachelSpeicher.clear();
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
        const gefunden = data ? kachelPois(new Uint8Array(data), z, x, y) : [];
        kachelSpeicher.set(key, gefunden);
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
  function themaGeaendert() { if (karte) karte.setStyle(stil(), { diff: false }); }

  return { zeigen, sucheOrt, themaGeaendert, get karte() { return karte; } };
})();
