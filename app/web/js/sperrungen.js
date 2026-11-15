// Sperrungen für die Routenplanung: gesperrte Stellen (Punkt) und Abschnitte, die BRouter umfahren soll.
// Anlegen: Klick auf die Strecke (Stelle), entlang der Strecke ziehen (Abschnitt) oder „+“ in der Leiste und selbst
// einzeichnen. Gespeichert in daten/orte/sperrungen.json, Liste immer da, auf der Karte bei offener Routenplanung oder aufgeklappter Liste (Nutzer, 15. Nov. 2026).
"use strict";

const Sperrungen = (() => {
  const PUNKT_M = 40;        // Radius einer gesperrten Stelle
  const BREITE_M = 12;       // halbe Breite eines Abschnitts, der genau dem Weg folgt
  const BREITE_FREI_M = 25;  // halbe Breite, wenn ein Stück nur gerade verbunden ist (kein Weg gefunden)
  const ROT = "#c8553d";
  const FUER = [{ id: "fuss", titel: "Zu Fuß" }, { id: "rad", titel: "Rad" }, { id: "auto", titel: "Auto" }];
  const LAGEN = ["sperr-linie-rand", "sperr-linie", "sperr-zeichen-punkt",
    "sperr-entwurf-linie", "sperr-entwurf-punkt", "sperr-entwurf-knoten"];

  // Sperrung: { id, name, art: "punkt"|"abschnitt", lon, lat | linie: [[lon, lat], …], frei?, aus?, fuer?: [Profil-IDs] }
  let liste = [], geladen = null, routeOffen = false, listeAuf = false;
  let zeichnen = null;  // beim Einzeichnen per „+“: { punkte, teile: [{ c, weg }], kette }
  let entwurf = null;   // rote Vorschau: Koordinaten (ein Punkt = Stelle)
  let popup = null, zug = null;

  // Auf der Karte zu sehen (und anklickbar): bei offener Routenplanung, aufgeklappter Liste oder beim Einzeichnen
  function sichtbar() { return routeOffen || listeAuf || !!zeichnen; }
  const hatRouten = () => !!(OW.status && OW.status.routen);

  const karte = () => Karten.karte;
  const r6 = x => +x.toFixed(6);

  function laden() {
    if (!geladen) geladen = api("sperrungen")
      .then(d => { liste = d && Array.isArray(d.sperrungen) ? d.sperrungen : []; })
      .catch(() => { liste = []; geladen = null; });
    return geladen;
  }

  async function speichern() {
    zeichneAlles();
    const r = await api("sperrungen", { sperrungen: liste }).catch(() => null);
    if (!r || !r.ok) meldung("Die Sperrungen ließen sich nicht speichern.");
  }

  function meldung(text) {
    const h = $("#karte-zoomhinweis");
    h.textContent = text;
    h.hidden = false;
    setTimeout(() => { h.hidden = true; }, 4000);
  }

  // Routenplanung geöffnet bzw. geschlossen
  async function zeigen(an) {
    routeOffen = an;
    if (!an) {
      zeichnenEnde();
      popupWeg();
      zug = null;
      const k = karte();
      if (k) k.getCanvas().style.cursor = "";
    }
    if (an) await laden();
    zeichneAlles();
  }

  function zeichneAlles() { zeichneKarte(); listeZeichnen(); }

  // ------------------------------------------------ Für die Routenberechnung

  // Sperrungen, die für dieses Verkehrsmittel gelten und in der Gegend von Start und Ziel liegen
  function aktive(profilId, a, b) {
    if (!a || !b) return [];
    const w = Math.min(a.lon, b.lon), o = Math.max(a.lon, b.lon), s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
    // Rand: halbe Strecke, mindestens 15 km (Umwege bleiben drin, ferne Sperrungen machen die Adresse nicht lang)
    const randLat = Math.max(15 / 111, (n - s) * 0.5 + (o - w) * 0.25);
    const randLon = randLat / Math.max(0.2, Math.cos((s + n) / 2 * Math.PI / 180));
    const drin = c => c[0] >= w - randLon && c[0] <= o + randLon && c[1] >= s - randLat && c[1] <= n + randLat;
    return liste.filter(x => !x.aus && (!x.fuer || x.fuer.includes(profilId)) &&
      (x.art === "punkt" ? drin([x.lon, x.lat]) : x.linie.some(drin)));
  }

  function anzahl(profilId, a, b) { return aktive(profilId, a, b).length; }

  // Zusatz für die BRouter-Adresse: Stellen als Kreise (nogos), Abschnitte als schmale Flächen um die Linie (polygons).
  // Eine Linie allein (polylines) sperrt bei BRouter nur das Überqueren, nicht das Entlangfahren.
  function param(profilId, a, b) {
    const kreise = [], flaechen = [];
    for (const s of aktive(profilId, a, b)) {
      if (s.art === "punkt") kreise.push(r6(s.lon) + "," + r6(s.lat) + "," + PUNKT_M);
      else flaechen.push(puffer(s.linie, s.frei ? BREITE_FREI_M : BREITE_M).map(p => r6(p[0]) + "," + r6(p[1])).join(","));
    }
    return (kreise.length ? "&nogos=" + kreise.join("|") : "") + (flaechen.length ? "&polygons=" + flaechen.join("|") : "");
  }

  // Ebene Näherung in Metern um einen Bezugspunkt (für die kurzen Strecken hier genau genug)
  function eben(lat0) {
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    return { hin: c => [c[0] * kx, c[1] * ky], zurueck: p => [p[0] / kx, p[1] / ky] };
  }

  // Linie vereinfachen (Douglas-Peucker), Toleranz in Metern
  function vereinfachen(pts, tol) {
    if (pts.length < 3) return pts;
    const behalten = new Array(pts.length).fill(false);
    behalten[0] = behalten[pts.length - 1] = true;
    const stapel = [[0, pts.length - 1]];
    while (stapel.length) {
      const [i, j] = stapel.pop();
      let max = 0, idx = -1;
      const [ax, ay] = pts[i], [bx, by] = pts[j], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let k = i + 1; k < j; k++) {
        const t = l2 ? Math.max(0, Math.min(1, ((pts[k][0] - ax) * dx + (pts[k][1] - ay) * dy) / l2)) : 0;
        const d = Math.hypot(pts[k][0] - ax - t * dx, pts[k][1] - ay - t * dy);
        if (d > max) { max = d; idx = k; }
      }
      if (max > tol) { behalten[idx] = true; stapel.push([i, idx], [idx, j]); }
    }
    return pts.filter((_, k) => behalten[k]);
  }

  // Schmale Fläche (halb Meter zu jeder Seite) um eine Linie, auch an den Enden ein Stück länger
  function puffer(linie, halb) {
    const e = eben(linie[0][1]);
    let p = vereinfachen(linie.map(e.hin), halb / 3);
    p = p.filter((q, i) => i === 0 || Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) > 0.5);
    if (p.length < 2) { // fast nur ein Punkt: kleines Quadrat
      const [x, y] = p[0];
      return [[x - halb, y - halb], [x + halb, y - halb], [x + halb, y + halb], [x - halb, y + halb]].map(e.zurueck);
    }
    const richtung = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); return [dx / l, dy / l]; };
    const links = [], rechts = [];
    for (let i = 0; i < p.length; i++) {
      const r1 = i > 0 ? richtung(p[i - 1], p[i]) : null, r2 = i < p.length - 1 ? richtung(p[i], p[i + 1]) : null;
      let nx, ny, f = halb, [x, y] = p[i];
      if (!r1) { nx = -r2[1]; ny = r2[0]; x -= r2[0] * halb; y -= r2[1] * halb; }
      else if (!r2) { nx = -r1[1]; ny = r1[0]; x += r1[0] * halb; y += r1[1] * halb; }
      else {
        // Gehrung: Mittel der beiden Normalen, in spitzen Kurven begrenzt
        nx = -(r1[1] + r2[1]); ny = r1[0] + r2[0];
        const l = Math.hypot(nx, ny);
        if (l < 1e-6) { nx = -r1[1]; ny = r1[0]; }
        else {
          nx /= l; ny /= l;
          f = Math.min(halb * 2, halb / Math.max(0.2, nx * -r1[1] + ny * r1[0]));
        }
      }
      links.push([x + nx * f, y + ny * f]);
      rechts.push([x - nx * f, y - ny * f]);
    }
    return links.concat(rechts.reverse()).map(e.zurueck);
  }

  function meter(linie) {
    let m = 0;
    for (let i = 1; i < linie.length; i++) {
      const [a, b] = [linie[i - 1], linie[i]];
      const dx = (b[0] - a[0]) * 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180), dy = (b[1] - a[1]) * 110540;
      m += Math.hypot(dx, dy);
    }
    return m;
  }

  // Punkt auf halber Länge der Linie
  function mitteVon(linie) {
    let rest = meter(linie) / 2;
    for (let i = 1; i < linie.length; i++) {
      const d = meter([linie[i - 1], linie[i]]);
      if (d >= rest && d > 0) {
        const t = rest / d;
        return [linie[i - 1][0] + t * (linie[i][0] - linie[i - 1][0]), linie[i - 1][1] + t * (linie[i][1] - linie[i - 1][1])];
      }
      rest -= d;
    }
    return linie[Math.floor(linie.length / 2)];
  }

  function kmText(m) { return m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km"; }

  // ------------------------------------------------ Karte

  // Zeichen „Einfahrt verboten“: roter Kreis mit weißem Balken
  function zeichenBild() {
    const n = 44, c = document.createElement("canvas");
    c.width = c.height = n;
    const g = c.getContext("2d");
    g.beginPath(); g.arc(n / 2, n / 2, n / 2 - 3, 0, Math.PI * 2);
    g.fillStyle = ROT; g.fill();
    g.lineWidth = 3.5; g.strokeStyle = "#ffffff"; g.stroke();
    g.fillStyle = "#ffffff";
    g.fillRect(n * 0.26, n * 0.43, n * 0.48, n * 0.14);
    return { width: n, height: n, data: new Uint8Array(g.getImageData(0, 0, n, n).data.buffer) };
  }

  function sammlung(features) { return { type: "FeatureCollection", features }; }

  function zeichneKarte() {
    const k = karte();
    if (!k) return;
    const feste = [], vorschau = [];
    if (sichtbar()) {
      for (const s of liste) {
        const p = { id: s.id, aus: s.aus ? 1 : 0 };
        // Abschnitt: Linie plus ein Zeichen in der Mitte („line-center“ setzte es je Kachel einmal, also mehrfach)
        if (s.art === "abschnitt") feste.push({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: s.linie } });
        feste.push({ type: "Feature", properties: p, geometry: { type: "Point", coordinates: s.art === "punkt" ? [s.lon, s.lat] : mitteVon(s.linie) } });
      }
      if (entwurf && entwurf.length) vorschau.push({ type: "Feature", properties: {}, geometry: entwurf.length === 1
        ? { type: "Point", coordinates: entwurf[0] } : { type: "LineString", coordinates: entwurf } });
      if (zeichnen) for (const q of zeichnen.punkte) vorschau.push({ type: "Feature", properties: { knoten: 1 }, geometry: { type: "Point", coordinates: q } });
    }
    try {
      if (!k.hasImage("sperr-zeichen")) k.addImage("sperr-zeichen", zeichenBild(), { pixelRatio: 2 });
      if (k.getSource("sperrungen")) {
        k.getSource("sperrungen").setData(sammlung(feste));
        k.getSource("sperr-entwurf").setData(sammlung(vorschau));
        return;
      }
      if (!sichtbar()) return;
      k.addSource("sperrungen", { type: "geojson", data: sammlung(feste) });
      k.addSource("sperr-entwurf", { type: "geojson", data: sammlung(vorschau) });
      const rund = { "line-cap": "round", "line-join": "round" };
      const blass = (an, aus) => ["case", ["==", ["get", "aus"], 1], aus, an];
      const linien = ["==", ["geometry-type"], "LineString"], punkte = ["==", ["geometry-type"], "Point"];
      // Wie Absperrband: weißer Rand, rot gestrichelt
      k.addLayer({ id: "sperr-linie-rand", type: "line", source: "sperrungen", filter: linien, layout: rund,
        paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": blass(0.9, 0.3) } });
      k.addLayer({ id: "sperr-linie", type: "line", source: "sperrungen", filter: linien, layout: { "line-join": "round" },
        paint: { "line-color": ROT, "line-width": 5, "line-dasharray": [1.6, 1], "line-opacity": blass(1, 0.35) } });
      k.addLayer({ id: "sperr-zeichen-punkt", type: "symbol", source: "sperrungen", filter: punkte,
        layout: { "icon-image": "sperr-zeichen", "icon-allow-overlap": true, "icon-ignore-placement": true },
        paint: { "icon-opacity": blass(1, 0.4) } });
      // Vorschau beim Ziehen, Klicken und Einzeichnen
      k.addLayer({ id: "sperr-entwurf-linie", type: "line", source: "sperr-entwurf", filter: linien, layout: rund,
        paint: { "line-color": ROT, "line-width": 6, "line-opacity": 0.85 } });
      k.addLayer({ id: "sperr-entwurf-punkt", type: "circle", source: "sperr-entwurf", filter: ["all", punkte, ["!", ["has", "knoten"]]],
        paint: { "circle-radius": 10, "circle-color": ROT, "circle-opacity": 0.6, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
      k.addLayer({ id: "sperr-entwurf-knoten", type: "circle", source: "sperr-entwurf", filter: ["has", "knoten"],
        paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": ROT, "circle-stroke-width": 2.5 } });
    } catch (e) { /* Stil lädt gerade neu: style.load zeichnet gleich nach */ }
  }

  // Unterste Ebene der Sperrungen (Route und Ausweichstrecken kommen darunter)
  function ersteLage() {
    const k = karte();
    return k && k.getLayer(LAGEN[0]) ? LAGEN[0] : undefined;
  }

  function kasten(p, r) { return [[p.x - r, p.y - r], [p.x + r, p.y + r]]; }

  function sperrungUnter(punkt) {
    const k = karte();
    if (!k || !k.getLayer("sperr-zeichen-punkt")) return null;
    const f = k.queryRenderedFeatures(kasten(punkt, 5), { layers: ["sperr-zeichen-punkt", "sperr-linie-rand"] });
    return f.length ? liste.find(s => s.id === f[0].properties.id) || null : null;
  }

  function aufStrecke(punkt) {
    const k = karte();
    if (!k || !Routen.strecke || !k.getLayer("route-rand")) return false;
    return k.queryRenderedFeatures(kasten(punkt, 4), { layers: ["route-rand"] }).length > 0;
  }

  // Nächste Stelle der Strecke zum Mauspunkt (in Bildschirm-Pixeln): Index des Abschnitts und Punkt darauf
  function naechste(c, punkt) {
    const k = karte();
    let best = { d: Infinity, i: 0, ll: c[0] };
    let a = k.project([c[0][0], c[0][1]]);
    for (let i = 1; i < c.length; i++) {
      const b = k.project([c[i][0], c[i][1]]);
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((punkt.x - a.x) * dx + (punkt.y - a.y) * dy) / l2)) : 0;
      const d = Math.hypot(punkt.x - a.x - t * dx, punkt.y - a.y - t * dy);
      if (d < best.d) best = { d, i: i - 1, t, ll: [c[i - 1][0] + t * (c[i][0] - c[i - 1][0]), c[i - 1][1] + t * (c[i][1] - c[i - 1][1])] };
      a = b;
    }
    return best;
  }

  // Stück der Strecke zwischen zwei Stellen (Ergebnisse von naechste), Anfang und Ende genau an den Stellen
  function stueck(c, von, bis) {
    if (von.i > bis.i || (von.i === bis.i && von.t > bis.t)) [von, bis] = [bis, von];
    const teil = [von.ll];
    for (let i = von.i + 1; i <= bis.i; i++) teil.push([c[i][0], c[i][1]]);
    teil.push(bis.ll);
    return teil.map(q => [r6(q[0]), r6(q[1])]);
  }

  function popupWeg() {
    if (popup) { const p = popup; popup = null; p.remove(); }
  }

  function zeigePopup(lngLat, inhalt, beimSchliessen) {
    popupWeg();
    const p = popup = new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(lngLat).setDOMContent(inhalt).addTo(karte());
    p.on("close", () => { if (popup === p) popup = null; if (beimSchliessen) beimSchliessen(); });
  }

  function entwurfWeg() { entwurf = null; zeichneKarte(); }

  // Fragt vor dem Sperren nach (so sperrt man nichts aus Versehen, wenn man nur die Karte verschieben wollte)
  function frage(lngLat, titel, text, knopf, sperren) {
    zeigePopup(lngLat, el("div", { class: "punkt-popup" }, el("b", {}, titel), el("small", {}, ...zeilen(text)),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "knopf knopf-klein knopf-haupt", onclick: sperren }, sym("ban"), knopf),
        el("button", { type: "button", class: "punkt-weg", onclick: () => { popupWeg(); entwurfWeg(); } }, "Abbrechen"))),
      () => { if (!zeichnen) entwurfWeg(); });
  }

  function stelleFragen(ll) {
    entwurf = [[r6(ll[0]), r6(ll[1])]];
    zeichneKarte();
    frage(ll, "Diese Stelle sperren?", "Die Route führt dann außen herum.", "Stelle sperren",
      () => anlegen({ art: "punkt", lon: entwurf[0][0], lat: entwurf[0][1] }));
  }

  function abschnittFragen(linie, frei) {
    entwurf = linie;
    zeichneKarte();
    frage(mitteVon(linie), "Diesen Abschnitt sperren?", kmText(meter(linie)) + " lang.\nDie Route führt dann außen herum.",
      "Abschnitt sperren", () => anlegen({ art: "abschnitt", linie, frei: frei || undefined }));
  }

  // Neue Sperrung speichern, Namen nach dem nächsten Ort, dann die Route neu berechnen
  async function anlegen(s) {
    popupWeg();
    s.id = Date.now().toString(36);
    const mitte = s.art === "punkt" ? [s.lon, s.lat] : mitteVon(s.linie);
    s.name = await nameFuer(mitte);
    if (!s.frei) delete s.frei;
    liste.push(s);
    entwurf = null;
    listeAuf = true;
    await speichern();
    Routen.neuBerechnen();
  }

  async function nameFuer(c) {
    const nah = OW.status && OW.status.orte ? await api("ortnah?lat=" + c[1].toFixed(5) + "&lon=" + c[0].toFixed(5)).catch(() => null) : null;
    const name = nah && nah.name ? "Bei " + nah.name : "Sperrung";
    // Gleiche Namen durchzählen
    if (!liste.some(s => s.name === name)) return name;
    let n = 2;
    while (liste.some(s => s.name === name + " " + n)) n++;
    return name + " " + n;
  }

  // ------------------------------------------------ Klicken und Ziehen

  // Von routen.js für jeden Klick in die Karte gerufen; true = erledigt
  function klick(e) {
    if (!sichtbar()) return false;
    if (zeichnen) { punktDazu(e.lngLat); return true; }
    const s = sperrungUnter(e.point);
    if (s) { sperrPopup(s, s.art === "punkt" ? [s.lon, s.lat] : [e.lngLat.lng, e.lngLat.lat]); return true; }
    const c = Routen.strecke;
    if (c && aufStrecke(e.point)) { stelleFragen(naechste(c, e.point).ll); return true; }
    return false;
  }

  function verbinden(k) {
    k.on("style.load", () => zeichneKarte());
    laden().then(zeichneAlles);
    // Auf der Strecke drücken und ziehen: Abschnitt markieren (die Karte verschiebt sich dabei nicht)
    k.on("mousedown", e => {
      if (!routeOffen || zeichnen || e.originalEvent.button !== 0) return;
      const c = Routen.strecke;
      if (!c || !aufStrecke(e.point) || sperrungUnter(e.point)) return;
      e.preventDefault();
      zug = { c, von: naechste(c, e.point), x: e.point.x, y: e.point.y, bewegt: false };
    });
    k.on("mousemove", e => {
      if (!sichtbar()) return;
      if (zug) {
        if (!zug.bewegt && Math.hypot(e.point.x - zug.x, e.point.y - zug.y) < 6) return;
        if (!zug.bewegt) popupWeg();
        zug.bewegt = true;
        entwurf = stueck(zug.c, zug.von, naechste(zug.c, e.point));
        zeichneKarte();
      }
      k.getCanvas().style.cursor = zeichnen ? "crosshair" : zug && zug.bewegt ? "grabbing"
        : (aufStrecke(e.point) || sperrungUnter(e.point) || Routen.altHover) ? "pointer" : "";
    });
    document.addEventListener("mouseup", () => {
      if (!zug) return;
      const z = zug;
      zug = null;
      if (z.bewegt && entwurf && entwurf.length > 1 && meter(entwurf) > 5) abschnittFragen(entwurf);
      else if (z.bewegt) entwurfWeg();
      // Ohne Bewegung folgt der normale Klick (klick oben)
    });
    document.addEventListener("keydown", e => {
      if (!zeichnen || e.target.closest("input, textarea")) return;
      if (e.key === "Escape") zeichnenEnde();
      else if (e.key === "Enter") zeichnenFertig();
      else if (e.key === "Backspace") { e.preventDefault(); rueckgaengig(); }
    });
  }

  // ------------------------------------------------ Selbst einzeichnen („+“)

  function zeichnenStarten() {
    popupWeg();
    zeichnen = { punkte: [], teile: [], kette: Promise.resolve() };
    entwurf = null;
    listeAuf = true;
    const k = karte();
    k.doubleClickZoom.disable();
    k.getCanvas().style.cursor = "crosshair";
    zeichneAlles();
  }

  function zeichnenEnde() {
    if (!zeichnen) return;
    zeichnen = null;
    entwurf = null;
    const k = karte();
    if (k) { k.doubleClickZoom.enable(); k.getCanvas().style.cursor = ""; }
    zeichneAlles();
  }

  // Bisher eingezeichnete Linie (Stücke aneinander)
  function zeichnungLinie() {
    const linie = [];
    for (const t of zeichnen.teile) for (const q of t.c) {
      const l = linie[linie.length - 1];
      if (!l || l[0] !== q[0] || l[1] !== q[1]) linie.push(q);
    }
    return linie;
  }

  function entwurfAusZeichnung() {
    entwurf = zeichnen.punkte.length === 1 ? [zeichnen.punkte[0]] : zeichnungLinie();
    zeichneAlles();
  }

  function punktDazu(ll) {
    const z = zeichnen, p = [r6(ll.lng), r6(ll.lat)];
    z.punkte.push(p);
    if (z.punkte.length > 1) {
      const a = z.punkte[z.punkte.length - 2], teil = { c: [a, p], weg: false, sucht: true };
      z.teile.push(teil);
      // Nacheinander: BRouter rechnet nur eine Route zugleich
      z.kette = z.kette.then(() => wegZwischen(a, p)).then(weg => {
        teil.sucht = false;
        if (weg) { teil.c = weg; teil.weg = true; }
        if (zeichnen === z && z.teile.includes(teil)) entwurfAusZeichnung();
      });
    }
    entwurfAusZeichnung();
  }

  function rueckgaengig() {
    if (!zeichnen || !zeichnen.punkte.length) return;
    zeichnen.punkte.pop();
    zeichnen.teile.pop();
    entwurfAusZeichnung();
  }

  // Die Linie folgt dem Weg: BRouter-Strecke zwischen den beiden Klicks (sonst gerade Linie)
  async function wegZwischen(a, b) {
    const luft = meter([a, b]);
    if (luft > 20000) return null;
    try {
      const r = await fetch("/route/brouter?lonlats=" + a[0] + "," + a[1] + "|" + b[0] + "," + b[1] +
        "&profile=" + Routen.profilBrouter + "&alternativeidx=0&format=geojson");
      const text = await r.text();
      if (!r.ok || text.trim()[0] !== "{") return null;
      const c = JSON.parse(text).features[0].geometry.coordinates.map(q => [r6(q[0]), r6(q[1])]);
      // Großer Umweg: wohl nicht der gemeinte Weg, dann lieber gerade
      if (meter(c) > luft * 3 + 200) return null;
      return [a].concat(c, [b]);
    } catch (e) { return null; }
  }

  async function zeichnenFertig() {
    const z = zeichnen;
    if (!z || !z.punkte.length) return;
    await z.kette;
    if (zeichnen !== z) return;
    const s = z.punkte.length === 1 ? { art: "punkt", lon: z.punkte[0][0], lat: z.punkte[0][1] }
      : { art: "abschnitt", linie: zeichnungLinie(), frei: z.teile.some(t => !t.weg) };
    zeichnenEnde();
    anlegen(s);
  }

  // ------------------------------------------------ Fenster an einer Sperrung

  function beschreibung(s) {
    const teile = [s.art === "punkt" ? "Gesperrte Stelle" : "Gesperrter Abschnitt, " + kmText(meter(s.linie))];
    if (s.fuer) teile.push("gilt nur für " + FUER.filter(f => s.fuer.includes(f.id)).map(f => f.titel).join(" und "));
    return teile.join(", ");
  }

  function sperrPopup(s, ll) {
    const box = el("div", { class: "punkt-popup" });
    const ansicht = () => box.replaceChildren(el("b", {}, s.name), el("small", {}, beschreibung(s)),
      s.aus ? el("small", {}, "Ausgeschaltet, gilt gerade nicht.") : "",
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "punkt-weg", onclick: () => { umschalten(s); popupWeg(); } },
          sym("eye-off"), s.aus ? "Einschalten" : "Ausschalten"),
        el("button", { type: "button", class: "punkt-weg", onclick: () => box.replaceChildren(formular(s, ansicht)) }, sym("pencil"), "Bearbeiten"),
        el("button", { type: "button", class: "punkt-weg", onclick: loeschFrage }, sym("trash-2"), "Löschen")));
    const loeschFrage = () => box.replaceChildren(el("b", {}, s.name), el("span", {}, "Diese Sperrung wirklich löschen?"),
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "knopf knopf-klein", onclick: () => {
          liste = liste.filter(x => x !== s); popupWeg(); speichern(); Routen.neuBerechnen(); } }, "Löschen"),
        el("button", { type: "button", class: "punkt-weg", onclick: ansicht }, "Abbrechen")));
    ansicht();
    zeigePopup(ll, box);
  }

  function formular(s, abbrechen) {
    const name = el("input", { type: "text", value: s.name, placeholder: "Name, z. B. Brücke gesperrt", maxlength: "80" });
    const haken = FUER.map(f => {
      const h = el("input", { type: "checkbox", value: f.id });
      h.checked = !s.fuer || s.fuer.includes(f.id);
      return { f, h };
    });
    const hinweis = el("small", { class: "sperr-fehler" });
    const los = (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      const fuer = haken.filter(x => x.h.checked).map(x => x.f.id);
      if (!fuer.length) { hinweis.textContent = "Bitte mindestens ein Verkehrsmittel wählen."; return; }
      s.name = n;
      if (fuer.length === FUER.length) delete s.fuer; else s.fuer = fuer;
      popupWeg();
      speichern();
      Routen.neuBerechnen();
    };
    setTimeout(() => { name.focus(); name.select(); }, 0);
    return el("form", { class: "ort-formular", onsubmit: los }, name,
      el("small", {}, "Gilt für"),
      el("div", { class: "sperr-fuer" }, ...haken.map(x => el("label", {}, x.h, x.f.titel))), hinweis,
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "submit", class: "knopf knopf-klein knopf-haupt" }, "Speichern"),
        el("button", { type: "button", class: "punkt-weg", onclick: abbrechen }, "Abbrechen")));
  }

  function umschalten(s) {
    if (s.aus) delete s.aus; else s.aus = true;
    speichern();
    Routen.neuBerechnen();
  }

  function zuSperrung(s) {
    const k = karte();
    const c = s.art === "punkt" ? [[s.lon, s.lat]] : s.linie;
    const b = new maplibregl.LngLatBounds();
    for (const q of c) b.extend(q);
    const links = innerWidth > 800 ? 380 : 40;
    if (s.art === "punkt") k.flyTo({ center: [s.lon, s.lat], zoom: Math.max(k.getZoom(), 15), speed: 1.6 });
    else k.fitBounds(b, { padding: { top: 80, bottom: 80, left: links, right: 80 }, maxZoom: 16 });
    sperrPopup(s, s.art === "punkt" ? [s.lon, s.lat] : mitteVon(s.linie));
  }

  // ------------------------------------------------ Liste in der Leiste

  function listeZeichnen() {
    const box = $("#sperrungen");
    if (!box) return;
    // Immer da (auch leer), damit man weiß, dass es Sperrungen gibt (Nutzer, 15. Nov. 2026); ohne Routendaten nicht
    box.hidden = !hatRouten();
    if (box.hidden) { box.innerHTML = ""; return; }
    const kopf = el("div", { class: "sperr-kopf" },
      el("button", { type: "button", class: "meine-orte-kopf" + (listeAuf ? " auf" : ""), "aria-expanded": String(listeAuf),
        onclick: () => {
          listeAuf = !listeAuf;
          if (!sichtbar()) popupWeg();
          zeichneAlles();
          if (listeAuf) imKastenZeigen($(".karte-panel"), box, box);
        } },
        sym("ban"), el("span", {}, "Sperrungen"), el("small", {}, String(liste.length)), sym("chevron-down")),
      el("button", { type: "button", class: "sperr-plus" + (zeichnen ? " an" : ""), title: "Sperrung einzeichnen", "aria-label": "Sperrung einzeichnen",
        onclick: () => zeichnen ? zeichnenEnde() : zeichnenStarten() }, sym("plus")));
    let inhalt = "";
    if (zeichnen) inhalt = zeichnenKasten();
    else if (listeAuf) inhalt = liste.length
      ? el("div", { class: "ort-treffer meine-liste" }, ...liste.slice().sort((a, b) => a.name.localeCompare(b.name, "de")).map(zeile))
      : el("div", { class: "sperr-kasten" }, el("p", {}, "Noch keine Sperrungen.", el("br"),
        "Bei „Route planen“ sperrt ein Klick auf die Strecke eine Stelle.", el("br"),
        "Entlang der Strecke ziehen sperrt einen Abschnitt.", el("br"),
        "Mit dem Plus zeichnest du eine Sperrung selbst ein."));
    box.replaceChildren(kopf, inhalt);
  }

  function zeichnenKasten() {
    const n = zeichnen.punkte.length;
    const sucht = zeichnen.teile.some(t => t.sucht);
    const text = !n ? ["Klick in die Karte auf die gesperrte Stelle.", "Für einen Abschnitt klickst du nacheinander Anfang und Ende an, die Linie folgt dem Weg."]
      : n === 1 ? ["Für eine Stelle jetzt auf „Fertig“.", "Für einen Abschnitt noch das Ende anklicken."]
      : ["Weitere Klicks verlängern den Abschnitt.", "Nimmt die Linie den falschen Weg, setz einen Punkt dazwischen."];
    return el("div", { class: "sperr-kasten" },
      el("p", {}, ...text.flatMap((t, i) => i ? [el("br"), t] : [t])),
      n > 1 ? el("small", {}, sucht ? "Weg wird gesucht …" : "Abschnitt " + kmText(meter(zeichnungLinie()))) : "",
      el("div", { class: "punkt-knoepfe" },
        el("button", { type: "button", class: "knopf knopf-klein knopf-haupt", disabled: !n || null, onclick: zeichnenFertig },
          n > 1 ? "Abschnitt sperren" : "Fertig"),
        n ? el("button", { type: "button", class: "punkt-weg", onclick: rueckgaengig }, "Letzten Punkt weg") : "",
        el("button", { type: "button", class: "punkt-weg", onclick: zeichnenEnde }, "Abbrechen")));
  }

  function zeile(s) {
    const titel = s.aus ? "Sperrung wieder einschalten" : "Sperrung ausschalten";
    return el("div", { class: "mein-zeile" + (s.aus ? " aus" : "") },
      el("button", { type: "button", onclick: () => zuSperrung(s) }, sym("ban"), " ", el("b", {}, s.name), " ",
        el("small", {}, s.art === "punkt" ? "Stelle" : "Abschnitt, " + kmText(meter(s.linie)))),
      el("button", { type: "button", class: "auge" + (s.aus ? " an" : ""), title: titel, "aria-label": titel, "aria-pressed": String(!!s.aus),
        onclick: (e) => { e.stopPropagation(); umschalten(s); } }, sym("eye-off")));
  }

  return { zeigen, klick, verbinden, param, anzahl, ersteLage };
})();
