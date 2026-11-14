// Sonne und Mond auf der Karte: Auf- und Untergang, Dämmerung und Mondphase für die Kartenmitte,
// offline berechnet mit SunCalc (vendor/suncalc.js). Wurde zuletzt ein Ort gesucht und liegt die Mitte
// noch in seiner Nähe, steht sein Name dabei. Uhrzeiten nach der Uhr dieses Computers.
"use strict";

const Sonne = (() => {
  let offen = false, uhr = null, verbunden = false;
  const knopf = $("#sonne-knopf"), panel = $("#sonne-panel");

  knopf.addEventListener("click", () => { offen ? schliessen() : oeffnen(); });

  function oeffnen() {
    const karte = Karten.karte;
    if (!karte) return;
    offen = true;
    knopf.classList.add("aktiv");
    if (!verbunden) { karte.on("moveend", () => { if (offen) zeichnen(); }); verbunden = true; }
    zeichnen();
    clearInterval(uhr);
    // Jede Minute neu (nur solange die Karte zu sehen ist)
    uhr = setInterval(() => { if (offen && panel.closest(".ansicht").classList.contains("sichtbar")) zeichnen(); }, 60000);
  }

  function schliessen() {
    offen = false;
    clearInterval(uhr);
    knopf.classList.remove("aktiv");
    panel.hidden = true;
    gewaehlt = null; // beim nächsten Öffnen wieder heute
  }

  const zeit = (d) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const gueltig = (d) => d instanceof Date && !isNaN(d);
  const tag = (d) => d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  function dauer(ms) {
    const min = Math.max(1, Math.round(ms / 60000)), h = Math.floor(min / 60), m = min % 60;
    return h ? h + " Std." + (m ? " " + m + " Min." : "") : m + " Min.";
  }
  // Kurz für die Kachel: „9:27 Std.“
  function stunden(ms) {
    const min = Math.round(ms / 60000);
    return Math.floor(min / 60) + ":" + String(min % 60).padStart(2, "0") + " Std.";
  }
  // Zeiten eines Kalendertags: SunCalc rechnet mit dem Tag, in dem die Mittagszeit liegt
  function zeitenAm(d, lat, lon) {
    const mittag = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
    return SunCalc.getTimes(mittag, lat, lon);
  }

  // Eigenes Datum: null = heute. Kopf mit Datumsfeld wird nur einmal gebaut, damit beim Neuzeichnen
  // (jede Minute, nach dem Verschieben) nichts aus dem Feld verschwindet, während man tippt.
  let gewaehlt = null, kopf = null, inhalt = null, titel, ortText, feld, heuteKnopf;
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const gleicherTag = (a, b) => iso(a) === iso(b);

  function aufbauen() {
    titel = el("b", {});
    ortText = el("small", {});
    feld = el("input", { type: "date", "aria-label": "Datum", min: "1900-01-01", max: "2199-12-31" });
    feld.addEventListener("change", () => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(feld.value);
      if (!feld.value) { gewaehlt = null; zeichnen(); return; }
      // Halb getippte Jahre (z. B. 0002) nicht übernehmen
      if (!m || +m[1] < 1900 || +m[1] > 2199) return;
      const d = new Date(+m[1], +m[2] - 1, +m[3], 12);
      gewaehlt = gleicherTag(d, new Date()) ? null : d;
      zeichnen();
    });
    heuteKnopf = el("button", { type: "button", class: "knopf knopf-klein", onclick: () => { gewaehlt = null; zeichnen(); } }, "Heute");
    kopf = el("div", { class: "sonne-kopfbereich" },
      el("div", { class: "sonne-kopf" }, titel, ortText),
      el("div", { class: "sonne-datum" }, el("small", {}, "Anderer Tag:"), feld, heuteKnopf));
    inhalt = el("div", { class: "sonne-inhalt" });
    panel.replaceChildren(kopf, inhalt);
  }

  function zeichnen() {
    const karte = Karten.karte;
    if (!karte || typeof SunCalc === "undefined") return;
    if (!kopf) aufbauen();
    const c = karte.getCenter(), lat = c.lat, lon = c.lng;
    const heute = !gewaehlt;
    // Am gewählten Tag gilt Mittag als Zeitpunkt (für Mondphase und nächsten Voll-/Neumond)
    const jetzt = heute ? new Date() : gewaehlt;
    const morgenD = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() + 1);
    const t = zeitenAm(jetzt, lat, lon), m = zeitenAm(morgenD, lat, lon);

    panel.hidden = false;
    inhalt.innerHTML = "";

    // Kopf: Datum und Ort
    const ort = Karten.ortBeiMitte(10);
    titel.textContent = heute ? "Heute, " + jetzt.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })
      : jetzt.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    ortText.textContent = ort ? "bei " + ort.name : "Kartenmitte";
    if (document.activeElement !== feld) feld.value = iso(jetzt);
    heuteKnopf.hidden = heute;

    // Polartag oder Polarnacht (nur ganz im Norden, z. B. Nordschweden)
    if (!gueltig(t.sunrise) || !gueltig(t.sunset)) {
      const hoch = SunCalc.getPosition(t.solarNoon, lat, lon).altitude > 0;
      const wann = heute ? "heute" : "an diesem Tag";
      inhalt.append(el("div", { class: "sonne-status" }, el("b", {}, hoch ? "Die Sonne geht " + wann + " nicht unter." : "Die Sonne geht " + wann + " nicht auf.")));
    } else {
      if (heute) inhalt.append(status(jetzt, t, m));
      inhalt.append(el("div", { class: "sonne-werte" },
        el("div", {}, el("small", {}, sym("sunrise"), "Aufgang"), el("b", {}, zeit(t.sunrise))),
        el("div", {}, el("small", {}, sym("sunset"), "Untergang"), el("b", {}, zeit(t.sunset))),
        el("div", {}, el("small", {}, sym("sun"), "Tageslicht"), el("b", {}, stunden(t.sunset - t.sunrise)))));
      if (gueltig(t.dawn) && gueltig(t.dusk))
        inhalt.append(el("div", { class: "sonne-zeile" }, "Ohne Lampe hell genug: " + zeit(t.dawn) + " bis " + zeit(t.dusk) + " Uhr"));
      if (gueltig(m.sunrise) && gueltig(m.sunset))
        inhalt.append(el("div", { class: "sonne-zeile" }, (heute ? "Morgen: " : "Am Tag danach: ") + zeit(m.sunrise) + " bis " + zeit(m.sunset) + " Uhr"));
    }

    inhalt.append(mond(jetzt, lat, lon, heute));

    if (!ort && karte.getZoom() < 9)
      inhalt.append(el("div",{ class: "sonne-hinweis" }, "Gilt für die Mitte der Karte.", el("br"), "Such unten deinen Ort, dann stimmen die Zeiten auf die Minute."));
  }

  // Was jetzt gilt: wie lange es noch hell ist bzw. wann es hell wird
  function status(jetzt, t, m) {
    let haupt, unter;
    if (jetzt < t.sunrise) {
      haupt = "Sonnenaufgang in " + dauer(t.sunrise - jetzt);
      unter = gueltig(t.dawn) && jetzt < t.dawn ? "Dämmrig ab " + zeit(t.dawn) + " Uhr" : "Es dämmert schon.";
    } else if (jetzt < t.sunset) {
      haupt = "Noch " + dauer(t.sunset - jetzt) + " hell";
      unter = gueltig(t.dusk) ? "Danach Dämmerung bis " + zeit(t.dusk) + " Uhr" : "";
    } else {
      haupt = gueltig(t.dusk) && jetzt < t.dusk ? "Dämmerung: noch " + dauer(t.dusk - jetzt) + " etwas Licht" : "Dunkel";
      unter = gueltig(m.sunrise) ? "Sonnenaufgang morgen um " + zeit(m.sunrise) + " Uhr" : "";
    }
    return el("div", { class: "sonne-status" }, el("b", {}, haupt), unter ? el("small", {}, unter) : null);
  }

  // ------------------------------------------------ Mond

  function phasenName(p) {
    if (p < 0.03 || p > 0.97) return "Neumond";
    if (Math.abs(p - 0.25) < 0.03) return "Halbmond, zunehmend";
    if (Math.abs(p - 0.5) < 0.03) return "Vollmond";
    if (Math.abs(p - 0.75) < 0.03) return "Halbmond, abnehmend";
    if (p < 0.25) return "Zunehmende Sichel";
    if (p < 0.5) return "Zunehmender Mond";
    if (p < 0.75) return "Abnehmender Mond";
    return "Abnehmende Sichel";
  }

  // Nächster Zeitpunkt, an dem die Phase den Wert ziel (0 = Neumond, 0,5 = Vollmond) überschreitet
  function naechste(von, ziel) {
    const schritt = 3 * 3600e3;
    let vorher = (SunCalc.getMoonIllumination(von).phase - ziel + 1) % 1;
    for (let t = von.getTime() + schritt; t < von.getTime() + 31 * 864e5; t += schritt) {
      const jetzt = (SunCalc.getMoonIllumination(new Date(t)).phase - ziel + 1) % 1;
      if (jetzt < vorher) return new Date(t); // Sprung von knapp unter 1 auf knapp über 0
      vorher = jetzt;
    }
    return null;
  }

  // Mondbild: beleuchteter Teil von rechts (zunehmend) bzw. links (abnehmend), wie man ihn bei uns sieht
  function mondBild(p) {
    const r = 15, rx = Math.abs(Math.cos(2 * Math.PI * p)) * r;
    const zunehmend = p < 0.5, dick = (p > 0.25 && p < 0.75);
    const rand = zunehmend ? "A" + r + "," + r + " 0 0,1 0," + r : "A" + r + "," + r + " 0 0,0 0," + r;
    const schwung = zunehmend ? (dick ? 1 : 0) : (dick ? 0 : 1);
    const d = "M0," + (-r) + " " + rand + " A" + rx.toFixed(2) + "," + r + " 0 0," + schwung + " 0," + (-r) + " Z";
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "-16 -16 32 32");
    svg.setAttribute("class", "mond-bild");
    svg.setAttribute("aria-hidden", "true");
    const kreis = document.createElementNS(ns, "circle");
    kreis.setAttribute("r", r);
    kreis.setAttribute("class", "mond-dunkel");
    const hell = document.createElementNS(ns, "path");
    hell.setAttribute("d", d);
    hell.setAttribute("class", "mond-hell");
    svg.append(kreis, hell);
    return svg;
  }

  function mond(jetzt, lat, lon, heute) {
    const ill = SunCalc.getMoonIllumination(jetzt);
    const zeiten = SunCalc.getMoonTimes(jetzt, lat, lon);
    const auf = zeiten.rise ? "Aufgang " + zeit(zeiten.rise) : null, ab = zeiten.set ? "Untergang " + zeit(zeiten.set) : null;
    const zeitText = zeiten.alwaysUp ? (heute ? "Heute" : "An diesem Tag") + " den ganzen Tag am Himmel" : zeiten.alwaysDown ? (heute ? "Heute" : "An diesem Tag") + " nicht zu sehen" : [auf, ab].filter(Boolean).join(" · ");
    const voll = naechste(jetzt, 0.5), neu = naechste(jetzt, 0);
    const termine = [voll ? "Vollmond " + tag(voll) : null, neu ? "Neumond " + tag(neu) : null]
      .filter(Boolean).sort((a, b) => (a.startsWith("Voll") ? voll : neu) - (b.startsWith("Voll") ? voll : neu));
    return el("div", { class: "sonne-mond" }, mondBild(ill.phase),
      el("div", {},
        el("b", {}, phasenName(ill.phase)), el("small", {}, Math.round(ill.fraction * 100) + " % beleuchtet"),
        zeitText ? el("small", {}, zeitText) : null,
        ...termine.map(x => el("small", {}, x))));
  }

  return { oeffnen, schliessen };
})();
