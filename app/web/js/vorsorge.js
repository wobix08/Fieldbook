// Vorsorge: Checklisten zum Abhaken (Vorräte, Stromausfall, Aufbewahren, Dokumente, Notgepäck),
// ein Vorratsrechner nach Personen und eine Druckansicht.
"use strict";

const Vorsorge = (() => {
  let konf = null;
  let stand = null;            // Häkchen, Datum und Personen aus daten/vorsorge.json
  const artikelCache = {};

  async function zeigen(params) {
    if (!konf) konf = await ladeKonfigSprache("vorsorge");
    if (!stand) stand = await api("vorsorge").catch(() => ({}));
    if (!stand.haken) stand.haken = {};
    if (!stand.datum) stand.datum = {};
    if (!stand.personen) stand.personen = { erwachsen: 1 };

    const k = params.get("k");
    const kap = konf.kapitel.find(x => x.id === k);
    const ziel = $("#vs-inhalt");
    ziel.innerHTML = "";
    if (params.get("druck") === "alle") {
      ziel.append(...konf.kapitel.map(x => kapitelAnsicht(x, true)));
      setTimeout(() => window.print(), 300);
    } else if (kap) {
      ziel.append(kapitelAnsicht(kap));
      // Sprung zu einem Abschnitt, z. B. „Wenn es passiert“
      const a = params.get("a");
      if (a) setTimeout(() => { const z = document.getElementById("vs-" + a); if (z) z.scrollIntoView({ block: "start" }); }, 50);
    } else ziel.append(uebersicht());
  }

  // ---------------------------------------------------------------- Übersicht

  function uebersicht() {
    const strom = konf.kapitel.find(x => x.id === "stromausfall");
    const sofort = strom && strom.abschnitte.find(a => a.id === "sofort");
    const liste = el("ol", { class: "eh-lektionen vs-kapitel" });
    konf.kapitel.forEach((x, i) => {
      const n = anzahl(x), fertig = (stand.haken[x.id] || []).length;
      const datum = stand.datum[x.id] ? "zuletzt geprüft am " + new Date(stand.datum[x.id]).toLocaleDateString("de-DE") : "";
      liste.append(el("li", {}, el("a", { href: "#vorsorge?k=" + x.id },
        el("span", { class: "eh-nr" }, i + 1), symFeld(x.icon),
        el("span", { class: "eh-name" }, x.titel, datum ? el("small", {}, datum) : null),
        el("span", { class: "eh-status" + (fertig && fertig === n ? " ok" : "") }, (fertig === n ? "✓ " : "") + fertig + " von " + n))));
    });
    return el("div", { class: "vs-uebersicht" },
      el("p", { class: "hinweis" }, konf.einleitung),
      sofort ? el("a", { class: "vs-sofort", href: "#vorsorge?k=stromausfall&a=sofort" },
        sym("zap-off"), el("span", {}, el("b", {}, "Strom weg und nicht vorbereitet?"), " " + sofort.hinweis.replace(/^Nicht vorbereitet\? /, "")), el("span", { class: "vs-pfeil" }, "→")) : null,
      liste,
      weiterVorsorgen(),
      el("div", { class: "vs-knoepfe" },
        el("a", { class: "knopf knopf-klein", href: "#vorsorge?druck=alle" }, sym("printer"), "Alles drucken"),
        el("button", { class: "knopf knopf-klein", onclick: zuruecksetzen }, "↺ Alles zurücksetzen"),
        el("span", { class: "hinweis klein" }, "Zurücksetzen löscht alle Häkchen, z. B. um alles neu durchzugehen.")));
  }

  function weiterVorsorgen() {
    const w = konf.weiter;
    if (!w) return null;
    const mehr = el("div", { class: "knoepfe" });
    // Aufgebaut wie eine Kapitelzeile, nur mit einem Pfeil statt der Nummer im Kreis
    const box = el("details", { class: "vs-weiter" },
      el("summary", {}, el("span", { class: "eh-nr vs-auf" }, "›"), symFeld("warehouse"), el("span", { class: "eh-name" }, w.titel)),
      el("div", { class: "vs-weiter-inhalt" },
        el("p", {}, w.text),
        el("ul", {}, ...w.punkte.map(p => el("li", {}, p))),
        verweisKnoepfe(w.verweise),
        mehr));
    // Artikel erst suchen, wenn jemand den Abschnitt aufklappt
    box.addEventListener("toggle", () => { if (box.open && !mehr.childNodes.length) mehrLesen(mehr, "weiter", w.artikel); });
    return box;
  }

  async function zuruecksetzen() {
    if (!confirm("Alle Häkchen auf der Seite Vorsorge löschen?")) return;
    stand.haken = {};
    stand.datum = {};
    await speichern();
    zeigen(new URLSearchParams());
  }

  function anzahl(kap) {
    return kap.abschnitte.reduce((s, a) => s + a.gruppen.reduce((t, g) => t + g.punkte.length, 0), 0);
  }
  function speichern() { return api("vorsorge/speichern", stand).catch(() => { }); }

  // ---------------------------------------------------------------- Kapitel

  function kapitelAnsicht(kap, druck) {
    const nr = konf.kapitel.indexOf(kap) + 1;
    const naechstes = konf.kapitel[nr];
    const mehr = el("div", { class: "knoepfe" }, el("span", { class: "hinweis" }, "Artikel werden gesucht …"));
    if (!druck) mehrLesen(mehr, kap.id, kap.artikel || []);
    return el("div", { class: "vs-kapitelseite" },
      druck ? null : el("div", { class: "eh-lektion-kopf vs-knoepfe" },
        el("a", { class: "knopf knopf-klein", href: "#vorsorge" }, "← Übersicht"),
        el("span", { class: "hinweis" }, "Kapitel " + nr + " von " + konf.kapitel.length)),
      el("h2", {}, sym(kap.icon), kap.titel),
      ...kap.warum.map(s => el("p", {}, s)),
      kap.rechner ? rechner() : null,
      ...kap.abschnitte.map(a => abschnitt(kap, a)),
      druck ? null : verweisKnoepfe(kap.verweise),
      druck || !(kap.artikel || []).length ? null : el("div", {}, el("h3", {}, "Mehr lesen"), mehr),
      druck ? null : el("div", { class: "vs-knoepfe vs-fuss" },
        el("a", { class: "knopf", href: "#vorsorge" }, "← Übersicht"),
        el("button", { class: "knopf", onclick: () => window.print() }, sym("printer"), "Drucken"),
        naechstes ? el("a", { class: "knopf knopf-haupt", href: "#vorsorge?k=" + naechstes.id }, "Nächstes Kapitel: " + (naechstes.kurz || naechstes.titel) + " →") : null));
  }

  function abschnitt(kap, a) {
    const d = el("section", { class: "vs-abschnitt" + (a.hervor ? " hervor" : ""), id: a.id ? "vs-" + a.id : null },
      el("h3", {}, a.titel),
      a.hinweis ? el("p", { class: a.hervor ? "vs-hervor-text" : "hinweis" }, a.hinweis) : null,
      ...(a.text || []).map(s => el("p", {}, s)));
    for (const g of a.gruppen) {
      const titel = g.titel || (g.stufe ? konf.stufen[g.stufe] : null);
      d.append(...[
        titel ? el("h4", { class: "vs-gruppe" + (g.stufe ? " stufe-" + g.stufe : "") }, titel) : null,
        el("ul", { class: "eh-ueben vs-liste" }, ...g.punkte.map(p => punkt(kap, p))),
      ].filter(Boolean));
    }
    return d;
  }

  function punkt(kap, p) {
    const liste = stand.haken[kap.id] || [];
    const box = el("input", { type: "checkbox", checked: liste.includes(p.id) });
    box.addEventListener("change", () => {
      const l = (stand.haken[kap.id] || []).filter(x => x !== p.id);
      if (box.checked) l.push(p.id);
      stand.haken[kap.id] = l;
      stand.datum[kap.id] = new Date().toISOString();
      speichern();
    });
    return el("li", {}, el("label", {}, box, " ", p.text, p.mehr ? el("small", { class: "vs-mehr" }, p.mehr) : null));
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
      const zeilen = r.lebensmittel.map(l => {
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
          el("tbody", {}, ...zeilen)),
        (stand.personen.saeugling || 0) > 0 ? el("p", { class: "eh-kinder" }, sym("baby"), " " + r.saeugling) : null,
        el("p", { class: "hinweis klein" }, r.quelle),
      ].filter(Boolean));
    };
    berechne();
    return el("div", { class: "karte-box vs-rechner" },
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
      const buecher = await Kiwix.buecher().catch(() => []);
      for (const titel of titelListe) {
        let treffer = null;
        for (const name of konf.pakete) {
          for (const b of buecher.filter(x => x.name === name)) {
            const v = await Kiwix.vorschlaege(b, titel, 3).catch(() => []);
            treffer = v.find(x => x.titel.toLowerCase() === titel.toLowerCase());
            if (treffer) break;
          }
          if (treffer) break;
        }
        if (treffer && !liste.some(x => x.url === treffer.url)) liste.push(treffer);
      }
      artikelCache[id] = liste;
    }
    ziel.innerHTML = "";
    for (const a of artikelCache[id])
      ziel.append(el("a", { class: "knopf knopf-klein", href: "#lesen?url=" + encodeURIComponent(a.url) + "&titel=" + encodeURIComponent(a.titel) }, sym("book-open"), a.titel));
    if (!artikelCache[id].length) ziel.append(el("span", { class: "hinweis" }, "Keine passenden Artikel gefunden. Dafür wird die Wikipedia gebraucht."));
  }

  return { zeigen };
})();
