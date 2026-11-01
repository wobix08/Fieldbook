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
    else box.append("Stell eine Frage. Ich suche in der Offline-Bibliothek und antworte mit Quellen.");
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
    if (e.medizin) box.append(medizinHinweis());
    $("#chat").append(box);
  }

  function medizinHinweis() {
    return el("p", { class: "medizin-hinweis warnung" }, "Gesundheitsthema: Bitte die Quellen lesen. Im akuten Notfall: ", el("a", { href: "#erstehilfe" }, "Erste-Hilfe-Spickzettel"), " oder Notruf " + Land.notruf() + ".");
  }

  // Nur das Nötige aus den Quellen speichern
  const kurzQuellen = (qs) => qs.map(q => ({ nr: q.nr, titel: q.titel, url: q.url, text: (q.text || "").slice(0, 300), buch: { titel: q.buch.titel, name: q.buch.name, englisch: !!q.buch.englisch } }));

  // Lage des Nutzers: bestimmt, welche Mittel die KI voraussetzen darf
  const LAGEN = {
    normal: "Lage: zu Hause. Strom und einfaches Werkzeug sind vermutlich da, Läden und Fachleute aber nicht unbedingt erreichbar.",
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
      const buecher = (await Kiwix.buecher()).filter(b => b.durchsuchen);
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
      const s3 = schritt("Artikel werden gelesen …");
      const quellen = await lesen(treffer, suchFrage, begriffe, budget());
      fertig(s3, quellen.length + " Artikel gelesen");

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
      const medizin = quellen.some(q => /medicine|mdwiki|medizin/i.test(q.buch.name)) || /wunde|blut|schmerz|vergift|fieber|verbrenn|bruch|medikament|krank|atem|herz/i.test(frage);
      if (medizin) box.append(medizinHinweis());
      verlauf.push({ frage: suchFrage, antwort });
      if (verlauf.length > 3) verlauf.shift();
      merke({ frage, suchFrage, antwort, medizin, quellen: kurzQuellen(quellen) });
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

  async function suchbegriffe(frage, englisch, vorher, lage) {
    const kontext = vorher ? "Vorherige Frage im Gespräch (nur beachten, wenn sich die neue Frage darauf bezieht, z. B. mit \"das\", \"dazu\", \"und wenn …\"): " + vorher.frage + "\n" : "";
    const sys = "Du erzeugst Suchbegriffe für eine Offline-Bibliothek (Wikipedia, Lehrbücher, Reparatur- und Selbsthilfe-Anleitungen). " +
      "Gib 1 bis 3 kurze deutsche Suchbegriffe zurück, die wie Artikeltitel klingen (Substantive, z. B. \"Schnittwunde\", \"Radioempfänger\", \"Wundversorgung\"). " +
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
      properties: {
        de: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        en: { type: "array", items: { type: "string" }, maxItems: 2 },
      },
      required: englisch ? ["de", "en"] : ["de"],
    };
    const roh = await KI.chat([
      { role: "system", content: sys },
      { role: "user", content: kontext + "Frage: " + frage },
    ], { max_tokens: 120, temperature: 0.1, response_format: { type: "json_schema", json_schema: { name: "suche", schema } } });
    let j;
    try { j = JSON.parse(roh); } catch { const m = roh.match(/\{[\s\S]*\}/); j = m ? JSON.parse(m[0]) : null; }
    if (!j || !Array.isArray(j.de) || !j.de.length) throw new Error("keine Begriffe");
    const sauber = (a) => (a || []).map(s => String(s).trim()).filter(s => s && s.length < 60).slice(0, 3);
    return { de: sauber(j.de), en: englisch ? sauber(j.en).slice(0, 2) : [] };
  }

  // Titel-Treffer und Volltext-Treffer kombinieren und bewerten
  // Pakete mit Anleitungen zum Selbermachen
  const PRAXIS_PAKET = /appropedia|post-disaster|ifixit|wikibooks|energypedia|electronics|diy\.|mechanics|bicycles|ham\.|outdoors|gardening|cooking|sustainability|wikihow|survival|bushcraft/i;

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
        auftraege.push(Kiwix.vorschlaege(b, begriff, 3).then(r => r.map((t, i) => {
          const exakt = t.titel.toLowerCase() === begriff.toLowerCase();
          return Object.assign(t, { punkte: (exakt ? 12 : 6 - i * 1.5) - bi, begriff });
        })).catch(() => []));
        auftraege.push(Kiwix.suche(b, begriff, 4).then(r => r.map((t, i) => Object.assign(t, { punkte: 5 - i - bi, begriff }))).catch(() => []));
      });
    }
    const alle = (await Promise.all(auftraege)).flat();
    // Gleiche Artikel zusammenfassen
    const nachUrl = new Map();
    for (const t of alle) {
      const key = decodeURIComponent(t.url).toLowerCase();
      const v = nachUrl.get(key);
      if (v) v.punkte += t.punkte * 0.6; else nachUrl.set(key, Object.assign({}, t));
    }
    // Wikipedia-Medizin und Haupt-Wikipedia leicht bevorzugen, Englisch leicht abwerten
    const liste = [...nachUrl.values()].map(t => {
      if (/medicine/.test(t.buch.name)) t.punkte += 1;
      if (t.buch.englisch) t.punkte -= 1.5;
      // Kinderlexikon nur im Modus "Einfach erklären" bevorzugen
      if (/klexikon/.test(t.buch.name)) t.punkte += einfach ? 3 : -3;
      // Wörterbuch nur bei Fragen nach Wortbedeutungen
      if (/wiktionary/.test(t.buch.name) && !/bedeut|heißt|wort|übersetz|herkunft/i.test(begriffe.frage || "")) t.punkte -= 4;
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
    }).sort((a, b) => b.punkte - a.punkte);
    if (!liste.length) return [];
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

  async function lesen(treffer, frage, begriffe, budgetZeichen) {
    const woerter = staemme(frage + " " + begriffe.de.join(" ") + " " + begriffe.en.join(" "));
    const anleitung = ANLEITUNG.test(frage);
    const texte = await Promise.all(treffer.map(t => Kiwix.artikelText(t.url).then(a => ({ t, a })).catch(() => null)));
    // Gleiche Zielartikel (nach Weiterleitungen) nur einmal
    const gesehen = new Set();
    const gueltig = texte.filter(x => {
      if (!x || !x.a.abschnitte.length) return false;
      // Platzhalterseiten ohne brauchbaren Inhalt überspringen (z. B. iFixit-Geräteseiten, die nur Datenblätter sind)
      const voll = x.a.abschnitte.map(s => s.text).join(" ");
      if (voll.length < 300) return false;
      if (/California Energy Commission|Date Added: \d{4}/.test(voll) && !/\b(step|schritt|replace|austausch|remove|entfern)/i.test(voll)) return false;
      const k = decodeURIComponent(x.a.url).toLowerCase();
      if (gesehen.has(k)) return false;
      gesehen.add(k);
      return true;
    }).slice(0, 4);
    const proArtikel = Math.floor(budgetZeichen / Math.max(1, gueltig.length));
    return gueltig.map(({ t, a }, i) => {
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
      return { nr: i + 1, titel: a.titel || t.titel, url: a.url || t.url, buch: t.buch, text };
    });
  }

  async function antworten(frage, quellen, einfach, vorher, lage, onText) {
    const sys =
      "Du bist ein hilfsbereiter Assistent in einer Offline-Bibliothek für Selbsthilfe. Antworte immer auf " + (Land.sprache() === "en" ? "Englisch" : "Deutsch") + ". " +
      "Notrufnummer im Land des Nutzers: " + Land.notruf() + ". " +
      LAGEN[lage || "normal"] + " " +
      "Der Nutzer will es selbst tun, mit dem, was er hat oder findet. Gib eine praktische Anleitung zum Selbermachen. " +
      "Empfiehl nicht, eine Firma, einen Handwerker oder Fachleute zu beauftragen oder etwas zu kaufen. " +
      "Die naheliegende Standardlösung (z. B. Feuerzeug, Steckdose) erwähnst du höchstens in einem kurzen Satz und erklärst dann die Wege ohne sie. " +
      "Nenne kurz die wichtigsten Sicherheitsregeln (z. B. Kurzschluss, richtige Polung, Gase, Brandgefahr). " +
      "Bei Reparaturen erklärst du in ein bis zwei Sätzen, wie das Gerät grundsätzlich funktioniert, und gehst dann die häufigsten Ursachen der Reihe nach durch, " +
      "vom Einfachen zum Schwierigen, jeweils mit: woran man es erkennt und was man tun kann. Anleitungen für andere Modelle oder Marken sind oft übertragbar. " +
      "Ausnahme: Ist ein Mensch in Lebensgefahr oder schwer verletzt, nennst du zuerst den Notruf. Bei Geräten, Technik und Reparaturen nennst du keinen Notruf. " +
      "Bei Arbeiten an 230-Volt-Netzstrom oder Gasleitungen schreibst du einen kurzen Sicherheitshinweis, z. B. \"Vorher den Stecker ziehen\". " +
      "Bei reinen Wissensfragen (z. B. Geschichte, Tiere, Begriffe) antwortest du einfach sachlich, ohne Anleitung. " +
      "Diese Regeln befolgst du still: Erwähne sie nicht in der Antwort. Sprich den Nutzer mit \"du\" an. " +
      "Nutze nur die Informationen aus den QUELLEN und erfinde nichts. " +
      "Wenn die Quellen die Frage nur teilweise beantworten, gib trotzdem die passenden praktischen Informationen daraus wieder und sag kurz, was fehlt. " +
      "Nur wenn gar nichts Passendes in den Quellen steht, sag ehrlich, dass du dazu nichts gefunden hast. " +
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
