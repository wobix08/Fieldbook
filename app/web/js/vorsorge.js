// Vorsorge: oben der Stand je Stufe (Das Wichtigste · Gut vorbereitet · Weiter vorsorgen), darunter
// „Wenn es passiert“ (Lagen mit kurzen Schritten) und „Vorbereiten“ (Raster aus Themen und Stufen).
// Alle Stufen sind immer da. Eine Themenseite zeigt sie untereinander; die höheren sind zugeklappt,
// bis man dort etwas abhakt oder über das Raster hinspringt.
// Dazu ein Vorratsrechner, eine automatische Packliste für die Notfallkiste und Druckansichten.
"use strict";

const Vorsorge = (() => {
  let roh = null;              // vorsorge.json wie geladen
  let konf = null;             // dieselbe Konfiguration mit den Texten des gewählten Landes
  let konfLand = null;
  let stand = null;            // Häkchen, Datum und Personen aus daten/vorsorge.json
  const artikelCache = {};

  // Texte je Land: Ein Eintrag mit 'land' {DE: {...}, AT: {...}, CH: {...}} übernimmt die Felder des
  // gewählten Landes; {"weg": true} lässt ihn in diesem Land ganz weg (nur Einträge in Listen).
  function fuerLand(x, code) {
    if (Array.isArray(x)) return x.map(y => fuerLand(y, code)).filter(y => !(y && y.weg));
    if (!x || typeof x !== "object") return x;
    const o = {};
    for (const k in x) if (k !== "land") o[k] = fuerLand(x[k], code);
    if (x.land && x.land[code]) Object.assign(o, fuerLand(x.land[code], code));
    return o;
  }

  async function zeigen(params) {
    if (!roh) roh = await ladeKonfigSprache("vorsorge");
    // Das Land kann sich in den Einstellungen ändern, deshalb bei jedem Öffnen prüfen
    const code = (Land.aktuell() || {}).code || "DE";
    if (!konf || konfLand !== code) { konf = fuerLand(roh, code); konfLand = code; }
    const ziel = $("#vs-inhalt");
    if (!stand) {
      // Nur ein erfolgreich geladener Stand wird übernommen und gespeichert;
      // bei einem Fehler bleibt der gespeicherte Stand unberührt und das Laden wird beim nächsten Öffnen neu versucht
      let geladen;
      try {
        geladen = await api("vorsorge");
        if (!geladen || typeof geladen !== "object" || geladen.fehler) throw new Error((geladen && geladen.fehler) || "Ungültige Antwort");
      } catch (e) {
        ziel.innerHTML = "";
        ziel.append(fehlerBox("Der Stand der Vorsorge konnte nicht geladen werden.", () => zeigen(params), "Erneut versuchen", e && e.message));
        return;
      }
      if (!geladen.haken) geladen.haken = {};
      if (!geladen.datum) geladen.datum = {};
      if (!geladen.personen) geladen.personen = { erwachsen: 1 };
      stand = geladen;
      if (stand.version !== 2) { uebernehmen(); speichern(); }
    }

    ziel.innerHTML = "";
    const druck = params.get("druck");
    const thema = konf.themen.find(x => x.id === params.get("k"));
    const lage = konf.lagen.find(x => x.id === params.get("lage"));
    if (druck) {
      // Alte Adressen (#vorsorge?druck=…) öffnen die Übersicht und das Druckfenster
      history.replaceState(null, "", "#vorsorge");
      ziel.append(uebersicht());
      setTimeout(() => drucken(druck), 300);
    } else if (thema) {
      ziel.append(themaAnsicht(thema));
      const s = params.get("s");
      // Sprung zu einer Stufe (s=2) oder Stelle (z=rechner, z=packliste); ist die Stufe zugeklappt,
      // wird sie aufgeklappt. Bei der ersten Stufe wird nicht gesprungen: Sie steht
      // ohnehin oben, und sonst rutschen Erklärung und Vorratsrechner aus dem Blick.
      const ziel2 = s && s !== "1" ? "vs-s" + s : params.get("z") ? "vs-" + params.get("z") : null;
      if (ziel2) setTimeout(() => { const z = document.getElementById(ziel2); if (z) { if (z.tagName === "DETAILS") z.open = true; z.scrollIntoView({ block: "start" }); } }, 50);
    } else if (lage) {
      ziel.append(lageAnsicht(lage));
    } else ziel.append(uebersicht());
  }

  // Häkchen aus der früheren Gliederung (Kapitel Vorräte, Stromausfall, Aufbewahren …) übernehmen
  function uebernehmen() {
    const alt = stand.haken, neu = {};
    for (const t of konf.themen) for (const p of allePunkte(t)) {
      const orte = p.alt || [t.id + "/" + p.id];
      if (orte.some(o => { const [k, id] = o.split("/"); return (alt[k] || []).includes(id); }))
        (neu[t.id] = neu[t.id] || []).push(p.id);
    }
    stand.haken = neu;
    stand.datum = {};
    stand.version = 2;
  }

  function allePunkte(t) { return t.stufen.flatMap(s => s.punkte); }
  // Speichert den Stand; scheitert es (auch mit Antwort {fehler}), erscheint ein kleiner Hinweis oben
  async function speichern() {
    let ok = true;
    try {
      const r = await api("vorsorge/speichern", stand);
      if (r && r.fehler) ok = false;
    } catch { ok = false; }
    const ziel = $("#vs-inhalt");
    const alt = document.getElementById("vs-speicherfehler");
    if (ok) { if (alt) alt.remove(); return; }
    if (!alt && ziel) ziel.prepend(el("p", { id: "vs-speicherfehler", class: "hinweis", role: "alert" }, "Konnte nicht gespeichert werden."));
  }
  function hat(t, p) { return (stand.haken[t.id] || []).includes(p.id); }

  // ---------------------------------------------------------------- Übersicht

  function uebersicht() {
    return el("div", { class: "vs-uebersicht" },
      el("p", { class: "hinweis" }, zeilen(konf.einleitung)),
      el("h2", {}, "Wenn es passiert"),
      el("p", { class: "hinweis" }, "Kurze Schritte, wenn die Lage schon da ist.", el("br"), "Für nichts davon musst du etwas kaufen."),
      el("div", { class: "vs-lagen" }, ...konf.lagen.map(l =>
        el("a", { class: "vs-lage", href: "#vorsorge?lage=" + l.id }, el("span", { class: "vs-lage-feld", "aria-hidden": "true" }, sym(l.icon)), el("span", {}, l.kurz || l.titel)))),
      el("h2", {}, "Vorbereiten"),
      stufenStand(),
      el("p", { class: "hinweis" }, "Klick ein Feld an, um es zu öffnen."),
      raster(),
      el("div", { class: "vs-knoepfe" },
        el("button", { class: "knopf knopf-klein", onclick: () => drucken("wichtigste") }, sym("printer"), "Das Wichtigste drucken"),
        el("button", { class: "knopf knopf-klein", onclick: () => drucken("alle") }, sym("printer"), "Alles drucken"),
        el("button", { class: "knopf knopf-klein", onclick: () => drucken("kiste") }, sym("box"), "Für die Notfallkiste drucken"),
        el("button", { class: "knopf knopf-klein", onclick: zuruecksetzen }, "↺ Alles zurücksetzen"),
        el("span", { class: "hinweis klein" }, "Zurücksetzen löscht alle Häkchen, z. B. um alles neu durchzugehen.")));
  }

  // Drucken ohne eigene Seite: Fieldbook baut die Druckblätter selbst (A4, Kopfzeile, Fußzeile mit
  // Seitenzahl) in einem unsichtbaren Bereich, nur der wird gedruckt. So sieht der Druck in jedem
  // Browser gleich aus; Kopf- und Fußzeilen über @page kann nicht jeder Browser (Firefox nicht).
  // art: "wichtigste", "alle", "kiste" oder "thema"/"lage" mit dem Thema bzw. der Lage.
  async function drucken(art, ding) {
    let titel, bloecke;
    if (art === "kiste") {
      titel = "Notfallkiste und Wenn es passiert";
      bloecke = [packlisteDruck(), ...konf.lagen.map(l => lageAnsicht(l, true))];
    } else if (art === "thema") {
      titel = ding.titel; bloecke = [themaAnsicht(ding, "alle")];
    } else if (art === "lage") {
      titel = ding.titel; bloecke = [lageAnsicht(ding, true)];
    } else {
      titel = art === "wichtigste" ? "Das Wichtigste" : "Alles";
      bloecke = konf.themen.map(t => themaAnsicht(t, art === "wichtigste" ? "wichtigste" : "alle"));
    }
    const alt = document.getElementById("vs-druck");
    if (alt) alt.remove();
    const bereich = el("div", { id: "vs-druck", class: "messen" });
    document.body.append(bereich);
    await document.fonts.ready;
    blaetterBauen(bereich, bloecke, titel);
    bereich.classList.remove("messen");
    document.body.classList.add("vs-drucken");
    const weg = () => {
      window.removeEventListener("afterprint", weg);
      bereich.remove();
      document.body.classList.remove("vs-drucken");
    };
    window.addEventListener("afterprint", weg);
    window.print();
  }

  // Verteilt die Blöcke auf Blätter fester Höhe. Jeder Block (Thema, Lage) beginnt auf einem neuen Blatt.
  // Passt etwas nicht mehr, wird es aufs nächste Blatt geschoben; Abschnitte und Listen werden dabei
  // geteilt (auf dem neuen Blatt geht es in einer Kopie des Abschnitts weiter). Eine Überschrift
  // wandert mit, statt allein unten zu stehen.
  function blaetterBauen(bereich, bloecke, titel) {
    const datum = new Date().toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
    const blaetter = [];
    let inhalt = null;
    let klone = new Map();          // Abschnitt im Original → seine Kopie auf dem aktuellen Blatt
    const teilbar = k => k.nodeType === 1 && /^(DIV|SECTION|UL|OL)$/.test(k.tagName) &&
      !k.classList.contains("vs-rechner") && !k.classList.contains("vs-warnung") && k.childNodes.length > 1;
    const istTitel = k => k && /^H[2-4]$/.test(k.tagName);

    function neuesBlatt() {
      // leere Abschnitts-Kopien vom alten Blatt entfernen (sonst bliebe z. B. ein Trennstrich unten stehen)
      for (const c of [...klone.values()].reverse()) if (!c.childNodes.length) c.remove();
      klone = new Map();
      const logo = el("span", { class: "ds-logo" });
      logo.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20c-2.6-1.7-6-2.1-10-1.5V9.6l3.6-2.7 2.2 1.7L12 4"/><path d="M12 20c2.6-1.7 6-2.1 10-1.5V9.6l-4-3.6-2 1.8L12 4"/><path d="M12 4v16"/></svg>';
      inhalt = el("div", { class: "ds-inhalt" });
      const blatt = el("div", { class: "ds-blatt" },
        el("div", { class: "ds-kopf" }, el("span", { class: "ds-name" }, logo, "Fieldbook · Vorsorge"), el("span", {}, titel)),
        inhalt,
        el("div", { class: "ds-fuss" }, el("span", {}, "Gedruckt am " + datum + " mit Fieldbook"), el("span", { class: "ds-seite" })));
      bereich.append(blatt);
      blaetter.push(blatt);
    }
    const voll = () => inhalt.scrollHeight > inhalt.clientHeight + 1;
    // Blatt leer: höchstens leere Abschnitts-Kopien darauf
    const leer = () => !inhalt.textContent.trim() && !inhalt.querySelector("input, img, svg, table");

    // Behälter auf dem aktuellen Blatt für einen Pfad von Abschnitten (fehlende Kopien werden angelegt)
    function behaelter(pfad) {
      let b = inhalt;
      for (const p of pfad) {
        if (!klone.has(p)) {
          const c = p.cloneNode(false);
          c.removeAttribute("id");
          b.append(c);
          klone.set(p, c);
        }
        b = klone.get(p);
      }
      return b;
    }

    function setzen(knoten, pfad) {
      const b = behaelter(pfad);
      b.append(knoten);
      if (!voll() || knoten.nodeType !== 1) return;
      knoten.remove();
      if (teilbar(knoten)) {
        for (const k of [...knoten.childNodes]) setzen(k, pfad.concat(knoten));
        return;
      }
      if (leer()) {
        b.append(knoten);           // passt auch auf ein leeres Blatt nicht: trotzdem hier
        return;
      }
      const mit = istTitel(b.lastElementChild) ? b.lastElementChild : null;
      if (mit) mit.remove();
      neuesBlatt();
      if (mit) behaelter(pfad).append(mit);
      behaelter(pfad).append(knoten);
    }

    for (const block of bloecke) {
      neuesBlatt();
      for (const k of [...block.childNodes]) setzen(k, [block]);
    }
    for (const c of [...klone.values()].reverse()) if (!c.childNodes.length) c.remove();
    blaetter.forEach((b, i) => { b.querySelector(".ds-seite").textContent = "Seite " + (i + 1) + " von " + blaetter.length; });
  }

  // Stand je Stufe über alle Themen: Name, wofür sie gedacht ist, wie viel schon abgehakt ist
  function stufenStand() {
    return el("div", { class: "vs-stand" }, ...konf.stufen.map((st, i) => {
      let gesamt = 0, fertig = 0;
      for (const t of konf.themen) {
        const s = t.stufen[i];
        if (!s) continue;
        gesamt += s.punkte.length;
        fertig += s.punkte.filter(p => hat(t, p)).length;
      }
      return el("div", { class: "vs-stand-stufe" + (gesamt && fertig === gesamt ? " ok" : "") },
        el("div", { class: "vs-stand-kopf" }, el("b", {}, st.name), el("span", {}, (gesamt && fertig === gesamt ? "✓ " : "") + fertig + " von " + gesamt)),
        el("span", { class: "vs-balken" }, el("span", { style: "width:" + (gesamt ? Math.round(fertig / gesamt * 100) : 0) + "%" })),
        el("span", { class: "hinweis klein" }, st.text));
    }));
  }

  function raster() {
    const tab = el("div", { class: "vs-raster", role: "table" },
      el("div", { class: "vs-r-kopf", role: "row" }, el("span", {}),
        ...konf.stufen.map(s => el("span", { role: "columnheader" }, s.name))));
    for (const t of konf.themen) {
      const zeile = el("div", { class: "vs-r-zeile", role: "row" },
        el("a", { class: "vs-r-thema", href: "#vorsorge?k=" + t.id }, symFeld(t.icon), el("span", {}, t.titel)));
      t.stufen.forEach((s, i) => {
        if (!s.punkte.length) { zeile.append(el("span", { class: "vs-r-feld leer" }, "–")); return; }
        const fertig = s.punkte.filter(p => hat(t, p)).length;
        zeile.append(el("a", { class: "vs-r-feld" + (fertig === s.punkte.length ? " ok" : ""), href: "#vorsorge?k=" + t.id + "&s=" + (i + 1),
          "aria-label": t.titel + ", " + konf.stufen[i].name + ": " + fertig + " von " + s.punkte.length },
          el("span", {}, (fertig === s.punkte.length ? "✓ " : "") + fertig + " von " + s.punkte.length),
          el("span", { class: "vs-balken" }, el("span", { style: "width:" + Math.round(fertig / s.punkte.length * 100) + "%" }))));
      });
      tab.append(zeile);
    }
    return tab;
  }

  async function zuruecksetzen() {
    if (!confirm("Alle Häkchen auf der Seite Vorsorge löschen?")) return;
    stand.haken = {};
    stand.datum = {};
    await speichern();
    zeigen(new URLSearchParams());
  }

  // ---------------------------------------------------------------- Themen

  function themaAnsicht(t, druck) {
    const nr = konf.themen.indexOf(t) + 1;
    const naechstes = konf.themen[nr];
    const mehr = el("div", { class: "knoepfe" }, el("span", { class: "hinweis" }, "Artikel werden gesucht …"));
    if (!druck) mehrLesen(mehr, t.id, t.artikel || []);
    const datum = stand.datum[t.id] ? "Zuletzt geändert am " + new Date(stand.datum[t.id]).toLocaleDateString("de-DE") : "";
    return el("div", { class: "vs-kapitelseite" },
      druck ? null : el("div", { class: "eh-lektion-kopf vs-knoepfe" },
        el("a", { class: "knopf knopf-klein", href: "#vorsorge" }, "← Übersicht"),
        el("span", { class: "hinweis" }, "Thema " + nr + " von " + konf.themen.length + (datum ? " · " + datum : ""))),
      el("h2", {}, sym(t.icon), t.titel),
      el("p", { class: "vs-warum" }, zeilen(t.warum)),
      t.rechner ? rechner() : null,
      ...t.stufen.map((s, i) => stufeAbschnitt(t, s, i, druck)),
      t.kiste ? packliste(druck) : null,
      druck ? null : verweisKnoepfe(t.verweise),
      druck || !(t.artikel || []).length ? null : el("div", {}, el("h3", {}, "Mehr lesen"), mehr),
      druck ? null : el("div", { class: "vs-knoepfe vs-fuss" },
        el("a", { class: "knopf", href: "#vorsorge" }, "← Übersicht"),
        el("button", { class: "knopf", onclick: () => drucken("thema", t) }, sym("printer"), "Drucken"),
        naechstes ? el("a", { class: "knopf knopf-haupt", href: "#vorsorge?k=" + naechstes.id }, "Nächstes Thema: " + (naechstes.kurz || naechstes.titel) + " →") : null));
  }

  // Eine Stufe eines Themas. Die erste ist immer offen; die höheren sind zugeklappt, bis dort etwas
  // abgehakt ist. Im Druck stehen alle offen da, bei „Das Wichtigste drucken“ nur die erste.
  function stufeAbschnitt(t, s, i, druck) {
    if (!s.punkte.length) return null;
    if (druck === "wichtigste" && i > 0) return null;
    const aus = i > 0 && !druck;
    const name = konf.stufen[i].name;
    const inhalt = [
      ...s.text.map(x => el("p", {}, zeilen(x))),
      s.hinweis ? el("p", { class: "hinweis" }, zeilen(s.hinweis)) : null,
      el("ul", { class: "eh-ueben vs-liste" }, ...s.punkte.map(p => punkt(t, p))),
    ];
    const fertig = s.punkte.filter(p => hat(t, p)).length;
    const zaehler = el("span", { class: "vs-zaehler" }, fertig + " von " + s.punkte.length);
    if (aus) {
      return el("details", { class: "vs-stufe zu", id: "vs-s" + (i + 1), open: fertig > 0 },
        el("summary", {}, el("span", { class: "vs-auf" }, "›"), el("span", { class: "vs-stufe-name" }, name),
          el("span", { class: "hinweis" }, " (zusätzlich) · " + s.punkte.length + " Punkte"), zaehler),
        ...inhalt);
    }
    return el("section", { class: "vs-stufe", id: "vs-s" + (i + 1) },
      el("h3", {}, el("span", { class: "vs-stufe-name" }, name), i ? el("span", { class: "hinweis" }, " (zusätzlich)") : null, druck ? null : zaehler),
      ...inhalt);
  }

  function punkt(t, p, inPackliste) {
    const box = el("input", { type: "checkbox", checked: hat(t, p), "data-thema": t.id, "data-punkt": p.id });
    box.addEventListener("change", () => {
      // Derselbe Punkt kann auf der Seite mehrfach stehen (Stufe und Packliste): alle mitziehen
      for (const b of document.querySelectorAll("#vs-inhalt input[data-thema]"))
        if (b !== box && b.dataset.thema === t.id && b.dataset.punkt === p.id) b.checked = box.checked;
      const l = (stand.haken[t.id] || []).filter(x => x !== p.id);
      if (box.checked) l.push(p.id);
      stand.haken[t.id] = l;
      stand.datum[t.id] = new Date().toISOString();
      speichern();
    });
    return el("li", {}, el("label", {}, box, " ", p.text,
      p.frei ? el("span", { class: "vs-marke" }, "kostet nichts") : null,
      p.kiste && !t.kiste && !inPackliste ? el("a", { class: "vs-marke kiste", href: "#vorsorge?k=aufbewahren&z=packliste", title: "Zur Packliste der Notfallkiste" }, "Notfallkiste") : null,
      inPackliste && !t.kiste ? el("a", { class: "vs-herkunft", href: "#vorsorge?k=" + t.id }, t.kurz || t.titel) : null,
      p.mehr ? el("small", { class: "vs-mehr" }, zeilen(p.mehr)) : null),
      verweisLinks(p));
  }

  // Verweise direkt am Punkt: 'verweis' ist ein Objekt {text, link} oder eine Liste davon
  function verweisLinks(p) {
    return [].concat(p.verweis || []).map(v => el("a", { class: "vs-verweis", href: v.link }, sym("arrow-right"), v.text));
  }

  // Packliste der Notfallkiste: alle markierten Punkte aus allen Themen, nach Stufen gegliedert.
  // Die Häkchen sind dieselben wie im jeweiligen Thema.
  function kistenPunkte(i) {
    const liste = [];
    for (const t of konf.themen) if (t.stufen[i]) for (const p of t.stufen[i].punkte) if (p.kiste) liste.push({ t, p });
    return liste;
  }

  function packliste(druck) {
    const gruppen = konf.stufen.map((st, i) => {
      if (druck === "wichtigste" && i > 0) return null;
      const liste = kistenPunkte(i);
      if (!liste.length) return null;
      return [
        el("h4", { class: "vs-packliste-stufe" }, el("span", { class: "vs-stufe-name" }, st.name), i ? el("span", { class: "hinweis" }, " (zusätzlich)") : null),
        el("ul", { class: "eh-ueben vs-liste" }, ...liste.map(({ t, p }) => punkt(t, p, true))),
      ];
    }).filter(Boolean).flat();
    return el("section", { class: "vs-stufe vs-packliste", id: "vs-packliste" },
      el("h3", {}, sym("box"), "Was in die Notfallkiste kommt"),
      el("p", { class: "hinweis" }, "Zusammengestellt aus den anderen Themen.", el("br"), "Ein Häkchen hier gilt auch dort."),
      ...gruppen);
  }

  function packlisteDruck() {
    const t = konf.themen.find(x => x.kiste);
    return el("div", { class: "vs-kapitelseite" }, el("h2", {}, sym("box"), "Notfallkiste"), el("p", {}, zeilen(t.warum)), packliste(true));
  }

  // ---------------------------------------------------------------- Lagen

  function lageAnsicht(l, druck) {
    const nr = konf.lagen.indexOf(l) + 1;
    const naechste = konf.lagen[nr];
    const mehr = el("div", { class: "knoepfe" }, el("span", { class: "hinweis" }, "Artikel werden gesucht …"));
    if (!druck) mehrLesen(mehr, "lage-" + l.id, l.artikel || []);
    const themen = (l.vorbereiten || []).map(id => konf.themen.find(t => t.id === id)).filter(Boolean);
    return el("div", { class: "vs-kapitelseite vs-lageseite" },
      druck ? null : el("div", { class: "eh-lektion-kopf vs-knoepfe" },
        el("a", { class: "knopf knopf-klein", href: "#vorsorge" }, "← Übersicht"),
        el("span", { class: "hinweis" }, "Wenn es passiert")),
      el("h2", {}, sym(l.icon), l.titel),
      (l.warnung || []).length ? el("div", { class: "fehlerbox vs-warnung" },
        el("b", {}, sym("triangle-alert"), "Mach das nicht"),
        ...l.warnung.map(w => el("p", {}, zeilen(w)))) : null,
      ...l.schritte.map(g => el("section", { class: "vs-schritte" },
        el("h3", {}, g.titel),
        el("ul", {}, ...g.punkte.map(p => {
          const ziel = p.lage && konf.lagen.find(x => x.id === p.lage);
          return el("li", {}, zeilen(p.text),
            p.mehr ? el("small", { class: "vs-mehr" }, zeilen(p.mehr)) : null,
            ziel && !druck ? el("a", { class: "vs-verweis", href: "#vorsorge?lage=" + ziel.id }, sym("arrow-right"), ziel.titel) : null,
            druck ? null : verweisLinks(p));
        })))),
      druck || !themen.length ? null : el("div", {}, el("h3", {}, "Dafür vorbereiten"),
        el("div", { class: "knoepfe" }, ...themen.map(t => el("a", { class: "knopf knopf-klein", href: "#vorsorge?k=" + t.id }, sym(t.icon), t.titel)))),
      druck ? null : verweisKnoepfe(l.verweise),
      druck || !(l.artikel || []).length ? null : el("div", {}, el("h3", {}, "Mehr lesen"), mehr),
      druck ? null : el("div", { class: "vs-knoepfe vs-fuss" },
        el("a", { class: "knopf", href: "#vorsorge" }, "← Übersicht"),
        el("button", { class: "knopf", onclick: () => drucken("lage", l) }, sym("printer"), "Drucken"),
        naechste ? el("a", { class: "knopf knopf-haupt", href: "#vorsorge?lage=" + naechste.id }, "Nächste Lage: " + (naechste.kurz || naechste.titel) + " →") : null));
  }

  function verweisKnoepfe(liste) {
    if (!liste || !liste.length) return null;
    return el("div", { class: "knoepfe vs-verweise" },
      ...liste.map(v => el("a", { class: "knopf knopf-klein", href: v.link }, v.icon ? sym(v.icon) : null, v.text)));
  }

  // ---------------------------------------------------------------- Vorratsrechner

  function rechner() {
    const r = konf.rechner;
    const ergebnis = el("div", { class: "vs-rechner-ergebnis" });
    const felder = r.gruppen.map(g => {
      const f = el("input", { type: "number", min: "0", max: "30", step: "1", value: String(stand.personen[g.id] || 0), "aria-label": g.titel });
      f.addEventListener("input", () => {
        stand.personen[g.id] = Math.max(0, Math.min(30, parseInt(f.value, 10) || 0));
        berechne();
        speichern();
      });
      return el("label", { class: "vs-person" }, el("span", {}, el("b", {}, g.titel), el("small", {}, g.alter)), f);
    });
    const berechne = () => {
      ergebnis.innerHTML = "";
      const anteil = r.gruppen.reduce((s, g) => s + (stand.personen[g.id] || 0) * g.anteil, 0);
      const wasser = r.gruppen.reduce((s, g) => s + (stand.personen[g.id] || 0) * g.wasser, 0);
      if (!anteil) { ergebnis.append(el("p", { class: "hinweis" }, "Trag ein, wie viele Personen in deinem Haushalt leben.")); return; }
      const zeilenTab = r.lebensmittel.map(l => {
        const menge = l.id === "getraenke" ? wasser * r.tage : l.menge * anteil;
        return el("tr", {},
          el("td", {}, l.titel),
          el("td", { class: "vs-menge" }, zahl(menge) + " " + l.einheit),
          el("td", { class: "hinweis" }, "z. B. " + beispiele(l, menge)));
      });
      // el() lässt null weg, append() würde „null“ als Text einfügen
      ergebnis.append(...[
        el("table", { class: "vs-tabelle" },
          el("thead", {}, el("tr", {}, el("th", {}, "Gruppe"), el("th", {}, "Für " + r.tage + " Tage"), el("th", {}, "So könnte das aussehen"))),
          el("tbody", {}, ...zeilenTab)),
        (stand.personen.saeugling || 0) > 0 ? el("p", { class: "eh-kinder" }, sym("baby"), " ", zeilen(r.saeugling)) : null,
        el("p", { class: "hinweis klein" }, zeilen(r.quelle)),
      ].filter(Boolean));
    };
    berechne();
    return el("div", { class: "karte-box vs-rechner", id: "vs-rechner" },
      el("h3", {}, sym("calculator"), "Wie viel braucht ihr?"),
      el("div", { class: "vs-personen" }, ...felder),
      ergebnis);
  }

  // Menge gleichmäßig auf die Beispiel-Packungen verteilen, mindestens eine von jeder.
  // Bei genau einer Packung steht das erste Wort in der Einzahl („1 Glas“ statt „1 Gläser“).
  const EINZAHL = { Flaschen: "Flasche", Packungen: "Packung", Dosen: "Dose", "Gläser": "Glas", "Stücke": "Stück" };
  function beispiele(l, menge) {
    const anteil = menge / l.beispiele.length;
    return l.beispiele.map(b => {
      const n = Math.max(1, Math.round(anteil / b.gewicht));
      const name = n === 1 ? b.name.replace(/^\S+/, w => EINZAHL[w] || w) : b.name;
      return n + " " + name;
    }).join(", ");
  }

  function zahl(x) {
    return x.toLocaleString("de-DE", { maximumFractionDigits: x < 1 ? 2 : x < 10 ? 1 : 0 });
  }

  // ---------------------------------------------------------------- Mehr lesen

  async function mehrLesen(ziel, id, titelListe) {
    if (!(id in artikelCache)) {
      const liste = [];
      let fehler = false;
      const buecher = await Kiwix.buecher().catch(() => { fehler = true; return []; });
      for (const titel of titelListe) {
        let treffer = null;
        for (const name of konf.pakete) {
          for (const b of buecher.filter(x => x.name === name)) {
            const v = await Kiwix.vorschlaege(b, titel, 3).catch(() => { fehler = true; return []; });
            treffer = v.find(x => x.titel.toLowerCase() === titel.toLowerCase());
            if (treffer) break;
          }
          if (treffer) break;
        }
        if (treffer && !liste.some(x => x.url === treffer.url)) liste.push(treffer);
      }
      // Leere Ergebnisse und Fehler nicht merken (die Bibliothek startet vielleicht noch)
      if (fehler || !liste.length) { zeigeArtikel(ziel, liste); return; }
      artikelCache[id] = liste;
    }
    zeigeArtikel(ziel, artikelCache[id]);
  }

  function zeigeArtikel(ziel, liste) {
    ziel.innerHTML = "";
    for (const a of liste)
      ziel.append(el("a", { class: "knopf knopf-klein", href: "#lesen?url=" + encodeURIComponent(a.url) + "&titel=" + encodeURIComponent(a.titel) }, sym("book-open"), a.titel));
    if (!liste.length) ziel.append(el("span", { class: "hinweis" }, zeilen("Keine passenden Artikel gefunden. Dafür wird die Wikipedia gebraucht.")));
  }

  return { zeigen };
})();
