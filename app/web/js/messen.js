// Entfernung messen auf der Karte: Luftlinie über beliebig viele Punkte (z. B. „Wie weit ist der nächste Trinkwasser-Punkt?“).
// Start über „Entfernung messen“ im Fenster eines markierten Punkts, danach setzt jeder Klick in die Karte einen weiteren Punkt.
// Rechtsklick nimmt den letzten Punkt zurück. Nichts wird gespeichert.
"use strict";

const Messen = (() => {
  let punkte = [];          // [{ lat, lon }]
  let aktiv = false, verbunden = false;
  const panel = $("#mess-panel");
  const karte = () => Karten.karte;

  // Abstand zweier Punkte in Metern (Kugel mit Erdradius 6371 km, genau genug für Luftlinien)
  function abstand(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function gesamt() {
    let m = 0;
    for (let i = 1; i < punkte.length; i++) m += abstand(punkte[i - 1], punkte[i]);
    return m;
  }
  // 850 m · 2,4 km · 135 km
  function laenge(m) {
    if (m < 1000) return (Math.round(m / 10) * 10).toLocaleString("de-DE") + " m";
    return (m / 1000).toLocaleString("de-DE", { maximumFractionDigits: m < 100000 ? 1 : 0 }) + " km";
  }

  function starten(p) {
    const k = karte();
    if (!k) return;
    punkte = [{ lat: p.lat, lon: p.lon }];
    aktiv = true;
    Karten.markierungWeg();
    if (!verbunden) {
      // Nach einem Stilwechsel (hell/dunkel) sind eigene Ebenen weg: neu anlegen
      k.on("styledata", () => { if (aktiv && !k.getSource("messen")) zeichneKarte(); });
      verbunden = true;
    }
    k.getCanvas().style.cursor = "crosshair";
    zeichnen();
  }

  function beenden() {
    if (!aktiv) return;
    aktiv = false;
    punkte = [];
    panel.hidden = true;
    const k = karte();
    if (k) {
      k.getCanvas().style.cursor = "";
      for (const id of ["messen-punkte", "messen-linie", "messen-rand"]) if (k.getLayer(id)) k.removeLayer(id);
      if (k.getSource("messen")) k.removeSource("messen");
    }
  }

  function zurueck() {
    if (punkte.length > 1) { punkte.pop(); zeichnen(); }
    else beenden();
  }

  // Klick in die Karte: true, wenn er hierher gehört (dann setzt die Karte keine Markierung)
  function klick(e) {
    if (!aktiv) return false;
    punkte.push({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    zeichnen();
    return true;
  }

  function zeichnen() { zeichneKarte(); zeichnePanel(); }

  function zeichneKarte() {
    const k = karte();
    if (!k) return;
    const koord = punkte.map(p => [p.lon, p.lat]);
    const daten = { type: "FeatureCollection", features: koord.map(c => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} })) };
    if (koord.length > 1) daten.features.unshift({ type: "Feature", geometry: { type: "LineString", coordinates: koord }, properties: {} });
    try {
      if (k.getSource("messen")) { k.getSource("messen").setData(daten); return; }
      k.addSource("messen", { type: "geojson", data: daten });
      const linie = ["==", ["geometry-type"], "LineString"];
      k.addLayer({ id: "messen-rand", type: "line", source: "messen", filter: linie,
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.9 } });
      k.addLayer({ id: "messen-linie", type: "line", source: "messen", filter: linie,
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#2a2f2b", "line-width": 3, "line-dasharray": [2, 1.5] } });
      k.addLayer({ id: "messen-punkte", type: "circle", source: "messen", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": "#2a2f2b", "circle-stroke-width": 2.5 } });
    } catch (e) { /* Stil lädt gerade neu: styledata zeichnet gleich nach */ }
  }

  function zeichnePanel() {
    const n = punkte.length;
    panel.replaceChildren(
      el("div", { class: "mess-kopf" }, sym("ruler"), el("b", {}, "Entfernung messen"),
        el("button", { type: "button", class: "mess-zu", title: "Messen beenden", "aria-label": "Messen beenden", onclick: beenden }, sym("x"))),
      el("div", { class: "mess-wert" }, el("b", {}, laenge(gesamt())), el("span", {}, "Luftlinie")),
      el("p", { class: "hinweis klein" }, n < 2
        ? ["Klicke in die Karte, wohin du messen willst."]
        : [n + " Punkte.", el("br"), "Jeder weitere Klick verlängert die Strecke, ein Rechtsklick nimmt den letzten Punkt zurück."]),
      el("div", { class: "mess-knoepfe" },
        n > 1 ? el("button", { type: "button", class: "knopf knopf-klein", onclick: zurueck }, sym("rotate-ccw"), "Letzten Punkt zurück") : "",
        el("button", { type: "button", class: "knopf knopf-klein", onclick: beenden }, "Fertig")));
    panel.hidden = false;
  }

  // Route planen und Messen schließen sich aus
  $("#routen-knopf").addEventListener("click", beenden);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && aktiv && !e.target.closest("input, textarea")) beenden(); });

  return { starten, beenden, klick, zurueck, get aktiv() { return aktiv; } };
})();
