// Sonne und Mond auf der Karte: Auf- und Untergang, Dämmerung und Mondphase für den markierten Punkt
// (gesuchter oder angeklickter Ort, solange er zu sehen ist) bzw. sonst für die Kartenmitte,
// offline berechnet mit SunCalc (vendor/suncalc.js). Uhrzeiten nach der Uhr dieses Computers.
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
    kalZu();
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
  const deutsch = (d) => String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();

  // Getipptes Datum lesen: 14.11.2026, 14.11.26, 14.11. (dieses Jahr) oder 2026-11-14. Sonst null.
  function lies(text) {
    const t = text.trim();
    let j, m, d;
    const isoForm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    const de = /^(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{4}|\d{2})?$/.exec(t);
    if (isoForm) { j = +isoForm[1]; m = +isoForm[2]; d = +isoForm[3]; }
    else if (de) { d = +de[1]; m = +de[2]; j = de[3] ? +de[3] : new Date().getFullYear(); if (j < 100) j += 2000; }
    else return null;
    const datum = new Date(j, m - 1, d, 12);
    if (j < 1900 || j > 2199 || datum.getMonth() !== m - 1 || datum.getDate() !== d) return null;
    return datum;
  }

  function setzeTag(d) {
    gewaehlt = d && !gleicherTag(d, new Date()) ? d : null;
    // Auch wenn das Feld gerade den Fokus hat (nach der Wahl im Kalender springt er dorthin zurück)
    feld.value = deutsch(gewaehlt || new Date());
    feld.removeAttribute("aria-invalid");
    zeichnen();
  }

  function aufbauen() {
    titel = el("b", {});
    ortText = el("small", {});
    feld = el("input", { type: "text", "aria-label": "Datum, zum Beispiel 24.12.2026", placeholder: "TT.MM.JJJJ", size: 10, inputmode: "numeric", autocomplete: "off", spellcheck: "false" });
    const uebernehmen = () => {
      if (!feld.value.trim()) { feld.removeAttribute("aria-invalid"); setzeTag(null); return; }
      const d = lies(feld.value);
      if (!d) { feld.setAttribute("aria-invalid", "true"); return; }
      feld.removeAttribute("aria-invalid");
      feld.value = deutsch(d);
      kalZu();
      setzeTag(d);
    };
    feld.addEventListener("change", uebernehmen);
    feld.addEventListener("input", () => {
      feld.removeAttribute("aria-invalid");
      // Kalender blättert beim Tippen mit, übernommen wird erst mit Enter oder beim Verlassen des Felds
      const d = lies(feld.value);
      if (d && !kal.hidden) { kalMonat = new Date(d.getFullYear(), d.getMonth(), 1); kalBauen(); }
    });
    feld.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); uebernehmen(); }
      else if (e.key === "ArrowDown" && kal.hidden) { e.preventDefault(); kalAuf(true); }
      else if (e.key === "Escape" && !kal.hidden) { e.preventDefault(); kalZu(); }
    });
    feld.addEventListener("click", () => { if (kal.hidden) kalAuf(false); });
    kalKnopf = el("button", { type: "button", "aria-label": "Kalender", "aria-expanded": "false", title: "Kalender",
      onclick: () => { kal.hidden ? kalAuf(true) : kalZu(); } }, sym("calendar"));
    heuteKnopf = el("button", { type: "button", class: "knopf knopf-klein", onclick: () => { kalZu(); setzeTag(null); } }, "Heute");
    kal = kalender();
    kopf = el("div", { class: "sonne-kopfbereich" },
      el("div", { class: "sonne-kopf" }, titel, ortText),
      el("div", { class: "sonne-datum" }, el("small", {}, "Anderer Tag:"), el("div", { class: "sonne-feld" }, feld, kalKnopf), heuteKnopf),
      kal);
    inhalt = el("div", { class: "sonne-inhalt" });
    panel.replaceChildren(kopf, inhalt);
    // Klick daneben schließt den Kalender
    document.addEventListener("pointerdown", (e) => {
      if (!kal.hidden && !kal.contains(e.target) && !e.target.closest(".sonne-feld")) kalZu();
    });
  }

  // ------------------------------------------------ Kalender
  // Eigener kleiner Kalender statt dem des Browsers (dessen blaue Farben lassen sich nicht ändern).
  // Woche ab Montag, gewählter Tag gefüllt, heute umrandet. Tastatur: Pfeile, Bild auf/ab, Enter, Esc.

  let kal, kalKnopf, kalTitel, kalTage, kalMonat;
  const WOCHE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  function kalender() {
    const blaettern = (n) => { kalMonat = new Date(kalMonat.getFullYear(), kalMonat.getMonth() + n, 1); kalBauen(); };
    kalTitel = el("b", { "aria-live": "polite" });
    kalTage = el("div", { class: "kal-tage" });
    kalTage.addEventListener("keydown", kalTaste);
    return el("div", { class: "kalender", hidden: true },
      el("div", { class: "kal-kopf" },
        el("button", { type: "button", "aria-label": "Voriger Monat", title: "Voriger Monat", onclick: () => blaettern(-1) }, sym("chevron-left")),
        kalTitel,
        el("button", { type: "button", "aria-label": "Nächster Monat", title: "Nächster Monat", onclick: () => blaettern(1) }, sym("chevron-right"))),
      kalTage);
  }

  function kalAuf(fokus) {
    const d = gewaehlt || new Date();
    kalMonat = new Date(d.getFullYear(), d.getMonth(), 1);
    kal.hidden = false;
    kalKnopf.setAttribute("aria-expanded", "true");
    kalBauen(fokus ? d : null);
  }

  function kalZu(fokusZurueck) {
    if (!kal || kal.hidden) return;
    kal.hidden = true;
    kalKnopf.setAttribute("aria-expanded", "false");
    if (fokusZurueck) feld.focus();
  }

  // Tage des Monats neu zeichnen; fokus = Tag, der den Tastaturfokus bekommt
  function kalBauen(fokus) {
    const j = kalMonat.getFullYear(), m = kalMonat.getMonth();
    const heute = new Date(), auswahl = gewaehlt || heute;
    const anzahl = new Date(j, m + 1, 0).getDate(), versatz = (new Date(j, m, 1).getDay() + 6) % 7;
    kalTitel.textContent = kalMonat.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
    // Wer mit Tab hineinkommt, landet auf dem gewählten Tag, sonst auf dem ersten
    const tabTag = fokus && fokus.getMonth() === m && fokus.getFullYear() === j ? fokus.getDate()
      : auswahl.getMonth() === m && auswahl.getFullYear() === j ? auswahl.getDate() : 1;
    const zellen = WOCHE.map(w => el("span", { class: "kal-wt", "aria-hidden": "true" }, w));
    for (let i = 0; i < versatz; i++) zellen.push(el("span", {}));
    for (let t = 1; t <= anzahl; t++) {
      const d = new Date(j, m, t, 12);
      const b = el("button", { type: "button", class: "kal-tag", "data-tag": t, tabindex: t === tabTag ? "0" : "-1",
        "aria-label": d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
        onclick: () => { kalZu(true); setzeTag(d); } }, String(t));
      if (gleicherTag(d, auswahl)) { b.classList.add("gewaehlt"); b.setAttribute("aria-pressed", "true"); }
      if (gleicherTag(d, heute)) { b.classList.add("heute"); b.setAttribute("aria-current", "date"); }
      zellen.push(b);
    }
    kalTage.replaceChildren(...zellen);
    if (fokus) { const b = kalTage.querySelector('[data-tag="' + tabTag + '"]'); if (b) b.focus(); }
  }

  function kalTaste(e) {
    const b = e.target.closest(".kal-tag");
    if (e.key === "Escape") { e.preventDefault(); kalZu(true); return; }
    if (!b) return;
    const schritt = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const monate = { PageUp: -1, PageDown: 1 }[e.key];
    if (!schritt && !monate) return;
    e.preventDefault();
    const t = +b.dataset.tag, j = kalMonat.getFullYear(), m = kalMonat.getMonth();
    const ziel = schritt ? new Date(j, m, t + schritt, 12) : new Date(j, m + monate, Math.min(t, new Date(j, m + monate + 1, 0).getDate()), 12);
    if (ziel.getMonth() !== m || ziel.getFullYear() !== j) kalMonat = new Date(ziel.getFullYear(), ziel.getMonth(), 1);
    kalBauen(ziel);
  }

  function zeichnen() {
    const karte = Karten.karte;
    if (!karte || typeof SunCalc === "undefined") return;
    if (!kopf) aufbauen();
    // Markierter Punkt (Suche oder Klick), solange er zu sehen ist; sonst die Kartenmitte
    const ort = Karten.punkt();
    const c = karte.getCenter(), lat = ort ? ort.lat : c.lat, lon = ort ? ort.lon : c.lng;
    const heute = !gewaehlt;
    // Am gewählten Tag gilt Mittag als Zeitpunkt (für Mondphase und nächsten Voll-/Neumond)
    const jetzt = heute ? new Date() : gewaehlt;
    const morgenD = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() + 1);
    const t = zeitenAm(jetzt, lat, lon), m = zeitenAm(morgenD, lat, lon);

    panel.hidden = false;
    inhalt.innerHTML = "";

    // Kopf: Datum und Ort
    titel.textContent = heute ? "Heute, " + jetzt.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })
      : jetzt.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    ortText.textContent = ort ? ort.text : "Kartenmitte";
    if (document.activeElement !== feld) { feld.value = deutsch(jetzt); feld.removeAttribute("aria-invalid"); }
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
      inhalt.append(el("div",{ class: "sonne-hinweis" }, "Gilt für die Mitte der Karte.", el("br"), "Such unten deinen Ort oder klick ihn in der Karte an.", el("br"), "Dann stimmen die Zeiten auf die Minute."));
  }

  // Markierter Punkt hat sich geändert
  function neu() { if (offen) zeichnen(); }

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

  return { oeffnen, schliessen, neu, get offen() { return offen; } };
})();
