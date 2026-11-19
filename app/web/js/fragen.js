// Fragen: KI macht Suchbegriffe -> Suche in der Bibliothek -> KI antwortet mit Quellen.
"use strict";

const Fragen = (() => {
  let beschaeftigt = false;
  let wartendeFrage = null; // Frage, die während einer laufenden Antwort kam
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
      // Läuft gerade eine Antwort: Frage merken, sie wird danach gestellt (bis dahin steht sie im Feld)
      if (beschaeftigt) {
        wartendeFrage = q;
        $("#frage-feld").value = q;
        const h = el("div", { class: "hinweis klein" }, "Deine Frage wird gestellt, sobald die laufende Antwort fertig ist.");
        $("#chat").append(h);
        h.scrollIntoView({ block: "end" });
        return;
      }
      $("#frage-feld").value = q;
      senden();
      return;
    }
    setTimeout(() => $("#frage-feld").focus(), 50);
  }

  function begruessung() {
    const s = OW.status || {};
    const box = el("div", { class: "antwort" });
    if (!s.wissen) box.append("Es ist noch keine Bibliothek installiert. ", el("a", { href: "#inhalte?zu=wissen" }, "Wissen unter „Inhalte“ laden"));
    else if (!s.modell) box.append("Es ist keine KI eingerichtet. Du kannst trotzdem fragen: Dann zeige ich passende Artikel. ", el("a", { href: "#inhalte?zu=ki" }, "KI unter „Inhalte“ laden"));
    else if (s.sparmodus) box.append("Der Sparmodus ist an, die KI ist aus. Ich zeige dir passende Artikel. ", el("button", { class: "knopf knopf-klein", onclick: () => schalteKi(true) }, "KI einschalten"));
    else box.append("Stell eine Frage. Ich suche in der Offline-Bibliothek und antworte mit Quellen.");
    $("#chat").append(box);
    // Kleine Modelle (bis 9B): Tipp, dass genaue Fragen viel bessere Antworten bringen. Zugeklappt rechts in der
    // Zeile „Zum Beispiel“, aufgeklappt schwebend darunter (verschiebt nichts)
    const tipp = s.modell && !s.sparmodus && /-(0\.\d+|\d)b$/i.test(s.modell)
      ? el("details", { class: "frage-tipp", id: "frage-tipp" },
        el("summary", {}, "Tipp: Je genauer die Frage, desto besser die Antwort"),
        el("div", { class: "frage-tipp-text" },
          "Die KI auf deinem Gerät ist viel kleiner als große Online-KIs (z. B. Claude oder ChatGPT).", el("br"),
          "Je genauer du fragst, desto besser die Antwort.", el("br"),
          // Beide Fragen je 10-mal getestet: die genaue ohne Fehler (Note 3,4), die ungenaue schwächer (2,9, ein Fehler)
          "Also lieber „Wie repariere ich einen Schuh, dessen Sohle sich löst?“ als „Wie repariere ich einen Schuh?“."))
      : null;
    // Beispielfragen zum Anklicken: zeigen, wie man gut fragt. Jedes Mal drei zufällige aus BEISPIELE.
    // Im Rundgang nur die Frage, die die Beispiel-KI kennt (kommt aus uebung/ki/antworten.json nach)
    const knopf = (f) => el("button", { type: "button", class: "beispielfrage", onclick: () => {
      if (beschaeftigt) return;
      $("#frage-feld").value = f;
      senden();
    } }, f);
    if (!s.wissen) return;
    const leiste = el("div", { class: "beispielfragen" },
      el("div", { class: "beispiel-kopf" }, el("span", { class: "hinweis klein" }, "Zum Beispiel:"), tipp));
    $("#chat").append(leiste);
    if (!uebung()) leiste.append(...zufaellige(BEISPIELE, 3).map(knopf));
    else uebungDaten().then(d => {
      const a = d && d.antworten.find(x => x.nach === 0);
      if (a && leiste.isConnected) leiste.append(knopf(a.frage));
    });
  }
  // Nur Fragen, die in den KI-Tests (Qwen 3.5 4B, je 10 Durchläufe, .claude/ki-tests) zuverlässig gut beantwortet
  // wurden; siehe ki.md. „Ohne Fehler“ reicht nicht, manche Antworten sagen nur „keine Angaben gefunden“.
  // Stand 13. Nov. 2026: die einzigen 4 von 26 getesteten Fragen ohne Fehler in allen 10 Läufen.
  const BEISPIELE = [
    "Wie erkenne ich einen Knochenbruch?",
    "Wie repariere ich einen Schuh, dessen Sohle sich löst?",
    "Was hilft gegen Kopfschmerzen ohne Tabletten?",
    "Wie lagere ich Trinkwasser für den Notfall?"
  ];
  // n zufällige, verschiedene Einträge (Reihenfolge ebenfalls zufällig)
  function zufaellige(liste, n) {
    const rest = liste.slice();
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    return rest.slice(0, n);
  }

  // Neues Thema: Anzeige und Gedächtnis leeren
  function neuerChat() {
    if (beschaeftigt) return;
    verlauf.length = 0;
    uebungTeile.length = 0;
    chatId = null;
    eintraege = [];
    $("#chat").innerHTML = "";
    begruessung();
    markiereAktiv();
    verlaufZu();
    $("#frage-feld").focus();
  }
  $("#neuer-chat").addEventListener("click", neuerChat);
  // Aufgeklappter Tipp schließt bei Klick daneben und mit Esc
  document.addEventListener("click", (e) => { const t = $("#frage-tipp"); if (t && t.open && !t.contains(e.target)) t.open = false; });
  document.addEventListener("keydown", (e) => { const t = $("#frage-tipp"); if (t && e.key === "Escape" && t.open) { t.open = false; t.querySelector("summary").focus(); } });

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
    const alle = $("#alle-weg");
    alleWischen(false);
    alle.hidden = !chats.length;
    alle.dataset.anzahl = chats.length;
    if (!chats.length) { ziel.append(el("div", { class: "leer" }, "Noch keine Chats. Deine Fragen werden hier gespeichert.")); return; }
    for (const c of chats) {
      // Löschen wie am Handy: X (oder nach links ziehen) schiebt den Eintrag zur Seite, dahinter liegt „Löschen“
      const eintrag = el("div", { class: "chat-eintrag", "data-id": c.id },
        el("button", { class: "chat-endgueltig", tabindex: "-1", onclick: () => loescheChat(c.id) }, "Löschen"),
        el("div", { class: "chat-zeile" },
          el("button", { class: "oeffnen", title: c.titel, onclick: (e) => { if (eintrag.dataset.gezogen) { e.preventDefault(); return; } oeffneChat(c.id); } },
            el("span", { class: "t" }, c.titel), el("small", {}, zeitText(c.zeit))),
          el("button", { class: "weg", title: "Chat löschen", "aria-label": "Chat löschen", onclick: () => wischen(eintrag, !eintrag.classList.contains("gewischt")) }, sym("x"))));
      ziehbar(eintrag);
      ziel.append(eintrag);
    }
    markiereAktiv();
  }

  // Eintrag zur Seite schieben (zeigt „Löschen“) oder zurück; immer nur einer zugleich offen
  function wischen(eintrag, auf) {
    for (const e of document.querySelectorAll(".chat-eintrag.gewischt")) if (e !== eintrag) wischen(e, false);
    eintrag.classList.toggle("gewischt", auf);
    const knopf = eintrag.querySelector(".chat-endgueltig");
    knopf.tabIndex = auf ? 0 : -1;
    if (auf) knopf.focus({ preventScroll: true });
  }

  // Mit Maus oder Finger nach links ziehen öffnet, nach rechts schließt
  function ziehbar(eintrag) {
    const zeile = eintrag.querySelector(".chat-zeile");
    let start = null, dx = 0;
    zeile.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".weg")) return;
      start = e.clientX; dx = 0; delete eintrag.dataset.gezogen;
    });
    zeile.addEventListener("pointermove", (e) => {
      if (start === null) return;
      dx = e.clientX - start;
      if (Math.abs(dx) < 8 && !eintrag.dataset.gezogen) return;
      if (!eintrag.dataset.gezogen) { eintrag.dataset.gezogen = "1"; zeile.setPointerCapture(e.pointerId); eintrag.classList.add("zieht"); }
      const basis = eintrag.classList.contains("gewischt") ? -88 : 0;
      zeile.style.transform = "translateX(" + Math.max(-120, Math.min(0, basis + dx)) + "px)";
    });
    const ende = () => {
      if (start === null) return;
      start = null;
      eintrag.classList.remove("zieht");
      zeile.style.transform = "";
      if (eintrag.dataset.gezogen) {
        if (dx < -40) wischen(eintrag, true); else if (dx > 40) wischen(eintrag, false);
        // Der Klick nach dem Ziehen soll den Chat nicht öffnen
        setTimeout(() => delete eintrag.dataset.gezogen, 0);
      }
    };
    zeile.addEventListener("pointerup", ende);
    zeile.addEventListener("pointercancel", ende);
  }

  // „Alle Chats löschen“ genauso: der Knopf gleitet weg, darunter liegt der rote Knopf, der wirklich löscht
  function alleWischen(auf) {
    const alle = $("#alle-weg"), knopf = $("#chats-endgueltig");
    if (auf) {
      const n = +alle.dataset.anzahl || 0;
      knopf.textContent = n === 1 ? "Ja, den Chat löschen" : "Ja, alle " + n + " Chats löschen";
    }
    alle.classList.toggle("gewischt", auf);
    knopf.tabIndex = auf ? 0 : -1;
    $("#chats-loeschen").tabIndex = auf ? -1 : 0;
    if (auf) knopf.focus({ preventScroll: true });
  }

  // Klick daneben oder Esc schiebt einen offenen Eintrag zurück
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".chat-eintrag.gewischt")) for (const x of document.querySelectorAll(".chat-eintrag.gewischt")) wischen(x, false);
    if (!e.target.closest("#alle-weg")) alleWischen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const x of document.querySelectorAll(".chat-eintrag.gewischt")) wischen(x, false);
    alleWischen(false);
  });

  function markiereAktiv() {
    for (const e of document.querySelectorAll(".chat-eintrag")) e.classList.toggle("aktiv", e.dataset.id === chatId);
  }

  async function oeffneChat(id) {
    if (beschaeftigt) return;
    let c;
    try { c = await api("chat?id=" + encodeURIComponent(id)); } catch (e) { c = null; }
    if (beschaeftigt) return;   // inzwischen läuft eine Frage: Chat nicht darunter austauschen
    if (!c || c.fehler) {
      dialog("Chat nicht geöffnet", "Dieser Chat ließ sich gerade nicht öffnen. Bitte versuche es noch einmal.", [{ text: "OK", wert: true, haupt: true }]);
      return;
    }
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

  // Hilfen: Frist für Anfragen, sicheres Dekodieren, begrenzt parallel laden
  // Knopf „Anhalten“: stoppCtl gilt für die laufende Frage. Jede KI-Anfrage hängt sich daran (mitFrist, mitLeerlauf),
  // halt() prüft zwischen den Schritten (Suche und Lesen fragen die KI nicht und laufen sonst weiter).
  let stoppCtl = null;
  const angehalten = () => !!(stoppCtl && stoppCtl.signal.aborted);
  function stoppFehler() { return Object.assign(new Error("Angehalten"), { angehalten: true }); }
  function halt() { if (angehalten()) throw stoppFehler(); }
  function anStopp(c) {
    const s = stoppCtl;
    if (!s) return () => { };
    if (s.signal.aborted) throw stoppFehler();
    const weg = () => c.abort();
    s.signal.addEventListener("abort", weg);
    return () => s.signal.removeEventListener("abort", weg);
  }
  async function mitFrist(ms, f) {
    const c = new AbortController();
    const los = anStopp(c);
    const t = setTimeout(() => c.abort(), ms);
    try { return await f(c.signal); }
    catch (e) {
      if (angehalten()) throw stoppFehler();
      if (c.signal.aborted) throw new Error("Zeitüberschreitung: keine Antwort innerhalb von " + Math.round(ms / 1000) + " Sekunden.");
      throw e;
    }
    finally { clearTimeout(t); los(); }
  }
  // Inaktivitäts-Frist für gestreamte Antworten: bis zum ersten Token erstMs, danach bricht nur ab,
  // wenn leerMs lang kein neues Token kommt. f bekommt (signal, aktiv); aktiv() bei jedem Token aufrufen.
  async function mitLeerlauf(erstMs, leerMs, f) {
    const c = new AbortController();
    const los = anStopp(c);
    let ms = erstMs, t;
    const starten = () => { clearTimeout(t); t = setTimeout(() => c.abort(), ms); };
    const aktiv = () => { ms = leerMs; starten(); };
    starten();
    try { return await f(c.signal, aktiv); }
    catch (e) {
      if (angehalten()) throw stoppFehler();
      if (c.signal.aborted) throw new Error("Zeitüberschreitung: keine Antwort innerhalb von " + Math.round(ms / 1000) + " Sekunden.");
      throw e;
    }
    finally { clearTimeout(t); los(); }
  }
  // Während eine Antwort läuft, wird aus „Fragen“ der Knopf „Anhalten“
  function sendeKnopf(laeuft) {
    const k = $("#frage-senden");
    k.disabled = false;
    k.classList.toggle("knopf-haupt", !laeuft);
    k.classList.toggle("anhalten", laeuft);
    k.replaceChildren(...(laeuft ? [sym("square"), "Anhalten"] : ["Fragen"]));
    if (laeuft) k.title = "Antwort anhalten"; else k.removeAttribute("title");
  }
  function anhalten() {
    if (!beschaeftigt) return;
    if (uebungStopp) { uebungStopp(); return; }
    if (stoppCtl) stoppCtl.abort();
    $("#frage-senden").disabled = true;   // bis die Antwort wirklich steht (kurz)
  }
  function dekodiert(s) { try { return decodeURIComponent(s); } catch { return String(s); } }
  async function parallel(liste, max, f) {
    let i = 0;
    const lauf = async () => { while (i < liste.length) { const x = liste[i++]; await f(x); } };
    await Promise.all(Array.from({ length: Math.min(max, liste.length) }, lauf));
  }

  // Die Rückfrage ist das Wegschieben selbst: „Löschen“ liegt erst nach dem X (oder Ziehen) frei
  async function loescheChat(id) {
    // Während einer Antwort gesperrt: Der Chat würde beim Speichern der Antwort wieder auftauchen
    if (beschaeftigt) {
      dialog("Bitte warten", "Gerade wird eine Antwort geschrieben. Danach lässt sich der Chat löschen.", [{ text: "OK", wert: true, haupt: true }]);
      return;
    }
    try { await api("chat/loeschen", { id }); }
    catch (e) {
      dialog("Chat nicht gelöscht", "Der Chat ließ sich gerade nicht löschen. Bitte versuche es noch einmal.", [{ text: "OK", wert: true, haupt: true }]);
      return;
    }
    if (id === chatId) neuerChat();
    ladeListe();
  }

  // Alle früheren Chats auf einmal löschen
  $("#chats-loeschen").addEventListener("click", () => { if (!beschaeftigt) alleWischen(true); });
  $("#chats-endgueltig").addEventListener("click", async () => {
    if (beschaeftigt) return;
    alleWischen(false);
    let r;
    try { r = await api("chats/loeschen", {}); } catch (e) { r = { fehler: "Fieldbook antwortet gerade nicht." }; }
    if (r.fehler) dialog("Nicht alles gelöscht", el("p", {}, r.fehler, el("br"), "Bitte versuche es noch einmal."), [{ text: "OK", wert: true, haupt: true }]);
    if (chatId) neuerChat();
    ladeListe();
  });

  // Nach jeder Antwort speichern. Der Titel ist die erste Frage
  async function merke(eintrag) {
    eintraege.push(eintrag);
    if (!chatId) chatId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const titel = eintraege[0].frage.length > 60 ? eintraege[0].frage.slice(0, 57) + " …" : eintraege[0].frage;
    try { await api("chat/speichern", { id: chatId, titel, eintraege }); } catch (e) { console.warn("Chat speichern:", e); }
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
    if (e.antwort) box.append(antwortKopieren(e.antwort, quellen));
    if (e.suche && e.suche.length) box.append(weitersuchen(e.suche));
    if (e.angehalten) box.append(el("p", { class: "hinweis klein antwort-angehalten" }, "Du hast die Antwort angehalten."));
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

  // Antwort mit Quellen als Text, z. B. zum Weiterschicken. Links fehlen bewusst, sie gehen nur auf diesem Laptop
  function antwortKopieren(antwort, quellen) {
    return el("div", { class: "antwort-knoepfe" }, kopierKnopf(() => schlichterText(antwort) +
      (quellen.length ? "\n\nQuellen:\n" + quellen.map(q => "[" + q.nr + "] " + q.titel + " (" + q.buch.titel + ")").join("\n") : "")));
  }

  function medizinHinweis() {
    return el("p", { class: "medizin-hinweis warnung" }, "Gesundheitsthema: Bitte die Quellen lesen. Im akuten Notfall: ", el("a", { href: "#erstehilfe" }, "Erste-Hilfe-Spickzettel"), " oder Notruf " + Land.notruf() + ".");
  }

  // Nur das Nötige aus den Quellen speichern
  const kurzQuellen = (qs) => qs.map(q => ({ nr: q.nr, titel: q.titel, url: q.url, text: (q.text || "").slice(0, 300), stelle: q.stelle, buch: { titel: q.buch.titel, name: q.buch.name, englisch: !!q.buch.englisch } }));

  // Lage des Nutzers: bestimmt, welche Mittel die KI voraussetzen darf
  const LAGEN = {
    normal: "Lage: zu Hause. Strom und einfaches Werkzeug sind vermutlich da.",
    strom: "Lage: Stromausfall. Kein Netzstrom, kein Internet, vielleicht kein Handynetz. Schlage nichts vor, das eine Steckdose braucht. Möglich sind z. B. Batterien, Autobatterie, Powerbank, Solarpanel, Gaskocher, Feuer.",
    draussen: "Lage: draußen oder unterwegs. Es gibt nur, was man dabei hat oder in der Natur findet. Keine Steckdose, kein Werkzeugkasten.",
    krise: "Lage: Krise. Keine Läden, keine Handwerker, keine Lieferungen, Hilfe ist vielleicht nicht erreichbar. Es gibt nur, was vorhanden ist oder sich finden, ausbauen (z. B. aus einem Auto) oder improvisieren lässt.",
  };
  try { const l = localStorage.getItem("ow-lage"); if (l && LAGEN[l]) $("#lage").value = l; } catch { }
  $("#lage").addEventListener("change", () => { try { localStorage.setItem("ow-lage", $("#lage").value); } catch { } });
  // „Schnell“: ohne Absatzsuche (Mischform). Standard ist gründlich; die Wahl bleibt gemerkt
  try { $("#schnell").checked = localStorage.getItem("ow-schnell") === "1"; } catch { }
  $("#schnell").addEventListener("change", () => { try { localStorage.setItem("ow-schnell", $("#schnell").checked ? "1" : "0"); } catch { } });

  $("#frage-form").addEventListener("submit", (e) => { e.preventDefault(); if (beschaeftigt) anhalten(); else senden(); });
  $("#frage-feld").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); senden(); } });

  // Rechnet die KI auf dem Prozessor (keine Grafikkarte)?
  const aufProzessor = () => ((OW.status || {}).backend || "cpu") === "cpu";

  // Budget für Artikeltext je nach Modell und Rechenweg
  function budget() {
    const s = OW.status || {};
    const ctx = (s.ki && s.ki.kontext) || 8192;
    return Math.min(aufProzessor() ? 4500 : 9000, Math.floor(ctx * 0.55 * 3));
  }

  async function senden() {
    if (uebung()) return uebungSenden();
    const frage = $("#frage-feld").value.trim();
    if (!frage || beschaeftigt) return;
    beschaeftigt = true;
    stoppCtl = new AbortController();
    sendeKnopf(true);
    $("#frage-feld").value = "";
    const einfach = $("#einfach").checked;
    const lage = LAGEN[$("#lage").value] ? $("#lage").value : "normal";

    const beispiele = $("#chat > .beispielfragen");   // nur die der Begrüßung, nicht der Vorschlag unter einer Antwort
    if (beispiele) beispiele.remove();
    $("#chat").append(el("div", { class: "frage-blase" }, frage));
    const box = el("div", { class: "antwort" });
    const schritte = el("ul", { class: "schritte-liste" });
    const text = el("div", { class: "antwort-text" });
    box.append(schritte, text);
    $("#chat").append(box);
    // Bis zum Eingabefeld scrollen (direkt unter der Antwort): So bleibt der Knopf „Anhalten“ zu sehen
    $("#frage-form").scrollIntoView({ behavior: "smooth", block: "end" });

    const schritt = (t) => { const li = el("li", {}, t); schritte.append(li); return li; };
    const fertig = (li, t, fehler) => { li.className = fehler ? "fehler" : "fertig"; if (t) li.textContent = t; };

    // Gesprächskontext im selben Chat:
    // - Kurze Ergänzung (z. B. nur eine Modellnummer): mit der vorherigen Frage verbinden
    // - Sonst bekommt die KI die vorherige Frage als Hintergrund, entscheidet aber selbst, ob sie dazugehört
    const vorher = verlauf[verlauf.length - 1];
    const ergaenzung = !!(vorher && istErgaenzung(frage));
    const suchFrage = ergaenzung ? vorher.frage + " " + frage : frage;
    const kontext = !ergaenzung && vorher && vorher.antwort ? vorher : null;

    // Antwort nur einmal pro Bild neu aufbauen (nicht bei jedem Token)
    let neuerText = null, rafId = 0;
    let teil = "", quellenJetzt = [];   // für „Anhalten“: was bis dahin geschrieben und gelesen ist
    const zeigeGedrosselt = (t, quellen) => {
      neuerText = t;
      teil = t;
      if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; if (neuerText !== null) zeigeAntwort(text, neuerText, quellen); });
    };
    const stopGedrosselt = () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; neuerText = null; };
    let bibFehler = false;   // Fehler kam von der Bibliothek, nicht von der KI
    const holeBuecher = async (neu) => {
      try { return await Kiwix.buecher(neu); } catch (e) { bibFehler = true; throw e; }
    };

    try {
      let buecher = (await holeBuecher()).filter(b => b.durchsuchen);
      // Die Bibliothek startet gerade neu (z. B. nach einem Absturz von kiwix-serve): kurz warten, noch einmal versuchen.
      // Sind gar keine Pakete installiert, lohnt das Warten nicht (dann zählen nur die eigenen Unterlagen)
      if (!buecher.length && (OW.status || {}).wissen > 0) {
        await new Promise(r => setTimeout(r, 4000));
        await aktualisiereStatus();
        buecher = (await holeBuecher(true)).filter(b => b.durchsuchen);
      }
      // Eigene Unterlagen (js/eigene.js) werden mit durchsucht, sobald ihr Text ausgelesen ist
      buecher = (await Eigene.alsBuch()).concat(buecher);
      if (!buecher.length) { bibFehler = true; throw new Error("Keine durchsuchbare Bibliothek installiert."); }
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
          halt();
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
      // Kernwörter der Frage für den Volltext (ohne die Lage „ohne Strom“), siehe suchen()
      if (mitKi) begriffe.satz = kurzfassung(suchFrage.replace(/\bohne\s+\S+/gi, " "));
      // Fieldbooks Kurs und Vorsorge werden in suchen() mit durchsucht (fieldbookDokumente)
      const gesundheit = fragenArt(suchFrage).gesundheit;
      // Bei Gesundheitsfragen nie Homöopathie-Ratgeber und keine iFixit-Anleitungen
      // (bei Verbrennungen kam sonst „LeapPad Screen Replacement“ in die Quellenliste, wegen Akku-Verbrennungen)
      const serioes = (liste) => !gesundheit ? liste : liste.filter(t => !UNSERIOES.test(t.titel + " " + (t.auszug || "")) &&
        !/ifixit/.test(t.buch.name));
      let treffer = serioes(await suchen(buecher, begriffe, einfach, praxis));
      halt();
      if (!treffer.length) {
        const kurz = kurzfassung(suchFrage);
        const woerter = kurz.split(" ").filter(w => w.length > 3 && !nummern.includes(w));
        const zweit = { de: [kurz].concat(woerter.slice(0, 2)), en: [kurz], codes: nummern, frage: suchFrage };
        treffer = serioes(await suchen(buecher, zweit, einfach, praxis));
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
      // Mit KI dauert die Prüfung noch etwas: so lange die ersten Treffer zum Selberlesen zeigen
      let vorlaeufig = mitKi && treffer.length ? vorlaeufigeListe(treffer) : null;
      if (vorlaeufig) box.append(vorlaeufig);

      // 3. Artikel lesen
      const s3 = schritt(mitKi ? "Artikel werden gelesen und geprüft …" : "Artikel werden gelesen …");
      let quellen = await lesen(treffer, suchFrage, begriffe, budget(), mitKi);
      halt();
      fertig(s3, quellen.length + (quellen.length === 1 ? " passender Artikel" : " passende Artikel") + " gelesen");
      // Passt keiner: ein zweiter Versuch mit anderen Begriffen (Oberbegriffe, Namen von Verfahren)
      if (!quellen.length && mitKi) {
        fertig(s3, "Keiner der gefundenen Artikel passt.");
        // Die KI hat alle ersten Treffer als unpassend aussortiert: nicht stehen lassen
        if (vorlaeufig) { vorlaeufig.remove(); vorlaeufig = null; }
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
        } catch { halt(); fertig(s3b, "Zweite Suche hat nicht geklappt.", true); }
        halt();
      }
      // Fieldbook-Inhalte zuerst: Quelle [1] gilt in antworten() als fachlich geprüft
      quellen = quellen.filter(q => q.intern).concat(quellen.filter(q => !q.intern)).map((q, i) => Object.assign(q, { nr: i + 1 }));
      // „kurs“: Fieldbook-Inhalte, aus denen allein die KI schreibt (Kurs-Lektion, bei Sicherheitsfragen jeder passende)
      const kurs = quellen.filter(q => q.kurs);
      if (!quellen.length) {
        if (vorlaeufig) vorlaeufig.remove();
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

      // VERSUCH Mischform: Mit Kurs-Lektion bekommt die KI heute nur den Kurs; geprüfte Absätze dürfen dazu, wenn sie
      // nach Bedeutung besser passen als der Rest des Budgets. Was an die KI geht, steht in der Liste zuerst.
      let anKi = kurs.length ? kurs : quellen;
      // Knopf „Schnell“ lässt die Mischform weg; window.__ohneMisch nur im Test (Vergleichslauf)
      if (suchhilfeDa() && begriffe.bedeutung !== false && !$("#schnell").checked && !window.__ohneMisch) {
        const s3c = schritt("Passende Absätze werden gesucht …");
        try {
          const abs = await absaetzeSuchen(buecher, begriffe, suchFrage);
          halt();
          // Sicherheitsfrage, Fieldbook allein: nur weitere Fieldbook-Absätze dazu. Sonst kam über die Mischform genau
          // der Bibliothekssatz zurück, den das Allein-Schreiben fernhalten soll (Regenwasser: Kinderlexikon, Beeren: Esstest)
          const nurFb = kurs.length && sicherheitsFrage(suchFrage);
          anKi = await mischen(anKi, nurFb ? abs.filter(p => p.art === "fieldbook") : abs, suchFrage, budget());
          fertig(s3c, anKi.filter(q => q.absatz).length + " passende Absätze dazu");
        } catch (e) { halt(); fertig(s3c, "Absatzsuche hat nicht geklappt.", true); }
      }
      quellen = anKi.concat(quellen.filter(q => !anKi.includes(q))).map((q, i) => Object.assign(q, { nr: i + 1 }));

      // Quellen sofort zeigen: Ohne Grafikkarte dauert es bis zum ersten Wort der Antwort noch etwa 30 s,
      // wer selbst lesen will, kann schon einen Artikel öffnen. Die ersten Treffer bleiben zugeklappt darunter.
      if (vorlaeufig) { box.insertBefore(quellenListe(quellen), vorlaeufig); vorlaeufig.open = false; }
      else box.append(quellenListe(quellen));
      quellenJetzt = quellen;

      // 4. Antworten
      const s4 = schritt("Antwort wird geschrieben …");
      text.classList.add("cursor");
      // Mit Kurs-Lektion schreibt die KI nur aus dem Kurs; die Bibliotheksartikel stehen zum Selberlesen in der Liste.
      // Test 13. Nov. 2026: Die restlichen Fehler kamen aus ihnen („bei Wirbelsäulenverdacht keine Seitenlage“, andere Handgriffe)
      const antwort = await antworten(suchFrage, anKi, einfach, kontext, lage, (t) => zeigeGedrosselt(t, quellen));
      text.classList.remove("cursor");
      stopGedrosselt();
      stellenSuchen(antwort, quellen);
      zeigeAntwort(text, antwort, quellen);   // letzter Stand immer direkt
      linksAuffrischen(box, quellen);
      fertig(s4, "Antwort fertig");
      box.insertBefore(antwortKopieren(antwort, quellen), vorlaeufig && vorlaeufig.isConnected ? vorlaeufig : null);
      const suche = weiterBegriffe(begriffe);
      box.append(weitersuchen(suche));
      // Wortanfänge statt Teilstrings: „Bruchrechnung“, „herzlich“ lösen nichts aus, „Herzinfarkt“, „Knochenbruch“ schon
      const medizin = quellen.some(q => q.intern || /medicine|mdwiki|medizin/i.test(q.buch.name)) ||
        /wunde(?!r)|\bblut|schmerz|vergift|fieber|\bverbrenn|(knochen|bein|arm|rippen|schädel|fuß|hand|wirbel)bruch|\bbruch(?!rechn|stück|teil|zahl)|gebrochen|medikament|\w*krank|\batem|\bherz(?!lich|og|los|ig|chen)/i.test(frage);
      if (medizin) box.append(medizinHinweis());
      verlauf.push({ frage: suchFrage, antwort });
      if (verlauf.length > 3) verlauf.shift();
      merke({ frage, suchFrage, antwort, medizin, quellen: kurzQuellen(quellen), suche });
    } catch (e) {
      text.classList.remove("cursor");
      stopGedrosselt();
      if (e && e.angehalten) {
        // Angehalten: Was schon geschrieben ist, bleibt stehen (auch im gespeicherten Chat), die Quellen auch
        if (teil) zeigeAntwort(text, teil, quellenJetzt);
        const offen = [...schritte.children].filter(li => !li.className);
        offen.forEach((li, i) => { if (i < offen.length - 1) li.remove(); else { li.className = "angehalten"; li.textContent = "Angehalten"; } });
        box.querySelectorAll(".vorlaeufig").forEach(v => { if (quellenJetzt.length) v.open = false; });
        box.append(el("p", { class: "hinweis klein antwort-angehalten" }, teil ? "Du hast die Antwort angehalten." : "Du hast die Frage angehalten."));
        if (teil) {
          verlauf.push({ frage: suchFrage, antwort: teil });
          if (verlauf.length > 3) verlauf.shift();
          merke({ frage, suchFrage, antwort: teil, angehalten: true, quellen: kurzQuellen(quellenJetzt) });
        }
        return;
      }
      console.error(e);
      // Verständlich statt „Failed to fetch“; die technische Meldung nur als Tooltip
      text.append(fehlerBox(bibFehler ? "Die Bibliothek ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal."
        : "Die KI hat nicht geantwortet. Bitte prüfe oben den KI-Status und versuche es noch einmal.",
        () => { $("#frage-feld").value = frage; senden(); }, "Nochmal fragen", e.message));
    } finally {
      beschaeftigt = false;
      stoppCtl = null;
      sendeKnopf(false);
      box.scrollIntoView({ behavior: "smooth", block: "end" });
      // Frage, die während der Antwort über ?q= kam, jetzt stellen
      if (wartendeFrage) {
        const w = wartendeFrage;
        wartendeFrage = null;
        $("#frage-feld").value = w;
        setTimeout(senden, 0);
      }
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
      "Jeder Begriff ist ein Wort oder höchstens zwei, ohne Verb und ohne \"ohne\", so wie ein Lexikonartikel heißt. " +
      // Test 15. Nov. 2026 (120 Testfragen): Ohne diesen Satz erfand das 4B-Modell oft Wörter wie „Kartoffelkühlung“,
      // die es als Artikel nicht gibt. Damit 172 statt 104 Begriffe mit echtem Artikel, 125 statt 99 deutsche Quellen.
      // Die Beispiele kommen absichtlich in keiner Testfrage vor
      "Nimm gebräuchliche Wörter, unter denen es wirklich einen Wikipedia-Artikel gibt, in der Einzahl (z. B. \"Zwiebel\", \"Prellung\", \"Sextant\"). " +
      "Erfinde keine neuen zusammengesetzten Wörter wie \"Zwiebelkühlung\" oder \"Prellungsversorgung\". " +
      "Die Lage der Frage (z. B. ohne Strom) steckt nicht im Suchbegriff. " +
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
    // Ohne Zufall (temperature 0): Dieselbe Frage findet immer dieselben Artikel (Nutzer, 18. Nov. 2026; mit 0.1 schwankten
    // die Quellen von Lauf zu Lauf). Nur der zweite Versuch nach erfolgloser Suche probiert mit Zufall andere Wörter.
    const roh = await mitFrist(60000, (signal) => KI.chat([
      { role: "system", content: sys },
      { role: "user", content: kontext + "Frage: " + frage },
    ], { max_tokens: 120, temperature: ohneErfolg ? 0.7 : 0, response_format: { type: "json_schema", json_schema: { name: "suche", schema } }, signal }));
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
    // Fieldbook-Inhalte (Kurs, Vorsorge) haben Adressen innerhalb von Fieldbook („#erstehilfe?…“, „#vorsorge?…“)
    if (url.startsWith("#")) return fieldbookDokumente().then(ds => {
      const d = ds.find(x => x.url === url);
      if (!d) throw new Error("Fieldbook-Inhalt fehlt");
      // In Abschnitten wie ein Artikel: Die Prüfung sieht dann „So hilfst du, Im Ernstfall: Unterkühlung“ bzw. die Punkte
      // der Vorsorge-Liste. Mit nur einem Textblock fehlte die Abschnittsliste, und die Prüfung nahm bei Unterkühlung
      // zweimal von fünf Läufen nur die Wikibooks-Artikel mit „Maßnahmen bei …“ (Test 18. Nov. 2026)
      return { titel: d.titel, url: d.url, abschnitte: d.abschnitte, fb: d };
    });
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
    // höchstens 4 Artikel gleichzeitig laden
    await parallel(treffer.filter(t => !t.auszug && !t.pdf), 4, t => artikel(t.url).then(a => {
      t.auszug = a.abschnitte.slice(0, 2).map(s => s.text).join(" ").slice(0, 300);
    }).catch(() => {}));
    const texte = treffer.map(t => "title: " + t.titel + " | text: " + String(t.auszug || "").replace(/<[^>]+>/g, "").slice(0, 300));
    // Frist 20 s: hängt die Suchhilfe, geht es ohne sie weiter
    const daten = await mitFrist(20000, async (signal) => {
      const r = await fetch("/suchhilfe/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: [frage].concat(texte) }), signal });
      if (!r.ok) throw new Error("Suchhilfe antwortet nicht");
      return (await r.json()).data;
    });
    // Falsche Anzahl Vektoren: nicht sortieren (sonst NaN), wie bei einem Fehler ohne Suchhilfe weitermachen
    if (!Array.isArray(daten) || daten.length !== texte.length + 1) throw new Error("Suchhilfe: falsche Anzahl Vektoren");
    const v = daten.sort((a, b) => a.index - b.index).map(d => d.embedding);
    const sims = v.slice(1).map(x => aehnlich(v[0], x));
    // Der Fragevektor wird noch für die Fieldbook-Inhalte gebraucht (fbNachBedeutung)
    sims.frage = v[0];
    return sims;
  }
  const aehnlich = (a, b) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / Math.sqrt(x * y); };
  const fbSuchText = (d) => "title: " + d.titel + " | text: " + d.suchtext.slice(0, 300);

  // Fieldbook-Inhalte (Kurs, Vorsorge) nach Bedeutung: Der Wortvergleich fand „Notgepäck“ bei „Notfallrucksack“ und
  // „Kälte und Hitze“ bei „Unterkühlung“ nicht. Die Vektoren der etwa 25 Dokumente werden einmal berechnet und gemerkt
  // (etwa 3 s), pro Frage kommt nur der Fragevektor dazu, den nachBedeutung() ohnehin berechnet.
  let fbVek = null;
  function fbVektoren() {
    if (!fbVek) fbVek = fieldbookDokumente().then(ds => mitFrist(30000, async (signal) => {
      const r = await fetch("/suchhilfe/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: ds.map(fbSuchText) }), signal });
      if (!r.ok) throw new Error("Suchhilfe antwortet nicht");
      const daten = (await r.json()).data;
      if (!Array.isArray(daten) || daten.length !== ds.length) throw new Error("Suchhilfe: falsche Anzahl Vektoren");
      return daten.sort((a, b) => a.index - b.index).map((x, i) => ({ d: ds[i], v: x.embedding }));
    })).catch(e => { fbVek = null; throw e; });
    return fbVek;
  }
  // Zusätzlich jeder Abschnitt einzeln (etwa 200): Titel + 300 Zeichen erfasst nur den Anfang. „Kälte und Hitze“ beginnt
  // mit Kälte, „Sonnenstich“ fand die Lektion deshalb nicht (0,40), über den Abschnitt schon (0,57). Messung 19. Nov. 2026
  // an 120 Testfragen: 11 ändern sich, 9 klar besser (Sonnenstich, Hitzewelle, Regenwasser, Schnittwunde, Erfrierungen,
  // Durchfall, SOS …); Gegenfragen: 1 von 30 ändert sich. Auf dem Prozessor dauern 200 Abschnitte etwa 40 s, deshalb
  // im Hintergrund, ohne darauf zu warten, und gemerkt in localStorage (gerundet auf 8 Bit, etwa 230 KB).
  const FB_ABS_SPEICHER = "ow-fb-abschnitte-v1";
  const fbAbsTexte = (ds) => {
    const t = [];
    ds.forEach((d, i) => { for (const a of d.abschnitte || []) if ((a.text || "").length >= 40)
      t.push({ i, text: "title: " + d.titel + (a.ueberschrift ? " – " + a.ueberschrift : "") + " | text: " + a.text.slice(0, 300) }); });
    return t;
  };
  const kodiere = (v) => { const m = Math.max(...v.map(Math.abs)) || 1; const b = new Int8Array(v.map(x => Math.round(x / m * 127)));
    return m.toPrecision(6) + ":" + btoa(String.fromCharCode(...new Uint8Array(b.buffer))); };
  const dekodiere = (s) => { const [ms, b] = s.split(":"), m = parseFloat(ms); const by = Uint8Array.from(atob(b), c => c.charCodeAt(0));
    return Array.from(new Int8Array(by.buffer), x => x / 127 * m); };
  function kurzHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  let fbAbs = null, fbAbsFertig = null;
  function fbAbschnitte() {
    if (!fbAbs) fbAbs = fieldbookDokumente().then(async ds => {
      const texte = fbAbsTexte(ds);
      let alt = {};
      try { alt = JSON.parse(localStorage.getItem(FB_ABS_SPEICHER) || "{}"); } catch { }
      const neu = {}, fehlt = [];
      for (const t of texte) { const h = kurzHash(t.text); if (alt[h]) neu[h] = alt[h]; else fehlt.push(t); }
      for (let k = 0; k < fehlt.length; k += 32) {
        const teil = fehlt.slice(k, k + 32);
        const daten = await mitFrist(120000, async (signal) => {
          const r = await fetch("/suchhilfe/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: teil.map(t => t.text) }), signal });
          if (!r.ok) throw new Error("Suchhilfe antwortet nicht");
          return (await r.json()).data;
        });
        if (!Array.isArray(daten) || daten.length !== teil.length) throw new Error("Suchhilfe: falsche Anzahl Vektoren");
        daten.sort((a, b) => a.index - b.index).forEach((x, j) => { neu[kurzHash(teil[j].text)] = kodiere(x.embedding); });
      }
      if (fehlt.length) try { localStorage.setItem(FB_ABS_SPEICHER, JSON.stringify(neu)); } catch { /* voll: nur für diese Sitzung */ }
      return (fbAbsFertig = texte.map(t => ({ d: ds[t.i], v: dekodiere(neu[kurzHash(t.text)]) })));
    }).catch(e => { fbAbs = null; throw e; });
    return fbAbs;
  }
  // Das passendste Dokument, ein zweites nur, wenn es fast genauso nah ist. Schwelle 0,42 (Messung 18. Nov. 2026, Titel
  // und 300 Zeichen): passende Paare 0,42 bis 0,66 (Unterkühlung → Kälte und Hitze 0,54, Notfallrucksack → Notgepäck 0,63),
  // unpassende höchstens 0,40 (Schlangenbiss → Verschlucken, Reis kochen → Vorsorge Essen). Ein einzelner Abschnitt zählt
  // erst ab 0,50: Abschnitte liegen allgemein höher, mit 0,42 kamen Lagerfeuer → Verbrennungen, Kurbelradio → Notruf dazu.
  async function fbNachBedeutung(frageVektor) {
    const liste = (await fbVektoren()).map(x => ({ d: x.d, sim: aehnlich(frageVektor, x.v), nurAbschnitt: false }));
    if (!window.__fbOhneAbschnitte) {
      fbAbschnitte().catch(() => {});
      for (const a of fbAbsFertig || []) {
        const s = aehnlich(frageVektor, a.v), x = liste.find(y => y.d.url === a.d.url);
        // Ab 0,56 behandelt der Abschnitt klar die Frage (Schnee → „Schnee und Eis“ 0,72, Sonnenstich → Lektion 0,57),
        // darunter oft nur ein Nachbarthema (Erfrierungen → Abschnitt Unterkühlung 0,54): dann nur eine Quelle neben anderen
        if (x && s >= 0.50 && s > x.sim) { if (x.sim < 0.42 && s < 0.56) x.nurAbschnitt = true; else x.nurAbschnitt = false; x.sim = s; }
      }
    }
    const gut = liste.filter(x => x.sim >= 0.42).sort((a, b) => b.sim - a.sim);
    // Nur im Test: window.__fbLog = [] zeigt, welche Fieldbook-Inhalte nach Bedeutung passen (und Fehler dabei)
    if (window.__fbLog) window.__fbLog.push({ fertig: !!fbAbsFertig, gut: gut.map(x => x.d.titel + " " + x.sim.toFixed(2)) });
    return gut.filter((x, i) => i === 0 || (i === 1 && gut[0].sim - x.sim <= 0.05));
  }

  async function suchen(buecher, begriffe, einfach, praxis) {
    const auftraege = [];
    const nummern = begriffe.codes || [];
    for (const b of buecher) {
      // Modellnummern wörtlich in jedem Paket suchen; die Titelsuche findet auch "LFX25973ST" bei "LFX25973"
      for (const c of nummern) {
        auftraege.push(() => Kiwix.vorschlaege(b, c, 5).then(r => r.map((t, i) => Object.assign(t, { punkte: 14 - i, begriff: c }))).catch(() => []));
        auftraege.push(() => Kiwix.suche(b, c, 4).then(r => r.map((t, i) => Object.assign(t, { punkte: 10 - i, begriff: c }))).catch(() => []));
      }
      // iFixit Deutsch ist überwiegend englisch: dort mit beiden Sprachen suchen
      const gemischt = /ifixit/.test(b.name);
      const liste = (gemischt ? begriffe.en.concat(begriffe.de) : b.englisch ? begriffe.en : begriffe.de).filter(x => !nummern.includes(x));
      liste.forEach((begriff, bi) => {
        // Einzelne Wörter aus der Frage („Fisch“) nur als Ergänzung: Ihr Lexikonartikel (das Tier) soll
        // die Treffer zu den eigentlichen Begriffen („Fischfang“) nicht verdrängen
        const faktor = (begriffe.extra || []).includes(begriff) ? 0.5 : 1;
        auftraege.push(() => Kiwix.vorschlaege(b, begriff, 3).then(r => r.map((t, i) => {
          const exakt = t.titel.toLowerCase() === begriff.toLowerCase();
          return Object.assign(t, { punkte: ((exakt ? 12 : 6 - i * 1.5) - bi) * faktor, begriff });
        })).catch(() => []));
        auftraege.push(() => Kiwix.suche(b, begriff, 4).then(r => r.map((t, i) => Object.assign(t, { punkte: (5 - i - bi) * faktor, begriff }))).catch(() => []));
      });
      // Die Wörter der Frage selbst im Volltext (deutsche Pakete): Etwa die Hälfte der Suchbegriffe des 4B gibt es nicht
      // als Artikel („Waldübernachtung“, „Backofen-Ersatz“), Wörter wie „Wildcampen“ oder „Brennglas“ kennt es nicht.
      // Der Volltext findet sie über die Frage („Wald übernachten“ → Camping, Jedermannsrecht); die Suchhilfe sortiert danach
      if (begriffe.satz && !b.englisch && !gemischt && !liste.some(x => x.toLowerCase() === begriffe.satz.toLowerCase()))
        auftraege.push(() => Kiwix.suche(b, begriffe.satz, 4).then(r => r.map((t, i) => Object.assign(t, { punkte: 5 - i, begriff: begriffe.satz }))).catch(() => []));
    }
    // Höchstens 4 Anfragen gleichzeitig (kiwix-serve verträgt nicht viele); Reihenfolge der Ergebnisse bleibt
    // Vektoren der Fieldbook-Inhalte beim ersten Mal schon berechnen, während die Bibliothek sucht
    if (begriffe.bedeutung !== false && suchhilfeDa()) { fbVektoren().catch(() => {}); fbAbschnitte().catch(() => {}); }
    const ergebnisse = new Array(auftraege.length);
    await parallel(auftraege.map((f, i) => i), 4, async (i) => { ergebnisse[i] = await auftraege[i](); });
    const alle = ergebnisse.flat();
    // Fieldbooks eigene Inhalte (Erste-Hilfe-Kurs, Vorsorge) wie ein Paket: Treffer, wenn Suchbegriffe darin vorkommen,
    // im Titel zählt es mehr. Suchhilfe und Prüfung entscheiden danach wie bei jedem Artikel.
    const fbWoerter = staemme(begriffe.de.concat(begriffe.thema ? [begriffe.thema] : []).join(" "));
    for (const d of await fieldbookDokumente()) {
      // Nur der eigentliche Titel zählt: „Erste-Hilfe-Kurs:“ passte sonst bei jedem „Erste-Hilfe-…“-Suchbegriff
      const imTitel = fbWoerter.filter(w => d.titel.replace(/^[^:]+: /, "").toLowerCase().includes(w)).length;
      const imText = fbWoerter.filter(w => d.suchtext.toLowerCase().includes(w)).length;
      if (imTitel || imText >= 2) alle.push({ titel: d.titel, url: d.url, auszug: d.suchtext.slice(0, 300), buch: FB_BUCH, punkte: imTitel * 6 + imText });
    }
    // Gleiche Artikel zusammenfassen
    const nachUrl = new Map();
    for (const t of alle) {
      // Dasselbe Buch steckt manchmal in zwei PDF-Paketen: gleiche Stelle nur einmal
      // Derselbe Artikel aus mehreren Ausgaben eines Werks (Wikipedia vollständig, „Das Beste“, Medizin) nur einmal
      const key = t.pdf ? "pdf:" + (t.auszug || "").slice(0, 120) : ohneAusgabe(dekodiert(t.url).toLowerCase());
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
        // Fieldbook-Inhalte, die nach Bedeutung passen, kommen dazu, als hätten sie auch die meisten Punkte (+0,1)
        try {
          for (const { d, sim: s, nurAbschnitt } of await fbNachBedeutung(sim.frage)) {
            const da = pool.find(t => t.url === d.url);
            if (da) da.wert = Math.max(da.wert, s + 0.1);
            else pool.push({ titel: d.titel, url: d.url, auszug: d.suchtext.slice(0, 300), buch: FB_BUCH, punkte: 0, wert: s + 0.1, nurAbschnitt });
          }
        } catch (e) { if (window.__fbLog) window.__fbLog.push({ fehler: String(e && e.stack || e) }); /* ohne Fieldbook-Vektoren: nur der Wortvergleich */ }
        pool.sort((a, b) => b.wert - a.wert);
        // Die zwei besten Fieldbook-Inhalte bleiben immer unter den Kandidaten (Sicherung: Vorsorge-Punkt mit 0,51 fiel
        // hinter sieben Bibliotheksartikel und kam gar nicht zur Prüfung)
        const fbBeste = pool.filter(t => t.buch.id === FB_BUCH.id).slice(0, 2);
        const proBuch = {};
        return fbBeste.concat(pool.filter(t => t.buch.id !== FB_BUCH.id && (proBuch[t.buch.id] = (proBuch[t.buch.id] || 0) + 1) <= 2)
          .slice(0, 7 - fbBeste.length)).sort((a, b) => b.wert - a.wert);
      } catch { /* Suchhilfe antwortet nicht: wie ohne */ }
    }
    // Schwache Treffer weglassen, höchstens 2 Artikel pro Buch
    const grenze = Math.max(1, liste[0].punkte * 0.4);
    const proBuch = {};
    // Ein paar mehr als nötig: Leere Seiten fallen beim Lesen noch heraus
    return liste.filter(t => t.punkte >= grenze)
      .filter(t => (proBuch[t.buch.id] = (proBuch[t.buch.id] || 0) + 1) <= 2).slice(0, 7);
  }

  // VERSUCH (Zweig versuch-mischform, 18. Nov. 2026): Mischform aus ganzen Artikeln und einzelnen Absätzen.
  // Die heutigen Quellen (ganze Artikel, wie gewählt) und Absätze aus einer breiten Suche konkurrieren nach Bedeutung
  // um das Budget. Nachgerechnet an 36 Fragen blind besser als nur Artikel (16 zu 6), aber mit mehr gefährlichen Stellen
  // aus Absätzen; dieser Einbau prüft, ob die echten Antworten sie übernehmen. Ablauf und Messwerte in ki-versuche.md.
  const MISCH_STOPP = new Set("wie was wo wann warum wer kann muss soll ich man du mein meine ein eine einen einem einer der die das den dem des und oder ist sind bei mit von zu zum zur für im in am an auf aus es sich nicht auch wird werden wenn dann als nach über unter so noch nur sehr mehr kein keine durch um vor the a an of to and or in on for with is are be it this that how what do does can i you your my at by from as not".split(" "));
  const mischWoerter = (t) => (String(t).toLowerCase().match(/[a-zäöüß]{3,}/g) || []).filter(w => !MISCH_STOPP.has(w)).map(w => w.slice(0, 6));
  const mischArt = (b) => b.id === "fieldbook" ? "fieldbook" : /stackexchange|restarters/.test(b.name) ? "forum" : b.englisch ? "englisch" : "lexikon";
  const MISCH_HERKUNFT = { fieldbook: "Fieldbook selbst, fachlich geprüft", forum: "Forum (Meinungen einzelner)", englisch: "englisches Fachbuch oder Lexikon", lexikon: "deutsches Lexikon oder Lehrbuch" };
  async function mischVektoren(texte) {
    const daten = await mitFrist(30000, async (signal) => {
      const r = await fetch("/suchhilfe/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: texte }), signal });
      if (!r.ok) throw new Error("Suchhilfe antwortet nicht");
      return (await r.json()).data;
    });
    if (!Array.isArray(daten) || daten.length !== texte.length) throw new Error("Suchhilfe: falsche Anzahl Vektoren");
    return daten.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }

  // Absätze breit suchen: Fragewörter, Suchbegriffe und Thema in allen Paketen (Volltext und Titel), bis 40 Artikel,
  // alle Absätze per Wortvergleich vorsortieren, die besten 40 (dazu bis 8 aus Fieldbook) nach Bedeutung, 12 prüft die KI
  async function absaetzeSuchen(buecher, begriffe, frage) {
    const de = [...new Set([begriffe.satz || kurzfassung(frage)].concat(begriffe.de, begriffe.thema ? [begriffe.thema] : []))].filter(Boolean);
    const en = begriffe.en || [];
    const auftraege = [];
    for (const b of buecher) {
      if (/wiktionary|gutenberg|wikisource|wikiquote|ted_mul/.test(b.name)) continue;
      const liste = /ifixit/.test(b.name) ? en.concat(de) : b.englisch ? en : de;
      liste.forEach((q, qi) => {
        auftraege.push(() => Kiwix.suche(b, q, 3).then(r => r.map((x, i) => Object.assign(x, { b, rang: qi + i }))).catch(() => []));
        auftraege.push(() => Kiwix.vorschlaege(b, q, 2).then(r => r.map((x, i) => Object.assign(x, { b, rang: qi + i }))).catch(() => []));
      });
    }
    const ergebnisse = new Array(auftraege.length);
    await parallel(auftraege.map((f, i) => i), 4, async (i) => { ergebnisse[i] = await auftraege[i](); });
    const nachUrl = new Map();
    for (const x of ergebnisse.flat()) { const k = x.pdf ? "pdf:" + (x.auszug || "").slice(0, 80) : ohneAusgabe(dekodiert(x.url).toLowerCase()); if (!nachUrl.has(k) || nachUrl.get(k).rang > x.rang) nachUrl.set(k, x); }
    const proBuch = {};
    const kand = [...nachUrl.values()].sort((a, b) => a.rang - b.rang).filter(x => (proBuch[x.b.id] = (proBuch[x.b.id] || 0) + 1) <= 4).slice(0, 40);
    const absaetze = [];
    await parallel(kand, 4, async (x) => {
      const art = mischArt(x.b);
      if (x.pdf) { if (x.auszug) absaetze.push({ titel: x.titel, ueb: "", buch: x.b, url: x.pdf, art, text: String(x.auszug).replace(/<[^>]+>/g, "") }); return; }
      try {
        const a = await artikel(x.url);
        for (const s of a.abschnitte || []) {
          let akt = "";
          const fertigAbsatz = () => { if (akt.trim().length > 40) absaetze.push({ titel: a.titel || x.titel, ueb: s.ueberschrift || "", buch: x.b, url: a.url || x.url, art, text: akt.trim() }); akt = ""; };
          for (const p of String(s.text).split(/\n+/)) { if ((akt + " " + p).length > 600 && akt) fertigAbsatz(); akt += " " + p; }
          fertigAbsatz();
        }
      } catch { /* Artikel nicht lesbar: weglassen */ }
    });
    const gesehen = new Set();
    const frei = absaetze.filter(p => { const k = p.text.slice(0, 120); if (gesehen.has(k)) return false; gesehen.add(k); return true; });
    const fb = [];
    for (const d of await fieldbookDokumente()) for (const s of d.abschnitte || []) if (s.text && s.text.length > 30)
      fb.push({ titel: d.titel, ueb: s.ueberschrift || "", buch: FB_BUCH, url: d.url, art: "fieldbook", text: s.text, intern: true });
    const alle = frei.concat(fb);
    const qw = [...new Set(mischWoerter(frage + " " + de.join(" ") + " " + en.join(" ")))];
    const df = {}, doks = alle.map(p => new Set(mischWoerter(p.titel + " " + p.ueb + " " + p.text)));
    doks.forEach(s => s.forEach(w => { df[w] = (df[w] || 0) + 1; }));
    alle.forEach((p, i) => { p.lex = qw.reduce((s, w) => s + (doks[i].has(w) ? Math.log(1 + alle.length / (df[w] || 1)) : 0), 0); });
    const vor = frei.slice().sort((a, b) => b.lex - a.lex).slice(0, 40).concat(fb.filter(p => p.lex > 0).sort((a, b) => b.lex - a.lex).slice(0, 8));
    if (!vor.length) return [];
    const v = await mischVektoren(["task: question answering | query: " + frage].concat(vor.map(p => "title: " + p.titel + (p.ueb ? " – " + p.ueb : "") + " | text: " + p.text.slice(0, 500))));
    vor.forEach((p, i) => { p.wert = aehnlich(v[0], v[i + 1]) + (p.art === "fieldbook" ? 0.05 : p.art === "forum" ? -0.03 : 0); });
    vor.sort((a, b) => b.wert - a.wert);
    const pr = vor.slice(0, 12);
    const sys = "Du bewertest Textabschnitte für eine Frage. Ein Abschnitt hilft, wenn er etwas enthält, das direkt zur Antwort beiträgt: eine Anleitung, eine Regel, eine Zahl, eine Warnung oder eine klare Erklärung. " +
      "Er hilft nicht, wenn er nur Geschichte, Begriffe, Statistik, ein anderes Thema oder eine andere Lage behandelt. " +
      "Abschnitte mit gefährlichen, fragwürdigen oder widersprüchlichen Ratschlägen nimmst du nie, auch wenn sie zum Thema passen. Foren sind Meinungen Einzelner: Nimm sie nur, wenn kein Lexikon, Lehrbuch oder Fieldbook-Abschnitt dasselbe besser sagt. " +
      "Abschnitte aus Fieldbook selbst sind fachlich geprüft: Passen sie zur Frage, nimm sie zuerst. Antworte nur mit JSON: die Nummern der hilfreichen Abschnitte, der hilfreichste zuerst.";
    const ein = "FRAGE: " + frage + "\n\nABSCHNITTE:\n" + pr.map((p, i) => "[" + (i + 1) + "] " + p.titel + (p.ueb ? " – " + p.ueb : "") + "\nAus: " + MISCH_HERKUNFT[p.art] + "\n" + p.text.replace(/\s+/g, " ").slice(0, 350)).join("\n\n");
    const schema = { type: "object", properties: { passend: { type: "array", items: { type: "integer" }, maxItems: 8 } }, required: ["passend"] };
    const roh = await mitFrist(60000, (signal) => KI.chat([{ role: "system", content: sys }, { role: "user", content: ein }],
      { max_tokens: 60, temperature: 0, response_format: { type: "json_schema", json_schema: { name: "pruefung", schema } }, signal }));
    let wahl = [];
    try { wahl = (JSON.parse(roh.match(/\{[\s\S]*\}/)[0]).passend || []).filter(n => n >= 1 && n <= pr.length); } catch { /* keine Wahl */ }
    return [...new Set(wahl)].map(n => pr[n - 1]);
  }

  // Quellen an die KI (ganze Artikel) und geprüfte Absätze nach Bedeutung ins Budget füllen.
  // Absätze aus Artikeln, die schon ganz dabei sind, entfallen. Zu große Blöcke werden auf den Rest gekürzt.
  async function mischen(quellen, absaetze, frage, budgetZeichen) {
    const schonDa = new Set(quellen.map(q => String(q.titel).toLowerCase()));
    const bloecke = quellen.map(q => ({ q, kopf: q.titel, text: q.text, fb: !!q.intern }))
      .concat(absaetze.filter(p => !schonDa.has(String(p.titel).toLowerCase())).map(p => ({ p, kopf: p.titel + (p.ueb ? " – " + p.ueb : ""), text: p.text, fb: p.art === "fieldbook" })));
    if (bloecke.length <= quellen.length) return quellen;
    const v = await mischVektoren(["task: question answering | query: " + frage].concat(bloecke.map(b => "title: " + b.kopf + " | text: " + b.text.slice(0, 1500))));
    bloecke.forEach((b, i) => { b.wert = aehnlich(v[0], v[i + 1]) + (b.fb ? 0.05 : 0); });
    bloecke.sort((a, b) => b.wert - a.wert);
    let rest = budgetZeichen;
    const aus = [];
    for (const b of bloecke) {
      if (rest < 300) break;
      let t = b.text;
      if (t.length > rest) { if (rest < 600) continue; t = t.slice(0, rest) + " …"; }
      rest -= t.length;
      if (b.q) aus.push(Object.assign(b.q, { text: t }));
      else aus.push({ titel: b.kopf, url: b.p.url, buch: b.p.buch, text: t, absaetze: [{ text: b.p.text, punkte: 1, anfang: 0 }], intern: !!b.p.intern, absatz: true });
    }
    return aus.length ? aus : quellen;
  }

  const ANLEITUNG = /\b(wie|was tun|was mache|was soll|behandl|versorg|reparier|anleitung|hilft|helfen|vorgehen|schritt)/i;
  const PRAXIS_ABSCHNITT = /behandlung|therapie|erste hilfe|versorgung|maßnahmen|massnahmen|reparatur|anleitung|vorgehen|durchführung|anwendung|reinigung|vorbeugung|prävention|treatment|repair|first aid|steps|procedure/i;

  // Wortstämme grob: erste 6 Zeichen, damit "versorge" auch "Wundversorgung" trifft
  // Paketname ohne Ausgabe und Datum: „wikipedia_de_top_maxi_2026-10“ → „wikipedia_de“ (auch innerhalb einer Adresse)
  function ohneAusgabe(s) {
    return String(s).replace(/(_(all|top|medicine|maxi|mini|nopic))+_\d{4}-\d{2}[a-z]?/gi, "");
  }

  function staemme(text) {
    return [...new Set(text.toLowerCase().split(/[^a-zäöüß0-9]+/).filter(w => w.length > 3).map(w => w.slice(0, 6)))];
  }

  async function lesen(treffer, frage, begriffe, budgetZeichen, mitPruefung, max) {
    const woerter = staemme(frage + " " + begriffe.de.join(" ") + " " + begriffe.en.join(" "));
    const anleitung = ANLEITUNG.test(frage);
    const texte = await Promise.all(treffer.map(t => artikel(t.url).then(a => ({ t, a })).catch(() => null)));
    // Gleiche Zielartikel (nach Weiterleitungen) nur einmal
    const gesehen = new Set();
    const gueltig = texte.filter(x => {
      if (!x || !x.a.abschnitte.length) return false;
      // Platzhalterseiten ohne brauchbaren Inhalt überspringen (z. B. iFixit-Geräteseiten, die nur Datenblätter sind)
      // Eigene Unterlagen dürfen kurz sein (eine Notiz, ein Plan)
      const voll = x.a.abschnitte.map(s => s.text).join(" ");
      if (voll.length < (x.t.buch.eigene || x.a.fb ? 20 : 300)) return false;
      if (/California Energy Commission|Date Added: \d{4}/.test(voll) && !/\b(step|schritt|replace|austausch|remove|entfern)/i.test(voll)) return false;
      // Auch über verschiedene Adressen derselbe Artikel (z. B. Klexikon „Wolf“ zweimal) nur einmal
      const k = dekodiert(x.a.url).toLowerCase();
      const k2 = ohneAusgabe(x.t.buch.id) + "|" + String(x.a.titel || x.t.titel).toLowerCase();
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
    // Sicherheitsfragen: Fieldbook-Inhalte unter den Treffern bleiben und kommen nach vorn (beim Sonnenstich verwarf die
    // Prüfung des 4B den Kurs „Kälte und Hitze“ und nahm nur Wikibooks mit „keine kalten Umschläge mehr“)
    const sicher = sicherheitsFrage(frage);
    if (sicher) auswahl = gueltig.filter(x => x.a.fb).concat(auswahl.filter(x => !x.a.fb));
    auswahl = auswahl.slice(0, max || 4);
    // Fieldbook-Inhalte (Kurs, Vorsorge) kommen ganz, die übrigen Artikel teilen sich den Rest (mindestens 1.500 Zeichen)
    const fbLaenge = auswahl.filter(x => x.a.fb).reduce((s, x) => s + fbText(x.a.fb, frage).length, 0);
    const proArtikel = Math.floor(Math.max(1500, budgetZeichen - fbLaenge) / Math.max(1, auswahl.filter(x => !x.a.fb).length));
    // TEST (18. Nov. 2026, nur mit window.__abschnittTest): alle Abschnitte der gewählten Artikel nach Bedeutung (Suchhilfe)
    let simsAlle = null;
    if (window.__abschnittTest && auswahl.length) {
      try {
        const uhr = performance.now();
        const flach = [];
        auswahl.forEach(({ a }, ai) => a.abschnitte.forEach((s, si) => flach.push({ ai, si,
          text: "title: " + a.titel + (s.ueberschrift ? " – " + s.ueberschrift : "") + " | text: " + s.text.slice(0, 1500) })));
        const r = await fetch("/suchhilfe/v1/embeddings", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: ["task: search result | query: " + frage + (begriffe.thema ? " (" + begriffe.thema + ")" : "")].concat(flach.map(f => f.text)) }) });
        const v = (await r.json()).data.sort((x, y) => x.index - y.index).map(d => d.embedding);
        const aehnlich = (x, y) => { let s = 0, p = 0, q = 0; for (let k = 0; k < x.length; k++) { s += x[k] * y[k]; p += x[k] * x[k]; q += y[k] * y[k]; } return s / Math.sqrt(p * q); };
        simsAlle = auswahl.map(() => []);
        flach.forEach((f, k) => { simsAlle[f.ai][f.si] = aehnlich(v[0], v[k + 1]); });
        window.__abschnittMs = (window.__abschnittMs || []).concat([{ n: flach.length, ms: Math.round(performance.now() - uhr) }]);
      } catch (e) { window.__abschnittFehler = String(e); }
    }
    return auswahl.map(({ t, a }, i) => {
      // Fieldbook-Inhalt: ganzer, zur Frage zugeschnittener Text; intern = fachlich geprüft, kurs = KI schreibt nur daraus
      // Nur über einen einzelnen Abschnitt gefunden (nurAbschnitt): Die Lektion passt nicht als Ganzes, oft nur ein
      // Nachbarthema (Erfrierungen → Abschnitt Unterkühlung). Dann eine Quelle neben anderen, nicht die einzige.
      if (a.fb) return { nr: i + 1, titel: a.titel, url: a.url, buch: FB_BUCH, text: fbText(a.fb, frage), absaetze: [], intern: true, kurs: (a.fb.art === "kurs" || sicher) && !t.nurAbschnitt };
      // Einleitung immer, dann die Abschnitte mit den meisten Suchwörtern
      const anker = (a.anker || "").toLowerCase();
      const sims = simsAlle && simsAlle[i];
      const sMin = sims ? Math.min(...sims) : 0, sMax = sims ? Math.max(...sims) : 1;
      const bewertet = a.abschnitte.map((s, idx) => {
        if (sims) {
          let p = 8 * (sims[idx] - sMin) / Math.max(1e-6, sMax - sMin);
          if (idx === 0) p += 2;
          if (anker && s.ueberschrift.toLowerCase() === anker) p += 3;
          return { s, idx, p };
        }
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
      // Wie-Fragen: Eine Anleitung ist ein zusammenhängender Block. Nach der Einleitung ab dem ersten Absatz mit
      // Anleitungs-Überschrift der Reihe nach, bis das Budget voll ist. Die Schritte selbst enthalten oft kein Suchwort
      // („250 g Olivenöl“) und fielen beim Wörterzählen heraus (Seife: 0 von 14 Rezept-Absätzen, Test 18. Nov. 2026).
      const praxisStart = anleitung && !sims ? a.abschnitte.findIndex(s => PRAXIS_ABSCHNITT.test(s.ueberschrift)) : -1;
      if (praxisStart >= 0) {
        const einleitung = bewertet.find(b => b.s.text.trim().length >= 40);
        if (einleitung && einleitung.idx < praxisStart) { gewaehlt.push(einleitung); laenge += einleitung.s.text.length; }
        for (let k = praxisStart; k < bewertet.length && laenge <= proArtikel; k++) { gewaehlt.push(bewertet[k]); laenge += bewertet[k].s.text.length; }
      } else {
        for (const b of bewertet.slice().sort((x, y) => y.p - x.p || x.idx - y.idx)) {
          if (laenge > proArtikel) break;
          gewaehlt.push(b);
          laenge += b.s.text.length;
        }
      }
      gewaehlt.sort((x, y) => x.idx - y.idx);
      let text = gewaehlt.map(b => (b.s.ueberschrift ? "[" + b.s.ueberschrift + "] " : "") + b.s.text).join("\n");
      if (text.length > proArtikel) text = text.slice(0, proArtikel) + " …";
      // Absätze, die die KI zu sehen bekommt: Aus ihnen sucht stellenSuchen nach der Antwort die passende Stelle
      let bis = 0;
      const absaetze = gewaehlt.map(b => {
        const anfang = bis;
        bis += (b.s.ueberschrift ? b.s.ueberschrift.length + 3 : 0) + b.s.text.length + 1;
        return { text: b.s.text, punkte: b.p - (b.idx < 2 ? 2 : 0), anfang };
      }).filter(x => x.anfang < proArtikel);
      // Fundstellen in PDF-Büchern verweisen auf die Seite im PDF selbst
      return { nr: i + 1, titel: a.titel || t.titel, url: t.pdf || a.url || t.url, buch: t.buch, text, absaetze };
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
      // Eigene Unterlagen: Fundstelle statt Anfang (die erste Zeile ist dort oft nur der Name des Geräts)
      // Erster Absatz mit Inhalt: Seitenreste wie „Kommentare: 45“ (iFixit) oder „Questions“ (Foren) überspringen,
      // sonst sah die Prüfung nur den Titel und lehnte passende Anleitungen ab (Heizung/Grundfos, Test 18. Nov. 2026)
      const erster = a.abschnitte.find(s => s.text.trim().length >= 40) || a.abschnitte[0];
      const anfang = (t.buch.eigene ? (t.auszug || a.abschnitte.map(s => s.text).join(" ")).slice(0, 400)
        : (erster ? erster.text : "")).replace(/\s+/g, " ").slice(0, t.buch.eigene ? 400 : 280);
      // Jede Überschrift nur einmal: Mehrere Absätze unter einer Überschrift füllten sonst die 10 Plätze
      // („Geschichte, Geschichte, Geschichte …“), und die Prüfung sah die hilfreichen Kapitel nicht (Test 18. Nov. 2026)
      const kapitel = [...new Set(a.abschnitte.map(s => s.ueberschrift).filter(Boolean))].slice(0, 10).join(", ");
      const herkunft = t.buch.eigene ? "\nAus: eigene Unterlagen des Nutzers (seine Geräte, Pläne, Notizen)"
        : a.fb ? "\nAus: Fieldbook selbst, fachlich geprüft (deutsch)"
        : "\nAus: " + t.buch.titel.replace(/\s*\(.*$/, "") + (t.buch.englisch ? " (englisch)" : " (deutsch)");
      return "[" + (i + 1) + "] " + (a.titel || "") + herkunft + "\nAnfang: " + anfang + (kapitel ? "\nAbschnitte: " + kapitel : "");
    }).join("\n\n");
    const sys = "Du prüfst Suchergebnisse. Für jeden Artikel entscheidest du: Enthält er Wissen, das hilft, diese Frage zu beantworten? " +
      "Er hilft auch, wenn er nur einen Teil beantwortet oder das passende Gerät, Verfahren oder Grundwissen erklärt. " +
      "Er hilft nicht, wenn es um ein anderes Gerät, eine andere Sache oder ein anderes Thema geht, auch wenn einzelne Wörter gleich sind. " +
      // Test 18. Nov. 2026: Ohne diesen Satz verdrängte die Huawei-Anleitung („camera and flashlight“) den Artikel Taschenlampe
      "Achte darauf, worum es im Titel eigentlich geht: Ein bestimmtes Handy, Auto oder anderes Gerät, das nur ein Bauteil mit gleichem Namen hat, ist ein anderes Gerät. " +
      "Er hilft auch nicht, wenn er zu einer anderen Lage gehört: Schließt die Frage etwas aus (z. B. „ohne Strom“, „ohne Gerät X“), hilft ein Artikel nicht, der genau das voraussetzt. " +
      "Artikel für Feuerwehr, Industrie, Kraftwerke oder Fachbetriebe helfen bei Fragen aus dem Alltag nicht. " +
      "Allgemeine Artikel und Anleitungen, die das Thema im Ganzen erklären, kommen vor Einzelversuchen, Sonderfällen und Forenfragen. " +
      (eintraege.some(x => x.a.fb) ? "Artikel aus Fieldbook selbst sind fachlich geprüft: Behandeln sie das Thema der Frage, nimm sie zuerst. " : "") +
      (eintraege.some(x => x.t.buch.eigene) ? "Eigene Unterlagen des Nutzers gehören zu seinen eigenen Geräten und Plänen: Behandeln sie genau die gefragte Sache, sind sie am hilfreichsten; dass das Wort nur vorkommt, reicht nicht. " : "") +
      // 19. Nov. 2026, an 22 aufgezeichneten Prüfungen (Antworten „an der Frage vorbei“ und Wächter Heizung, Werkzeug
      // .claude/werkzeuge/pruef-test.js): eindeutig falsche Kandidaten 11 → 7 je Lauf (Radio statt Mazda-Autoradio,
      // Powerbank statt Solar-Forum). Ohne den Satz zu übertragbaren Modell-Anleitungen verlor „Heizung wird nicht warm“
      // die Grundfos-Anleitung an allgemeine Lexikonartikel.
      "Nennt die Frage kein bestimmtes Modell und keine besondere Lage, nimm zuerst die Artikel, die das gefragte Gerät oder Thema so behandeln, wie man es üblicherweise hat: allgemeine Artikel und Anleitungen zu genau dieser Sache. " +
      "Eine Anleitung für ein bestimmtes Modell derselben Art ist gut, wenn sich das Vorgehen übertragen lässt. " +
      "Artikel über eine andere Art Gerät (z. B. ein Rasenmäher-Motor bei einer Frage zum Automotor), Forenfragen zu einer Lage, die die Frage nicht nennt, und reine Theorie ohne praktischen Nutzen nimmst du nur, wenn nichts Passenderes da ist. " +
      "Antworte nur mit JSON: die Nummern der hilfreichen Artikel, der hilfreichste zuerst.";
    const schema = { type: "object", properties: { passend: { type: "array", items: { type: "integer" }, maxItems: 7 } }, required: ["passend"] };
    const roh = await mitFrist(60000, (signal) => KI.chat([{ role: "system", content: sys }, { role: "user", content: "FRAGE: " + frage + (thema ? "\nKERN DER FRAGE: " + thema : "") + "\n\nARTIKEL:\n" + liste }],
      { max_tokens: 60, temperature: 0, response_format: { type: "json_schema", json_schema: { name: "pruefung", schema } }, signal }));
    const j = JSON.parse(roh);
    return [...new Set((j.passend || []).map(n => n - 1).filter(i => i >= 0 && i < artikel.length))];
  }

  function landName() {
    const l = Land.aktuell() || {};
    return (l.name && (l.name.de || l.name.en)) || l.code || "Deutschland";
  }

  // Grobe Einordnung der Frage, damit nur die passenden Regeln in die Anweisung kommen
  const KOERPER = /verletz|wunde|blut|schmerz|stich|biss|zecke|vergift|fieber|krank|durchfall|erbrech|verbrenn|verbrüh|bruch|gebrochen|schiene|unterkühl|erfrier|sonnenstich|hitzschlag|bewusstlos|atem|herz|allerg|blase|nasenbluten|medikament|tablette/;
  function fragenArt(frage) {
    const f = frage.toLowerCase();
    return {
      reparatur: /reparier|kaputt|defekt|geht nicht|nicht mehr an|lässt sich nicht|funktioniert nicht|springt nicht|lädt nicht|rauscht|tropft|undicht|klemmt|wird nicht|abgesprungen|platten|flick|loch im|sohle|sicherung/.test(f),
      gesundheit: KOERPER.test(f) || /notfall|notruf/.test(f),
      koerper: KOERPER.test(f),
      bedingung: /\bohne\b|stromausfall|\bkein(e|en)?\b/.test(f),
      heizen: /heiz|wärm|warm|kerze|frier|kalt/.test(f),
      trinkwasser: /trink|pfütze|bachwasser|regenwasser|flusswasser|quellwasser|brunnen|wasserfilter|wasser.*(desinfiz|keim|aufbereit|filtern|sauber)|chlortablett/.test(f),
      // Essen aus der Natur und Haltbarmachen: Hier liefert die Bibliothek gefährliche Ratschläge (Esstest für Beeren,
      // Fleisch im Wasserbad einkochen), Fieldbooks Faustregeln sagen es richtig
      nahrung: /essbar|beere|pilz|wildpflanz|wildkräut|giftig|haltbar|einkoch|einmach|konserv|verdorb|schimmel|botulis|schnee essen/.test(f),
      elektrik: /sicherung|stromschlag|steckdose.*(kaputt|defekt|locker|wackel|schmor|funk)|fi-schalter|leitungsschutz|elektroinstall/.test(f),
    };
  }
  // Sicherheitsfragen (19. Nov. 2026): Passt ein geprüfter Fieldbook-Inhalt, bleibt er dabei, auch wenn die Prüfung
  // ihn verwirft, und passt er als Ganzes, schreibt die KI nur aus ihm (wie bisher beim Kurs). Grund: Steht ein
  // gefährlicher Satz in einer Bibliotheksquelle, übernehmen ihn 4B und 9B auch neben der richtigen Fieldbook-Quelle;
  // Regeln in der Anweisung halfen nicht (Gefahren-Kreislauf 1).
  // „Notruf“, „Notfall“ allein zählen nicht: Bei „Notrufmeldestelle in Wuppertal“ verdrängten die allgemeinen
  // Fieldbook-Texte sonst den passenden Artikel
  const sicherheitsFrage = (frage) => { const a = fragenArt(frage); return a.koerper || a.trinkwasser || a.nahrung || a.elektrik; };

  // Fieldbooks eigene Inhalte als durchsuchbare Quelle: Erste-Hilfe-Kurs (erstehilfe.json, vom Nutzer fachlich geprüft)
  // und Vorsorge-Themen (vorsorge.json). Ersetzt seit 18. Nov. 2026 die Wortliste KURS_THEMEN, die nie vollständig war
  // („erfrier“ zeigte auf eine Lektion nur zur Unterkühlung, Notgepäck fehlte). Suche, Suchhilfe und Prüfung finden sie
  // jetzt wie jeden Artikel. Test 13. Nov. 2026 bleibt gültig: Wird eine Kurs-Lektion gewählt, schreibt die KI nur aus ihr.
  const FB_BUCH = { id: "fieldbook", name: "fieldbook", titel: "Fieldbook" };
  // Als Promise gemerkt: Zwei gleichzeitige Aufrufe (Vektoren und Abschnitte) bekamen sonst zwei verschiedene Listen
  let fbDoks = null;
  function fieldbookDokumente() { return fbDoks || (fbDoks = ladeFieldbookDokumente()); }
  async function ladeFieldbookDokumente() {
    const doks = [];
    const z = (t) => Land.einsetzen(t);
    try {
      const konf = await ladeKonfigSprache("erstehilfe");
      const zettelAlle = konf.spickzettel || [];
      for (const l of (konf.lektionen || []).filter(x => x.schritte)) {
        const zettel = zettelAlle.filter(x => x.lektion === l.id);
        doks.push({ art: "kurs", l, zettel, titel: "Erste-Hilfe-Kurs: " + l.titel, url: "#erstehilfe?l=" + l.id,
          suchtext: z([l.titel].concat(l.verstehen || [], l.schritte, l.kinder ? [l.kinder] : [], zettel.map(x => x.titel + ": " + (x.sofort || []).join(" "))).join(" ")),
          abschnitte: (l.verstehen || []).map(v => ({ ueberschrift: "", text: z(v) })).concat(
            [{ ueberschrift: "So hilfst du", text: z(l.schritte.join(" ")) }], l.kinder ? [{ ueberschrift: "Kinder", text: z(l.kinder) }] : [],
            zettel.map(x => ({ ueberschrift: "Im Ernstfall: " + x.titel, text: z((x.sofort || []).join(" ")) }))) });
      }
      // Spickzettel ohne eigene Lektion
      for (const s of zettelAlle.filter(x => !(konf.lektionen || []).some(l => l.schritte && l.id === x.lektion))) {
        doks.push({ art: "kurs", l: null, zettel: [s], titel: "Erste-Hilfe-Kurs: " + s.titel, url: "#erstehilfe?k=" + s.id,
          suchtext: z(s.titel + ": " + (s.sofort || []).join(" ")),
          abschnitte: [{ ueberschrift: "Im Ernstfall: " + s.titel, text: z((s.sofort || []).join(" ")) }] });
      }
    } catch { /* ohne Kurs weiter */ }
    try {
      const konf = await ladeKonfigSprache("vorsorge");
      const stufen = ["Das Wichtigste", "Gut vorbereitet", "Weiter vorsorgen"];
      for (const t of (konf.themen || []).filter(x => x.stufen)) {
        const text = [t.warum].concat(t.stufen.map((s, i) => "[" + (stufen[i] || "Stufe " + (i + 1)) + "] " +
          (s.text || []).join(" ") + " " + (s.punkte || []).map(p => "- " + p.text + (p.mehr ? ": " + p.mehr : "")).join(" "))).filter(Boolean).map(z).join("\n");
        doks.push({ art: "vorsorge", titel: "Vorsorge: " + t.titel, url: "#vorsorge?k=" + t.id, text, suchtext: t.titel + ". " + text.replace(/\n/g, " "),
          abschnitte: [{ ueberschrift: "", text: z(t.warum || "") }].concat(...t.stufen.map(s => (s.punkte || []).map(p => ({ ueberschrift: z(p.text), text: z(p.mehr || p.text) })))) });
      }
    } catch { /* ohne Vorsorge weiter */ }
    // Faustregeln der Seite Kochen (kochen.json „leitfaden“): Wasser trinkbar machen, Einkochen, Haltbarkeit, Verdorben,
    // Wildpflanzen. Seit 19. Nov. 2026 durchsuchbar: Dort steht z. B. „Fleisch nur im Druckeinkochtopf“, während die
    // Bibliothek bei Haltbarmachen-Fragen das Wasserbad-Einkochen lieferte.
    try {
      const konf = await ladeKonfigSprache("kochen");
      for (const t of (konf.leitfaden || []).filter(x => x.id !== "rezepte" && (x.abschnitte || []).length)) {
        const abschnitte = t.abschnitte.map(a => ({ ueberschrift: z(a.titel), text: z((a.punkte || []).join(" ")) }));
        const text = abschnitte.map(a => "[" + a.ueberschrift + "] " + a.text).join("\n");
        doks.push({ art: "kochen", titel: "Kochen: " + t.titel, url: "#kochen?l=" + t.id, text, suchtext: t.titel + ". " + text.replace(/\n/g, " "), abschnitte });
      }
    } catch { /* ohne Kochen weiter */ }
    return doks;
  }

  // Text eines Fieldbook-Inhalts für die KI. Lektionen passend zur Frage zugeschnitten.
  function fbText(d, frage) {
    if (d.art !== "kurs") return d.text;
    const f = frage.toLowerCase(), z = (t) => Land.einsetzen(t), l = d.l;
    // Lektion „Kälte und Hitze“: Geht die Frage nur um eins davon, bekommt die KI nur diesen Teil. Sonst übernimmt
    // sie Hitze-Regeln bei Unterkühlung (Test 13. Nov. 2026: einmal Paracetamol aus dem Hitze-Teil).
    let verstehen = l ? l.verstehen || [] : [], schritte = l ? l.schritte : [], sofort = (x) => x.sofort || [];
    if (l && l.id === "temperatur") {
      const kalt = /unterkühl|erfrier|hypotherm|kälte|friert|frieren/.test(f), heiss = /hitz|sonnenstich|überhitz/.test(f);
      const h = schritte.findIndex(x => /^Hitze:/.test(x));
      if (kalt !== heiss && h > 0) {
        verstehen = verstehen.filter(x => /hitze|sonnenstich/i.test(x) === heiss);
        schritte = kalt ? schritte.slice(0, h) : schritte.slice(h);
        sofort = (x) => (x.sofort || []).filter(y => /unterkühl/i.test(y) === kalt);
      }
    }
    const teile = [];
    if (l) {
      teile.push("[Verstehen] " + verstehen.join(" "), "[So hilfst du] " + schritte.map((x, i) => (i + 1) + ". " + x).join(" "));
      if (l.kinder) teile.push("[Kinder] " + l.kinder);
    }
    // Spickzettel nur, wenn er zur Frage passt (die Herz-Lektion hat zwei: Herzinfarkt und Schlaganfall)
    const zettel = d.zettel.filter(x => !l || x.titel.toLowerCase().split(/[^a-zäöüß]+/).some(w => w.length > 4 && f.includes(w.slice(0, 6))));
    zettel.forEach(x => teile.push("[Im Ernstfall: " + x.titel + "] " + sofort(x).join(" ")));
    return teile.map(z).join("\n");
  }
  // Homöopathie-Ratgeber und Ähnliches bei Gesundheitsfragen nie als Quelle
  const UNSERIOES = /medicus|homöopath|homoeopath|homeopath|globuli|bachblüt/i;

  async function antworten(frage, quellen, einfach, vorher, lage, onText) {
    // Regeln für bestimmte Fragen nur dann mitgeben, wenn die Frage dazu passt. Das kleine Modell wendet
    // jede Regel sonst auch auf andere Fragen an (Abkochen beim Heizen, Fehlerbilder bei Eicheln).
    const art = fragenArt(frage);
    // Ohne Grafikkarte schreibt die KI nur etwa 7 Token pro Sekunde. 150 statt 250 Wörter sparen etwa 12 s,
    // im Test mit 120 Fragen (Nov. 2026) ohne messbaren Verlust an Qualität
    const woerter = aufProzessor() ? 150 : 250;
    let sys =
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
      (quellen.some(q => q.intern)
        ? "Quelle [1] stammt aus Fieldbook selbst und ist fachlich geprüft: Baue deine Antwort auf [1] auf. Weicht eine andere Quelle davon ab " +
          "(z. B. bei Kühldauer, Salben, Lagerung oder Medikamenten), gilt [1], und die abweichende Angabe lässt du weg. Andere Quellen nimmst du nur für Ergänzungen, die [1] nicht widersprechen. " +
          "Fragt der Nutzer, wie etwas geht, übernimmst du die nummerierten Schritte aus [1] in genau dieser Reihenfolge, ohne einen Schritt umzustellen oder wegzulassen. "
        : "") +
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
      "Antworte klar und praktisch, bei Anleitungen in nummerierten Schritten. Halte dich kurz (höchstens etwa " + woerter + " Wörter). " +
      (einfach ? "Erkläre es so einfach, dass ein Kind mit 8 bis 10 Jahren es versteht: kurze Sätze, keine Fachwörter, ein anschauliches Beispiel. " : "");
    // Kurze Anweisung für 4B und 9B (18. Nov. 2026): Die lange Anweisung oben verwirrt die kleinen Modelle. Blind an
    // 36 Testfragen und 30 Gegenfragen mit denselben Quellen: 4B kurz quellentreuer (23 statt 10), erfindet seltener
    // (5 statt 19), schlecht 6 statt 10, gefährlich 9 statt 11; 9B kurz klar am besten (ki-versuche.md).
    // Gemeinsamer Text für beide; soll sich eins davon ändern, hier aufteilen. Andere Modelle behalten die lange Anweisung.
    if (OW.status && (OW.status.modell === "qwen35-9b" || OW.status.modell === "qwen35-4b"))
      sys = "Du bist ein hilfsbereiter Assistent in einer Offline-Bibliothek für Selbsthilfe. Antworte immer auf " + (Land.sprache() === "en" ? "Englisch" : "Deutsch") + ". " +
        "Der Nutzer lebt in " + landName() + ", Notrufnummer: " + Land.notruf() + ". " +
        "Sprich den Nutzer mit \"du\" an. " +
        "Nutze nur die Informationen aus den QUELLEN und erfinde nichts. " +
        // Runde 2: drei Regeln zurück gegen „nichts gefunden“, Notruf-Floskeln und Fachleute-Empfehlungen
        "Wenn die Quellen die Frage nur teilweise beantworten, gib trotzdem die passenden praktischen Informationen daraus wieder. " +
        "Nur wenn gar nichts Passendes in den Quellen steht, sag ehrlich, dass du dazu nichts gefunden hast. " +
        "Den Notruf nennst du nur, wenn ein Mensch in Gefahr ist, nie bei Geräten und Reparaturen. " +
        "Empfiehl nicht, eine Firma, einen Handwerker oder Fachleute zu beauftragen oder etwas zu kaufen. " +
        // 19. Nov. 2026: ohne diesen Satz schrieb die KI die Regeln in die Antwort („112 nur bei akuter Lebensgefahr …“)
        "Diese Regeln befolgst du still: Erwähne sie nicht in der Antwort. " +
        "Kennzeichne Aussagen mit der Quellennummer in eckigen Klammern, z. B. [1]. " +
        "Halte dich kurz (höchstens etwa " + woerter + " Wörter). " +
        (einfach ? "Erkläre es so einfach, dass ein Kind mit 8 bis 10 Jahren es versteht: kurze Sätze, keine Fachwörter, ein anschauliches Beispiel. " : "");
    const block = quellen.map(q => "[" + q.nr + "] " + q.titel + " (" + q.buch.titel + ")\n" + q.text).join("\n\n");
    // Nur im Test: window.__sysTest(sys) ändert die Anweisung (Vergleich von Antwortregeln an gespeicherten Quellen)
    if (window.__sysTest) sys = window.__sysTest(sys);
    const nachrichten = [{ role: "system", content: sys }];
    if (vorher) nachrichten.push({ role: "user", content: vorher.frage }, { role: "assistant", content: vorher.antwort.slice(0, 800) });
    nachrichten.push({ role: "user", content: "QUELLEN:\n" + block + "\n\nFRAGE: " + frage +
      (vorher ? "\n\n(Beantworte nur diese FRAGE mit diesen QUELLEN. Ist es ein neues Thema, erwähne das vorherige Gespräch nicht.)" : "") });
    // Frist: bis zum ersten Token 180 s, danach nur Abbruch, wenn 60 s lang nichts Neues kommt; bei Seitenwechsel wird nicht abgebrochen
    // window.__tempTest nur im Test (Vergleich mit anderer Temperatur)
    const temperatur = typeof window.__tempTest === "number" ? window.__tempTest : 0.3;
    return mitLeerlauf(180000, 60000, (signal, aktiv) => KI.chat(nachrichten, { max_tokens: 700, temperature: temperatur, signal }, (t) => { aktiv(); if (onText) onText(t); }));
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
    // Kurs-Lektion oder Vorsorge-Thema aus Fieldbook selbst
    if (q.intern || /^#(erstehilfe|vorsorge)/.test(String(q.url))) return q.url;
    // Eigene Unterlagen: PDF im PDF-Leser, Word, Text und Bilder in der eigenen Ansicht
    const eigene = Eigene.linkVon(q.url);
    if (eigene) return eigene;
    // Stellen aus PDF-Büchern öffnen im eigenen PDF-Leser auf der gefundenen Seite
    const pdf = String(q.url).match(/^(\/kiwix\/content\/[^#]+\.pdf)(?:#page=(\d+))?$/i);
    if (pdf) return "#pdf?url=" + encodeURIComponent(pdf[1]) + (pdf[2] ? "&seite=" + pdf[2] : "") + "&titel=" + encodeURIComponent(String(q.titel).replace(/, Seite \d+$/, ""));
    return "#lesen?url=" + encodeURIComponent(q.url) + "&titel=" + encodeURIComponent(q.titel) +
      (q.stelle ? "&stelle=" + encodeURIComponent(q.stelle) : "");
  }

  // Stelle im Artikel, aus der die Antwort am ehesten stammt: Beim Öffnen der Quelle springt das Lesefenster
  // dorthin und hebt sie hervor. Gesucht wird im Absatz mit den meisten Wörtern der Sätze, die die Quelle nennen.
  function stellenSuchen(antwort, quellen) {
    const saetze = String(antwort || "").split(/\n+|(?<=[.!?])\s+/);
    for (const q of quellen) {
      if (!q.absaetze || !q.absaetze.length) continue;
      const eigene = saetze.filter(s => s.includes("[" + q.nr + "]"));
      const woerter = staemme((eigene.length ? eigene : saetze).join(" "));
      // Seltene Wörter zählen mehr: „Wasser“ steht im Artikel Trinkwasser in jedem Absatz und sagt nichts über die Stelle
      const kleine = q.absaetze.map(a => a.text.toLowerCase());
      const gewicht = new Map(woerter.map(w => [w, 1 / Math.max(1, kleine.filter(t => t.includes(w)).length)]));
      const treffer = (t) => { const lc = t.toLowerCase(); let p = 0; for (const w of woerter) if (lc.includes(w)) p += gewicht.get(w); return p; };
      let absatz = null, beste = -1;
      for (const a of q.absaetze) {
        const p = treffer(a.text) + a.punkte * 0.1;
        if (p > beste) { beste = p; absatz = a; }
      }
      // Darin der Satz mit den meisten Treffern. Getrennt wird nur nach einem Wort mit mindestens drei Buchstaben
      // vor einem Großbuchstaben, damit „z. B.“ oder „ca. 5 l“ den Satz nicht zerschneiden
      const teile = absatz.text.split(/(?<=[^\s.]{3}[.!?])\s+(?=[A-ZÄÖÜ„"])/).map(s => s.trim()).filter(s => s.length >= 25);
      let satz = teile[0] || absatz.text, satzP = -1;
      for (const s of teile) { const p = treffer(s); if (p > satzP) { satzP = p; satz = s; } }
      if (satz.length > 160) satz = satz.slice(0, 160).replace(/\s+\S*$/, "");
      q.stelle = satz;
    }
  }

  // Schon angezeigte Quellenlinks um die gefundene Stelle ergänzen
  function linksAuffrischen(box, quellen) {
    for (const a of box.querySelectorAll('a[href^="#lesen?"]')) {
      const url = new URLSearchParams(a.getAttribute("href").slice(7)).get("url");
      const q = quellen.find(x => x.url === url && x.stelle);
      if (q) a.setAttribute("href", leseLink(q));
    }
  }

  function quellenPunkte(quellen, mitAuszug) {
    return el("ol", {}, ...quellen.map(q => el("li", {},
      el("a", { href: leseLink(q) }, q.titel), " ", el("span", { class: "paket" }, "· " + q.buch.titel + (q.buch.englisch ? " (englisch)" : "")),
      mitAuszug ? el("div", { class: "klein hinweis" }, q.text.slice(0, 280) + " …") : null)));
  }

  function quellenListe(quellen, mitAuszug) {
    return el("div", { class: "quellen" }, el("b", {}, "Quellen"), quellenPunkte(quellen, mitAuszug));
  }

  // Erste Treffer der Suche, bevor die KI sie geprüft hat (ohne Grafikkarte etwa 20 s früher als die Quellen)
  function vorlaeufigeListe(treffer) {
    const qs = treffer.slice(0, 5).map(t => ({ titel: t.titel, url: t.pdf || t.url, buch: t.buch }));
    return el("details", { class: "quellen vorlaeufig", open: true },
      el("summary", {}, el("b", {}, "Erste Treffer"), " ", el("span", { class: "paket" }, "· noch nicht geprüft")),
      quellenPunkte(qs, false));
  }

  // ---------------------------------------------------------------- Beispiel-KI im Rundgang (Kapitel KI)
  // Statt des Modells kommen vorbereitete Antworten aus uebung/ki/antworten.json, Wort für Wort wie eine echte.
  // So läuft das Kapitel auch ohne geladene KI und auf schwachen Laptops. Gespeichert wird nichts.
  // Übungsmodus: am Cookie erkennen (gilt schon beim Laden der Seite, bevor der Rundgang weitermacht), oder am laufenden
  // Rundgang (ein Rundgang in einem anderen Tab kann das gemeinsame Cookie löschen; dann trotzdem nie das echte Modell)
  function uebung() { return /(?:^|;\s*)fb-uebung=1(?:;|$)/.test(document.cookie) || Rundgang.aktiv(); }
  const uebungJson = {};     // je Kapitel die geladenen Antworten
  let uebungLauf = 0;        // zählt Antworten, damit eine zurückgenommene nicht weiterschreibt
  let uebungStopp = null;    // Knopf „Anhalten“ während einer Beispiel-Antwort
  const uebungTeile = [];    // je Frage [Frage-Blase, Antwort]
  function uebungDaten() {
    // Im Kapitel Eigene Unterlagen die Antworten aus uebung/eigene/antworten.json (gleiches Format), sonst die des Kapitels KI.
    // So schlägt jede Seite die Frage ihres Kapitels vor und kennt nur diese.
    const k = Rundgang.kapitel() === "eigene" ? "eigene" : "ki";
    if (!uebungJson[k]) uebungJson[k] = fetch("/uebung/" + k + "/antworten.json").then(r => r.json())
      .catch(() => { delete uebungJson[k]; return null; });
    return uebungJson[k];
  }
  // Frage passt nicht zur Beispiel-KI: Rundgang zeigt einen Hinweis (rundgang.json, fehl), bis man das Feld ändert
  $("#frage-feld").addEventListener("input", () => { delete $("#frage-form").dataset.uebungFehl; });

  async function uebungSenden() {
    const frage = $("#frage-feld").value.trim();
    if (!frage || beschaeftigt) return;
    const d = await uebungDaten();
    const a = d && d.antworten.find(x => x.nach === uebungTeile.length && x.erkennen.every(m => new RegExp(m, "i").test(frage)));
    if (!a) { $("#frage-form").dataset.uebungFehl = "1"; return; }
    delete $("#frage-form").dataset.uebungFehl;
    const nr = ++uebungLauf;
    const warte = (ms) => new Promise(r => setTimeout(r, ms));
    const weg = () => nr !== uebungLauf;
    let gestoppt = false;
    uebungStopp = () => { gestoppt = true; };
    beschaeftigt = true;
    sendeKnopf(true);
    $("#frage-feld").value = "";
    const beispiele = $("#chat > .beispielfragen");   // nur die der Begrüßung, nicht der Vorschlag unter einer Antwort
    if (beispiele) beispiele.remove();
    const blase = el("div", { class: "frage-blase" }, frage);
    const box = el("div", { class: "antwort" });
    const schritte = el("ul", { class: "schritte-liste" });
    const text = el("div", { class: "antwort-text" });
    box.append(schritte, text);
    $("#chat").append(blase, box);
    uebungTeile.push([blase, box]);
    $("#frage-form").scrollIntoView({ behavior: "smooth", block: "end" });
    const quellen = a.quellen.map((q, i) => Object.assign({ nr: i + 1 }, q));
    const mitKi = KI.bereit();
    let bisher = "";
    // Angehalten: wie bei der echten KI bleibt stehen, was schon da ist
    const stoppen = () => {
      text.classList.remove("cursor");
      if (bisher) zeigeAntwort(text, bisher, quellen);
      const li = [...schritte.children].find(x => !x.className);
      if (li) { li.className = "angehalten"; li.textContent = "Angehalten"; }
      box.append(el("p", { class: "hinweis klein antwort-angehalten" }, bisher ? "Du hast die Antwort angehalten." : "Du hast die Frage angehalten."));
      if (bisher) verlauf.push({ frage, antwort: bisher });
    };
    try {
      // Dieselben Zeilen wie bei der echten Suche, nur schneller
      const vorher = [mitKi ? "Suchbegriffe werden erstellt …" : null, "Suche in " + ((OW.status || {}).wissen || 4) + " Paketen …",
        mitKi ? "Artikel werden gelesen und geprüft …" : "Artikel werden gelesen …"];
      for (let i = 0; i < vorher.length; i++) {
        if (!vorher[i]) continue;
        const li = el("li", {}, vorher[i]);
        schritte.append(li);
        await warte(900);
        if (weg()) return;
        if (gestoppt) return stoppen();
        li.className = "fertig";
        li.textContent = a.schritte[i];
      }
      if (!mitKi) {
        text.append("Passende Artikel (die KI ist aus):");
        box.append(quellenListe(quellen, true));
        verlauf.push({ frage, antwort: null });
        return;
      }
      box.append(quellenListe(quellen));
      const li = el("li", {}, "Antwort wird geschrieben …");
      schritte.append(li);
      text.classList.add("cursor");
      await warte(700);
      const woerter = a.antwort.match(/\S+\s*/g) || [];
      // Eigene Dauer je Antwort möglich: Die zum Anhalten schreibt langsam, damit man Zeit für den Knopf hat
      const pause = (a.sekunden || d.sekunden || 9) * 1000 / Math.max(1, woerter.length);
      for (const w of woerter) {
        if (weg()) return;
        if (gestoppt) return stoppen();
        bisher += w;
        zeigeAntwort(text, bisher, quellen);
        await warte(pause);
      }
      if (weg()) return;
      if (gestoppt) return stoppen();
      text.classList.remove("cursor");
      zeigeAntwort(text, a.antwort, quellen);
      li.className = "fertig";
      li.textContent = "Antwort fertig";
      box.append(antwortKopieren(a.antwort, quellen));
      verlauf.push({ frage, antwort: a.antwort });
      // Folgt eine Frage mit „vorschlagen“, steht sie zum Anklicken unter der Antwort (Rundgang: Antwort anhalten)
      const naechste = d.antworten.find(x => x.vorschlagen && x.nach === uebungTeile.length);
      // Nach dem Klick nur versteckt: „Zurück“ im Rundgang zeigt sie wieder (uebungZurueck)
      if (naechste) box.append(el("div", { class: "beispielfragen" }, el("button", { type: "button", class: "beispielfrage", onclick: (ev) => {
        if (beschaeftigt) return;
        ev.currentTarget.parentNode.hidden = true;
        $("#frage-feld").value = naechste.frage;
        senden();
      } }, naechste.frage)));
    } finally {
      if (!weg()) {
        beschaeftigt = false;
        uebungStopp = null;
        sendeKnopf(false);
        box.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    }
  }
  // „Zurück“ im Rundgang: nur die ersten n Fragen bleiben stehen, eine laufende Antwort hört auf
  function uebungZurueck(n) {
    uebungLauf++;
    beschaeftigt = false;
    uebungStopp = null;
    sendeKnopf(false);
    $("#frage-feld").value = "";
    delete $("#frage-form").dataset.uebungFehl;
    while (uebungTeile.length > n) uebungTeile.pop().forEach(e => e.remove());
    if (n && uebungTeile[n - 1]) uebungTeile[n - 1][1].querySelectorAll(".beispielfragen[hidden]").forEach(b => { b.hidden = false; });
    verlauf.length = Math.min(verlauf.length, n);
    if (!n) { $("#chat").innerHTML = ""; begruessung(); }
  }

  // _antworten nur für Tests: Antwort an gespeicherten Quellen neu erzeugen
  return { zeigen, beschaeftigt: () => beschaeftigt, uebungZurueck, _antworten: antworten };
})();
