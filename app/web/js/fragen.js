// Fragen: KI macht Suchbegriffe -> Suche in der Bibliothek -> KI antwortet mit Quellen.
"use strict";

const Fragen = (() => {
  let beschaeftigt = false;
  const verlauf = []; // [{frage, antwort}] für Rückfragen
  // Aktueller Chat: wird nach jeder Antwort in daten\chats gespeichert
  let chatId = null;
  let eintraege = []; // [{frage, suchFrage, antwort, hinweis, quellen, medizin, ohneKi}]
  let listeGeladen = false;

  function zeigen(params) {
    if (!listeGeladen) { listeGeladen = true; ladeListe(); }
    if (!$("#chat").children.length) begruessung();
    // Frage von der Startseite übernehmen und direkt stellen
    const q = params && params.get("q");
    if (q) {
      history.replaceState(null, "", "#fragen");
      $("#frage-feld").value = q;
      senden();
      return;
    }
    setTimeout(() => $("#frage-feld").focus(), 50);
  }

  function begruessung() {
    const s = OW.status || {};
    const box = el("div", { class: "antwort" });
    if (!s.wissen) box.append("Es ist noch keine Bibliothek installiert. ", el("a", { href: "#inhalte" }, "Wissen herunterladen"));
    else if (!s.modell) box.append("Es ist keine KI eingerichtet. Du kannst trotzdem fragen: Dann zeige ich passende Artikel. ", el("a", { href: "#inhalte" }, "KI einrichten"));
    else if (s.sparmodus) box.append("Der Sparmodus ist an, die KI ist aus. Ich zeige dir passende Artikel. ", el("button", { class: "knopf knopf-klein", onclick: () => schalteKi(true) }, "KI einschalten"));
    else {
      box.append("Stell eine Frage. Ich suche in der Offline-Bibliothek und antworte mit Quellen.");
      // Kleine Modelle (bis 9B): Hinweis, dass genaue Fragen viel bessere Antworten bringen
      if (/-(0\.\d+|\d)b$/i.test(s.modell || ""))
        box.append(el("p", { class: "hinweis klein", style: "margin:8px 0 0" }, "Tipp: Die KI auf deinem Gerät ist viel kleiner als große Online-KIs (z. B. Claude oder ChatGPT). " +
          "Je genauer du fragst, desto besser die Antwort. Also lieber „Radio lässt sich nicht einschalten, was kann ich prüfen?“ als „Radio reparieren“."));
    }
    $("#chat").append(box);
  }

  // Neues Thema: Anzeige und Gedächtnis leeren
  function neuerChat() {
    if (beschaeftigt) return;
    verlauf.length = 0;
    chatId = null;
    eintraege = [];
    $("#chat").innerHTML = "";
    begruessung();
    markiereAktiv();
    verlaufZu();
    $("#frage-feld").focus();
  }
  $("#neuer-chat").addEventListener("click", neuerChat);

  // ---------------------------------------------------------------- Verlauf (frühere Chats)
  function verlaufZu() { $("#chat-verlauf").classList.remove("offen"); $("#verlauf-knopf").setAttribute("aria-expanded", "false"); }
  $("#verlauf-knopf").addEventListener("click", () => {
    const offen = $("#chat-verlauf").classList.toggle("offen");
    $("#verlauf-knopf").setAttribute("aria-expanded", String(offen));
  });

  function zeitText(s) {
    const d = new Date(s);
    if (isNaN(d)) return "";
    const heute = new Date();
    const tage = Math.floor((new Date(heute.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (tage === 0) return "heute, " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    if (tage === 1) return "gestern";
    if (tage < 7) return "vor " + tage + " Tagen";
    return d.toLocaleDateString("de-DE");
  }

  async function ladeListe() {
    const ziel = $("#chat-liste");
    let chats = [];
    try { chats = (await api("chats")).chats || []; } catch { }
    ziel.innerHTML = "";
    if (!chats.length) { ziel.append(el("div", { class: "leer" }, "Noch keine Chats. Deine Fragen werden hier gespeichert.")); return; }
    for (const c of chats) {
      ziel.append(el("div", { class: "chat-eintrag", "data-id": c.id },
        el("button", { class: "oeffnen", title: c.titel, onclick: () => oeffneChat(c.id) },
          el("span", { class: "t" }, c.titel), el("small", {}, zeitText(c.zeit))),
        el("button", { class: "weg", title: "Chat löschen", "aria-label": "Chat löschen", onclick: () => loescheChat(c.id, c.titel) }, sym("x"))));
    }
    markiereAktiv();
  }

  function markiereAktiv() {
    for (const e of document.querySelectorAll(".chat-eintrag")) e.classList.toggle("aktiv", e.dataset.id === chatId);
  }

  async function oeffneChat(id) {
    if (beschaeftigt) return;
    let c;
    try { c = await api("chat?id=" + encodeURIComponent(id)); } catch (e) { return; }
    if (!c || c.fehler) return;
    chatId = id;
    eintraege = Array.isArray(c.eintraege) ? c.eintraege : [];
    verlauf.length = 0;
    for (const e of eintraege.slice(-3)) verlauf.push({ frage: e.suchFrage || e.frage, antwort: e.antwort || null });
    $("#chat").innerHTML = "";
    for (const e of eintraege) zeigeEintrag(e);
    markiereAktiv();
    verlaufZu();
    $("#chat").lastElementChild && $("#chat").lastElementChild.scrollIntoView({ block: "end" });
  }

  async function loescheChat(id, titel) {
    const ok = await dialog("Chat löschen?", "„" + titel + "“ wird endgültig gelöscht.", [{ text: "Abbrechen", wert: false }, { text: "Löschen", wert: true, haupt: true }]);
    if (!ok) return;
    try { await api("chat/loeschen", { id }); } catch { }
    if (id === chatId) neuerChat();
    ladeListe();
  }

  // Nach jeder Antwort speichern. Der Titel ist die erste Frage
  async function merke(eintrag) {
    eintraege.push(eintrag);
    if (!chatId) chatId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const titel = eintraege[0].frage.length > 60 ? eintraege[0].frage.slice(0, 57) + " …" : eintraege[0].frage;
    try { await api("chat/speichern", { id: chatId, titel, eintraege }); } catch { }
    ladeListe();
  }

  // Gespeicherten Eintrag wieder anzeigen
  function zeigeEintrag(e) {
    $("#chat").append(el("div", { class: "frage-blase" }, e.frage));
    const box = el("div", { class: "antwort" });
    const text = el("div", { class: "antwort-text" });
    box.append(text);
    const quellen = e.quellen || [];
    if (e.antwort) zeigeAntwort(text, e.antwort, quellen);
    else if (e.hinweis) text.textContent = e.hinweis;
    if (e.ohneKi) { text.append("Passende Artikel (die KI ist aus):"); box.append(quellenListe(quellen, true)); }
    else if (quellen.length) box.append(quellenListe(quellen));
    if (e.suche && e.suche.length) box.append(weitersuchen(e.suche));
    if (e.medizin) box.append(medizinHinweis());
    $("#chat").append(box);
  }

  // Suchbegriffe zum Selbst-Weiterlesen: die deutschen Begriffe der KI und Modellnummern, höchstens drei
  function weiterBegriffe(b) {
    return [...new Set((b.codes || []).concat(b.de || []).map(s => String(s).trim()).filter(Boolean))].slice(0, 3);
  }
  function weitersuchen(begriffe) {
    if (!begriffe.length) return null;
    return el("div", { class: "weitersuchen" }, el("span", { class: "hinweis klein" }, "Selbst weiterlesen, in der Bibliothek suchen nach:"),
      ...begriffe.map(w => el("a", { class: "knopf knopf-klein", href: "#bibliothek?q=" + encodeURIComponent(w) }, sym("search"), w)));
  }

  function medizinHinweis() {
    return el("p", { class: "medizin-hinweis warnung" }, "Gesundheitsthema: Bitte die Quellen lesen. Im akuten Notfall: ", el("a", { href: "#erstehilfe" }, "Erste-Hilfe-Spickzettel"), " oder Notruf " + Land.notruf() + ".");
  }

  // Nur das Nötige aus den Quellen speichern
  const kurzQuellen = (qs) => qs.map(q => ({ nr: q.nr, titel: q.titel, url: q.url, text: (q.text || "").slice(0, 300), buch: { titel: q.buch.titel, name: q.buch.name, englisch: !!q.buch.englisch } }));

  // Lage des Nutzers: bestimmt, welche Mittel die KI voraussetzen darf
  const LAGEN = {
    normal: "Lage: zu Hause. Strom und einfaches Werkzeug sind vermutlich da.",
    strom: "Lage: Stromausfall. Kein Netzstrom, kein Internet, vielleicht kein Handynetz. Schlage nichts vor, das eine Steckdose braucht. Möglich sind z. B. Batterien, Autobatterie, Powerbank, Solarpanel, Gaskocher, Feuer.",
    draussen: "Lage: draußen oder unterwegs. Es gibt nur, was man dabei hat oder in der Natur findet. Keine Steckdose, kein Werkzeugkasten.",
    krise: "Lage: Krise. Keine Läden, keine Handwerker, keine Lieferungen, Hilfe ist vielleicht nicht erreichbar. Es gibt nur, was vorhanden ist oder sich finden, ausbauen (z. B. aus einem Auto) oder improvisieren lässt.",
  };
  try { const l = localStorage.getItem("ow-lage"); if (l && LAGEN[l]) $("#lage").value = l; } catch { }
  $("#lage").addEventListener("change", () => { try { localStorage.setItem("ow-lage", $("#lage").value); } catch { } });

  $("#frage-form").addEventListener("submit", (e) => { e.preventDefault(); senden(); });
  $("#frage-feld").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); senden(); } });

  // Budget für Artikeltext je nach Modell und Rechenweg
  function budget() {
    const s = OW.status || {};
    const ctx = (s.ki && s.ki.kontext) || 8192;
    const cpu = (s.backend || "cpu") === "cpu";
    return Math.min(cpu ? 4500 : 9000, Math.floor(ctx * 0.55 * 3));
  }

  async function senden() {
    const frage = $("#frage-feld").value.trim();
    if (!frage || beschaeftigt) return;
    beschaeftigt = true;
    $("#frage-senden").disabled = true;
    $("#frage-feld").value = "";
    const einfach = $("#einfach").checked;
    const lage = LAGEN[$("#lage").value] ? $("#lage").value : "normal";

    $("#chat").append(el("div", { class: "frage-blase" }, frage));
    const box = el("div", { class: "antwort" });
    const schritte = el("ul", { class: "schritte-liste" });
    const text = el("div", { class: "antwort-text" });
    box.append(schritte, text);
    $("#chat").append(box);
    box.scrollIntoView({ behavior: "smooth", block: "end" });

    const schritt = (t) => { const li = el("li", {}, t); schritte.append(li); return li; };
    const fertig = (li, t, fehler) => { li.className = fehler ? "fehler" : "fertig"; if (t) li.textContent = t; };

    // Gesprächskontext im selben Chat:
    // - Kurze Ergänzung (z. B. nur eine Modellnummer): mit der vorherigen Frage verbinden
    // - Sonst bekommt die KI die vorherige Frage als Hintergrund, entscheidet aber selbst, ob sie dazugehört
    const vorher = verlauf[verlauf.length - 1];
    const ergaenzung = !!(vorher && istErgaenzung(frage));
    const suchFrage = ergaenzung ? vorher.frage + " " + frage : frage;
    const kontext = !ergaenzung && vorher && vorher.antwort ? vorher : null;

    try {
      let buecher = (await Kiwix.buecher()).filter(b => b.durchsuchen);
      // Die Bibliothek startet gerade neu (z. B. nach einem Absturz von kiwix-serve): kurz warten, noch einmal versuchen
      if (!buecher.length) {
        await new Promise(r => setTimeout(r, 4000));
        await aktualisiereStatus();
        buecher = (await Kiwix.buecher(true)).filter(b => b.durchsuchen);
      }
      if (!buecher.length) throw new Error("Keine durchsuchbare Bibliothek installiert.");
      const mitKi = KI.bereit();
      const hatEnglisch = buecher.some(b => b.englisch);
      const nummern = codes(suchFrage);

      // 1. Suchbegriffe
      let begriffe;
      if (mitKi) {
        const s1 = schritt("Suchbegriffe werden erstellt …");
        try {
          begriffe = await suchbegriffe(suchFrage, hatEnglisch, kontext, lage);
        } catch (e) {
          begriffe = { de: [kurzfassung(suchFrage)], en: [] };
        }
        begriffe.codes = nummern;
        // Dazu die Hauptwörter der Frage selbst: Die KI erfindet manchmal Wörter, die es als Artikel nicht gibt
        // („Kerzenheizung“), die Wörter des Nutzers („Kerzen“, „Zimmer“) finden dann trotzdem etwas
        begriffe.extra = hauptwoerter(suchFrage).filter(w => !begriffe.de.some(d => d.toLowerCase() === w.toLowerCase()));
        begriffe.de = begriffe.de.concat(begriffe.extra).slice(0, 6);
        fertig(s1, "Suchbegriffe: " + [...new Set(nummern.concat(begriffe.de, begriffe.en))].join(" · "));
      } else begriffe = { de: [kurzfassung(suchFrage)], en: [], codes: nummern };

      // 2. Suchen. Findet die KI-Umschreibung nichts, noch einmal mit den Wörtern der Frage
      const s2 = schritt("Suche in " + buecher.length + " Paketen …");
      const praxis = lage !== "normal" || ANLEITUNG.test(suchFrage);
      begriffe.frage = suchFrage;
      let treffer = await suchen(buecher, begriffe, einfach, praxis);
      if (!treffer.length) {
        const kurz = kurzfassung(suchFrage);
        const woerter = kurz.split(" ").filter(w => w.length > 3 && !nummern.includes(w));
        const zweit = { de: [kurz].concat(woerter.slice(0, 2)), en: [kurz], codes: nummern, frage: suchFrage };
        treffer = await suchen(buecher, zweit, einfach, praxis);
        if (treffer.length) begriffe = zweit;
      }
      if (!treffer.length) {
        fertig(s2, "Nichts Passendes gefunden.", true);
        text.textContent = "Dazu habe ich in der Bibliothek nichts gefunden. Versuche andere Wörter, zum Beispiel den Namen der Sache statt einer ganzen Frage. " +
          "Eine Modellnummer oder einen Namen kannst du auch einfach als nächste Nachricht schicken.";
        verlauf.push({ frage: suchFrage, antwort: null });
        if (verlauf.length > 3) verlauf.shift();
        merke({ frage, suchFrage, antwort: null, hinweis: text.textContent, quellen: [] });
        return;
      }
      const pakete = [...new Set(treffer.map(t => t.buch.titel))];
      fertig(s2, "Gefunden: " + treffer.length + " Artikel in " + pakete.join(", "));

      // 3. Artikel lesen
      const s3 = schritt(mitKi ? "Artikel werden gelesen und geprüft …" : "Artikel werden gelesen …");
      let quellen = await lesen(treffer, suchFrage, begriffe, budget(), mitKi);
      fertig(s3, quellen.length + (quellen.length === 1 ? " passender Artikel" : " passende Artikel") + " gelesen");
      // Passt keiner: ein zweiter Versuch mit anderen Begriffen (Oberbegriffe, Namen von Verfahren)
      if (!quellen.length && mitKi) {
        fertig(s3, "Keiner der gefundenen Artikel passt.");
        const s3b = schritt("Zweite Suche mit anderen Begriffen …");
        try {
          const neu = await suchbegriffe(suchFrage, hatEnglisch, kontext, lage, begriffe.de.concat(begriffe.en));
          // Nur Begriffe, die noch nicht gesucht wurden
          const schon = new Set(begriffe.de.concat(begriffe.en).map(s => s.toLowerCase()));
          neu.de = neu.de.filter(s => !schon.has(s.toLowerCase()));
          neu.en = neu.en.filter(s => !schon.has(s.toLowerCase()));
          if (!neu.de.length && !neu.en.length) throw new Error("keine neuen Begriffe");
          neu.codes = nummern;
          neu.frage = suchFrage;
          const bekannt = new Set(treffer.map(t => t.url));
          const t2 = (await suchen(buecher, neu, einfach, praxis)).filter(t => !bekannt.has(t.url));
          if (t2.length) quellen = await lesen(t2, suchFrage, neu, budget(), true);
          if (quellen.length) begriffe = neu;
          fertig(s3b, "Zweite Suche: " + neu.de.concat(neu.en).join(" · ") + " · " + quellen.length + " passend");
        } catch { fertig(s3b, "Zweite Suche hat nicht geklappt.", true); }
      }
      if (!quellen.length) {
        text.textContent = "Dazu habe ich in der Bibliothek nichts Passendes gefunden. Versuche es mit anderen Wörtern, zum Beispiel dem Namen der Sache oder des Verfahrens, oder such selbst in der Bibliothek:";
        const suche = weiterBegriffe(begriffe);
        box.append(weitersuchen(suche));
        verlauf.push({ frage: suchFrage, antwort: null });
        if (verlauf.length > 3) verlauf.shift();
        merke({ frage, suchFrage, antwort: null, hinweis: text.textContent, quellen: [], suche });
        return;
      }

      if (!mitKi) {
        text.append("Passende Artikel (die KI ist aus):");
        box.append(quellenListe(quellen, true));
        merke({ frage, suchFrage, antwort: null, ohneKi: true, quellen: kurzQuellen(quellen) });
        return;
      }

      // 4. Antworten
      const s4 = schritt("Antwort wird geschrieben …");
      text.classList.add("cursor");
      const antwort = await antworten(suchFrage, quellen, einfach, kontext, lage, (t) => { zeigeAntwort(text, t, quellen); });
      text.classList.remove("cursor");
      zeigeAntwort(text, antwort, quellen);
      fertig(s4, "Antwort fertig");
      box.append(quellenListe(quellen));
      const suche = weiterBegriffe(begriffe);
      box.append(weitersuchen(suche));
      const medizin =quellen.some(q => /medicine|mdwiki|medizin/i.test(q.buch.name)) || /wunde|blut|schmerz|vergift|fieber|verbrenn|bruch|medikament|krank|atem|herz/i.test(frage);
      if (medizin) box.append(medizinHinweis());
      verlauf.push({ frage: suchFrage, antwort });
      if (verlauf.length > 3) verlauf.shift();
      merke({ frage, suchFrage, antwort, medizin, quellen: kurzQuellen(quellen), suche });
    } catch (e) {
      text.classList.remove("cursor");
      text.append(el("div", { class: "fehlerbox" }, "Fehler: " + e.message));
    } finally {
      beschaeftigt = false;
      $("#frage-senden").disabled = false;
      box.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }

  // Ohne KI: Füllwörter aus der Frage entfernen
  function kurzfassung(f) {
    const stopp = /\b(wie|was|wo|wann|warum|wieso|weshalb|welche[rsmn]?|wer|kann|könnte|muss|soll|ich|man|du|mein[e]?|ein[e]?[nmrs]?|der|die|das|den|dem|des|und|oder|ist|sind|bei|mit|von|zu|zum|zur|für|im|in|am|an|auf|aus|es|sich|bitte|am besten|eigentlich|überhaupt|mache|machen|tun|habe|hat)\b/gi;
    const k = f.replace(/[?!.,;:]/g, " ").replace(stopp, " ").replace(/\s+/g, " ").trim();
    return k || f;
  }

  // Hauptwörter (großgeschrieben, nicht am Satzanfang), die längsten zuerst, höchstens zwei
  function hauptwoerter(f) {
    // Wörter nach „ohne“ beschreiben die Lage („ohne Strom“), nicht das Thema
    const w = f.replace(/[?!.,;:„“"()]/g, " ").replace(/\bohne\s+\S+/gi, " ").split(/\s+/).filter(Boolean).slice(1)
      .filter(x => /^[A-ZÄÖÜ][a-zäöüß-]{3,}$/.test(x) && !/^(Hilfe|Frage|Sache|Dinge?)$/.test(x));
    return [...new Set(w)].sort((a, b) => b.length - a.length).slice(0, 2);
  }

  // Kurze Nachricht ohne eigene Frage, z. B. "LFX25973" oder "Modell von LG": ergänzt die vorherige Frage
  function istErgaenzung(f) {
    const woerter = f.trim().split(/\s+/);
    if (codes(f).length && woerter.length <= 5) return true;
    return woerter.length <= 3 && !/\?|^(wie|was|wo|wann|warum|wieso|weshalb|welche|wer|kann|gibt|ist|sind)\b/i.test(f.trim());
  }

  // Modellnummern, Typbezeichnungen, Teilenummern: Buchstaben und Ziffern gemischt, z. B. "LFX25973", "UE55NU7179", "AA-Batterie" nicht
  function codes(text) {
    const m = text.match(/[A-Za-zÄÖÜäöü0-9][A-Za-zÄÖÜäöü0-9.\/-]{2,}[A-Za-zÄÖÜäöü0-9]/g) || [];
    return [...new Set(m.filter(w => /\d/.test(w) && /[A-Za-z]/.test(w) && w.replace(/[^0-9]/g, "").length >= 2))].slice(0, 2);
  }

  async function suchbegriffe(frage, englisch, vorher, lage, ohneErfolg) {
    let kontext = vorher ? "Vorherige Frage im Gespräch (nur beachten, wenn sich die neue Frage darauf bezieht, z. B. mit \"das\", \"dazu\", \"und wenn …\"): " + vorher.frage + "\n" : "";
    // Zweiter Versuch: Die ersten Begriffe fanden nichts Passendes
    if (ohneErfolg && ohneErfolg.length) kontext += "Diese Suchbegriffe haben nichts Passendes gefunden: " + ohneErfolg.join(", ") +
      ". Nenne andere: Oberbegriffe, Fachbegriffe oder Namen von Verfahren und Geräten, die als Titel eines Lexikonartikels vorkommen.\n";
    const sys = "Du erzeugst Suchbegriffe für eine Offline-Bibliothek (Wikipedia, Lehrbücher, Reparatur- und Selbsthilfe-Anleitungen). " +
      "Benenne zuerst unter \"thema\" in zwei bis vier Wörtern, worum es im Kern geht: das Sachgebiet und was der Nutzer erreichen will " +
      "(z. B. bei einer Frage nach einem verstauchten Fuß: \"Verstauchung Erste Hilfe\"). Leite die Suchbegriffe aus diesem Thema ab, nicht aus einzelnen Wörtern der Frage. " +
      "Gib dann 1 bis 3 kurze deutsche Suchbegriffe zurück, die wie Artikeltitel klingen (Substantive, z. B. \"Schnittwunde\", \"Radioempfänger\", \"Wundversorgung\"). " +
      "Jeder Begriff ist ein Wort oder höchstens zwei, ohne Verb und ohne \"ohne\", so wie ein Lexikonartikel heißt. Die Lage der Frage (z. B. ohne Strom) steckt nicht im Suchbegriff. " +
      "Modellnummern, Marken und Eigennamen übernimmst du wörtlich, z. B. \"LG Kühlschrank\". " +
      "Der Nutzer will Dinge selbst und mit einfachen Mitteln lösen. Suche nach den Verfahren und Techniken, mit denen man es selbst schafft, " +
      "nicht nach dem Gerät oder der Dienstleistung, die fehlt. Gute Suchbegriffe sind Fachbegriffe für die Methode, zum Beispiel: " +
      "\"Feuer machen\" → \"Feuerbohrer\", \"Zunder\"; \"Strom mit Solarpanel\" → \"Solarladeregler\", \"Inselanlage\"; " +
      "\"Essen ohne Kühlschrank frisch halten\" → \"Lebensmittelkonservierung\", \"Einkochen\", \"Dörren\"; \"Wasser trinkbar machen\" → \"Wasseraufbereitung\", \"Abkochen\". " +
      "Bei Reparaturen suchst du allgemein nach dem Bauteil, dem Funktionsprinzip und dem Fehlerbild, nicht nach einem bestimmten Modell " +
      "(z. B. \"Kühlschrank kühlt nicht\" → \"Kompressor\", \"Kältemaschine\"; englisch \"refrigerator not cooling\"). Modellnummern sucht das Programm selbst. " +
      LAGEN[lage || "normal"] + " " +
      (englisch ? "Gib zusätzlich 1 bis 2 englische Suchbegriffe für englische Quellen zurück. " : "") +
      "Antworte nur mit JSON.";
    const schema = {
      type: "object",
      // "thema" steht zuerst: Das Modell schreibt es vor den Begriffen und richtet sie danach aus
      properties: {
        thema: { type: "string" },
        de: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        en: { type: "array", items: { type: "string" }, maxItems: 2 },
      },
      required: englisch ? ["thema", "de", "en"] : ["thema", "de"],
    };
    const roh = await KI.chat([
      { role: "system", content: sys },
      { role: "user", content: kontext + "Frage: " + frage },
    ], { max_tokens: 120, temperature: ohneErfolg ? 0.7 : 0.1, response_format: { type: "json_schema", json_schema: { name: "suche", schema } } });
    let j;
    try { j = JSON.parse(roh); } catch { const m = roh.match(/\{[\s\S]*\}/); j = m ? JSON.parse(m[0]) : null; }
    if (!j || !Array.isArray(j.de) || !j.de.length) throw new Error("keine Begriffe");
    // Die Lage gehört nicht in den Suchbegriff („Reis kochen ohne Strom“ → „Reis kochen“), sonst findet die Titelsuche nichts
    const sauber = (a) => [...new Set((a || []).map(s => String(s).replace(/\s+(ohne|without)\s.*$/i, "").trim()).filter(s => s && s.length < 60))].slice(0, 3);
    // Das Thema selbst wird mitgesucht (Volltext findet auch zwei, drei Wörter) und hilft der Quellenprüfung
    const thema = String(j.thema || "").replace(/\s+(ohne|without)\s.*$/i, "").trim();
    const de = sauber(j.de);
    if (thema && thema.split(/\s+/).length <= 4 && !de.some(d => d.toLowerCase() === thema.toLowerCase())) de.push(thema);
    return { de, en: englisch ? sauber(j.en).slice(0, 2) : [], thema };
  }

  // Titel-Treffer und Volltext-Treffer kombinieren und bewerten
  // Pakete mit Anleitungen zum Selbermachen
  const PRAXIS_PAKET = /appropedia|post-disaster|ifixit|wikibooks|energypedia|electronics|diy\.|mechanics|bicycles|ham\.|outdoors|gardening|cooking|sustainability|wikihow|survival|bushcraft|restarters|zimgit-(water|knots|food)|wikiciv|cd3wd|usda-|gardenology/i;

  // Suchhilfe: Ein kleines Bedeutungsmodell (EmbeddingGemma, eigener Dienst unter /suchhilfe/) sortiert die
  // Kandidaten nach Bedeutung statt nach gleichen Wörtern. Fehlt es oder antwortet es nicht, bleibt alles wie vorher.
  // Getestet mit 120 Testfragen: deutlich öfter der passende Artikel statt einer Forenfrage, etwa 1 s auf dem Prozessor.
  const suchhilfeDa = () => !!(((OW.status || {}).ki || {}).suchhilfe);
  // Artikel nur einmal laden: Die Suchhilfe braucht den Anfang, das Lesen danach den ganzen Text
  const artikelCache = new Map();
  function artikel(url) {
    if (!artikelCache.has(url)) {
      const p = Kiwix.artikelText(url);
      p.catch(() => artikelCache.delete(url));
      artikelCache.set(url, p);
      if (artikelCache.size > 60) artikelCache.delete(artikelCache.keys().next().value);
    }
    return artikelCache.get(url);
  }
  async function nachBedeutung(begriffe, treffer) {
    const frage = "task: search result | query: " + begriffe.frage + (begriffe.thema ? " (" + begriffe.thema + ")" : "");
    // Treffer der Titelsuche haben keinen Auszug. Nur mit dem Titel verlieren sie gegen jeden Absatz,
    // deshalb kommt der Anfang des Artikels dazu
    await Promise.all(treffer.filter(t => !t.auszug && !t.pdf).map(t => artikel(t.url).then(a => {
      t.auszug = a.abschnitte.slice(0, 2).map(s => s.text).join(" ").slice(0, 300);
    }).catch(() => {})));
    const texte = treffer.map(t => "title: " + t.titel + " | text: " + String(t.auszug || "").replace(/<[^>]+>/g, "").slice(0, 300));
    const r = await fetch("/suchhilfe/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: [frage].concat(texte) }) });
    if (!r.ok) throw new Error("Suchhilfe antwortet nicht");
    const v = (await r.json()).data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    const aehnlich = (a, b) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / Math.sqrt(x * y); };
    return v.slice(1).map(x => aehnlich(v[0], x));
  }

  async function suchen(buecher, begriffe, einfach, praxis) {
    const auftraege = [];
    const nummern = begriffe.codes || [];
    for (const b of buecher) {
      // Modellnummern wörtlich in jedem Paket suchen; die Titelsuche findet auch "LFX25973ST" bei "LFX25973"
      for (const c of nummern) {
        auftraege.push(Kiwix.vorschlaege(b, c, 5).then(r => r.map((t, i) => Object.assign(t, { punkte: 14 - i, begriff: c }))).catch(() => []));
        auftraege.push(Kiwix.suche(b, c, 4).then(r => r.map((t, i) => Object.assign(t, { punkte: 10 - i, begriff: c }))).catch(() => []));
      }
      // iFixit Deutsch ist überwiegend englisch: dort mit beiden Sprachen suchen
      const gemischt = /ifixit/.test(b.name);
      const liste = (gemischt ? begriffe.en.concat(begriffe.de) : b.englisch ? begriffe.en : begriffe.de).filter(x => !nummern.includes(x));
      liste.forEach((begriff, bi) => {
        // Einzelne Wörter aus der Frage („Fisch“) nur als Ergänzung: Ihr Lexikonartikel (das Tier) soll
        // die Treffer zu den eigentlichen Begriffen („Fischfang“) nicht verdrängen
        const faktor = (begriffe.extra || []).includes(begriff) ? 0.5 : 1;
        auftraege.push(Kiwix.vorschlaege(b, begriff, 3).then(r => r.map((t, i) => {
          const exakt = t.titel.toLowerCase() === begriff.toLowerCase();
          return Object.assign(t, { punkte: ((exakt ? 12 : 6 - i * 1.5) - bi) * faktor, begriff });
        })).catch(() => []));
        auftraege.push(Kiwix.suche(b, begriff, 4).then(r => r.map((t, i) => Object.assign(t, { punkte: (5 - i - bi) * faktor, begriff }))).catch(() => []));
      });
    }
    const alle = (await Promise.all(auftraege)).flat();
    // Gleiche Artikel zusammenfassen
    const nachUrl = new Map();
    for (const t of alle) {
      // Dasselbe Buch steckt manchmal in zwei PDF-Paketen: gleiche Stelle nur einmal
      const key = t.pdf ? "pdf:" + (t.auszug || "").slice(0, 120) : decodeURIComponent(t.url).toLowerCase();
      const v = nachUrl.get(key);
      if (v) { v.punkte += t.punkte * 0.6; if (!v.auszug && t.auszug) v.auszug = t.auszug; } else nachUrl.set(key, Object.assign({}, t));
    }
    // Wikipedia-Medizin und Haupt-Wikipedia leicht bevorzugen, Englisch leicht abwerten
    const liste = [...nachUrl.values()].map(t => {
      if (/medicine/.test(t.buch.name)) t.punkte += 1;
      if (t.buch.englisch) t.punkte -= 1.5;
      // Fundstellen in PDF-Büchern (Handbücher): Volltext über das ganze Buch, aber ohne Titeltreffer wie bei
      // Lexikonartikeln. Der Ausgleich bringt sie in die Auswahl; ob sie passen, prüft danach die KI
      if (t.pdf) t.punkte += 4;
      // Kinderlexikon nur im Modus "Einfach erklären" bevorzugen
      if (/klexikon/.test(t.buch.name)) t.punkte += einfach ? 3 : -3;
      // Wörterbuch nur bei Fragen nach Wortbedeutungen (sonst ganz weglassen, siehe unten)
      if (/wiktionary/.test(t.buch.name) && !/bedeut|heißt|wort|übersetz|herkunft/i.test(begriffe.frage || "")) t.weg = true;
      // Forenfragen, wer etwas repariert oder wo man es kauft, helfen beim Selbermachen nicht
      if (/\b(anyone|anybody|where (can|do|to)|recommend|buy|purchase|wer repariert|wo kaufe|wo bekomme)\b/i.test(t.titel)) t.punkte -= 4;
      // Bei Anleitungsfragen und besonderer Lage: Praxis-Pakete vor dem allgemeinen Lexikon
      if (praxis && PRAXIS_PAKET.test(t.buch.name)) t.punkte += 2.5;
      // Titel mit der gesuchten Modellnummer stark bevorzugen
      const zumModell = nummern.some(c => t.titel.toLowerCase().includes(c.toLowerCase()));
      if (zumModell) t.punkte += 8;
      // iFixit: echte Anleitungen bevorzugen. Geräteseiten sind meist leere Platzhalter oder lange Modelllisten
      if (/ifixit/.test(t.buch.name)) {
        if (/\/Anleitung\/|\/Guide\//.test(t.url)) t.punkte += 2;
        else if (/\/Device\//.test(t.url) && !zumModell) t.punkte -= 8;
      }
      return t;
    }).filter(t => !t.weg).sort((a, b) => b.punkte - a.punkte);
    if (!liste.length) return [];
    // Mit Suchhilfe: mehr Kandidaten (16, bis 3 je Buch) nach Bedeutung sortieren, die Punkte zählen nur wenig mit
    if (begriffe.bedeutung !== false && suchhilfeDa()) {
      const max = liste[0].punkte, proB = {};
      const pool = liste.filter(t => t.punkte >= Math.max(1, max * 0.25))
        .filter(t => (proB[t.buch.id] = (proB[t.buch.id] || 0) + 1) <= 3).slice(0, 16);
      try {
        const sim = await nachBedeutung(begriffe, pool);
        // Mehr Gewicht für die Punkte (0,25 und 0,4) brachte im Test nichts
        pool.forEach((t, i) => { t.wert = sim[i] + 0.1 * Math.max(0, t.punkte) / max; });
        pool.sort((a, b) => b.wert - a.wert);
        const proBuch = {};
        return pool.filter(t => (proBuch[t.buch.id] = (proBuch[t.buch.id] || 0) + 1) <= 2).slice(0, 7);
      } catch { /* Suchhilfe antwortet nicht: wie ohne */ }
    }
    // Schwache Treffer weglassen, höchstens 2 Artikel pro Buch
    const grenze = Math.max(1, liste[0].punkte * 0.4);
    const proBuch = {};
    // Ein paar mehr als nötig: Leere Seiten fallen beim Lesen noch heraus
    return liste.filter(t => t.punkte >= grenze)
      .filter(t => (proBuch[t.buch.id] = (proBuch[t.buch.id] || 0) + 1) <= 2).slice(0, 7);
  }

  const ANLEITUNG = /\b(wie|was tun|was mache|was soll|behandl|versorg|reparier|anleitung|hilft|helfen|vorgehen|schritt)/i;
  const PRAXIS_ABSCHNITT = /behandlung|therapie|erste hilfe|versorgung|maßnahmen|massnahmen|reparatur|anleitung|vorgehen|durchführung|anwendung|reinigung|vorbeugung|prävention|treatment|repair|first aid|steps|procedure/i;

  // Wortstämme grob: erste 6 Zeichen, damit "versorge" auch "Wundversorgung" trifft
  function staemme(text) {
    return [...new Set(text.toLowerCase().split(/[^a-zäöüß0-9]+/).filter(w => w.length > 3).map(w => w.slice(0, 6)))];
  }

  async function lesen(treffer, frage, begriffe, budgetZeichen, mitPruefung) {
    const woerter = staemme(frage + " " + begriffe.de.join(" ") + " " + begriffe.en.join(" "));
    const anleitung = ANLEITUNG.test(frage);
    const texte = await Promise.all(treffer.map(t => artikel(t.url).then(a => ({ t, a })).catch(() => null)));
    // Gleiche Zielartikel (nach Weiterleitungen) nur einmal
    const gesehen = new Set();
    const gueltig = texte.filter(x => {
      if (!x || !x.a.abschnitte.length) return false;
      // Platzhalterseiten ohne brauchbaren Inhalt überspringen (z. B. iFixit-Geräteseiten, die nur Datenblätter sind)
      const voll = x.a.abschnitte.map(s => s.text).join(" ");
      if (voll.length < 300) return false;
      if (/California Energy Commission|Date Added: \d{4}/.test(voll) && !/\b(step|schritt|replace|austausch|remove|entfern)/i.test(voll)) return false;
      // Auch über verschiedene Adressen derselbe Artikel (z. B. Klexikon „Wolf“ zweimal) nur einmal
      const k = decodeURIComponent(x.a.url).toLowerCase();
      const k2 = x.t.buch.id + "|" + String(x.a.titel || x.t.titel).toLowerCase();
      if (gesehen.has(k) || gesehen.has(k2)) return false;
      gesehen.add(k);
      gesehen.add(k2);
      return true;
    });
    // Die KI sortiert Artikel aus, die zur Frage nicht passen (z. B. Winter-Tipps bei einer Radio-Frage)
    let auswahl = gueltig;
    if (mitPruefung && gueltig.length > 1) {
      try {
        // Passt nichts, bleibt die Liste leer: Dann lieber ehrlich „nichts gefunden“ als eine Antwort aus unpassenden Artikeln
        auswahl = (await quellenPruefen(frage, gueltig, begriffe.thema)).map(i => gueltig[i]);
      } catch { /* Prüfung fehlgeschlagen: alle behalten */ }
    }
    auswahl = auswahl.slice(0, 4);
    const proArtikel = Math.floor(budgetZeichen / Math.max(1, auswahl.length));
    return auswahl.map(({ t, a }, i) => {
      // Einleitung immer, dann die Abschnitte mit den meisten Suchwörtern
      const anker = (a.anker || "").toLowerCase();
      const bewertet = a.abschnitte.map((s, idx) => {
        const lc = (s.ueberschrift + " " + s.text).toLowerCase();
        let p = 0;
        for (const w of woerter) if (lc.includes(w)) p++;
        if (idx < 2) p += 2;
        if (anleitung && PRAXIS_ABSCHNITT.test(s.ueberschrift)) p += 3;
        if (anker && s.ueberschrift.toLowerCase() === anker) p += 3;
        return { s, idx, p };
      });
      const gewaehlt = [];
      let laenge = 0;
      for (const b of bewertet.slice().sort((x, y) => y.p - x.p || x.idx - y.idx)) {
        if (laenge > proArtikel) break;
        gewaehlt.push(b);
        laenge += b.s.text.length;
      }
      gewaehlt.sort((x, y) => x.idx - y.idx);
      let text = gewaehlt.map(b => (b.s.ueberschrift ? "[" + b.s.ueberschrift + "] " : "") + b.s.text).join("\n");
      if (text.length > proArtikel) text = text.slice(0, proArtikel) + " …";
      // Fundstellen in PDF-Büchern verweisen auf die Seite im PDF selbst
      return { nr: i + 1, titel: a.titel || t.titel, url: t.pdf || a.url || t.url, buch: t.buch, text };
    });
  }

  // Quellen prüfen: Die KI bekommt Titel, Anfang und Abschnittsüberschriften jedes Artikels und nennt die,
  // die bei genau dieser Frage helfen. Ergebnis: Positionen in der Liste, in der Reihenfolge der Liste.
  // Getestet (Nov. 2026): Herkunft und Sprache dazu brachte mehr deutsche Quellen und etwas bessere Antworten.
  // Eine Regel „deutsche zuerst“ wirkte zu stark (allgemeine deutsche Artikel statt Anleitungen), eine zusätzliche
  // „passende Stelle“ je Artikel verwirrte das kleine Modell.
  async function quellenPruefen(frage, eintraege, thema) {
    const artikel = eintraege.map(x => x.a);
    const liste = eintraege.map(({ t, a }, i) => {
      const anfang = (a.abschnitte[0] ? a.abschnitte[0].text : "").replace(/\s+/g, " ").slice(0, 280);
      const kapitel = a.abschnitte.map(s => s.ueberschrift).filter(Boolean).slice(0, 10).join(", ");
      const herkunft = "\nAus: " + t.buch.titel.replace(/\s*\(.*$/, "") + (t.buch.englisch ? " (englisch)" : " (deutsch)");
      return "[" + (i + 1) + "] " + (a.titel || "") + herkunft + "\nAnfang: " + anfang + (kapitel ? "\nAbschnitte: " + kapitel : "");
    }).join("\n\n");
    const sys = "Du prüfst Suchergebnisse. Für jeden Artikel entscheidest du: Enthält er Wissen, das hilft, diese Frage zu beantworten? " +
      "Er hilft auch, wenn er nur einen Teil beantwortet oder das passende Gerät, Verfahren oder Grundwissen erklärt. " +
      "Er hilft nicht, wenn es um ein anderes Gerät, eine andere Sache oder ein anderes Thema geht, auch wenn einzelne Wörter gleich sind. " +
      "Er hilft auch nicht, wenn er zu einer anderen Lage gehört: Schließt die Frage etwas aus (z. B. „ohne Strom“, „ohne Gerät X“), hilft ein Artikel nicht, der genau das voraussetzt. " +
      "Artikel für Feuerwehr, Industrie, Kraftwerke oder Fachbetriebe helfen bei Fragen aus dem Alltag nicht. " +
      "Allgemeine Artikel und Anleitungen, die das Thema im Ganzen erklären, kommen vor Einzelversuchen, Sonderfällen und Forenfragen. " +
      "Antworte nur mit JSON: die Nummern der hilfreichen Artikel, der hilfreichste zuerst.";
    const schema = { type: "object", properties: { passend: { type: "array", items: { type: "integer" }, maxItems: 7 } }, required: ["passend"] };
    const roh = await KI.chat([{ role: "system", content: sys }, { role: "user", content: "FRAGE: " + frage + (thema ? "\nKERN DER FRAGE: " + thema : "") + "\n\nARTIKEL:\n" + liste }],
      { max_tokens: 60, temperature: 0, response_format: { type: "json_schema", json_schema: { name: "pruefung", schema } } });
    const j = JSON.parse(roh);
    return [...new Set((j.passend || []).map(n => n - 1).filter(i => i >= 0 && i < artikel.length))];
  }

  function landName() {
    const l = Land.aktuell() || {};
    return (l.name && (l.name.de || l.name.en)) || l.code || "Deutschland";
  }

  // Grobe Einordnung der Frage, damit nur die passenden Regeln in die Anweisung kommen
  function fragenArt(frage) {
    const f = frage.toLowerCase();
    return {
      reparatur: /reparier|kaputt|defekt|geht nicht|nicht mehr an|lässt sich nicht|funktioniert nicht|springt nicht|lädt nicht|rauscht|tropft|undicht|klemmt|wird nicht|abgesprungen|platten|flick|loch im|sohle|sicherung/.test(f),
      gesundheit: /verletz|wunde|blut|schmerz|stich|biss|zecke|vergift|fieber|krank|durchfall|erbrech|verbrenn|verbrüh|bruch|gebrochen|schiene|unterkühl|erfrier|sonnenstich|hitzschlag|bewusstlos|atem|herz|allerg|blase|nasenbluten|medikament|tablette|notfall|notruf/.test(f),
      bedingung: /\bohne\b|stromausfall|\bkein(e|en)?\b/.test(f),
      heizen: /heiz|wärm|warm|kerze|frier|kalt/.test(f),
      trinkwasser: /trink|pfütze|bachwasser|regenwasser|flusswasser|quellwasser|brunnen|wasserfilter|wasser.*(desinfiz|keim|aufbereit|filtern|sauber)|chlortablett/.test(f),
    };
  }

  async function antworten(frage, quellen, einfach, vorher, lage, onText) {
    // Regeln für bestimmte Fragen nur dann mitgeben, wenn die Frage dazu passt. Das kleine Modell wendet
    // jede Regel sonst auch auf andere Fragen an (Abkochen beim Heizen, Fehlerbilder bei Eicheln).
    const art = fragenArt(frage);
    const sys =
      "Du bist ein hilfsbereiter Assistent in einer Offline-Bibliothek für Selbsthilfe. Antworte immer auf " + (Land.sprache() === "en" ? "Englisch" : "Deutsch") + ". " +
      "Der Nutzer lebt in " + landName() + ", Notrufnummer: " + Land.notruf() + ". " +
      "Bei Fragen zu Recht, Regeln und Behörden gilt, was in diesem Land gilt; beschreibt eine Quelle ein anderes Land, sag das deutlich dazu. " +
      LAGEN[lage || "normal"] + " " +
      "Bei praktischen Problemen will der Nutzer es selbst lösen, mit dem, was er hat oder findet: Gib dann eine Anleitung, wie er es selbst schafft. " +
      "Empfiehl nicht, eine Firma, einen Handwerker oder Fachleute zu beauftragen oder etwas zu kaufen. " +
      "Gibt es einen einfachen üblichen Weg, nenne ihn kurz zuerst und danach die Wege, wenn er nicht geht. " +
      "Nenne nur Sicherheitsregeln, die zu genau dieser Sache passen; erfinde keine Gefahren, die es bei dieser Sache nicht gibt. " +
      (art.reparatur
        ? "Erkläre in ein bis zwei Sätzen, wie das Gerät grundsätzlich funktioniert. Nennt die Frage keinen bestimmten Fehler, " +
          "gliederst du nach den typischen Fehlerbildern dieses Geräts (was der Nutzer bemerkt) und gibst zu jedem die häufigsten Ursachen und was man prüfen und tun kann, " +
          "vom Einfachen zum Schwierigen. Anleitungen für andere Modelle oder Marken sind oft übertragbar. "
        : "Bei praktischen Fragen nennst du die bewährten Wege, den sichersten und einfachsten zuerst. ") +
      (art.gesundheit
        ? "Erkläre, was man selbst tun kann (Erste Hilfe), und sag kurz, wann man Hilfe holen muss. Ist ein Mensch in Lebensgefahr oder schwer verletzt, nennst du zuerst den Notruf. "
        : "Den Notruf nennst du nur, wenn ein Mensch in Gefahr ist, nie bei Geräten und Reparaturen. ") +
      (art.trinkwasser
        ? "Filtern, Absetzen oder Pflanzenmittel machen Wasser nicht keimfrei. Nenne zuerst Abkochen (mindestens 1 Minute sprudelnd kochen) als sicheren Weg, " +
          "auch wenn die Quellen es nicht erwähnen, und Filtern nur als Vorstufe gegen Schmutz. "
        : "") +
      "Nur wenn deine Anleitung selbst Arbeiten am Netzstrom oder an Gasleitungen enthält, schreibst du dazu einen kurzen passenden Sicherheitshinweis. " +
      "Beschreibt eine Quelle einen anderen Fall (anderer Ort, anderes Gerät, andere Lage), übernimm nur, was sich übertragen lässt, nicht die Einzelheiten dieses Falls. " +
      (art.bedingung
        ? "Halte dich an die Bedingungen der Frage (z. B. „ohne …“, „bei Stromausfall“): Empfiehl nichts, was gegen sie verstößt, etwa ein Gerät, das Strom braucht, wenn es keinen Strom gibt, oder das Gerät, ohne das es gehen soll. "
        : "") +
      "Lass Teile einer Quelle weg, die für Feuerwehr, Industrie oder Fachbetriebe gedacht sind, wenn die Frage aus dem Alltag kommt. " +
      (art.heizen
        ? "Feuer, Grill, Gaskocher oder Kerzen als Wärmequelle in geschlossenen Räumen nur mit Hinweis auf Lüften und Kohlenmonoxid, offenes Feuer in der Wohnung nie. "
        : "") +
      "Bei Wissensfragen, Rat oder Beschäftigung (z. B. Geschichte, Natur, Begriffe, Spiele) antwortest du einfach direkt und passend, ohne Anleitung und ohne Sicherheitsregeln. " +
      "Gedichte, Zitate, Liedtexte und Zahlen gibst du nur wieder, wenn sie wörtlich in den QUELLEN stehen; schreib nie selbst ein Gedicht und schreib nie etwas einem Autor zu, das nicht so in den Quellen steht. " +
      "Diese Regeln befolgst du still: Erwähne sie nicht in der Antwort. Sprich den Nutzer mit \"du\" an. " +
      "Nutze nur die Informationen aus den QUELLEN und erfinde nichts. " +
      "Wenn die Quellen die Frage nur teilweise beantworten, gib trotzdem die passenden praktischen Informationen daraus wieder. " +
      "Nur wenn gar nichts Passendes in den Quellen steht, sag ehrlich, dass du dazu nichts gefunden hast. " +
      "Schreib nie, dass etwas ohne Fachwissen zu schwierig ist: Die Bibliothek ist dazu da, sich das Wissen anzueignen. " +
      "Ist die Frage so allgemein, dass eine genauere Angabe deutlich bessere Hilfe brächte, endest du mit einem kurzen Satz, was du dafür wissen müsstest (bei Geräten z. B. was genau passiert). " +
      "Passt keine Rückfrage, lässt du sie weg. Schreib keine Überschriften wie \"Rückfrage\" oder \"Grundprinzip\". " +
      "Kennzeichne Aussagen mit der Quellennummer in eckigen Klammern, z. B. [1]. Englische Quellen übersetzt du sinngemäß. " +
      "Antworte klar und praktisch, bei Anleitungen in nummerierten Schritten. Halte dich kurz (höchstens etwa 250 Wörter). " +
      (einfach ? "Erkläre es so einfach, dass ein Kind mit 8 bis 10 Jahren es versteht: kurze Sätze, keine Fachwörter, ein anschauliches Beispiel. " : "");
    const block = quellen.map(q => "[" + q.nr + "] " + q.titel + " (" + q.buch.titel + ")\n" + q.text).join("\n\n");
    const nachrichten = [{ role: "system", content: sys }];
    if (vorher) nachrichten.push({ role: "user", content: vorher.frage }, { role: "assistant", content: vorher.antwort.slice(0, 800) });
    nachrichten.push({ role: "user", content: "QUELLEN:\n" + block + "\n\nFRAGE: " + frage +
      (vorher ? "\n\n(Beantworte nur diese FRAGE mit diesen QUELLEN. Ist es ein neues Thema, erwähne das vorherige Gespräch nicht.)" : "") });
    return KI.chat(nachrichten, { max_tokens: 700, temperature: 0.3 }, onText);
  }

  function zeigeAntwort(ziel, text, quellen) {
    ziel.innerHTML = esc(text)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/^#+\s*(.+)$/gm, "<b>$1</b>")
      .replace(/\[(\d+)\]/g, (m, n) => {
        const q = quellen.find(x => x.nr === +n);
        return q ? '<a class="zitat" href="' + leseLink(q) + '" title="' + esc(q.titel) + '">[' + n + "]</a>" : m;
      });
  }

  function leseLink(q) {
    // Stellen aus PDF-Büchern öffnen im eigenen PDF-Leser auf der gefundenen Seite
    const pdf = String(q.url).match(/^(\/kiwix\/content\/[^#]+\.pdf)(?:#page=(\d+))?$/i);
    if (pdf) return "#pdf?url=" + encodeURIComponent(pdf[1]) + (pdf[2] ? "&seite=" + pdf[2] : "") + "&titel=" + encodeURIComponent(String(q.titel).replace(/, Seite \d+$/, ""));
    return "#lesen?url=" + encodeURIComponent(q.url) + "&titel=" + encodeURIComponent(q.titel);
  }

  function quellenListe(quellen, mitAuszug) {
    return el("div", { class: "quellen" }, el("b", {}, "Quellen"),
      el("ol", {}, ...quellen.map(q => el("li", {},
        el("a", { href: leseLink(q) }, q.titel), " ", el("span", { class: "paket" }, "· " + q.buch.titel + (q.buch.englisch ? " (englisch)" : "")),
        mitAuszug ? el("div", { class: "klein hinweis" }, q.text.slice(0, 280) + " …") : null))));
  }

  return { zeigen };
})();
