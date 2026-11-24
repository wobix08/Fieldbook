// Kochen: Rezepte zu den vorhandenen Zutaten (aus dem Koch-Wiki, ohne KI), Artikel zum Nachlesen
// und ein fester Leitfaden zu Wasser und Lebensmitteln.
"use strict";

const Kochen = (() => {
  let konf = null;
  let aufgebaut = false;
  let nachgelesen = false, nachlesenLaeuft = false, wiederholung = null;
  // Gelesene Rezeptseiten merken (begrenzt), damit gleiche Rezepte bei der nächsten Suche nicht neu geladen werden
  const seitenSpeicher = new Map(), SEITEN_MAX = 200;
  const leitfadenLinks = [];
  let beschaeftigt = false;
  const HAKEN = ["gewuerze", "fleisch", "aehnlich"];

  // Fragezeichen an den Häkchen: zeigt die Listen aus kochen.json lesbar an
  // (gleiche Grundform nur einmal, z. B. „Zitrone“ statt „Zitrone, Zitronen“)
  function lesbar(woerter) {
    const gesehen = new Set(), aus = [];
    for (let w of woerter) {
      w = w.replace(/^=/, "");
      const s = stamm(w.split(/\s+/).pop());
      if (gesehen.has(s)) continue;
      gesehen.add(s);
      aus.push(w.charAt(0).toUpperCase() + w.slice(1));
    }
    return aus;
  }
  function hilfeZeigen(k) {
    let titel, text, liste;
    if (k === "gewuerze") {
      titel = "Gewürze und Würzzutaten weglassen";
      text = "Fehlen dir nur diese Zutaten, gilt das Rezept trotzdem als machbar.\nAuf der Rezeptkarte steht dann „Ohne: …“.";
      liste = [el("li", {}, lesbar(konf.gewuerze || []).join(", "))];
    } else {
      titel = k === "fleisch" ? "Fleisch und Fisch austauschbar" : "Ähnliches austauschbar";
      text = "Hast du eine Zutat aus einer Gruppe, gelten die anderen derselben Gruppe als vorhanden.\nAuf der Rezeptkarte steht dann zum Beispiel „" + (k === "fleisch" ? "Hähnchen statt Rind" : "Sahne statt Milch") + "“." +
        (k === "aehnlich" ? "\nÖl zählt immer als vorhanden, deshalb geht auch „Öl statt Butter“." : "");
      liste = (konf[k] || []).map(g => { const w = lesbar(g); return el("li", {}, el("b", {}, w[0]), ": " + w.slice(1).join(", ")); });
    }
    dialog(titel, el("div", {}, el("p", {}, zeilen(text)), el("ul", { class: "koch-hilfe-liste" }, ...liste)), [{ text: "OK", wert: 1, haupt: true }]);
  }

  function merken() {
    const g = { zutaten: $("#koch-zutaten").value };
    for (const k of HAKEN) g[k] = $("#koch-" + k).checked;
    try { localStorage.setItem("ow-koch", JSON.stringify(g)); } catch { }
  }

  async function zeigen(params) {
    if (!konf) konf = await ladeKonfig("kochen");
    if (!aufgebaut) {
      aufgebaut = true;
      try { const o = localStorage.getItem("ow-ofen"); if (o) $("#koch-ofen").value = o; } catch { }
      $("#koch-ofen").addEventListener("change", () => { try { localStorage.setItem("ow-ofen", $("#koch-ofen").value); } catch { } });
      $("#koch-form").addEventListener("submit", (e) => { e.preventDefault(); suchen(); });
      // Zutaten und Häkchen fürs nächste Mal merken (meist ist danach noch das meiste da)
      try {
        const g = JSON.parse(localStorage.getItem("ow-koch") || "{}");
        if (g.zutaten) $("#koch-zutaten").value = g.zutaten;
        for (const k of HAKEN) $("#koch-" + k).checked = !!g[k];
      } catch { }
      for (const b of document.querySelectorAll(".koch-hilfe")) b.addEventListener("click", () => hilfeZeigen(b.dataset.haken));
      $("#koch-form").addEventListener("input", merken);
      $("#koch-form").addEventListener("change", merken);
      leitfaden();
    }
    // Sprung aus Vorsorge, z. B. #kochen?l=haltbarkeit: Abschnitt aufklappen und hinscrollen
    const l = params && params.get("l");
    const box = l && document.getElementById("koch-l-" + l);
    if (box) { box.open = true; setTimeout(() => box.scrollIntoView({ block: "start" }), 50); }
    // Direkt nach dem Programmstart läuft die Bibliothek oft noch nicht. Dann nicht "Koch-Wiki fehlt"
    // melden, sondern warten und es alle 3 Sekunden erneut versuchen.
    const buecher = await Kiwix.buecher();
    const s = OW.status || {};
    const startet = !buecher.length && s.wissen > 0 && !s.bibliothekFehler;
    $("#koch-start").hidden = !startet;
    if (startet) {
      $("#koch-fehlt").hidden = $("#koch-form").hidden = true;
      clearTimeout(wiederholung);
      wiederholung = setTimeout(async () => { if (location.hash.startsWith("#kochen")) { await aktualisiereStatus(); zeigen(); } }, 3000);
      return;
    }
    // Erst nach Erfolg als erledigt merken; nicht doppelt gleichzeitig starten
    if (!nachgelesen && !nachlesenLaeuft && buecher.length) {
      nachlesenLaeuft = true;
      nachlesen().then(() => { nachgelesen = true; }).catch((e) => console.error(e)).finally(() => { nachlesenLaeuft = false; });
    }
    const buch = await rezeptBuch();
    $("#koch-fehlt").hidden = !!buch;
    $("#koch-form").hidden = !buch;
    if (buch) $("#koch-paket").href = "#lesen?url=" + encodeURIComponent(buch.start) + "&titel=" + encodeURIComponent(buch.titel);
  }

  async function rezeptBuch() {
    return (await Kiwix.buecher()).find(b => b.name === konf.rezeptPaket) || null;
  }

  // ------------------------------------------------------------ Rezepte

  // Einfache Grundform, damit "Eier" zu "Ei" und "Kartoffeln" zu "Kartoffel" passt.
  // Beide Seiten (Eingabe und Rezept) werden gleich behandelt.
  // Umlaute ohne Punkte, damit „Walnüsse“ zu „Walnuss“ und „Äpfel“ zu „Apfel“ passt; ß wie ss (Schweiz).
  // Endungen werden mehrfach abgeschnitten („Pinienkerne“ → „Pinienkern“ → „Pinienk“, ebenso „Pinienkern“),
  // auch ein End-s bei längeren Wörtern („Champignons“, „Avocados“), aber nicht bei „ss“ („Walnuss“).
  function stamm(w) {
    w = w.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss").replace(/ies$/, "y");
    for (let i = 0; i < 3; i++) {
      const k = w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w.replace(/(en|er|n|e)$/, "");
      if (k === w || k.length < 2) break;
      w = k;
    }
    return w;
  }
  // Füllwörter zählen nicht: „oder ein Fertigprodukt“ würde sonst über „ein“ → „ei“ zu Eiern passen
  const FUELLWORT = /^(ein|eine|einer|einem|einen|eines|einige|oder|und|mit|ohne|von|vom|zum|zur|nach|etwas|evtl|ggf)$/;
  function woerter(text) {
    return (text.toLowerCase().match(/[a-zäöüß]+/g) || []).filter(w => !FUELLWORT.test(w)).map(stamm);
  }
  // Passt ein Wort zur Zutat? Gleich, oder bei längeren Wörtern als Wortende ("Bergkäse" → "Käse")
  function passt(wort, zutat) {
    return wort === zutat || (zutat.length >= 4 && wort.endsWith(zutat));
  }

  // Eigene Eingabe aufbereiten: Grundform, dazu das Wort ohne typischen Anhang („Knoblauchzehen“ → „Knoblauch“,
  // „Zimtstange“ → „Zimt“) und gleichbedeutende Wörter aus kochen.json („gleich“: Topfen = Quark, Semmel = Brötchen).
  const ANHAENGE = ["zehen", "zehe", "stangen", "stange", "schoten", "schote", "blätter", "blatt", "blättchen", "körner", "korn",
    "zweige", "zweig", "pulver", "filets", "filet", "würfel", "scheiben", "scheibe", "stücke", "stückchen", "knollen", "knolle",
    "samen", "saat", "kapseln", "kapsel", "flocken", "flöckchen", "röschen", "spitzen", "wurzel", "stiele", "röllchen", "fäden",
    "blättern", "kerne", "kernen", "kern", "grün", "fleisch", "brust", "schenkel", "keule", "zesten", "achtel",
    "spalten", "stifte", "splitter", "kolben", "rohmasse", "stauden"];
  // Allgemeine Wörter, die eine längere eigene Zutat nicht abdecken („Orangensaft“ ist kein „Saft“ fürs Rezept)
  const KEIN_OBERBEGRIFF = /^(saft|mark|kern|kerne|pulv|pulver|apfel|kraut|wass|wasser|salat|fleisch|weiss|weiß|grün|grun|frisch|fein|klein|gross|groß)$/;
  // … und eigene Zutaten, die trotz gleichem Wortende etwas anderes sind („Paniermehl“ ist kein „Mehl“)
  const KEIN_ERSATZ = /(panier|stärke|kartoffel|mandel|kokos|kernmehl)mehl$|kokosmilch$|(schnitt|bär)lauch$/;
  function eintrag(z) {
    const roh = (z.toLowerCase().match(/[a-zäöüß]+/g) || [z.toLowerCase()]).pop();
    const st = stamm(roh), alle = new Set([st]), suche = [];
    for (const a of ANHAENGE)
      // „Kürbiskerne“ sind kein Kürbis
      if (roh.endsWith(a) && roh.length - a.length >= 3 && !/^kürbisker/.test(roh)) { alle.add(stamm(roh.slice(0, -a.length))); break; }
    for (const g of konf.gleich || []) {
      const gs = g.map(f => stamm(f.split(/\s+/).pop()));
      // nur ganze Wörter, sonst gehörte „Schnittlauch“ zu „Lauch, Porree“
      if (gs.some(f => alle.has(f))) {
        gs.forEach(f => alle.add(f));
        if (stamm(g[0]) !== st) suche.push(g[0]);
      }
    }
    return { name: z, stamm: st, roh, alle: [...alle], suche };
  }
  // Steht die eigene Zutat in dieser Rezeptzeile? (zeile = Text der Zeile samt Zutatennamen)
  function inZeile(s, zeile) {
    if (woerter(zeile).some(x => s.alle.some(a => passt(x, a)))) return true;
    // „Vollmilch“ deckt „Milch“, „Bergkäse“ deckt „Käse“, „Trockenhefe“ deckt „Hefe“ (wie geschrieben verglichen)
    // (in Grundform und wie geschrieben, damit „Frühlingszwiebeln“ wie „Bergkäse“ klappen)
    const deckt = (eigen, x) => x.length >= 4 && x !== eigen && !KEIN_OBERBEGRIFF.test(x) && eigen.endsWith(x);
    return !KEIN_ERSATZ.test(s.roh) &&
      (woerter(zeile).some(x => deckt(s.stamm, x)) || rohWoerter(zeile).some(x => deckt(s.roh, x)));
  }

  function eingabe() {
    return $("#koch-zutaten").value.split(/[,;\n]|\bund\b/i).map(s => s.trim()).filter(Boolean).slice(0, 12);
  }

  async function suchen() {
    if (beschaeftigt) return;
    const zutaten = eingabe();
    const ziel = $("#koch-ergebnis");
    ziel.innerHTML = "";
    if (!zutaten.length) { ziel.append(el("p", { class: "hinweis koch-leer" }, "Schreib auf, was du da hast, z. B. „Kartoffeln, Eier, Zwiebeln“.")); return; }
    const buch = await rezeptBuch();
    if (!buch) return;
    beschaeftigt = true;
    const status = el("p", { class: "hinweis" }, "Rezepte werden gesucht …");
    ziel.append(status);
    try {
      const staemme = zutaten.map(eintrag);
      const regeln = regelnBauen(staemme);
      // Mitgesucht: Oberbegriffe der Tauschgruppen und das übliche Wort für „Topfen“, „Semmel“ usw.
      const kandidaten = await kandidatenSuchen(buch, zutaten, regeln.oberbegriffe.concat(...staemme.map(s => s.suche)));
      status.textContent = "Rezepte werden geprüft (" + kandidaten.length + ") …";
      const rezepte = (await nachEinander(kandidaten, 8, lesen)).filter(Boolean);
      const ohneOfen = $("#koch-ofen").value === "ohne";
      const bewertet = rezepte.map(r => bewerten(r, staemme, regeln)).filter(r => r.genutzt.length > 0 && r.fehlt.length <= 3);
      // Reihenfolge: erst was fehlt, dann wie viel man ändern muss (tauschen oder weglassen zählt gleich),
      // bei Gleichstand das Rezept, das mehr eigene Zutaten nutzt
      const aenderungen = r => r.getauscht.length + r.weg.length;
      bewertet.sort((a, b) =>
        (ohneOfen ? (a.ofen - b.ofen) : 0) || a.fehlt.length - b.fehlt.length ||
        aenderungen(a) - aenderungen(b) || b.genutzt.length - a.genutzt.length);
      zeigeRezepte(ziel, bewertet, zutaten, ohneOfen);
    } catch (e) {
      ziel.innerHTML = "";
      console.error(e);
      ziel.append(fehlerBox("Die Suche hat nicht geklappt. Bitte versuche es noch einmal.", null, null, e.message));
    } finally { beschaeftigt = false; }
  }

  // Volltextsuche mit allen Zutaten zusammen, paarweise und einzeln. So kommen auch Rezepte in die
  // Auswahl, die nur einen Teil der Zutaten nutzen.
  // Mit „austauschbar“ wird zusätzlich der Oberbegriff gesucht (z. B. „Fleisch“), damit auch Rezepte mit
  // einer anderen Zutat aus derselben Gruppe in die Auswahl kommen.
  async function kandidatenSuchen(buch, zutaten, oberbegriffe) {
    const anfragen = [zutaten.join(" ")];
    for (let i = 0; i < zutaten.length; i++)
      for (let j = i + 1; j < zutaten.length && anfragen.length < 16; j++) anfragen.push(zutaten[i] + " " + zutaten[j]);
    for (const z of zutaten) anfragen.push(z);
    for (const o of oberbegriffe || []) if (!anfragen.some(q => q.toLowerCase() === o)) anfragen.push(o);
    // Höchstens 4 Suchen gleichzeitig; scheiternde Suchen zählen als leer
    const listen = (await nachEinander(anfragen, 4, q => Kiwix.suche(buch, q, 25))).map(l => l || []);
    const gesehen = new Set(), kandidaten = [];
    for (const liste of listen)
      for (const t of liste) {
        // Kategorie-, Zutaten- und Hilfsseiten sind keine Rezepte
        let titel = t.url.split("/").pop();
        try { titel = decodeURIComponent(titel); } catch { }
        if (/[:]|^_/.test(titel) || gesehen.has(t.url)) continue;
        gesehen.add(t.url);
        kandidaten.push(t);
      }
    return kandidaten.slice(0, 80);
  }

  async function nachEinander(liste, gleichzeitig, fn) {
    const ergebnis = new Array(liste.length);
    let naechster = 0;
    async function arbeiter() { while (naechster < liste.length) { const i = naechster++; ergebnis[i] = await fn(liste[i]).catch(() => null); } }
    await Promise.all(Array.from({ length: gleichzeitig }, arbeiter));
    return ergebnis;
  }

  // Rezeptseite lesen: Zeilen aus dem Abschnitt "Zutaten" und ob ein Backofen gebraucht wird
  async function lesen(t) {
    if (seitenSpeicher.has(t.url)) return seitenSpeicher.get(t.url);
    const r = await fetch(t.url, { signal: AbortSignal.timeout(15000) }); // Frist: hängt der Abruf, bricht er ab
    if (!r.ok) return null;
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    const erg = seiteAuswerten(doc, t);
    if (seitenSpeicher.size >= SEITEN_MAX) seitenSpeicher.delete(seitenSpeicher.keys().next().value);
    seitenSpeicher.set(t.url, erg);
    return erg;
  }

  function seiteAuswerten(doc, t) {
    const abschnitt = (id) => {
      const kopf = doc.getElementById(id);
      const h = kopf && kopf.closest("h2");
      const teile = [];
      for (let n = h && h.nextElementSibling; n && n.tagName !== "H2"; n = n.nextElementSibling) teile.push(n);
      return teile;
    };
    const zeilen = abschnitt("Zutaten").flatMap(n => [...n.querySelectorAll("li")]).map(li => ({
      text: li.textContent.trim(),
      namen: [...li.querySelectorAll('a[title^="Zutat:"]')].map(a => a.getAttribute("title").slice(6)),
    }));
    if (!zeilen.length) return null;
    const zubereitung = abschnitt("Zubereitung").concat(abschnitt("Kochgeschirr")).map(n => n.textContent).join(" ");
    const titel = (doc.querySelector("h1") || {}).textContent || t.titel;
    return { titel: titel.trim() || t.titel, url: t.url, zeilen, ofen: brauchtOfen(zubereitung) ? 1 : 0 };
  }

  // Satzweise prüfen: "im Ofen warm halten" oder "Grill oder Backofen" heißt nicht, dass man einen Ofen braucht
  function brauchtOfen(text) {
    return text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])|\n+/).some(s =>
      /backofen|backrohr|\bofen\b|\brohr\b|umluft|unterhitze/i.test(s) &&
      !/warm\s*(zu\s*)?(halten|stellen)|warmhalten|warmstellen|(vorgewärmt|angewärmt)\w*\s+(back)?ofen/i.test(s) &&
      !/(grill|pfanne|herd|feuer)\s+oder\s+(back)?ofen|(back)?ofen\s+oder\s+(grill|pfanne|herd)/i.test(s));
  }

  // ---- Kästchen „weglassen“ und „austauschbar“ (Listen in kochen.json)
  // Gruppenwörter in Grundform und so wie geschrieben; Wortanfang oder Wortende genügt ab 4 Buchstaben
  // („Putenschnitzel“ → „pute“, „Eiernudeln“ → „nudeln“)
  // „=wort“ in kochen.json heißt: nur als ganzes Wort („=lauch“, sonst zählt „Schnittlauch“ mit)
  function formen(wort) {
    const w = wort.toLowerCase().split(/\s+/).pop();
    return w.startsWith("=") ? [w] : [...new Set([w, stamm(w)])];
  }
  function inGruppe(wort, gruppe) {
    return gruppe.some(f => f.startsWith("=") ? wort === f.slice(1) :
      wort === f || (f.length >= 4 && (wort.startsWith(f) || wort.endsWith(f))));
  }
  // Gewürze nur als ganzes Wort, Wortende oder mit typischem Anhang („Zimtstange“, „Lorbeerblätter“),
  // damit „Gewürzgurke“ oder „Kräuterbutter“ nicht als Gewürz gelten
  function istGewuerz(wort, liste) {
    return liste.some(f => wort === f || (f.length >= 4 && wort.endsWith(f)) ||
      (wort.startsWith(f) && /^(stangen?|pulver|blatt|blätter|körner|korn|zweige?|stiele?|samen|schoten?|nüsse|nuss|zehen?|kapseln?|flocken)$/.test(wort.slice(f.length))));
  }
  function rohWoerter(text) { return text.toLowerCase().match(/[a-zäöüß]+/g) || []; }

  function regelnBauen(staemme) {
    const an = k => { const e = $("#koch-" + k); return !!(e && e.checked); };
    const gewuerze = an("gewuerze") ? [].concat(...(konf.gewuerze || []).map(formen)) : [];
    const gruppen = [].concat(an("fleisch") ? konf.fleisch || [] : [], an("aehnlich") ? konf.aehnlich || [] : [])
      .map(g => ({ oberbegriff: g[0].replace(/^=/, ""), formen: [].concat(...g.map(formen)) }));
    // Zu jeder eigenen Zutat die Gruppe, in der sie steht
    // Grundzutaten (Öl usw.) zählen mit, dann gilt z. B. Butter als ersetzbar durch Öl
    const tausch = [], eigene = staemme.concat(konf.immerDa.map(i => ({ name: i.charAt(0).toUpperCase() + i.slice(1), immer: true })));
    for (const s of eigene) {
      const u = s.name.toLowerCase().split(/\s+/).pop();
      const g = gruppen.find(gr => inGruppe(u, gr.formen));
      if (g) tausch.push({ name: s.name, gruppe: g, immer: !!s.immer });
    }
    return { gewuerze, tausch, oberbegriffe: [...new Set(tausch.filter(t => !t.immer).map(t => t.gruppe.oberbegriff))] };
  }

  function bewerten(r, staemme, regeln) {
    // Grundzutaten wie geschrieben vergleichen (mit „ö“), sonst endet „Alkohol“ auf „ol“
    const immer = konf.immerDa.map(i => i.toLowerCase());
    const genutzt = new Set(), fehlt = [], getauscht = [], weg = [];
    zeilen: for (const z of r.zeilen) {
      const treffer = staemme.filter(s => inZeile(s, z.text + " " + z.namen.join(" ")));
      treffer.forEach(s => genutzt.add(s.name));
      // Grundzutaten auch als Wortende, egal wie kurz ("Olivenöl" → "öl")
      if (treffer.length || rohWoerter(z.text + " " + z.namen.join(" ")).some(x => immer.some(i => x.endsWith(i)))) continue;
      if (/optional|nach belieben|nach geschmack|zum garnieren/i.test(z.text)) continue;
      const name = z.namen[0] || z.text.replace(/^[\d½¼¾\s,.–-]*(g|kg|ml|l|el|tl|stück|prise|bund|dose|becher)?\b\s*/i, "").slice(0, 40);
      // Lieber die verlinkten Zutatennamen als den ganzen Text („Butterschmalz oder Schweineschmalz“ ist kein Fleisch)
      const roh = rohWoerter(z.namen.length ? z.namen.join(" ") : z.text);
      if (regeln) {
        for (const t of regeln.tausch)
          if (roh.some(x => inGruppe(x, t.gruppe.formen))) {
            if (!t.immer) genutzt.add(t.name);
            getauscht.push(t.name + " statt " + name);
            continue zeilen;
          }
        if (regeln.gewuerze.length && roh.some(x => istGewuerz(x, regeln.gewuerze))) { weg.push(name); continue; }
      }
      fehlt.push(name);
    }
    return { ...r, genutzt: [...genutzt], fehlt: [...new Set(fehlt)], getauscht: [...new Set(getauscht)], weg: [...new Set(weg)] };
  }

  function zeigeRezepte(ziel, rezepte, zutaten, ohneOfen) {
    ziel.innerHTML = "";
    if (!rezepte.length) {
      ziel.append(el("p", { class: "hinweis koch-leer" }, "Kein passendes Rezept gefunden. Versuch es mit weniger oder anderen Zutaten, z. B. nur den wichtigsten."));
      return;
    }
    // Immer 8 auf einmal, "Weitere Gerichte" hängt die nächsten 8 an
    // „ohne-ofen“ und „haken-…“: daran erkennt der Rundgang, womit gesucht wurde
    const haken = HAKEN.filter(k => $("#koch-" + k).checked).map(k => " haken-" + k).join("");
    const liste = el("div", { class: "rezepte" + (ohneOfen ? " ohne-ofen" : "") + haken });
    const weiter = el("button", { type: "button", class: "knopf", onclick: () => mehr() });
    const info = el("span", { class: "hinweis klein" });
    let gezeigt = 0;
    function mehr() {
      for (const r of rezepte.slice(gezeigt, gezeigt + 8)) liste.append(karte(r, zutaten, ohneOfen));
      gezeigt = Math.min(gezeigt + 8, rezepte.length);
      info.textContent = gezeigt + " von " + rezepte.length + " passenden Gerichten";
      const rest = rezepte.length - gezeigt;
      weiter.textContent = "Weitere " + Math.min(rest, 8) + " Gerichte";
      weiter.hidden = rest <= 0;
    }
    mehr();
    const unten = el("div", { class: "rezepte-weiter" }, weiter, info);
    // Oben ein Knopf zum Einklappen, damit man ohne langes Scrollen an Nachlesen und Leitfaden kommt
    const anzahl = el("span", { class: "hinweis klein" }, rezepte.length + " passende Gerichte");
    const klappen = el("button", { type: "button", class: "knopf knopf-klein rezepte-klappen", "aria-expanded": "true", onclick: () => {
      const zu = !liste.hidden;
      liste.hidden = unten.hidden = zu;
      klappen.setAttribute("aria-expanded", String(!zu));
      klappen.lastChild.textContent = zu ? "Rezepte zeigen" : "Rezepte einklappen";
    } }, sym("chevron-down"), el("span", {}, "Rezepte einklappen"));
    ziel.append(el("div", { class: "rezepte-kopf" }, anzahl, klappen), liste, unten);
  }

  function karte(r, zutaten, ohneOfen) {
    const merkmale = el("div", { class: "rezept-merkmale" },
      r.fehlt.length ? el("span", { class: "merkmal fehlt" }, "Es fehlt: " + r.fehlt.join(", ")) : el("span", { class: "merkmal alles" }, "✓ Du hast alles"),
      el("span", { class: "merkmal" }, "Nutzt: " + r.genutzt.join(", ")));
    // Jeder Tausch in einem eigenen Kästchen, sonst ist bei mehreren nicht klar, was wozu gehört
    for (const t of r.getauscht) merkmale.append(el("span", { class: "merkmal tausch" }, sym("arrow-left-right"), t));
    if (r.weg.length) merkmale.append(el("span", { class: "merkmal weg" }, "Ohne: " + r.weg.join(", ")));
    if (r.ofen) merkmale.append(el("span", { class: "merkmal ofen" + (ohneOfen ? " fehlt" : "") }, "braucht Backofen"));
    const frage = "Wie koche ich „" + r.titel + "“? Ich habe: " + zutaten.join(", ") + "." +
      (ohneOfen ? " Ich habe keinen Backofen, nur eine Herdplatte, einen Gaskocher oder Feuer." : "") +
      (r.getauscht.length ? " Ich nehme " + r.getauscht.join(", ") + "." : "") +
      (r.weg.length ? " Ich lasse weg: " + r.weg.join(", ") + "." : "") +
      (r.fehlt.length ? " Es fehlt mir: " + r.fehlt.join(", ") + ". Wie kann ich das ersetzen oder weglassen?" : "");
    const knoepfe = el("div", { class: "knoepfe" },
      el("a", { class: "knopf", href: "#lesen?url=" + encodeURIComponent(r.url) + "&titel=" + encodeURIComponent(r.titel) }, sym("book-open"), "Rezept lesen"));
    // Ohne eingerichtete KI gibt es nichts zu fragen
    if ((OW.status || {}).modell) knoepfe.append(el("a", { class: "knopf", href: "#fragen?q=" + encodeURIComponent(frage) }, sym("message-circle"), "Die KI fragen"));
    return el("div", { class: "rezept" }, el("div", { class: "rezept-text" }, el("h3", {}, r.titel), merkmale), knoepfe);
  }

  // ------------------------------------------------------------ Nachlesen und Leitfaden

  // Wirft, wenn (fast) alle Abfragen scheitern; dann bleibt "nachgelesen" false und der nächste Besuch versucht es neu
  async function nachlesen() {
    const ziel = $("#koch-nachlesen");
    const buecher = await Kiwix.buecher();
    const stat = { anzahl: 0, fehler: 0 };
    // Alle Titel parallel (höchstens 4 gleichzeitig) abfragen, danach der Reihe nach einsetzen
    const eintraege = konf.nachlesen.flatMap(g => g.artikel.map(eintrag => ({ g, eintrag })));
    const funde = await nachEinander(eintraege, 4, ({ eintrag }) => finde(buecher, eintrag.split("#")[0], stat));
    const linkFunde = await nachEinander(leitfadenLinks, 4, ({ titel }) => finde(buecher, titel, stat));
    if (stat.anzahl > 0 && stat.fehler === stat.anzahl) throw new Error("Nachschlagen nicht möglich");
    ziel.innerHTML = "";
    const gruppen = new Map();
    eintraege.forEach(({ g, eintrag }, i) => {
      let teil = gruppen.get(g);
      if (!teil) {
        const links = el("div", { class: "nachlesen-links" });
        const gruppe = el("div", { class: "nachlesen" }, el("h3", {}, sym(g.icon), g.titel), links);
        gruppe.hidden = true;
        ziel.append(gruppe);
        gruppen.set(g, teil = { links, gruppe });
      }
      const a = funde[i];
      if (!a) return;
      // "Artikel#Abschnitt" springt direkt zum Abschnitt und zeigt dessen Namen
      const abschnitt = eintrag.split("#")[1];
      const url = a.url + (abschnitt ? "#" + abschnitt.replace(/ /g, "_") : "");
      // Bei doppelten Überschriften hängt Wikipedia "_2" an, angezeigt wird nur der Name
      const name = abschnitt ? abschnitt.replace(/_\d+$/, "").replace(/_/g, " ") : a.titel;
      teil.links.append(el("a", { class: "knopf knopf-klein", href: "#lesen?url=" + encodeURIComponent(url) + "&titel=" + encodeURIComponent(name) }, name));
      teil.gruppe.hidden = false;
    });
    const ausgleichen = () => ziel.querySelectorAll(".nachlesen-links").forEach(zeilenAusgleichen);
    ausgleichen();
    new ResizeObserver(() => requestAnimationFrame(ausgleichen)).observe(ziel);
    if (document.fonts) document.fonts.ready.then(ausgleichen);
    // Verlinkte Wörter in den Überschriften des Leitfadens; ohne passenden Artikel bleibt es Text
    leitfadenLinks.forEach(({ wort }, i) => {
      const a = linkFunde[i];
      if (a && wort.isConnected) wort.replaceWith(el("a", { href: "#lesen?url=" + encodeURIComponent(a.url) + "&titel=" + encodeURIComponent(a.titel) }, wort.textContent));
    });
  }

  // Stichwörter ordentlicher setzen: Eine volle Zeile wird auf ganze Breite gezogen, wenn die Kästchen dafür nur wenig
  // wachsen müssen (höchstens gut ein Drittel des kleinsten). In der letzten Zeile bekommt ein Kästchen die Breite
  // des Kästchens darüber, wenn beide gleich weit links beginnen und ähnlich lang sind; sehr verschiedene bleiben.
  function zeilenAusgleichen(box) {
    const knoepfe = [...box.children];
    knoepfe.forEach(k => { k.classList.remove("gestreckt"); k.style.minWidth = ""; });
    if (!box.clientWidth) return;
    const zeilen = [];
    for (const k of knoepfe) {
      const z = zeilen[zeilen.length - 1];
      if (z && Math.abs(z.oben - k.offsetTop) < 4) z.k.push(k); else zeilen.push({ oben: k.offsetTop, k: [k] });
    }
    if (zeilen.length < 2) return;
    const abstand = parseFloat(getComputedStyle(box).columnGap) || 0;
    const breite = k => k.getBoundingClientRect().width;
    zeilen.slice(0, -1).forEach(z => {
      const breiten = z.k.map(breite);
      const frei = box.clientWidth - breiten.reduce((a, b) => a + b, 0) - abstand * (z.k.length - 1);
      if (frei / z.k.length <= 0.35 * Math.min(...breiten)) z.k.forEach(k => k.classList.add("gestreckt"));
    });
    const oben = zeilen[zeilen.length - 2].k, letzte = zeilen[zeilen.length - 1].k;
    for (let i = 0; i < letzte.length && i < oben.length; i++) {
      const b = breite(oben[i]);
      if (Math.abs(oben[i].offsetLeft - letzte[i].offsetLeft) > 2 || b / breite(letzte[i]) > 1.4) break;
      letzte[i].style.minWidth = b + "px";
    }
  }

  // Artikel mit genau diesem Titel im ersten Paket, das ihn hat (stat zählt Abfragen und Fehler)
  async function finde(buecher, titel, stat) {
    for (const name of konf.pakete)
      for (const b of buecher.filter(x => x.name === name)) {
        stat.anzahl++;
        const v = await Kiwix.vorschlaege(b, titel, 3).catch(() => { stat.fehler++; return []; });
        const exakt = v.find(x => x.titel.toLowerCase() === titel.toLowerCase());
        if (exakt) return exakt;
      }
    return null;
  }

  function leitfaden() {
    const ziel = $("#koch-leitfaden");
    for (const t of konf.leitfaden) {
      // Kopf wie die Klapp-Abschnitte (Bibliothek, Inhalte): Symbol im Feld, Titel, Pfeil rechts
      const box = el("details", { class: "leitfaden", id: "koch-l-" + t.id },
        el("summary", {}, symFeld(t.icon, "gross"), el("b", {}, t.titel), el("span", { class: "klapp-pfeil", "aria-hidden": "true" })));
      for (const a of t.abschnitte) {
        // Wörter aus "verweis" kommen in ein eigenes <span>, das nachlesen() durch einen Link ersetzt,
        // sobald die Bibliothek bereit ist
        const kopf = el("h4", {});
        let rest = a.titel;
        for (const [wort, titel] of Object.entries(a.verweis || {})) {
          const i = rest.indexOf(wort);
          if (i < 0) continue;
          const span = el("span", {}, wort);
          kopf.append(rest.slice(0, i), span);
          rest = rest.slice(i + wort.length);
          leitfadenLinks.push({ wort: span, titel });
        }
        kopf.append(rest);
        box.append(kopf, el("ul", {}, ...a.punkte.map(p => el("li", {}, zeilen(p)))));
      }
      ziel.append(box);
    }
  }

  // Für den Rundgang („Zurück“ nimmt die Aufgabe des Schritts zurück): Feld und Ergebnis leeren bzw. die
  // Backofen-Auswahl zurückstellen und die Liste dazu neu suchen
  function uebungLeeren() {
    $("#koch-zutaten").value = "";
    $("#koch-ergebnis").innerHTML = "";
  }
  async function uebungOfen(wert) {
    const s = $("#koch-ofen");
    if (s.value !== wert) { s.value = wert; s.dispatchEvent(new Event("change")); }
    for (let i = 0; i < 100 && beschaeftigt; i++) await new Promise(r => setTimeout(r, 100));
    if (eingabe().length) await suchen();
  }
  // haken: { gewuerze: false, … } – Häkchen zurückstellen und neu suchen
  async function uebungHaken(haken) {
    let anders = false;
    for (const k of Object.keys(haken)) {
      const e = $("#koch-" + k);
      if (e && e.checked !== !!haken[k]) { e.checked = !!haken[k]; anders = true; }
    }
    if (!anders) return;
    merken();
    for (let i = 0; i < 100 && beschaeftigt; i++) await new Promise(r => setTimeout(r, 100));
    if (eingabe().length) await suchen();
  }

  // abgleich: nur für Tests (prüft, ob eine Eingabe zu einer Rezeptzeile passt)
  async function abgleich(eingabeText, zeilenText) {
    if (!konf) konf = await ladeKonfig("kochen");
    return inZeile(eintrag(eingabeText), zeilenText);
  }

  return { zeigen, uebungLeeren, uebungOfen, uebungHaken, abgleich };
})();
