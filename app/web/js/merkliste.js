// Merkliste: selbst gemerkte Sachen aus allen Bereichen, in eigenen Ordnern (Speichern und Knöpfe in helfer.js).
// Gemerkt werden ganze Artikel, Buchseiten und Seiten aus Erste Hilfe und Vorsorge (Lesezeichen-Knopf) sowie
// markierte Textstellen (Knopf „Merken“ neben der Markierung). Eine Textstelle öffnet ihre Seite und springt hin.
"use strict";

const MerkAnsicht = (() => {
  const BEREICHE = [
    { id: "bibliothek", titel: "Bibliothek", icon: "library" },
    { id: "kochen", titel: "Kochen", icon: "cooking-pot" },
    { id: "erstehilfe", titel: "Erste Hilfe", icon: "briefcase-medical" },
    { id: "vorsorge", titel: "Vorsorge", icon: "shield-check" },
  ];
  const offen = new Set();
  let filter = "alle";
  let rezeptPaket = null;

  // Rezepte aus dem Koch-Wiki zählen zu „Kochen“, auch wenn sie im Lesefenster gemerkt wurden
  function bereichVon(e, buecher) {
    if (e.bereich && e.bereich !== "bibliothek") return e.bereich;
    const b = buecher.find(x => x.id === e.paket);
    return b && rezeptPaket && b.name === rezeptPaket ? "kochen" : "bibliothek";
  }

  // Adresse zum Öffnen; Textstellen bekommen „merk=<id>“, damit die Seite zur Stelle springt
  function linkVon(e, b) {
    const merk = e.stelle ? "merk=" + e.id : "";
    if (e.link) return e.link + (merk ? "&" + merk : "");
    if (e.paket === "eigene") return Eigene.linkVon(e.url, e.seite);
    if (e.pdf) return "#pdf?url=" + encodeURIComponent(e.url) + (e.seite ? "&seite=" + e.seite : "") + "&titel=" + encodeURIComponent(e.titel);
    return "#lesen?url=" + encodeURIComponent(e.url) + "&titel=" + encodeURIComponent(b ? b.titel : e.titel) + (merk ? "&" + merk : "");
  }

  async function zeigen() {
    const ziel = $("#merk-inhalt");
    let d, buecher, eigene;
    try {
      [d, buecher, eigene] = await Promise.all([Merkliste.laden(true), Kiwix.buecher(), Eigene.liste().catch(() => [])]);
      if (rezeptPaket === null) rezeptPaket = ((await ladeKonfig("kochen")) || {}).rezeptPaket || "";
    } catch (e) {
      ziel.replaceChildren(fehlerBox("Die Merkliste konnte nicht geladen werden.", zeigen, "Erneut versuchen", e && e.message));
      return;
    }
    zeichnen(d, buecher, eigene);
  }

  function zeichnen(d, buecher, eigene) {
    const ziel = $("#merk-inhalt");
    const eigeneDa = new Set(eigene.map(x => Eigene.url(x.datei)));
    // Einträge aus Paketen, die gerade fehlen, bleiben gespeichert, werden aber nicht gezeigt
    const alle = (d.liste || []).map(e => {
      const b = e.link ? null : e.paket === "eigene" ? (eigeneDa.has(e.url) ? Eigene.BUCH : null) : buecher.find(x => x.id === e.paket);
      return { e, b, bereich: bereichVon(e, buecher) };
    }).filter(x => x.e.link || x.b);
    const ordner = d.ordner || [];

    // Filter nach Bereich nur, wenn mehr als ein Bereich vorkommt
    const vorhanden = BEREICHE.filter(b => alle.some(x => x.bereich === b.id));
    if (!vorhanden.some(b => b.id === filter)) filter = "alle";
    const sichtbar = alle.filter(x => filter === "alle" || x.bereich === filter);
    const filterLeiste = vorhanden.length > 1 ? el("div", { class: "merk-filter", role: "group", "aria-label": "Nach Bereich zeigen" },
      [{ id: "alle", titel: "Alle" }, ...vorhanden].map(b => el("button", {
        type: "button", class: "knopf knopf-klein" + (filter === b.id ? " aktiv" : ""), "aria-pressed": String(filter === b.id),
        onclick: () => { filter = b.id; zeichnen(d, buecher, eigene); } }, b.icon ? sym(b.icon) : null, b.titel))) : null;

    const teile = [];
    if (!alle.length && !ordner.length) {
      teile.push(el("div", { class: "merk-leer" },
        el("p", {}, "Hier sammelst du, was du wiederfinden willst."),
        el("p", { class: "hinweis" }, "Ganze Artikel, Buchseiten und Themen aus Erste Hilfe und Vorsorge merkst du mit dem Lesezeichen-Knopf ", sym("bookmark"), " oben neben dem Titel.",
          el("br"), "Für eine einzelne Stelle markierst du den Text und klickst auf „Merken“.",
          el("br"), "Mit eigenen Ordnern kannst du alles sortieren.")));
    }
    if (filterLeiste) teile.push(filterLeiste);
    const liste = el("div", { class: "regal liste merk-liste" });
    for (const o of ordner) {
      const drin = sichtbar.filter(x => x.e.ordner === o.id);
      // Beim Filtern leere Ordner weglassen, sonst immer zeigen (auch leer, damit man hineinsortieren kann)
      if (filter !== "alle" && !drin.length) continue;
      const k = klappAbschnitt(offen, o.id, "folder", o.name, null, anzahl(drin.length), false);
      k.innen.append(el("div", { class: "klapp-liste" },
        drin.length ? drin.map(x => zeile(x, ordner)) : el("p", { class: "hinweis merk-ordner-leer" }, "Noch leer.", el("br"), "Über das Menü ", sym("ellipsis-vertical"), " an einem Eintrag legst du ihn hier hinein."),
        el("div", { class: "knopfreihe merk-ordner-knoepfe" },
          el("button", { type: "button", class: "knopf knopf-klein", onclick: () => ordnerUmbenennen(o) }, sym("pencil"), "Ordner umbenennen"),
          el("button", { type: "button", class: "knopf knopf-klein", onclick: () => ordnerLoeschen(o, drin.length) }, sym("trash-2"), "Ordner löschen"))));
      liste.append(k.box);
    }
    const lose = sichtbar.filter(x => !ordner.some(o => o.id === x.e.ordner));
    if (ordner.length && lose.length) liste.append(el("h2", { class: "merk-zwischen" }, "Ohne Ordner"));
    for (const x of lose) liste.append(zeile(x, ordner));
    teile.push(liste);
    ziel.replaceChildren(...teile);
  }

  const anzahl = (n) => n === 1 ? "1 Eintrag" : n + " Einträge";

  function zeile(x, ordner) {
    const { e, b } = x;
    const bereich = BEREICHE.find(y => y.id === x.bereich);
    const herkunft = e.link ? bereich.titel : (b.titel + (e.pdf && e.seite ? " · Seite " + e.seite : ""));
    const bild = e.link ? symFeld(bereich.icon) : b.eigene ? symFeld("folder-open")
      : el("img", { class: "e-bild", src: b.bild || "icon.svg", alt: "", loading: "lazy" });
    const menueKnopf = el("button", { type: "button", class: "knopf knopf-klein merk-menue-knopf", title: "Umbenennen, verschieben, entfernen",
      "aria-label": "Menü für „" + e.titel + "“", "aria-haspopup": "true", "aria-expanded": "false" }, sym("ellipsis-vertical"));
    const z = el("div", { class: "merk-zeile" },
      el("a", { class: "eintrag paket-zeile", href: linkVon(e, b) },
        bild,
        el("span", { class: "e-text" },
          el("b", {}, e.titel),
          e.stelle ? el("span", { class: "merk-stelle" }, /^[„“"»«‚']/.test(e.stelle) ? e.stelle : "„" + e.stelle + "“") : null,
          el("small", {}, herkunft)),
        el("span", { class: "paket-pfeil", "aria-hidden": "true" })),
      menueKnopf);
    menueKnopf.addEventListener("click", () => menue(z, menueKnopf, e, ordner));
    return z;
  }

  // ------------------------------------------------------------ Menü an einem Eintrag

  let offenesMenue = null;
  function menueZu(fokus) {
    if (!offenesMenue) return;
    const m = offenesMenue;
    offenesMenue = null;
    m.liste.remove();
    m.knopf.setAttribute("aria-expanded", "false");
    if (fokus) m.knopf.focus();
  }
  document.addEventListener("pointerdown", (ev) => {
    if (offenesMenue && !offenesMenue.liste.contains(ev.target) && !offenesMenue.knopf.contains(ev.target)) menueZu();
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && offenesMenue) menueZu(true); });

  function menue(zeileEl, knopf, e, ordner) {
    const warOffen = offenesMenue && offenesMenue.knopf === knopf;
    menueZu();
    if (warOffen) return;
    const punkt = (icon, text, fn, klasse) => el("button", { type: "button", class: klasse || null,
      onclick: () => { menueZu(); fn(); } }, icon ? sym(icon) : el("span", { class: "menue-haken" }), text);
    const liste = el("div", { class: "menue merk-menue", role: "menu" },
      punkt("pencil", "Umbenennen", () => umbenennen(e)),
      el("hr"),
      el("div", { class: "menue-titel" }, "In Ordner legen"),
      ...ordner.map(o => punkt(e.ordner === o.id ? null : "folder", o.name, () => verschieben(e, o.id), e.ordner === o.id ? "menue-aktiv" : null)),
      e.ordner && ordner.some(o => o.id === e.ordner) ? punkt("folder-input", "Aus dem Ordner nehmen", () => verschieben(e, "")) : null,
      punkt("folder-plus", "Neuer Ordner …", () => neuerOrdner(e)),
      el("hr"),
      punkt("trash-2", "Von der Merkliste nehmen", () => entfernen(e), "menue-rot"));
    // Aktueller Ordner bekommt einen Haken statt des Ordner-Symbols
    for (const b of liste.querySelectorAll(".menue-aktiv .menue-haken")) b.textContent = "✓";
    zeileEl.append(liste);
    knopf.setAttribute("aria-expanded", "true");
    offenesMenue = { liste, knopf };
    const erster = liste.querySelector("button");
    if (erster) erster.focus();
  }

  // ------------------------------------------------------------ Ändern

  async function aendern(daten, fehlerText) {
    try { await Merkliste.aendern(daten); return true; }
    catch (err) { await zeigeFehler(fehlerText, err); return false; }
    finally { if (location.hash.startsWith("#merkliste")) zeigen(); }
  }

  // Dialog mit einem Textfeld; gibt den Text zurück oder null
  async function nameFragen(titel, frage, wert, knopfText) {
    const feld = el("input", { type: "text", class: "eingabe", value: wert || "", maxlength: "200", "aria-label": frage, style: "width:100%" });
    feld.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); const k = feld.closest(".dialog").querySelector(".knopf-haupt"); if (k) k.click(); } });
    setTimeout(() => { feld.focus(); feld.select(); }, 0);
    const ok = await dialog(titel, el("div", {}, el("p", {}, frage), feld),
      [{ text: "Abbrechen", wert: null }, { text: knopfText, wert: "ok", haupt: true }]);
    const t = feld.value.trim();
    return ok === "ok" && t ? t : null;
  }

  async function umbenennen(e) {
    const t = await nameFragen("Umbenennen", "Neuer Name für den Eintrag:", e.titel, "Umbenennen");
    if (t && t !== e.titel) aendern({ aktion: "umbenennen", id: e.id, titel: t }, "Der Name konnte nicht geändert werden.");
  }
  const verschieben = (e, ordnerId) => aendern({ aktion: "verschieben", id: e.id, ordner: ordnerId }, "Der Eintrag konnte nicht verschoben werden.");
  const entfernen = (e) => aendern({ aktion: "entfernen", id: e.id }, "Der Eintrag konnte nicht entfernt werden.");

  // Neuer Ordner; mit e wird der Eintrag gleich hineingelegt
  async function neuerOrdner(e) {
    const name = await nameFragen("Neuer Ordner", "Name des Ordners:", "", "Anlegen");
    if (!name) return;
    let r;
    try { r = await Merkliste.aendern({ aktion: "ordnerNeu", name }); }
    catch (err) { await zeigeFehler("Der Ordner konnte nicht angelegt werden.", err); return; }
    offen.add(r.neu);
    if (e) await aendern({ aktion: "verschieben", id: e.id, ordner: r.neu }, "Der Eintrag konnte nicht verschoben werden.");
    else zeigen();
  }
  async function ordnerUmbenennen(o) {
    const name = await nameFragen("Ordner umbenennen", "Neuer Name des Ordners:", o.name, "Umbenennen");
    if (name && name !== o.name) aendern({ aktion: "ordnerUmbenennen", id: o.id, name }, "Der Ordner konnte nicht umbenannt werden.");
  }
  async function ordnerLoeschen(o, n) {
    if (n) {
      const ok = await dialog("Ordner löschen?", el("p", {}, "Der Ordner „" + o.name + "“ wird gelöscht.", el("br"),
        n === 1 ? "Der Eintrag darin bleibt auf der Merkliste und steht dann ohne Ordner da." : "Die " + n + " Einträge darin bleiben auf der Merkliste und stehen dann ohne Ordner da."),
        [{ text: "Abbrechen", wert: null }, { text: "Ordner löschen", wert: "ok", haupt: true }]);
      if (ok !== "ok") return;
    }
    offen.delete(o.id);
    aendern({ aktion: "ordnerLoeschen", id: o.id }, "Der Ordner konnte nicht gelöscht werden.");
  }

  $("#merk-neuer-ordner").addEventListener("click", () => neuerOrdner(null));

  // ------------------------------------------------------------ Textstellen

  // Text vergleichbar machen: Leerraum zusammenfassen
  const glatt = (t) => t.replace(/\s+/g, " ").trim();

  // Bereich (Range) der Textstelle in root suchen; Leerraum und Zeilenumbrüche zählen nicht
  function stelleFinden(root, stelle) {
    const doc = root.ownerDocument;
    const gesucht = glatt(stelle).toLowerCase();
    if (!gesucht) return null;
    let text = "";
    const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement && n.parentElement.closest("script, style, .fb-markfeld, .markfeld") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    // Fortlaufender Text mit einfachem Leerraum; zu jedem Zeichen merken, aus welchem Knoten es stammt
    const her = [];
    let leer = true;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.data;
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (/\s/.test(c)) { if (leer) continue; text += " "; leer = true; }
        else { text += c.toLowerCase(); leer = false; }
        her.push([n, i]);
      }
    }
    const pos = text.indexOf(gesucht);
    if (pos < 0) return null;
    const [an, ai] = her[pos], [bn, bi] = her[pos + gesucht.length - 1];
    const r = doc.createRange();
    r.setStart(an, ai);
    r.setEnd(bn, bi + 1);
    return r;
  }

  // Textstelle hervorheben und hinscrollen (im Lesefenster oder in einer Fieldbook-Seite)
  function stelleZeigen(root, stelle) {
    const r = stelleFinden(root, stelle);
    if (!r) return false;
    bereichZeigen(root, r);
    return true;
  }

  function bereichZeigen(root, r) {
    const doc = root.ownerDocument, win = doc.defaultView;
    if (win.CSS && win.CSS.highlights && win.Highlight) {
      if (!doc.getElementById("fb-merk-stil")) {
        const s = doc.createElement("style");
        s.id = "fb-merk-stil";
        s.textContent = "::highlight(fb-merk) { background-color: rgba(111,154,82,.45); color: inherit; }";
        doc.head.append(s);
      }
      win.CSS.highlights.set("fb-merk", new win.Highlight(r));
      // Ein Klick in die Seite nimmt die Hervorhebung wieder weg
      doc.addEventListener("pointerdown", () => win.CSS.highlights.delete("fb-merk"), { once: true });
    } else {
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const el0 = r.startContainer.parentElement;
    if (!el0) return;
    el0.scrollIntoView({ block: "center" });
    // Lädt danach noch etwas nach (Bilder, Seitengestaltung), verrutscht die Stelle: kurz darauf noch einmal
    // hinscrollen, solange der Nutzer nicht selbst scrollt oder klickt
    let selbst = false;
    const merken = () => { selbst = true; };
    for (const ev of ["wheel", "pointerdown", "keydown", "touchstart"]) doc.addEventListener(ev, merken, { once: true, passive: true });
    for (const ms of [700, 2000]) setTimeout(() => {
      if (selbst || !el0.isConnected) return;
      const oben = r.getBoundingClientRect().top;
      if (oben < 0 || oben > win.innerHeight * 0.8) el0.scrollIntoView({ block: "center" });
    }, ms);
  }

  // Stelle aus einer KI-Antwort im Lesefenster zeigen (Text statt Merklisten-Eintrag). Fehlt der genaue Satz
  // (im Artikel stehen z. B. Fußnotenzeichen dazwischen), genügt sein Anfang: Dann wird der ganze Absatz hervorgehoben.
  async function textZeigen(root, stelle, versuche) {
    const woerter = glatt(stelle).split(" ");
    for (let i = 0; i < (versuche || 1); i++) {
      if (stelleZeigen(root, stelle)) return true;
      for (const n of [8, 5]) {
        if (woerter.length <= n) continue;
        const r = stelleFinden(root, woerter.slice(0, n).join(" "));
        if (!r) continue;
        const start = r.startContainer.parentElement;
        const absatz = start && (start.closest("p, li, dd, pre, blockquote") || start);
        if (absatz) r.selectNodeContents(absatz);
        bereichZeigen(root, r);
        return true;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  // Stelle des Eintrags id zeigen; bei Fieldbook-Seiten kommt der Inhalt evtl. erst nach, deshalb mehrmals versuchen
  async function springen(root, id, versuche) {
    let e;
    try { e = (await Merkliste.liste()).find(x => x.id === id); } catch { return; }
    if (!e || !e.stelle) return;
    for (let i = 0; i < (versuche || 1); i++) {
      if (stelleZeigen(root, e.stelle)) return;
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Nach dem Öffnen einer Fieldbook-Seite mit „merk=…“ (aus app.js)
  function nachNavigation(ziel, params) {
    const id = params.get("merk");
    if (!id) return;
    const ansicht = document.querySelector('.ansicht[data-ansicht="' + ziel + '"]');
    if (ansicht) setTimeout(() => springen(ansicht, id, 10), 100);
  }

  // Knopf „Merken“ neben markiertem Text. doc: Dokument, in dem markiert wurde; holen(text) liefert den Eintrag
  // (ohne stelle) oder null. Gibt den Knopf zurück (Stil je nach Dokument über klasse).
  function merkKnopf(doc, text, holen, klasse) {
    const e = holen();
    if (!e) return null;
    const b = doc.createElement("button");
    b.type = "button";
    b.className = klasse;
    const s = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    const p = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z");
    s.append(p);
    b.append(s, "Merken");
    b.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    b.addEventListener("click", async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (b.disabled) return;
      b.disabled = true;
      try {
        await Merkliste.setzen(Object.assign({}, e, { stelle: glatt(text).slice(0, 1500) }), true);
        b.lastChild.textContent = "Gemerkt ✓";
        setTimeout(() => { const f = b.parentElement; if (f) f.remove(); }, 1200);
      } catch (err) {
        b.disabled = false;
        zeigeFehler("Die Stelle konnte nicht gemerkt werden.", err);
      }
    });
    return b;
  }

  // Markieren in den Fieldbook-Seiten Erste Hilfe, Vorsorge und Kochen: Feld „Merken“ neben der Markierung
  const SEITEN = ["erstehilfe", "vorsorge", "kochen"];
  let feld = null;
  const feldWeg = () => { if (feld) { feld.remove(); feld = null; } };
  function seitenEintrag() {
    const ansicht = document.querySelector(".ansicht.sichtbar");
    const name = ansicht && ansicht.dataset.ansicht;
    if (!SEITEN.includes(name)) return null;
    const h = ansicht.querySelector("h2") || ansicht.querySelector("h1");
    const titel = glatt((h && h.textContent) || BEREICHE.find(b => b.id === name).titel);
    // Adresse ohne „merk=…“; Kochen ohne Unterseite bekommt „?“ (der Server erwartet „#bereich?…“)
    let link = location.hash.replace(/[?&]merk=[^&]*/, "");
    if (!link.includes("?")) link += "?a=1";
    return { link, titel, bereich: name };
  }
  function markierungPruefen() {
    feldWeg();
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const text = sel.toString();
    if (glatt(text).length < 2) return;
    const r = sel.getRangeAt(0);
    const ansicht = document.querySelector(".ansicht.sichtbar");
    if (!ansicht || !ansicht.contains(r.commonAncestorContainer) || r.commonAncestorContainer.parentElement && r.commonAncestorContainer.parentElement.closest("input, textarea")) return;
    const k = merkKnopf(document, text, seitenEintrag, "knopf knopf-haupt knopf-klein");
    if (!k) return;
    const box = r.getBoundingClientRect();
    feld = el("div", { class: "markfeld" }, k);
    feld.style.top = (box.bottom + window.scrollY + 8) + "px";
    feld.style.left = Math.max(8, Math.min(box.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 130)) + "px";
    document.body.append(feld);
  }
  document.addEventListener("mouseup", (ev) => { if (!(ev.target.closest && ev.target.closest(".markfeld"))) setTimeout(markierungPruefen, 10); });
  document.addEventListener("keyup", (ev) => { if (ev.shiftKey) markierungPruefen(); });
  document.addEventListener("mousedown", (ev) => { if (!(ev.target.closest && ev.target.closest(".markfeld"))) feldWeg(); });
  window.addEventListener("hashchange", feldWeg);

  return { zeigen, merkKnopf, springen, textZeigen, nachNavigation };
})();
