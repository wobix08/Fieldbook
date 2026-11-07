// Erste Hilfe: Kurs zum Vorbereiten (Lektionen mit Übungen und Quiz),
// oben der Spickzettel für den Ernstfall.
"use strict";

const ErsteHilfe = (() => {
  let konf = null;
  let stand = null;            // Lernstand aus daten/erstehilfe.json
  let aktiverTakt = null;      // laufende Takt-Übung (wird beim Seitenwechsel gestoppt)
  const artikelCache = {};

  async function zeigen(params) {
    taktStopp();
    if (!konf) konf = await ladeKonfigSprache("erstehilfe");
    if (!stand) stand = await api("erstehilfe").catch(() => ({}));
    if (!stand.lektionen) stand.lektionen = {};
    if (!stand.faelle) stand.faelle = {};

    const k = params.get("k"), l = params.get("l"), f = params.get("f");
    const zettel = konf.spickzettel.find(x => x.id === k);
    const lektion = konf.lektionen.find(x => x.id === l && x.schritte);
    const fall = (konf.fallbeispiele || []).find(x => x.id === f && x.schritte);
    ernstfall(k);
    $("#eh-hinweis").innerHTML = "";
    $("#eh-hinweis").append(hinweisText());
    // In Lektion und Fallbeispiel stehen Ernstfall und Hinweis nicht oben (der Hinweis kommt am Ende)
    $(".ernstfall").hidden = !!(lektion || fall);
    $("#eh-hinweis").hidden = !!(lektion || fall);

    const ziel = $("#eh-inhalt");
    ziel.innerHTML = "";
    if (zettel) ziel.append(spickzettel(zettel));
    else if (lektion) ziel.append(lektionAnsicht(lektion));
    else if (fall) ziel.append(params.get("s") === "2" && hatStufe2(fall) ? fall2Ansicht(fall) : fallAnsicht(fall));
    else ziel.append(kurs());
  }

  // ---------------------------------------------------------------- Im Ernstfall

  function ernstfall(aktiv) {
    const land = Land.aktuell();
    const nr = $("#notruf");
    nr.innerHTML = "";
    // Erste Nummer groß hervorgehoben, die weiteren klein dahinter in einer Zeile
    (land ? land.nummern : [{ nummer: "112", titel: { de: "Notruf" } }]).forEach((n, i) => {
      nr.append(i === 0
        ? el("span", { class: "haupt" }, el("b", {}, sym("phone"), " " + n.nummer), " " + Land.text(n.titel))
        : el("span", {}, el("b", {}, n.nummer), " " + Land.text(n.titel)));
    });
    nr.title = land ? Land.text(land.name) : "";
    // Spickzettel in Spalten nach Gruppen (Lebensgefahr, plötzlich krank, Unfall und Umwelt)
    const k = $("#ernstfall-knoepfe");
    k.innerHTML = "";
    const gruppen = konf.gruppen || [{ id: "", titel: "" }];
    for (const g of gruppen) {
      const zettel = konf.spickzettel.filter(t => (t.gruppe || "") === g.id || (!g.id && !t.gruppe));
      if (!zettel.length) continue;
      k.append(el("div", { class: "e-gruppe" },
        g.titel ? el("div", { class: "e-gruppe-titel" }, g.titel) : null,
        ...zettel.map(t => el("a", { class: "e-knopf" + (t.id === aktiv ? " aktiv" : ""), href: "#erstehilfe?k=" + t.id, title: t.titel },
          sym(t.icon), el("span", {}, t.kurz || t.titel)))));
    }
  }

  function hinweisText() {
    const land = Land.aktuell() || {};
    const a = konf.kursanbieter || {};
    return el("span", {}, el("b", {}, "Dieser Kurs ersetzt keinen echten Erste-Hilfe-Kurs."),
      " Er bereitet dich vor und hilft beim Auffrischen. Handgriffe wie Herzdruckmassage oder stabile Seitenlage lernst du richtig nur unter Anleitung. Kurse gibt es zum Beispiel "
      + (a[land.code] || a.sonst || "beim Roten Kreuz") + ".");
  }

  function spickzettel(t) {
    const artikelKnopf = el("span", { class: "hinweis" }, "Artikel wird gesucht …");
    const lektion = t.lektion && konf.lektionen.find(x => x.id === t.lektion && x.schritte);
    const d = el("div", { class: "notfall-detail" },
      el("h2", {}, sym(t.icon), t.titel),
      el("h3", {}, "Sofort tun"),
      el("ol", {}, ...t.sofort.map(s => el("li", {}, zeilen(s)))),
      t.takt ? taktUebung({}) : null,
      el("div", { class: "knoepfe" },
        el("a", { class: "knopf", href: "#erstehilfe" }, "← Zum Kurs"),
        artikelKnopf,
        lektion ? el("a", { class: "knopf", href: "#erstehilfe?l=" + lektion.id }, sym("graduation-cap"), "Zur Lektion") : null,
        kiKnopf(t.titel + ": Was muss ich tun?")));
    finde(t.id, t.artikel).then(a => {
      if (a) artikelKnopf.replaceWith(artikelLink(a));
      else artikelKnopf.textContent = "Kein Artikel gefunden. Dafür wird die Medizin-Wikipedia oder die Wikipedia gebraucht.";
    });
    return d;
  }

  // ---------------------------------------------------------------- Kurs

  function kurs() {
    const alle = konf.lektionen;
    const fertig = alle.filter(x => istFertig(x.id)).length;
    const naechste = alle.find(x => x.schritte && !istFertig(x.id));
    const d = el("div", { class: "eh-kurs" });
    d.append(
      el("h2", {}, "Dein Erste-Hilfe-Kurs"),
      el("p", { class: "hinweis" }, "Mach den Kurs in Ruhe, bevor etwas passiert. Wer die Handgriffe einmal verstanden und geübt hat, handelt im Ernstfall, ohne lange zu lesen. Die Reihenfolge ist eine Empfehlung, du kannst jede Lektion jederzeit öffnen."),
      el("div", { class: "eh-fortschritt" },
        el("div", { class: "eh-balken" }, el("div", { style: "width:" + Math.round(fertig / alle.length * 100) + "%" })),
        el("span", {}, fertig + " von " + alle.length + " Lektionen abgeschlossen")),
      naechste
        ? el("a", { class: "knopf knopf-haupt eh-weiter", href: "#erstehilfe?l=" + naechste.id }, (fertig ? "Weitermachen: " : "Kurs beginnen: ") + naechste.titel + " →")
        : el("p", { class: "eh-alle" }, "Du hast alle Lektionen abgeschlossen. Zum Auffrischen kannst du jede Lektion jederzeit wiederholen."),
    );
    const liste = el("ol", { class: "eh-lektionen" });
    alle.forEach((x, i) => {
      const status = istFertig(x.id) ? el("span", { class: "eh-status ok" }, "✓ Abgeschlossen")
        : x.schritte ? el("span", { class: "eh-status" }, "Offen")
        : el("span", { class: "eh-status bald" }, "Kommt bald");
      const inhalt = [el("span", { class: "eh-nr" }, i + 1), symFeld(x.icon), el("span", { class: "eh-name" }, x.titel), status];
      liste.append(el("li", {}, x.schritte
        ? el("a", { href: "#erstehilfe?l=" + x.id }, ...inhalt)
        : el("div", { class: "gesperrt" }, ...inhalt)));
    });
    d.append(liste, fallListe(),
      el("p", { class: "eh-vorsorge" }, "Gut vorbereitet sein: Was in den Verbandkasten gehört, welche Vorräte und was bei Stromausfall hilft, steht auf der Seite ",
        el("a", { href: "#vorsorge?k=gesundheit" }, "Vorsorge"), "."),
      el("div", { class: "eh-zuruecksetzen" },
        el("button", { class: "knopf knopf-klein", onclick: zuruecksetzen }, "↺ Kurs zurücksetzen"),
        el("span", { class: "hinweis" }, "Löscht alle abgeschlossenen Lektionen, Fallbeispiele und Häkchen, damit die nächste Person den Kurs von vorn machen kann.")));
    return d;
  }

  function fallListe() {
    const faelle = konf.fallbeispiele || [];
    if (!faelle.length) return null;
    const nummer = (id) => konf.lektionen.findIndex(x => x.id === id) + 1;
    const geschafft = faelle.filter(f => stand.faelle[f.id] && stand.faelle[f.id].stufe1).length;
    const liste = el("ul", { class: "eh-lektionen eh-faelle" });
    for (const f of faelle) {
      const st = stand.faelle[f.id] || {};
      const status = !f.schritte ? el("span", { class: "eh-status bald" }, "Kommt bald")
        : st.stufe2 ? el("span", { class: "eh-status ok" }, "✓ Stufe 1 und 2")
        : st.stufe1 ? el("span", { class: "eh-status ok" }, hatStufe2(f) ? "✓ Stufe 1 · Stufe 2 offen" : "✓ Geschafft")
        : el("span", { class: "eh-status" }, "Offen");
      const inhalt = [symFeld(f.icon),
        el("span", { class: "eh-name" }, f.titel, el("small", {}, "Passt zu Lektion " + (f.lektionen || []).map(nummer).join(", "))),
        status];
      // Nach Stufe 1 führt der Eintrag direkt zu Stufe 2 (Stufe 1 ist von dort aus wiederholbar)
      liste.append(el("li", {}, f.schritte
        ? el("a", { href: "#erstehilfe?f=" + f.id + (st.stufe1 && hatStufe2(f) ? "&s=2" : "") }, ...inhalt)
        : el("div", { class: "gesperrt" }, ...inhalt)));
    }
    return el("div", { class: "eh-fall-bereich" },
      el("h2", {}, "Fallbeispiele"),
      el("p", { class: "hinweis" }, "Kleine Geschichten zum Durchspielen: Was tust du, Schritt für Schritt? Am besten nach den passenden Lektionen. "
        + geschafft + " von " + faelle.length + " fehlerfrei geschafft."),
      liste);
  }

  async function zuruecksetzen() {
    if (!confirm("Kurs zurücksetzen? Alle abgeschlossenen Lektionen, Fallbeispiele und abgehakten Übungen werden gelöscht.")) return;
    stand = { lektionen: {}, faelle: {} };
    await speichern();
    zeigen(new URLSearchParams());
  }

  function istFertig(id) { return !!(stand.lektionen[id] && stand.lektionen[id].fertig); }
  function lernstand(id) { return stand.lektionen[id] || (stand.lektionen[id] = { geuebt: [] }); }
  function speichern() { return api("erstehilfe/speichern", stand).catch(() => { }); }

  // ---------------------------------------------------------------- Lektion

  function lektionAnsicht(t) {
    const nr = konf.lektionen.indexOf(t) + 1;
    const ls = lernstand(t.id);
    if (!ls.geuebt) ls.geuebt = [];
    const d = el("div", { class: "eh-lektion" });
    const fertigBox = el("div", { class: "eh-fertig", hidden: !ls.fertig });
    const zeigeFertig = () => {
      fertigBox.hidden = false;
      fertigBox.innerHTML = "";
      const naechste = konf.lektionen.find(x => x.schritte && !istFertig(x.id));
      fertigBox.append(
        el("b", {}, "✓ Lektion abgeschlossen"),
        " am " + new Date(ls.fertig).toLocaleDateString("de-DE") + ".",
        naechste ? el("a", { class: "knopf knopf-haupt", href: "#erstehilfe?l=" + naechste.id }, "Nächste Lektion: " + naechste.titel + " →")
                 : el("a", { class: "knopf", href: "#erstehilfe" }, "← Zum Kurs"));
    };
    if (ls.fertig) zeigeFertig();

    // Übungen zum Abhaken; die Takt-Übung hakt sich nach 2 Minuten selbst ab
    const uebungen = el("ul", { class: "eh-ueben" });
    for (const u of t.ueben || []) {
      const box = el("input", { type: "checkbox", checked: ls.geuebt.includes(u.id) });
      const setze = (an) => {
        box.checked = an;
        ls.geuebt = ls.geuebt.filter(x => x !== u.id).concat(an ? [u.id] : []);
        speichern();
      };
      box.addEventListener("change", () => setze(box.checked));
      uebungen.append(el("li", {},
        el("label", {}, box, " ", el("span", {}, zeilen(u.text))),
        u.link ? el("a", { class: "knopf knopf-klein eh-uebung-link", href: u.link }, "Öffnen →") : null,
        u.takt ? taktUebung({ dauer: 120, fertig: () => setze(true) }) : null));
    }

    const mehr = el("div", { class: "knoepfe" }, el("span", { class: "hinweis" }, "Artikel werden gesucht …"));
    findeAlle(t.id, t.artikel || []).then(liste => {
      mehr.innerHTML = "";
      for (const a of liste) mehr.append(artikelLink(a));
      if (!liste.length) mehr.append(el("span", { class: "hinweis" }, "Keine Artikel gefunden. Dafür wird die Medizin-Wikipedia oder die Wikipedia gebraucht."));
      const ki = kiKnopf(t.titel + ": ");
      if (ki) mehr.append(ki);
    });

    // el() lässt null weg, d.append() würde „null“ als Text einfügen
    d.append(...[
      el("div", { class: "eh-lektion-kopf" },
        el("a", { class: "knopf knopf-klein", href: "#erstehilfe" }, "← Zum Kurs"),
        el("span", { class: "hinweis" }, "Lektion " + nr + " von " + konf.lektionen.length)),
      el("h2", {}, sym(t.icon), t.titel),
      el("h3", {}, "1. Verstehen"),
      ...t.verstehen.map(s => el("p", {}, zeilen(s))),
      el("h3", {}, "2. Schritt für Schritt"),
      t.bilder ? bilderReihe(t.bilder) : null,
      el("ol", { class: "eh-schritte" }, ...t.schritte.map(s => el("li", {}, zeilen(s)))),
      t.kinder ? el("div", { class: "eh-kinder" }, el("b", {}, sym("baby"), " Bei Kindern: "), el("span", {}, zeilen(t.kinder))) : null,
      el("h3", {}, "3. Jetzt üben"),
      el("p", { class: "hinweis" }, "Am besten mit einer zweiten Person. Hake ab, was du geübt hast."),
      uebungen,
      el("h3", {}, "4. Quiz"),
      quiz(t, () => { if (!ls.fertig) { ls.fertig = new Date().toISOString(); speichern(); } zeigeFertig(); }),
      fertigBox,
      el("h3", {}, "Mehr lesen"),
      mehr,
      el("p", { class: "eh-hinweis klein" }, hinweisText()),
      t.stand ? el("p", { class: "hinweis klein" }, "Inhalte " + t.stand + ".") : null,
    ].filter(Boolean));
    return d;
  }

  // Schritt-Bilder (je Schritt eine Datei, {n} = Nummer), darunter die Quelle
  function bilderReihe(b) {
    return el("div", { class: "eh-bilder" },
      b.titel ? el("b", {}, b.titel) : null,
      el("div", { class: "eh-bilder-reihe" }, ...b.schritte.map((text, i) => el("figure", {},
        el("div", { class: "eh-bild-flaeche" }, el("img", { src: b.datei.replace("{n}", i + 1), alt: text })),
        el("figcaption", {}, el("b", {}, (i + 1) + ". "), text)))),
      b.quelle ? el("small", { class: "hinweis" }, b.quelle) : null);
  }

  // Auswahl-Antworten zu einer Frage. Falsche Antworten darf man wiederholen. Die Antworten stehen
  // jedes Mal in anderer Reihenfolge, damit man nicht nur die Position lernt.
  function auswahl(f, beiRichtig, beiFalsch) {
    const rueck = el("p", { class: "eh-rueck", hidden: true });
    const reihe = f.antworten.map((a, j) => j).sort(() => Math.random() - 0.5);
    const knoepfe = reihe.map(j => el("button", { class: "eh-antwort", onclick: (e) => {
      const b = e.currentTarget;
      if (j === f.richtig) {
        b.classList.add("richtig");
        knoepfe.forEach(x => { x.disabled = true; });
        rueck.className = "eh-rueck richtig";
        rueck.textContent = "Richtig. " + Land.einsetzen(f.erklaerung);
        rueck.hidden = false;
        beiRichtig();
      } else {
        b.classList.add("falsch");
        b.disabled = true;
        rueck.className = "eh-rueck falsch";
        rueck.textContent = "Nicht ganz. Versuch es noch einmal.";
        rueck.hidden = false;
        if (beiFalsch) beiFalsch();
      }
    } }, Land.einsetzen(f.antworten[j])));
    return [el("div", { class: "eh-antworten" }, ...knoepfe), rueck];
  }

  // Quiz einer Lektion: sind alle Fragen richtig beantwortet, ist die Lektion geschafft
  function quiz(t, geschafft) {
    const d = el("div", { class: "eh-quiz" });
    let offen = t.quiz.length;
    t.quiz.forEach((f, i) => {
      d.append(el("div", { class: "eh-frage" }, el("p", {}, el("b", {}, (i + 1) + ". " + f.frage)),
        ...auswahl(f, () => { if (--offen === 0) geschafft(); })));
    });
    return d;
  }

  // ---------------------------------------------------------------- Fallbeispiel (Stufe 1: Auswahl)

  // Die Geschichte geht Schritt für Schritt weiter. Fehlerfrei durchgespielt zählt als geschafft.
  const PLATZ_ANTWORT = 170;   // Pixel unter einer neuen Frage für Erklärung und „Weiter“-Knopf
  function fallAnsicht(f) {
    const d = el("div", { class: "eh-lektion eh-fall" });
    const verlauf = el("div", { class: "eh-fall-verlauf" });
    let fehler = 0;
    const schritt = (i) => {
      if (i >= f.schritte.length) { ende(); return; }
      const s = f.schritte[i];
      const box = el("div", { class: "eh-frage eh-fall-schritt" });
      const weiter = el("button", { class: "knopf knopf-haupt", hidden: true, onclick: () => { weiter.remove(); schritt(i + 1); } },
        i + 1 < f.schritte.length ? "Weiter →" : "Wie geht es aus? →");
      box.append(...[
        s.situation ? el("p", { class: "eh-fall-situation" }, zeilen(s.situation)) : null,
        el("p", {}, el("b", {}, s.frage)),
        ...auswahl(s, () => {
          weiter.hidden = false;
          weiter.focus({ preventScroll: true });
          const fehlt = weiter.getBoundingClientRect().bottom + 16 - innerHeight;
          if (fehlt > 0) window.scrollBy({ top: fehlt, behavior: "smooth" });
        }, () => { fehler++; }),
        weiter,
      ].filter(Boolean));
      verlauf.append(box);
      // Nur so weit rollen, dass die neue Frage samt Platz für Erklärung und „Weiter“ zu sehen ist
      const fehlt = box.getBoundingClientRect().bottom + PLATZ_ANTWORT - innerHeight;
      if (i > 0 && fehlt > 0) window.scrollBy({ top: fehlt, behavior: "smooth" });
    };
    const ende = () => {
      d.classList.add("fertig");
      const fehlerfrei = fehler === 0;
      if (fehlerfrei) {
        if (!stand.faelle[f.id]) stand.faelle[f.id] = {};
        if (!stand.faelle[f.id].stufe1) { stand.faelle[f.id].stufe1 = new Date().toISOString(); speichern(); }
      }
      const stufe2 = hatStufe2(f);
      const box = el("div", { class: fehlerfrei ? "eh-fertig" : "eh-fall-nochmal" },
        el("p", {}, zeilen(f.abschluss || "")),
        el("p", {}, fehlerfrei
          ? el("b", {}, "✓ Fehlerfrei geschafft!" + (stufe2 ? " Jetzt bist du bereit für Stufe 2: Dort antwortest du in eigenen Worten." : ""))
          : el("b", {}, "Geschafft, aber " + fehler + (fehler === 1 ? " Antwort war" : " Antworten waren") + " nicht richtig. Spiel es noch einmal durch, bis alles sitzt. Fehlerfrei geschafft, wird Stufe 2 frei.")),
        el("div", { class: "knoepfe" },
          fehlerfrei ? null : el("button", { class: "knopf knopf-haupt", onclick: () => { d.replaceWith(fallAnsicht(f)); window.scrollTo(0, 0); } }, "↺ Noch einmal"),
          fehlerfrei && stufe2 ? el("a", { class: "knopf knopf-haupt", href: "#erstehilfe?f=" + f.id + "&s=2" }, "Weiter zu Stufe 2 →") : null,
          el("a", { class: "knopf", href: "#erstehilfe" }, "← Zum Kurs")));
      verlauf.append(box);
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    d.append(...fallKopf(f, 1), verlauf, el("p", { class: "eh-hinweis klein" }, hinweisText()));
    schritt(0);
    return d;
  }

  function hatStufe2(f) { return !!(f.schritte && f.schritte.every(s => s.kernpunkte && s.kernpunkte.length)); }
  function stufe1Geschafft(f) { return !!(stand.faelle[f.id] && stand.faelle[f.id].stufe1); }

  // Kopf eines Fallbeispiels: Zurück, Stufe, Titel, passende Lektionen, Einleitung
  function fallKopf(f, stufe) {
    const passend = (f.lektionen || []).map(id => konf.lektionen.find(x => x.id === id)).filter(Boolean);
    const andere = stufe === 1
      ? (hatStufe2(f) && stufe1Geschafft(f) ? el("a", { href: "#erstehilfe?f=" + f.id + "&s=2" }, "Zu Stufe 2 →") : null)
      : el("a", { href: "#erstehilfe?f=" + f.id }, "Stufe 1 wiederholen");
    return [
      el("div", { class: "eh-lektion-kopf" },
        el("a", { class: "knopf knopf-klein", href: "#erstehilfe" }, "← Zum Kurs"),
        el("span", { class: "hinweis" }, "Fallbeispiel · " + (stufe === 1 ? "Stufe 1: Auswählen" : "Stufe 2: In eigenen Worten")),
        andere),
      el("h2", {}, sym(f.icon), f.titel),
      passend.length ? el("p", { class: "hinweis" }, "Passt zu: ", ...passend.flatMap((x, i) => [i ? ", " : "", el("a", { href: "#erstehilfe?l=" + x.id }, x.titel)])) : null,
      el("p", { class: "eh-fall-situation eh-fall-start" }, zeilen(f.einleitung)),
    ].filter(Boolean);
  }

  // ---------------------------------------------------------------- Fallbeispiel (Stufe 2: freie Antwort)

  // Man schreibt selbst, was man tun würde. Die KI prüft nur gegen die festen Kernpunkte und Fehler
  // des Schritts; ohne KI hakt man selbst ab. Danach kommt immer die Musterlösung.
  function fall2Ansicht(f) {
    const d = el("div", { class: "eh-lektion eh-fall" });
    if (!stufe1Geschafft(f)) {
      d.append(...fallKopf(f, 2), el("div", { class: "eh-fall-nochmal" },
        el("p", {}, "Stufe 2 wird frei, sobald du Stufe 1 fehlerfrei geschafft hast."),
        el("a", { class: "knopf knopf-haupt", href: "#erstehilfe?f=" + f.id }, "Zu Stufe 1 →")));
      return d;
    }
    const verlauf = el("div", { class: "eh-fall-verlauf" });
    let genannt = 0, gesamt = 0, gefaehrlich = 0;
    const zaehler = [];   // je Schritt eine Funktion, die die Punkte am Ende liefert
    const schritt = (i) => {
      if (i >= f.schritte.length) { ende(); return; }
      const s = f.schritte[i];
      const feld = el("textarea", { class: "eh-freitext", rows: 3, placeholder: "Was tust du? Schreib es in eigenen Worten, Stichworte reichen." });
      const pruefen = el("button", { class: "knopf knopf-haupt" }, "Antwort prüfen");
      const ergebnis = el("div", { class: "eh-freitext-ergebnis" });
      const weiter = el("button", { class: "knopf knopf-haupt", hidden: true, onclick: () => { weiter.remove(); schritt(i + 1); } },
        i + 1 < f.schritte.length ? "Weiter →" : "Wie geht es aus? →");
      const box = el("div", { class: "eh-frage eh-fall-schritt" }, ...[
        s.situation ? el("p", { class: "eh-fall-situation" }, zeilen(s.situation)) : null,
        el("p", {}, el("b", {}, s.frage2 || s.frage)),
        feld,
        el("div", { class: "knoepfe" }, pruefen, KI.bereit() ? null : el("span", { class: "hinweis" }, "Ohne KI vergleichst du deine Antwort danach selbst.")),
        ergebnis,
        weiter,
      ].filter(Boolean));
      const fertig = () => {
        weiter.hidden = false;
        weiter.focus({ preventScroll: true });
        const fehlt = weiter.getBoundingClientRect().bottom + 16 - innerHeight;
        if (fehlt > 0) window.scrollBy({ top: fehlt, behavior: "smooth" });
      };
      pruefen.addEventListener("click", async () => {
        const antwort = feld.value.trim();
        if (antwort.length < 3) { feld.focus(); return; }
        feld.disabled = true;
        pruefen.remove();
        let bewertung = null;
        if (KI.bereit()) {
          ergebnis.append(el("p", { class: "hinweis" }, "Die KI prüft deine Antwort …"));
          bewertung = await kiBewertung(f, s, antwort).catch(() => null);
          ergebnis.innerHTML = "";
          if (!bewertung) ergebnis.append(el("p", { class: "hinweis" }, "Die KI konnte die Antwort gerade nicht prüfen. Vergleich sie bitte selbst."));
        }
        ergebnis.append(...rueckmeldung(s, bewertung, zaehler, i));
        fertig();
      });
      verlauf.append(box);
      const fehlt = box.getBoundingClientRect().bottom + PLATZ_ANTWORT - innerHeight;
      if (i > 0 && fehlt > 0) window.scrollBy({ top: fehlt, behavior: "smooth" });
      if (i > 0) feld.focus({ preventScroll: true });
    };
    const ende = () => {
      d.classList.add("fertig");
      for (const z of zaehler) { const p = z(); genannt += p.genannt; gesamt += p.gesamt; gefaehrlich += p.fehler; }
      if (!stand.faelle[f.id]) stand.faelle[f.id] = {};
      stand.faelle[f.id].stufe2 = { zeit: new Date().toISOString(), genannt, gesamt };
      speichern();
      const gut = genannt >= gesamt * 0.75 && !gefaehrlich;
      const box = el("div", { class: gut ? "eh-fertig" : "eh-fall-nochmal" },
        el("p", {}, zeilen(f.abschluss || "")),
        el("p", {}, el("b", {}, "Du hast " + genannt + " von " + gesamt + " wichtigen Punkten genannt"
          + (gefaehrlich ? " und " + gefaehrlich + (gefaehrlich === 1 ? " gefährlichen Fehler" : " gefährliche Fehler") + " gemacht." : ".")
          + (gut ? " Sehr gut, das sitzt!" : " Lies die Musterlösungen oben noch einmal und spiel es dann erneut durch."))),
        el("div", { class: "knoepfe" },
          el("button", { class: "knopf" + (gut ? "" : " knopf-haupt"), onclick: () => { d.replaceWith(fall2Ansicht(f)); window.scrollTo(0, 0); } }, "↺ Noch einmal"),
          el("a", { class: "knopf", href: "#erstehilfe" }, "← Zum Kurs")));
      verlauf.append(box);
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    d.append(...fallKopf(f, 2),
      el("p", { class: "hinweis eh-fall-anleitung" }, zeilen("Diesmal gibt es keine Auswahl. Schreib zu jedem Schritt, was du tun würdest."
        + (KI.bereit() ? " Die KI vergleicht deine Antwort mit den wichtigsten Punkten, danach siehst du die Musterlösung." : " Danach siehst du die wichtigsten Punkte und die Musterlösung."))),
      verlauf, el("p", { class: "eh-hinweis klein" }, hinweisText()));
    schritt(0);
    return d;
  }

  // Ergebnis eines Schritts: Kernpunkte (von der KI erkannt oder zum Selbst-Abhaken), gefährliche Fehler, Musterlösung
  function rueckmeldung(s, bewertung, zaehler, i) {
    const teile = [];
    if (bewertung) {
      const ok = s.kernpunkte.filter(k => bewertung.genannt.includes(k.id));
      const fehlerGefunden = (s.fehler || []).filter(x => bewertung.fehler.includes(x.id));
      teile.push(el("p", {}, el("b", {}, ok.length === s.kernpunkte.length ? "Sehr gut, du hast an alles gedacht." : "Du hast " + ok.length + " von " + s.kernpunkte.length + " wichtigen Punkten genannt.")),
        el("ul", { class: "eh-kernpunkte" }, ...s.kernpunkte.map(k => el("li", { class: ok.includes(k) ? "ja" : "nein" },
          (ok.includes(k) ? "✓ " : "○ ") + Land.einsetzen(k.text)))));
      if (fehlerGefunden.length) teile.push(el("ul", { class: "eh-kernpunkte" }, ...fehlerGefunden.map(x => el("li", { class: "gefahr" }, sym("triangle-alert"), " Vorsicht: " + Land.einsetzen(x.text)))));
      zaehler[i] = () => ({ genannt: ok.length, gesamt: s.kernpunkte.length, fehler: fehlerGefunden.length });
    } else {
      const kaestchen = s.kernpunkte.map(k => el("input", { type: "checkbox" }));
      teile.push(el("p", {}, el("b", {}, "Hake ab, woran du gedacht hast:")),
        el("ul", { class: "eh-kernpunkte selbst" }, ...s.kernpunkte.map((k, j) => el("li", {}, el("label", {}, kaestchen[j], " ", Land.einsetzen(k.text))))));
      if (s.fehler && s.fehler.length) teile.push(el("p", { class: "hinweis" }, "Vermeiden solltest du: " + s.fehler.map(x => Land.einsetzen(x.text)).join("; ") + "."));
      zaehler[i] = () => ({ genannt: kaestchen.filter(x => x.checked).length, gesamt: s.kernpunkte.length, fehler: 0 });
    }
    teile.push(el("p", { class: "eh-muster" }, el("b", {}, "Musterlösung: "), Land.einsetzen(s.antworten[s.richtig]), " ", Land.einsetzen(s.erklaerung)));
    return teile;
  }

  // Die KI sagt nur, welche Kernpunkte und Fehler in der Antwort stecken (feste Kennungen, JSON-Schema).
  // Sie schreibt keinen eigenen Text, damit sie keine falschen Ratschläge erfinden kann.
  async function kiBewertung(f, s, antwort) {
    const kp = s.kernpunkte.map(k => "- " + k.id + ": " + Land.einsetzen(k.text)).join("\n");
    const fe = (s.fehler || []).map(x => "- " + x.id + ": " + Land.einsetzen(x.text)).join("\n");
    const ids = (liste) => liste.length ? { type: "array", items: { type: "string", enum: liste.map(x => x.id) } } : { type: "array", maxItems: 0 };
    const schema = { type: "object", properties: { genannt: ids(s.kernpunkte), fehler: ids(s.fehler || []) }, required: ["genannt", "fehler"] };
    const sys = "Du prüfst Antworten in einem Erste-Hilfe-Kurs. Du bekommst eine Situation, eine Frage, eine Liste von Kernpunkten, "
      + "eine Liste gefährlicher Fehler und die Antwort eines Lernenden. "
      + "In 'genannt' stehen die Kennungen aller Kernpunkte, die die Antwort sinngemäß enthält. Andere Worte, Umgangssprache, "
      + "Stichworte und Tippfehler sind in Ordnung, aber der Kernpunkt muss wirklich gemeint sein. "
      + "In 'fehler' stehen die Kennungen der gefährlichen Fehler, die die Antwort tatsächlich vorschlägt. Erwähnt die Antwort einen Fehler nur, "
      + "um ihn abzulehnen, zählt er nicht. Antworte nur mit JSON.";
    const user = "Situation: " + Land.einsetzen([f.einleitung].concat(f.schritte.slice(0, f.schritte.indexOf(s) + 1).map(x => x.situation || "")).filter(Boolean).join(" "))
      + "\nFrage: " + (s.frage2 || s.frage)
      + "\nKernpunkte:\n" + kp
      + (fe ? "\nGefährliche Fehler:\n" + fe : "")
      + "\nAntwort des Lernenden: \"" + antwort.replace(/"/g, "'").slice(0, 1500) + "\"";
    const roh = await KI.chat([{ role: "system", content: sys }, { role: "user", content: user }],
      { max_tokens: 150, temperature: 0, response_format: { type: "json_schema", json_schema: { name: "bewertung", schema } } });
    let j;
    try { j = JSON.parse(roh); } catch { const m = roh.match(/\{[\s\S]*\}/); j = m ? JSON.parse(m[0]) : null; }
    if (!j) return null;
    return { genannt: Array.isArray(j.genannt) ? j.genannt : [], fehler: Array.isArray(j.fehler) ? j.fehler : [] };
  }

  // ---------------------------------------------------------------- Takt für die Herzdruckmassage

  // dauer: Sekunden bis zum Ende (Übung), ohne dauer läuft der Takt, bis man ihn stoppt (Ernstfall).
  function taktUebung(opt) {
    const TAKT = 60000 / 110;   // 110 Mal pro Minute, Mitte von 100 bis 120
    const zahl = el("div", { class: "takt-zahl" }, "30");
    const info = el("div", { class: "takt-info" }, opt.dauer ? "2 Minuten im Takt drücken" : "Piepton im richtigen Takt");
    const mitBeatmung = el("input", { type: "checkbox", checked: true });
    const knopf = el("button", { class: "knopf knopf-haupt" }, "▶ Takt starten");
    const box = el("div", { class: "takt" },
      zahl,
      el("div", { class: "takt-rechts" }, info,
        el("div", { class: "knoepfe" }, knopf, el("label", { class: "hinweis" }, mitBeatmung, " Nach 30 Mal: 2 Mal beatmen"))));

    let audio = null, timer = null, start = 0, naechster = 0, zaehler = 0, laeuft = false;
    const ton = (freq, ms) => {
      try {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.25, audio.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
        o.connect(g).connect(audio.destination);
        o.start(); o.stop(audio.currentTime + ms / 1000);
      } catch { }
    };
    const zeit = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
    const schritt = () => {
      if (!laeuft) return;
      const verstrichen = (performance.now() - start) / 1000;
      if (opt.dauer && verstrichen >= opt.dauer) { stopp(true); return; }
      zaehler++;
      zahl.textContent = zaehler;
      zahl.classList.remove("puls"); void zahl.offsetWidth; zahl.classList.add("puls");
      ton(zaehler === 30 ? 1320 : 880, 70);
      info.textContent = opt.dauer ? "Noch " + zeit(opt.dauer - verstrichen) : "Seit " + zeit(verstrichen);
      if (zaehler >= 30) {
        zaehler = 0;
        if (mitBeatmung.checked) {
          // Kurze Pause zum Beatmen, zwei tiefe Töne
          naechster += TAKT;
          setTimeout(() => { if (laeuft) { zahl.textContent = "2× beatmen"; zahl.classList.add("beatmen"); ton(440, 300); } }, TAKT);
          setTimeout(() => { if (laeuft) ton(440, 300); }, TAKT + 1500);
          naechster += 4500;
          timer = setTimeout(() => { zahl.classList.remove("beatmen"); weiter(); }, naechster - performance.now());
          return;
        }
      }
      weiter();
    };
    const weiter = () => {
      naechster += TAKT;
      timer = setTimeout(schritt, Math.max(0, naechster - performance.now()));
    };
    const stopp = (geschafft) => {
      laeuft = false;
      clearTimeout(timer);
      zahl.classList.remove("beatmen", "puls");
      zahl.textContent = "30";
      info.textContent = opt.dauer ? "2 Minuten im Takt drücken" : "Piepton im richtigen Takt";
      knopf.textContent = "▶ Takt starten";
      if (aktiverTakt && aktiverTakt.stopp === stopp) aktiverTakt = null;
      if (geschafft) {
        zahl.textContent = "✓";
        info.textContent = "2 Minuten geschafft! Jetzt würde ein zweiter Helfer übernehmen. Anstrengend, oder? Genau deshalb wechselt man sich ab.";
        if (opt.fertig) opt.fertig();
      }
    };
    knopf.addEventListener("click", () => {
      if (laeuft) { stopp(false); return; }
      taktStopp();
      if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { } }
      if (audio && audio.state === "suspended") audio.resume();
      laeuft = true;
      zaehler = 0;
      start = naechster = performance.now();
      knopf.textContent = "■ Stopp";
      aktiverTakt = { stopp };
      schritt();
    });
    return box;
  }

  function taktStopp() { if (aktiverTakt) aktiverTakt.stopp(false); }
  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#erstehilfe")) taktStopp(); });

  // ---------------------------------------------------------------- Artikel und KI

  function artikelLink(a) {
    return el("a", { class: "knopf", href: "#lesen?url=" + encodeURIComponent(a.url) + "&titel=" + encodeURIComponent(a.titel) }, sym("book-open"), a.titel);
  }

  function kiKnopf(frage) {
    if (!OW.status || !OW.status.modell) return null;
    return el("a", { class: "knopf", href: "#fragen", onclick: () => setTimeout(() => { const f = $("#frage-feld"); f.value = frage; f.focus(); }, 60) }, sym("message-circle"), "Die KI fragen");
  }

  // Exakter Treffer für einen Titel in der Reihenfolge der Pakete
  async function exakt(titel) {
    const buecher = await Kiwix.buecher();
    for (const name of konf.pakete) {
      for (const b of buecher.filter(x => x.name === name)) {
        const v = await Kiwix.vorschlaege(b, titel, 3).catch(() => []);
        const e = v.find(x => x.titel.toLowerCase() === titel.toLowerCase());
        if (e) return e;
      }
    }
    return null;
  }

  // Erster passender Artikel; ohne exakten Treffer der erste Vorschlag zum ersten Titel
  async function finde(id, titelListe) {
    if (id in artikelCache) return artikelCache[id];
    for (const titel of titelListe) {
      const e = await exakt(titel);
      if (e) return (artikelCache[id] = e);
    }
    const buecher = await Kiwix.buecher();
    for (const name of konf.pakete) {
      for (const b of buecher.filter(x => x.name === name)) {
        const v = await Kiwix.vorschlaege(b, titelListe[0], 1).catch(() => []);
        if (v[0]) return (artikelCache[id] = v[0]);
      }
    }
    return (artikelCache[id] = null);
  }

  // Alle Titel, die es exakt gibt (für „Mehr lesen“ in einer Lektion)
  async function findeAlle(id, titelListe) {
    const schluessel = "l:" + id;
    if (schluessel in artikelCache) return artikelCache[schluessel];
    const liste = [];
    for (const titel of titelListe) {
      const e = await exakt(titel);
      if (e && !liste.some(x => x.url === e.url)) liste.push(e);
    }
    return (artikelCache[schluessel] = liste);
  }

  return { zeigen };
})();
