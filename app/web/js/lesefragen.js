// Lesefenster: Seitenleiste „Zu diesem Artikel“. Die KI fasst den offenen Artikel zusammen, erklärt ihn einfach
// oder beantwortet eine Frage dazu. Anders als auf der Seite „Fragen“ gibt es keine Suche und keine Quellenprüfung,
// die KI liest nur diesen einen Artikel. Ohne Grafikkarte kommt das erste Wort deshalb viel früher.
"use strict";

const LeseFragen = (() => {
  const leiste = $("#lese-fragen"), knopf = $("#lese-fragen-knopf"), verlauf = $("#lf-verlauf");
  const feld = $("#lf-feld"), senden = $("#lf-senden"), rahmen = $("#lese-rahmen");
  let artikelUrl = null;        // Artikel, zu dem der Verlauf gehört
  let eintraege = [];           // [{frage, antwort}] zu diesem Artikel, für Rückfragen
  let lauf = null;              // { abbrechen } während die KI schreibt
  let nachher = 0;              // zweite Messung für die Artikelmitte (siehe mitteHalten)

  const aufProzessor = () => ((OW.status || {}).backend || "cpu") === "cpu";
  const kiEingerichtet = () => !!(OW.status && OW.status.modell);

  // Gerade angezeigter Artikel im inneren Rahmen des Kiwix-Viewers (ohne Suchseiten, Zufall und PDFs)
  function aktuellerArtikel() {
    try {
      const rahmen = $("#lese-rahmen");
      const innen = rahmen.contentDocument.getElementById("content_iframe");
      const l = (innen || rahmen).contentWindow.location;
      if (!/^\/kiwix\/content\/[^/]+\/./.test(l.pathname) || /\.pdf$/i.test(l.pathname)) return null;
      const doc = (innen || rahmen).contentDocument;
      const h1 = doc && doc.querySelector("h1");
      return { url: l.pathname, titel: ((h1 && h1.textContent) || (doc && doc.title) || "").replace(/\s+/g, " ").trim() };
    } catch { return null; }
  }

  // Knopf nur, wenn eine KI eingerichtet ist (auch im Sparmodus: dann erklärt die Leiste, wie man sie einschaltet)
  function knopfAnpassen() {
    knopf.hidden = !kiEingerichtet();
    if (knopf.hidden && !leiste.hidden) schliessen();
  }

  function oeffnen() {
    leiste.hidden = false;
    breiteSetzen(breite, false);
    knopf.setAttribute("aria-expanded", "true");
    artikelPruefen();
    setTimeout(() => feld.focus(), 30);
  }
  function schliessen() {
    leiste.hidden = true;
    knopf.setAttribute("aria-expanded", "false");
    mitteHalten();
  }
  knopf.addEventListener("click", () => leiste.hidden ? oeffnen() : schliessen());

  // Breite der Leiste: am linken Rand ziehen (oder Pfeiltasten am Griff), Doppelklick stellt 380 px wieder her.
  // Gemerkt im Browser wie die Größe im PDF-Leser; gilt für alle Artikel und nach dem Neustart.
  const STANDARD = 380, MIN = 300;
  const griff = $("#lf-griff"), koerper = leiste.parentElement;
  // Versteckt (anderer Bereich offen) ist der Körper 0 px breit: dann nicht begrenzen, beim Öffnen wird neu gerechnet
  const maxBreite = () => koerper.clientWidth ? Math.max(MIN, Math.min(koerper.clientWidth * 0.7, 1400)) : 2000;
  let breite = STANDARD;
  try { const b = parseInt(localStorage.getItem("lfBreite"), 10); if (b >= MIN) breite = b; } catch { }
  function breiteSetzen(b, merken) {
    breite = Math.round(Math.min(Math.max(b, MIN), Math.max(MIN, 2000)));
    // Im schmalen Fenster begrenzt die CSS-Regel max-width auf die Fensterbreite, gemerkt wird trotzdem der Wunsch
    leiste.style.width = Math.min(breite, maxBreite()) + "px";
    griff.setAttribute("aria-valuenow", String(breite));
    mitteHalten();
    if (merken) try { if (breite === STANDARD) localStorage.removeItem("lfBreite"); else localStorage.setItem("lfBreite", String(breite)); } catch { }
  }
  breiteSetzen(breite, false);
  window.addEventListener("resize", () => breiteSetzen(breite, false));

  // Artikel in der Mitte halten: Viele Pakete (z. B. Wikipedia) haben eine Höchstbreite und stehen mittig in ihrem
  // Rahmen. Wird der Rahmen schmaler, weil die Leiste aufgeht, rückt der Artikel sonst sofort nach links. Deshalb
  // bekommt der Rahmen links so viel Abstand, dass der Text in der Fenstermitte bleibt, solange die Leiste ihn nicht
  // berührt; danach rückt er nur so weit wie nötig. Seiten ohne Höchstbreite füllen den Platz wie bisher.
  function inhaltsDok() {
    try {
      const innen = rahmen.contentDocument.getElementById("content_iframe");
      // Breiten abfragen, damit der Browser erst die äußeren Rahmen neu umbricht und dann gemessen wird
      void rahmen.offsetWidth;
      if (innen) void innen.offsetWidth;
      return (innen || rahmen).contentDocument;
    } catch { return null; }
  }
  // Höchstbreite des Textes (Absätze, Überschriften, Bilder, Tabellen) oder null, wenn er den Rahmen ausfüllt.
  // Messen lässt sie sich nur, solange der Rahmen deutlich breiter ist (Rand ab 40 px); ist er schmaler, bricht der
  // Text um und wirkt schmaler. Deshalb gilt die größte gemessene Breite, gemerkt am Dokument des Artikels.
  function textBreite(d) {
    if (!d || !d.body) return null;
    const m = randMessen(d);
    if (m && m.rand >= 40) d.fbTextBreite = Math.max(d.fbTextBreite || 0, m.breite);
    return d.fbTextBreite || null;
  }
  function randMessen(d) {
    const cw = d.documentElement.clientWidth;
    let links = Infinity, rechts = -Infinity;
    const teile = d.body.querySelectorAll("p, h1, h2, h3, li, img, table, pre, dl, figure");
    for (let i = 0; i < teile.length && i < 400; i++) {
      const b = teile[i].getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      if (b.left < links) links = b.left;
      if (b.right > rechts) rechts = b.right;
    }
    if (links === Infinity) return null;
    const rand = Math.min(links, cw - rechts);
    return { rand, breite: cw - 2 * rand };
  }
  // Kleinste Rahmenbreite, bei der der Text noch seine gemessene Breite w hat. Gesucht wird zwischen der Breite,
  // bei der er breiter wurde (unten), und der vollen Breite (oben). Dafür wird die Leiste kurz ausgeblendet und
  // der Rahmen probeweise verbreitert; alles in einem Rutsch vor dem nächsten Bild, also unsichtbar.
  function grenzeSuchen(d, w, unten, oben) {
    const alt = rahmen.style.marginLeft;
    leiste.style.display = "none";
    const passt = (breite) => {
      rahmen.style.marginLeft = Math.max(0, oben - breite) + "px";
      inhaltsDok();   // äußere Rahmen neu umbrechen lassen
      const m = randMessen(d);
      return m && m.breite <= w + 8;
    };
    let ergebnis = oben;
    if (passt(oben)) {
      let lo = unten, hi = oben;   // bei lo zu breit, bei hi passt es
      while (hi - lo > 8) { const mitte = Math.round((lo + hi) / 2); if (passt(mitte)) hi = mitte; else lo = mitte; }
      ergebnis = hi;
    } else ergebnis = Infinity;
    leiste.style.display = "";
    rahmen.style.marginLeft = alt;
    return ergebnis;
  }
  // Nach jeder Änderung ein Bild später noch einmal: Lag die Messung zwischen zwei Umbrüchen, stimmt es dann
  function mitteHalten() {
    mitteJetzt();
    cancelAnimationFrame(nachher);
    nachher = requestAnimationFrame(mitteJetzt);
  }
  function mitteJetzt() {
    const offen = !leiste.hidden && getComputedStyle(leiste).position !== "absolute";
    let abstand = 0;
    // Auch bei geschlossener Leiste messen: Dann ist der Rahmen am breitesten
    const d = inhaltsDok();
    const w = textBreite(d);
    const F = koerper.clientWidth, P = leiste.offsetWidth;
    const berechnen = () => {
      const bildlauf = d.defaultView.innerWidth - d.documentElement.clientWidth;   // Bildlaufleiste im Rahmen
      // Unterhalb von d.fbGrenze stellt das Paket den Text breiter dar (Wikipedia unter etwa 1.150 px): Der Rahmen
      // soll dann nicht darunter fallen, sonst springt der Text zur Leiste hin. Passt das nicht mehr, ganz ohne Abstand.
      const grenze = d.fbGrenze || 0;
      if (grenze > F - P) return 0;
      // Rahmen symmetrisch zur Fenstermitte (F − 2P), höchstens so schmal wie Text plus 32 px Rand je Seite
      const ziel = Math.max(F - 2 * P, Math.min(Math.max(w + 64 + bildlauf, grenze), F - P));
      return Math.max(0, Math.round(F - P - ziel));
    };
    if (offen && w) abstand = berechnen();
    rahmen.style.marginLeft = abstand ? abstand + "px" : "";
    // Wird der Text bei dieser Rahmenbreite breiter als gemessen, die Grenze einmal suchen und neu rechnen
    if (abstand && d.fbGrenze === undefined) {
      const jetzt = randMessen(d);
      if (jetzt && jetzt.breite > w + 8) {
        d.fbGrenze = grenzeSuchen(d, w, d.documentElement.clientWidth + (d.defaultView.innerWidth - d.documentElement.clientWidth), F);
        abstand = berechnen();
        rahmen.style.marginLeft = abstand ? abstand + "px" : "";
      }
    }
    // Der freie Streifen links bekommt die Hintergrundfarbe des Artikels
    let grund = "";
    if (abstand && d) {
      const b = getComputedStyle(d.body).backgroundColor, h = getComputedStyle(d.documentElement).backgroundColor;
      grund = !/rgba\(0, 0, 0, 0\)|transparent/.test(b) ? b : h;
    }
    koerper.style.background = grund;
  }
  window.addEventListener("resize", mitteHalten);
  rahmen.addEventListener("load", () => {
    mitteHalten();
    try {
      const innen = rahmen.contentDocument.getElementById("content_iframe");
      // Nach dem Laden ändert sich das Layout oft noch (Schriften, Bilder): kurz danach noch einmal messen
      if (innen) innen.addEventListener("load", () => { mitteHalten(); setTimeout(mitteHalten, 600); });
    } catch { }
  });
  griff.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    griff.setPointerCapture(e.pointerId);
    griff.classList.add("zieht");
    koerper.classList.add("zieht");
    const rechts = koerper.getBoundingClientRect().right;
    const bewegen = (ev) => breiteSetzen(Math.min(rechts - ev.clientX, maxBreite()), false);
    const ende = () => {
      griff.removeEventListener("pointermove", bewegen);
      griff.classList.remove("zieht");
      koerper.classList.remove("zieht");
      breiteSetzen(breite, true);
    };
    griff.addEventListener("pointermove", bewegen);
    griff.addEventListener("pointerup", ende, { once: true });
    griff.addEventListener("pointercancel", ende, { once: true });
  });
  griff.addEventListener("dblclick", () => breiteSetzen(STANDARD, true));
  griff.addEventListener("keydown", (e) => {
    const schritt = e.shiftKey ? 100 : 20;
    if (e.key === "ArrowLeft") breiteSetzen(Math.min(breite + schritt, maxBreite()), true);
    else if (e.key === "ArrowRight") breiteSetzen(breite - schritt, true);
    else return;
    e.preventDefault();
  });
  $("#lf-zu").addEventListener("click", () => { schliessen(); knopf.focus(); });
  leiste.addEventListener("keydown", (e) => { if (e.key === "Escape") { schliessen(); knopf.focus(); } });

  // Neuer Artikel im Lesefenster: Verlauf leeren, eine laufende Antwort zum alten Artikel abbrechen
  function artikelPruefen() {
    const a = aktuellerArtikel();
    const url = a ? a.url : null;
    if (url === artikelUrl && verlauf.children.length) return;
    artikelUrl = url;
    eintraege = [];
    if (lauf) lauf.abbrechen();
    verlauf.replaceChildren(el("p", { class: "lf-leer" }, a
      ? ["Die KI liest nur diesen Artikel", a.titel ? el("b", {}, " „" + a.titel + "“") : null, ".", el("br"),
        "Du kannst ihn zusammenfassen oder einfach erklären lassen oder etwas dazu fragen."]
      : ["Öffne einen Artikel, dann kannst du die KI dazu fragen."]));
    sperren(!a);
  }

  function sperren(an) {
    leiste.querySelectorAll(".lf-schnell .knopf").forEach(k => { k.disabled = an; });
    if (!lauf) senden.disabled = an;
  }

  // Beim Wechsel des Artikels (äußerer und innerer Rahmen, wie in bibliothek.js) und beim Öffnen des Lesefensters
  $("#lese-rahmen").addEventListener("load", () => {
    if (!leiste.hidden) artikelPruefen();
    try {
      const w = $("#lese-rahmen").contentWindow;
      w.addEventListener("hashchange", () => { if (!leiste.hidden) artikelPruefen(); });
      const innen = w.document.getElementById("content_iframe");
      if (innen) innen.addEventListener("load", () => { if (!leiste.hidden) artikelPruefen(); });
    } catch { }
  });
  window.addEventListener("hashchange", () => { if (location.hash.startsWith("#lesen")) knopfAnpassen(); });
  // Status kommt beim Start etwas später: einmal nachsehen, sobald er da ist
  const warteAufStatus = setInterval(() => { if (OW.status) { clearInterval(warteAufStatus); knopfAnpassen(); } }, 500);

  leiste.querySelectorAll(".lf-schnell .knopf").forEach(k => k.addEventListener("click", () => fragen(k.dataset.art)));
  $("#lf-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (lauf) { lauf.abbrechen(); return; }
    const f = feld.value.trim();
    if (f) fragen("frage", f);
  });
  feld.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#lf-form").requestSubmit(); } });

  // Wie viel Artikeltext die KI bekommt (wie auf der Seite „Fragen“: ohne Grafikkarte 4.500 Zeichen)
  function budget() {
    const s = OW.status || {};
    const ctx = (s.ki && s.ki.kontext) || 8192;
    return Math.min(aufProzessor() ? 4500 : 9000, Math.floor(ctx * 0.55 * 3));
  }

  const abschnittText = (s) => (s.ueberschrift ? "[" + s.ueberschrift + "] " : "") + s.text;

  // Text für die KI. Passt der Artikel nicht ganz hinein: zum Zusammenfassen der Anfang, bei einer Frage die
  // Einleitung und die Abschnitte, die nach Bedeutung (Suchhilfe) oder gleichen Wörtern am besten passen.
  async function textFuer(a, frage, max) {
    const alle = a.abschnitte;
    const ganz = alle.map(abschnittText).join("\n");
    if (ganz.length <= max) return { text: ganz, gekuerzt: false };
    if (!frage) {
      let text = "";
      for (const s of alle) { const t = abschnittText(s); if (text.length + t.length > max) break; text += (text ? "\n" : "") + t; }
      return { text: text || ganz.slice(0, max), gekuerzt: true, anfang: true };
    }
    // Abschnitte zu Stücken von etwa 1.000 Zeichen zusammenfassen, damit kurze Listenpunkte nicht einzeln zählen
    const stuecke = [];
    alle.forEach((s, i) => {
      const letzt = stuecke[stuecke.length - 1];
      if (letzt && letzt.laenge < 1000 && letzt.ueberschrift === s.ueberschrift) { letzt.idx.push(i); letzt.laenge += s.text.length; }
      else stuecke.push({ idx: [i], laenge: s.text.length, ueberschrift: s.ueberschrift });
    });
    const inhalt = (st) => st.idx.map(i => abschnittText(alle[i])).join("\n");
    // Gleiche Wortanfänge als einfache Bewertung (auch ohne Suchhilfe)
    const woerter = [...new Set(frage.toLowerCase().split(/[^a-zäöüß0-9]+/).filter(w => w.length > 3).map(w => w.slice(0, 6)))];
    let werte = stuecke.map(st => { const lc = inhalt(st).toLowerCase(); return woerter.filter(w => lc.includes(w)).length; });
    // Suchhilfe: läuft immer auf dem Prozessor und kostet etwa 0,1 bis 0,15 s je Stück (gemessen Nov. 2026).
    // Deshalb höchstens 30 Stücke, je nur der Anfang; bei sehr langen Artikeln die 30 mit den meisten gleichen Wörtern.
    if ((((OW.status || {}).ki) || {}).suchhilfe) {
      const kandidaten = stuecke.map((st, i) => i);
      if (kandidaten.length > 30) kandidaten.sort((x, y) => werte[y] - werte[x] || x - y).splice(30);
      try {
        const sim = await nachBedeutung(frage, kandidaten.map(i => inhalt(stuecke[i])));
        const neu = stuecke.map(() => -1);
        kandidaten.forEach((i, k) => { neu[i] = sim[k]; });
        werte = neu;
      } catch { /* Suchhilfe antwortet nicht: gleiche Wörter reichen */ }
    }
    // Einleitung immer, dann die besten Stücke, am Ende wieder in der Reihenfolge des Artikels
    const reihenfolge = stuecke.map((st, i) => ({ i, w: i === 0 ? Infinity : (werte[i] || 0) })).sort((x, y) => y.w - x.w);
    const gewaehlt = [];
    let laenge = 0;
    for (const r of reihenfolge) {
      const t = inhalt(stuecke[r.i]);
      if (laenge + t.length > max && gewaehlt.length) continue;
      gewaehlt.push(r.i);
      laenge += t.length;
      if (laenge > max * 0.95) break;
    }
    gewaehlt.sort((x, y) => x - y);
    return { text: gewaehlt.map(i => inhalt(stuecke[i])).join("\n…\n").slice(0, max + 200), gekuerzt: true };
  }

  async function nachBedeutung(frage, texte) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    try {
      const r = await fetch("/suchhilfe/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" }, signal: c.signal,
        body: JSON.stringify({ input: ["task: question answering | query: " + frage].concat(texte.map(x => "title: none | text: " + x.slice(0, 400))) }) });
      if (!r.ok) throw new Error("Suchhilfe antwortet nicht");
      const daten = (await r.json()).data;
      if (!Array.isArray(daten) || daten.length !== texte.length + 1) throw new Error("Suchhilfe: falsche Anzahl");
      const v = daten.sort((a, b) => a.index - b.index).map(d => d.embedding);
      const aehnlich = (a, b) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / Math.sqrt(x * y); };
      return v.slice(1).map(x => aehnlich(v[0], x));
    } finally { clearTimeout(t); }
  }

  function anweisung(art, woerter, anfang) {
    const l = Land.aktuell() || {};
    const land = (l.name && (l.name.de || l.name.en)) || l.code || "Deutschland";
    const sprache = Land.sprache() === "en" ? "Englisch" : "Deutsch";
    const aufgabe = {
      zusammenfassen: "Fasse den ARTIKEL zusammen: zuerst ein Satz, worum es geht, dann die wichtigsten Punkte als kurze Liste mit Spiegelstrichen (höchstens 6 Punkte). ",
      einfach: "Erkläre in höchstens 8 kurzen Sätzen das Wichtigste aus dem ARTIKEL, so einfach, dass ein Kind mit 8 bis 10 Jahren es versteht: keine Fachwörter, ein anschauliches Beispiel. " +
        "Lass Zahlen, Statistiken und Nebensachen weg. ",
      frage: "Beantworte die FRAGE nur mit dem, was im ARTIKEL steht. Steht die Antwort nur teilweise darin, gib das Passende wieder und sag kurz, was fehlt. " +
        "Steht gar nichts dazu im ARTIKEL, antwortest du nur mit dem Satz: \"Dazu steht in diesem Artikel nichts.\" Bei Anleitungen schreibst du nummerierte Schritte. ",
    }[art];
    return "Du hilfst beim Lesen eines Artikels aus einer Offline-Bibliothek. Antworte immer auf " + sprache + ", auch wenn der Artikel in einer anderen Sprache ist. " +
      "Der Nutzer lebt in " + land + ", Notrufnummer: " + Land.notruf() + ". " + aufgabe +
      "Ist der Artikel eine Forenfrage mit Antworten, gibst du vor allem wieder, was in den Antworten steht. " +
      (anfang ? "Du bekommst nur den Anfang eines längeren Artikels; tu nicht so, als kenntest du den Rest. " : "") +
      "Nutze nur, was im ARTIKEL steht, und erfinde nichts. Ist bei einem Gesundheitsthema ein Mensch in Lebensgefahr, nennst du zuerst den Notruf. " +
      "Sprich den Nutzer mit \"du\" an. Schreib keine Quellennummern und keine Überschriften. Halte dich kurz (höchstens etwa " + woerter + " Wörter).";
  }

  function zeige(ziel, text) {
    ziel.innerHTML = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^#+\s*(.+)$/gm, "<b>$1</b>");
  }

  const TITEL = { zusammenfassen: "Zusammenfassen", einfach: "Einfach erklären" };

  async function fragen(art, frage) {
    if (lauf) return;
    const a = aktuellerArtikel();
    if (!a) { artikelPruefen(); return; }
    if (a.url !== artikelUrl) artikelPruefen();
    const leer = verlauf.querySelector(".lf-leer");
    if (leer) leer.remove();
    if (art === "frage") feld.value = "";
    verlauf.append(el("div", { class: "frage-blase" }, art === "frage" ? frage : TITEL[art]));
    const box = el("div", { class: "antwort" });
    const schritte = el("ul", { class: "schritte-liste" });
    const text = el("div", { class: "antwort-text" });
    box.append(schritte, text);
    verlauf.append(box);
    box.scrollIntoView({ block: "end" });

    // KI nicht bereit: erklären statt warten
    const s = OW.status || {}, ki = s.ki || {};
    if (s.sparmodus || ki.status !== "bereit") {
      schritte.remove();
      text.append(...(s.sparmodus
        ? ["Die KI ist im Sparmodus aus.", el("br"), "Klicke oben rechts auf „KI aus“, um sie einzuschalten."]
        : ki.status === "laedt" ? ["Die KI startet noch.", el("br"), "Versuche es in einem Moment noch einmal."]
        : ["Die KI läuft gerade nicht.", el("br"), "Oben rechts siehst du ihren Zustand."]));
      return;
    }

    const c = new AbortController();
    let frist, abgebrochen = false;
    const fristSetzen = (ms) => { clearTimeout(frist); frist = setTimeout(() => c.abort(), ms); };
    lauf = { abbrechen: () => { abgebrochen = true; c.abort(); } };
    senden.replaceChildren(sym("square"));
    senden.title = "Antwort abbrechen";
    senden.setAttribute("aria-label", "Antwort abbrechen");
    senden.disabled = false;
    sperren(true);
    const schritt = el("li", {}, "Die KI liest den Artikel …");
    schritte.append(schritt);
    let neuerText = null, rafId = 0;
    try {
      const artikel = await Kiwix.artikelText(a.url, 0, c.signal);
      if (!artikel.abschnitte.length) throw Object.assign(new Error("leer"), { leer: true });
      const woerter = aufProzessor() ? 150 : 250;
      const { text: inhalt, gekuerzt, anfang } = await textFuer(artikel, art === "frage" ? frage : null, budget());
      const nachrichten = [{ role: "system", content: anweisung(art, woerter, anfang) }];
      // Rückfragen: die letzte Frage und Antwort zu diesem Artikel als Hintergrund
      const vorher = art === "frage" ? eintraege[eintraege.length - 1] : null;
      if (vorher) nachrichten.push({ role: "user", content: vorher.frage }, { role: "assistant", content: vorher.antwort.slice(0, 600) });
      nachrichten.push({ role: "user", content: "ARTIKEL: " + (artikel.titel || a.titel) + "\n" + inhalt + (art === "frage" ? "\n\nFRAGE: " + frage : "") });
      fristSetzen(180000);
      text.classList.add("cursor");
      const antwort = await KI.chat(nachrichten, { max_tokens: 600, temperature: 0.3, signal: c.signal }, (t) => {
        if (schritt.isConnected) schritt.remove();
        fristSetzen(60000);
        neuerText = t;
        if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; if (neuerText !== null) zeige(text, neuerText); });
      });
      if (rafId) cancelAnimationFrame(rafId);
      text.classList.remove("cursor");
      zeige(text, antwort);
      schritte.remove();
      eintraege.push({ frage: art === "frage" ? frage : TITEL[art], antwort });
      if (gekuerzt) box.append(el("p", { class: "hinweis klein" }, anfang
        ? ["Der Artikel ist lang.", el("br"), "Die KI kennt nur seinen Anfang."]
        : ["Der Artikel ist lang.", el("br"), "Die KI hat nur die passendsten Abschnitte gelesen."]));
      // Medizin-Pakete: wie auf der Seite „Fragen“ der Weg zur geprüften Ersten Hilfe und der Notruf
      if (/medicine|mdwiki/i.test(a.url)) box.append(el("p", { class: "medizin-hinweis warnung" },
        "Gesundheitsthema: Bitte lies den Artikel selbst nach.", el("br"), "Im akuten Notfall: ",
        el("a", { href: "#erstehilfe" }, "Erste-Hilfe-Spickzettel"), " oder Notruf " + Land.notruf() + "."));
      // Steht nichts im Artikel: dieselbe Frage an die ganze Bibliothek
      if (art === "frage" && /steht in diesem Artikel nichts|nothing about this in this article/i.test(antwort))
        box.append(el("a", { class: "knopf knopf-klein", href: "#fragen?q=" + encodeURIComponent(frage) }, sym("message-circle"), "In der ganzen Bibliothek fragen"));
    } catch (e) {
      if (rafId) cancelAnimationFrame(rafId);
      text.classList.remove("cursor");
      schritte.remove();
      if (abgebrochen) {
        // Abgebrochen (oder neuer Artikel): Was schon da ist, bleibt stehen
        if (box.isConnected) box.append(el("p", { class: "hinweis klein" }, "Abgebrochen."));
      } else if (e && e.leer) {
        text.textContent = "Auf dieser Seite steht kein Text, den die KI lesen kann.";
      } else {
        console.error(e);
        text.append(fehlerBox(c.signal.aborted ? "Die KI hat zu lange nicht geantwortet." : "Die KI hat nicht geantwortet.",
          () => { box.previousElementSibling.remove(); box.remove(); fragen(art, frage); }, "Nochmal versuchen", e && e.message));
      }
    } finally {
      clearTimeout(frist);
      lauf = null;
      senden.replaceChildren(sym("send"));
      senden.title = "Frage stellen";
      senden.setAttribute("aria-label", "Frage stellen");
      sperren(!aktuellerArtikel());
      if (box.isConnected) box.scrollIntoView({ block: "end" });
    }
  }

  return { knopfAnpassen };
})();
