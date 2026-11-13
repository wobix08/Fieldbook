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

  async function zeigen(params) {
    if (!konf) konf = await ladeKonfig("kochen");
    if (!aufgebaut) {
      aufgebaut = true;
      try { const o = localStorage.getItem("ow-ofen"); if (o) $("#koch-ofen").value = o; } catch { }
      $("#koch-ofen").addEventListener("change", () => { try { localStorage.setItem("ow-ofen", $("#koch-ofen").value); } catch { } });
      $("#koch-form").addEventListener("submit", (e) => { e.preventDefault(); suchen(); });
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
  function stamm(w) {
    w = w.toLowerCase();
    const k = w.replace(/(en|er|n|e)$/, "");
    return k.length >= 2 ? k : w;
  }
  function woerter(text) {
    return (text.toLowerCase().match(/[a-zäöüß]+/g) || []).map(stamm);
  }
  // Passt ein Wort zur Zutat? Gleich, oder bei längeren Wörtern als Wortende ("Bergkäse" → "Käse")
  function passt(wort, zutat) {
    return wort === zutat || (zutat.length >= 4 && wort.endsWith(zutat));
  }

  function eingabe() {
    return $("#koch-zutaten").value.split(/[,;\n]|\bund\b/i).map(s => s.trim()).filter(Boolean).slice(0, 12);
  }

  async function suchen() {
    if (beschaeftigt) return;
    const zutaten = eingabe();
    const ziel = $("#koch-ergebnis");
    ziel.innerHTML = "";
    if (!zutaten.length) { ziel.append(el("p", { class: "hinweis" }, "Schreib auf, was du da hast, z. B. „Kartoffeln, Eier, Zwiebeln“.")); return; }
    const buch = await rezeptBuch();
    if (!buch) return;
    beschaeftigt = true;
    const status = el("p", { class: "hinweis" }, "Rezepte werden gesucht …");
    ziel.append(status);
    try {
      const kandidaten = await kandidatenSuchen(buch, zutaten);
      status.textContent = "Rezepte werden geprüft (" + kandidaten.length + ") …";
      const rezepte = (await nachEinander(kandidaten, 8, lesen)).filter(Boolean);
      const ohneOfen = $("#koch-ofen").value === "ohne";
      const staemme = zutaten.map(z => ({ name: z, stamm: stamm(z.split(/\s+/).pop()) }));
      const bewertet = rezepte.map(r => bewerten(r, staemme)).filter(r => r.genutzt.length > 0 && r.fehlt.length <= 3);
      bewertet.sort((a, b) =>
        (ohneOfen ? (a.ofen - b.ofen) : 0) || a.fehlt.length - b.fehlt.length || b.genutzt.length - a.genutzt.length);
      zeigeRezepte(ziel, bewertet, zutaten, ohneOfen);
    } catch (e) {
      ziel.innerHTML = "";
      console.error(e);
      ziel.append(fehlerBox("Die Suche hat nicht geklappt. Bitte versuche es noch einmal.", null, null, e.message));
    } finally { beschaeftigt = false; }
  }

  // Volltextsuche mit allen Zutaten zusammen, paarweise und einzeln. So kommen auch Rezepte in die
  // Auswahl, die nur einen Teil der Zutaten nutzen.
  async function kandidatenSuchen(buch, zutaten) {
    const anfragen = [zutaten.join(" ")];
    for (let i = 0; i < zutaten.length; i++)
      for (let j = i + 1; j < zutaten.length && anfragen.length < 16; j++) anfragen.push(zutaten[i] + " " + zutaten[j]);
    for (const z of zutaten) anfragen.push(z);
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

  function bewerten(r, staemme) {
    const immer = konf.immerDa.map(stamm);
    const genutzt = new Set(), fehlt = [];
    for (const z of r.zeilen) {
      const w = woerter(z.text + " " + z.namen.join(" "));
      const treffer = staemme.filter(s => w.some(x => passt(x, s.stamm)));
      treffer.forEach(s => genutzt.add(s.name));
      // Grundzutaten auch als Wortende, egal wie kurz ("Olivenöl" → "öl")
      if (treffer.length || w.some(x => immer.some(i => x.endsWith(i)))) continue;
      if (/optional|nach belieben|nach geschmack|zum garnieren/i.test(z.text)) continue;
      fehlt.push(z.namen[0] || z.text.replace(/^[\d½¼¾\s,.–-]*(g|kg|ml|l|el|tl|stück|prise|bund|dose|becher)?\b\s*/i, "").slice(0, 40));
    }
    return { ...r, genutzt: [...genutzt], fehlt: [...new Set(fehlt)] };
  }

  function zeigeRezepte(ziel, rezepte, zutaten, ohneOfen) {
    ziel.innerHTML = "";
    if (!rezepte.length) {
      ziel.append(el("p", { class: "hinweis" }, "Kein passendes Rezept gefunden. Versuch es mit weniger oder anderen Zutaten, z. B. nur den wichtigsten."));
      return;
    }
    // Immer 8 auf einmal, "Weitere Gerichte" hängt die nächsten 8 an
    const liste = el("div", { class: "rezepte" });
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
    ziel.append(liste, el("div", { class: "rezepte-weiter" }, weiter, info));
  }

  function karte(r, zutaten, ohneOfen) {
    const merkmale = el("div", { class: "rezept-merkmale" },
      r.fehlt.length ? el("span", { class: "merkmal fehlt" }, "Es fehlt: " + r.fehlt.join(", ")) : el("span", { class: "merkmal alles" }, "✓ Du hast alles"),
      el("span", { class: "merkmal" }, "Nutzt: " + r.genutzt.join(", ")));
    if (r.ofen) merkmale.append(el("span", { class: "merkmal" + (ohneOfen ? " fehlt" : "") }, "braucht Backofen"));
    const frage = "Wie koche ich „" + r.titel + "“? Ich habe: " + zutaten.join(", ") + "." +
      (ohneOfen ? " Ich habe keinen Backofen, nur eine Herdplatte, einen Gaskocher oder Feuer." : "") +
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

  return { zeigen };
})();
