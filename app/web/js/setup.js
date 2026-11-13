// Einrichtungs-Assistent: Gerät prüfen, KI wählen, Wissen, Karten und Sprachen wählen, abschließen.
// Die Downloads selbst laufen danach auf der Seite "Inhalte" (inhalte.js).
"use strict";

const Setup = (() => {
  const SCHRITTE = ["Dein Gerät", "KI-Assistent", "Wissen", "Karten", "Sprachen", "Übersicht"];
  const UEBERSICHT = SCHRITTE.length - 1;
  let sprachen = [], stimmen = [], alleSprachen = false, gruppen = {};
  const STUFEN = [
    { name: "Sehr schwaches Gerät", text: "Für die KI reicht der Arbeitsspeicher nicht (mindestens 8 GB). Bibliothek, Karten und Erste Hilfe funktionieren trotzdem." },
    { name: "Einsteiger-Gerät", text: "Kleine KI, rechnet auf dem Prozessor." },
    { name: "Standard-Gerät", text: "Mittlere KI möglich." },
    { name: "Starkes Gerät", text: "Große KI möglich." },
    { name: "Sehr starkes Gerät", text: "Sehr große KI möglich." },
  ];
  let schritt = 0, hw = null, kat = null, akt = { an: false, modus: "fragen", wann: "sofort", mbit: 0 }, downloadAktiv = false;
  let wahl = neueWahl();
  // Aufgeklappte Kategorien im Schritt „Wissen“ (bleiben beim Neuzeichnen offen)
  const aufgeklappt = new Set();
  function neueWahl() {
    return { modell: undefined, backend: "cpu", pakete: new Set(), karten: new Map(), sparen: false, routen: true, routenGroesse: null, desktop: undefined, uebersetzer: true,
      sprachen: new Set(), stimmen: new Set(), spracheingabe: false,
      // Vorauswahl je Bereich: zuletzt gewählte Stellung und die eigene Auswahl (damit man zu „Eigene“ zurückkann)
      zuletzt: {}, eigene: {} };
  }

  // ------------------------------------------------ Vorauswahl (Nichts · Das Wichtigste · Alles · Eigene)

  const STELLUNG_NAME = { nichts: "Nichts", wichtigste: "Das Wichtigste", alles: "Alles", eigene: "Eigene" };
  const gleich = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  // Welche Stellung passt zur aktuellen Auswahl? Bei Gleichstand gewinnt die zuletzt geklickte.
  function stellung(bereich, aktuell, sets) {
    const passt = id => sets[id] && gleich(aktuell, sets[id]);
    const z = wahl.zuletzt[bereich];
    if (z && z !== "eigene" && passt(z)) return z;
    // Ist alles schon installiert, sind alle Stellungen gleich: dann „Alles“ zeigen
    return ["alles", "wichtigste", "nichts"].find(passt) || "eigene";
  }
  const groesseText = b => b > 0 ? groesse(b) : "0 MB";

  // Schalter samt Merken der eigenen Auswahl. bereich: "wissen" | "karten" | "sprachen".
  // a.aktuell(): Menge zum Vergleichen; a.sets: { nichts, wichtigste?, alles }; a.bytes(id|"eigene"); a.setze(id); a.kopie()/a.zurueck(k)
  function vorauswahl(bereich, a, neuZeichnen, hinweis) {
    const akt = stellung(bereich, a.aktuell(), a.sets);
    if (akt === "eigene") wahl.eigene[bereich] = a.kopie();
    const ids = Object.keys(STELLUNG_NAME).filter(id => id === "eigene" || a.sets[id]);
    const schalter = stufenSchalter(ids.map(id => ({ id, text: STELLUNG_NAME[id],
      unter: id === "eigene" ? (wahl.eigene[bereich] ? groesseText(a.bytes("eigene")) : "") : groesseText(a.bytes(id)),
      gesperrt: id === "eigene" && !wahl.eigene[bereich] })), akt, (id) => {
      wahl.zuletzt[bereich] = id;
      if (id === "eigene") a.zurueck(wahl.eigene[bereich]); else a.setze(id);
      neuZeichnen();
    }, "Vorauswahl");
    return el("div", { class: "stufen-zeile" }, schalter, hinweis ? el("p", { class: "hinweis klein" }, hinweis) : null);
  }

  // Wissen: Mengen der Vorauswahl (Installiertes bleibt immer gewählt; „alles“ wählt je Variantengruppe die größte)
  // Bei schwachem Gerät und wenig Platz mit der kompakten Wikipedia
  const wichtigVorlage = () => kat.vorlagen.find(v => v.id === (stufe(hw) <= 1 && hw.freiGB < 60 ? "wichtigste-klein" : "wichtigste")) || { pakete: [] };
  function wissenSets() {
    const inst = kat.pakete.filter(p => p.installiert).map(p => p.id);
    const vorlage = id => (kat.vorlagen.find(v => v.id === id) || { pakete: [] }).pakete;
    // „Das Wichtigste“ tauscht keine Variante, wenn schon eine aus derselben Gruppe da ist (z. B. Wikipedia)
    const gruppeDa = new Set(kat.pakete.filter(p => p.installiert && p.gruppeExklusiv).map(p => p.gruppeExklusiv));
    const wichtig = wichtigVorlage().pakete.filter(id => { const p = kat.pakete.find(x => x.id === id); return !(p && !p.installiert && gruppeDa.has(p.gruppeExklusiv)); });
    return { nichts: einProGruppe(inst), wichtigste: einProGruppe(wichtig.concat(inst)), alles: einProGruppe(vorlage("alles").concat(inst)) };
  }
  // Je Variantengruppe höchstens eine Variante: eine neue ersetzt die installierte (die größte neue gewinnt).
  // Sind nur installierte gewählt (z. B. zwei aus früheren Versionen), bleiben sie.
  function einProGruppe(ids) {
    const s = new Set(ids), gruppen = {};
    for (const p of kat.pakete) if (p.gruppeExklusiv && s.has(p.id)) (gruppen[p.gruppeExklusiv] = gruppen[p.gruppeExklusiv] || []).push(p);
    for (const g of Object.values(gruppen)) {
      const neu = g.filter(p => !p.installiert).sort((a, b) => b.bytes - a.bytes);
      if (neu.length) g.forEach(p => { if (p !== neu[0]) s.delete(p.id); });
    }
    return s;
  }
  const paketBytes = ids => kat.pakete.reduce((b, p) => b + (ids.has(p.id) && (!p.installiert || p.update) ? p.bytes || 0 : 0), 0);

  // Karten: „Alles“ ist Europa (ganz) plus Weltkarte, die enthalten alle Einzelländer
  function kartenSets() {
    const inst = kat.karten.filter(r => r.installiert).map(r => r.id);
    const alles = kat.karten.filter(r => r.id === "europa" || r.id === "welt").map(r => r.id);
    return { nichts: new Set(inst), alles: new Set(alles.concat(inst)) };
  }
  function kartenBytes(ids) {
    let b = 0;
    for (const id of ids) {
      const r = kat.karten.find(x => x.id === id), k = wahl.karten.get(id);
      if (r && !r.installiert) b += k && k.bytes > 0 ? k.bytes : kartenSchaetzung(r, wahl.sparen);
    }
    return b;
  }

  // Sprachen: Schlüssel je Sprache „code“ bzw. „code+“ mit Stimme; „Alles“ = jede Sprache mit Text + Sprache
  const sprachSchluessel = (spr, stm) => new Set([...spr].map(c => stm.has(c) ? c + "+" : c));
  function sprachSets() {
    const da = new Set((OW.status || {}).sprachen || []);
    const neu = sprachen.filter(sp => !da.has(sp.code)).map(sp => sp.code);
    return { nichts: new Set(), alles: new Set(neu.map(c => stimmeBytes(c) ? c + "+" : c)) };
  }
  function ausSchluessel(s) {
    const spr = new Set(), stm = new Set();
    for (const k of s) { const c = k.replace("+", ""); spr.add(c); if (k.endsWith("+")) stm.add(c); }
    return { spr, stm };
  }

  // ------------------------------------------------ Hardware-Einstufung

  function besteGpu(h) {
    return (h.gpus || []).filter(g => g.dediziert).sort((a, b) => b.vramGB - a.vramGB)[0] || null;
  }
  function stufe(h) {
    const g = besteGpu(h), ram = Math.round(h.ramGB);
    if (g && g.vramGB >= 20) return 4;
    if (g && g.vramGB >= 8) return 3;
    if (ram >= 32) return 3;
    if ((g && g.vramGB >= 4) || ram >= 16) return 2;
    if (ram >= 7) return 1;
    return 0;
  }
  // Passt ein Modell auf das Gerät?  "gpu" | "cpu" | "langsam" | "zu-gross"
  function passung(m, h, backend) {
    const g = besteGpu(h), ram = Math.round(h.ramGB);
    if (backend === "vulkan" && g && m.minVramGB <= g.vramGB) return "gpu";
    if (m.minRamGB <= ram) return m.cpuGeeignet ? "cpu" : "langsam";
    return "zu-gross";
  }
  function empfehlung(h, modelle) {
    const g = besteGpu(h);
    const backend = g && g.vramGB >= 4 ? "vulkan" : "cpu";
    const angeboten = modelle.filter(m => !m.ausgemustert);
    let passend = angeboten.filter(m => passung(m, h, backend) === (backend === "vulkan" ? "gpu" : "cpu"));
    if (!passend.length) passend = angeboten.filter(m => passung(m, h, "cpu") === "cpu");
    passend.sort((a, b) => b.bytes - a.bytes);
    // Passt keine KI aufs Gerät, ist „Keine KI“ die Empfehlung
    return { modell: passend[0] ? passend[0].id : null, backend };
  }

  // ------------------------------------------------ Gerüst

  async function zeigen(params) {
    const start = parseInt(params && params.get("schritt"), 10);
    const neu = params && params.get("neu");
    // Der Katalog wird bei jedem Öffnen neu geladen (installiert sich zwischendurch etwas, stimmt er sonst nicht);
    // die gewählten Mengen (wahl) bleiben dabei erhalten
    const ersteMal = !hw || !kat || neu;
    {
      if (neu) wahl = neueWahl(); // "Einrichtung neu starten": mit dem aktuellen Stand vorbelegen
      if (ersteMal) {
        $("#setup-inhalt").innerHTML = '<p class="hinweis">Gerät wird geprüft …</p>';
        $("#setup-knoepfe").innerHTML = "";
        zeichneSchritte();
      }
      try {
        let sk, st, pk;
        [hw, kat, akt, sk, st, pk] = await Promise.all([holeHardware(30000), api("katalog"), api("aktualisierung"),
          ladeKonfig("sprachen").catch(() => ({})), ladeKonfig("stimmen").catch(() => ({})), ladeKonfig("pakete").catch(() => ({}))]);
        gruppen = pk.variantenGruppen || {};
        sprachen = sk.sprachen || [];
        stimmen = st.stimmen || [];
      } catch (e) {
        // Beim erneuten Öffnen gelten dann die alten Daten weiter
        if (ersteMal) {
          $("#setup-inhalt").innerHTML = '<div class="fehlerbox">Fehler: ' + esc(e.message) + "</div>";
          return;
        }
      }
      if (ersteMal) vorbelegen();
    }
    const f = await api("fortschritt").catch(() => null);
    downloadAktiv = !!(f && f.aktiv);
    schritt = !isNaN(start) ? Math.min(UEBERSICHT, start) : (neu ? 0 : schritt);
    zeichne();
  }

  function vorbelegen() {
    const e = kat.einstellungen || {};
    const emp = empfehlung(hw, kat.modelle);
    if (wahl.modell === undefined) {
      const installiert = kat.modelle.find(m => m.installiert && m.id === e.modell);
      wahl.modell = installiert ? installiert.id : emp.modell;
      wahl.backend = e.backend || emp.backend;
    }
    if (wahl.pakete.size === 0) {
      const inst = kat.pakete.filter(p => p.installiert).map(p => p.id);
      (inst.length ? inst : wichtigVorlage().pakete).forEach(id => wahl.pakete.add(id));
    }
    for (const r of kat.karten) if (r.installiert && !wahl.karten.has(r.id)) wahl.karten.set(r.id, { bytes: r.bytesInstalliert });
    const landKarte = (Land.aktuell() || {}).karte;
    if (wahl.karten.size === 0 && !kat.karten.some(r => r.installiert) && landKarte) wahl.karten.set(landKarte, { bytes: null });
    // Desktop-Symbol: beim ersten Einrichten angehakt, danach wie bisher
    if (wahl.desktop === undefined) wahl.desktop = (OW.status && OW.status.setupFertig) ? !!OW.status.desktopSymbol : true;
  }

  function zeichneSchritte() {
    const s = $("#schritte");
    s.innerHTML = "";
    // Jeder Schritt ist ein Link; die Auswahl bleibt beim Springen erhalten (solange das Gerät geprüft ist)
    const bereit = !!(hw && kat);
    SCHRITTE.forEach((t, i) => s.append(el(bereit && i !== schritt ? "a" : "div", {
      class: "schritt" + (i === schritt ? " aktiv" : i < schritt ? " fertig" : ""),
      href: bereit && i !== schritt ? "#setup?schritt=" + i : null,
      "aria-current": i === schritt ? "step" : null,
    }, (i + 1) + ". " + t)));
  }

  function knoepfe(zurueck, weiter, weiterText) {
    const k = $("#setup-knoepfe");
    k.innerHTML = "";
    k.append(zurueck ? el("button", { class: "knopf", onclick: zurueck }, "← Zurück") : el("span"));
    if (weiter) k.append(el("button", { class: "knopf knopf-haupt", onclick: weiter }, weiterText || "Weiter →"));
    // Beim ersten Start ist das Menü oben ausgeblendet; wer erst einmal nur schauen will, kommt hier heraus
    let sp = $("#setup-spaeter");
    if (!sp) { sp = el("p", { id: "setup-spaeter", class: "hinweis klein" }); k.after(sp); }
    sp.hidden = !ersteEinrichtung();
    sp.replaceChildren(el("a", { href: "#start" }, "Später einrichten"), el("br"), "Erste Hilfe und Vorsorge funktionieren auch ohne Einrichtung.");
  }
  // Erste Einrichtung: Fieldbook wurde noch nie fertig eingerichtet (dann ist das Menü oben ausgeblendet, siehe app.js)
  function ersteEinrichtung() { return !!(OW.status && !OW.status.setupFertig); }

  function geheZu(n) { schritt = n; zeichne(); window.scrollTo(0, 0); }

  function zeichne() {
    zeichneSchritte();
    [schrittGeraet, schrittKi, schrittWissen, schrittKarten, schrittSprachen, zeigeUebersicht][schritt]();
  }

  // ------------------------------------------------ 1. Gerät

  function schrittGeraet() {
    const st = stufe(hw);
    const g = besteGpu(hw);
    const gpuText = (hw.gpus || []).length
      ? hw.gpus.map(x => x.name + (x.dediziert ? " (" + x.vramGB + " GB eigener Speicher)" : " (im Prozessor eingebaut)")).join(", ")
      : "nicht erkannt";
    const c = $("#setup-inhalt");
    c.innerHTML = "";
    c.append(
      el("h1", {}, "Willkommen bei Fieldbook"),
      el("p", {}, "Der Assistent richtet alles in wenigen Schritten ein.", el("br"), "Dafür wird einmal Internet gebraucht.", el("br"), "Danach funktioniert alles offline."));
    // Ohne Internet: Hinweis und die Übernahme vom USB-Stick (z. B. von einem anderen Fieldbook-Laptop)
    if (!kat.katalogOnline) c.append(el("div", { class: "warnung", style: "display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px" },
      el("span", {}, "Keine Internetverbindung erkannt.", el("br"), "Zum Herunterladen wird Internet gebraucht.", el("br"), "Hast du die Inhalte auf einem USB-Stick, kannst du sie von dort übernehmen."),
      el("button", { class: "knopf knopf-klein", onclick: () => Inhalte.importDialog() }, sym("usb"), "Von USB-Stick übernehmen")));
    // Ungünstiger Ort des Fieldbook-Ordners (OneDrive, sehr langer Pfad): besser vor dem ersten Download verschieben
    const ow = OW.status && OW.status.ordnerWarnung;
    if (ow) c.append(el("p", { class: "warnung", style: "margin-bottom:16px" }, ...zeilen(ow)));
    // Gerät nur als eine Zeile, die Einzelwerte zum Aufklappen
    c.append(el("div", {},
      el("div", { class: "stufe", style: "margin:0" },
        el("span", { class: "stufe-punkte" }, "●".repeat(st) + "○".repeat(4 - st)),
        el("div", {}, el("b", {}, "Dein Gerät: " + STUFEN[st].name),
          ...(STUFEN[st].text + (g && g.vramGB >= 4 ? " Die Grafikkarte wird für die KI genutzt." : "")).split(/(?<=\.) /).flatMap(t => [el("br"), t]))),
      el("details", { class: "fb-details", style: "margin:8px 0 0 16px" }, el("summary", {}, "Einzelheiten zum Gerät"),
        el("table", { class: "hw-tabelle" },
          el("tr", {}, el("td", {}, "Prozessor"), el("td", {}, hw.cpu + " (" + hw.kerne + " Kerne)")),
          el("tr", {}, el("td", {}, "Arbeitsspeicher"), el("td", {}, Math.round(hw.ramGB) + " GB")),
          el("tr", {}, el("td", {}, "Grafikkarte"), el("td", {}, gpuText)),
          el("tr", {}, el("td", {}, "Freier Speicherplatz"), el("td", {}, Math.round(hw.freiGB) + " GB auf " + (hw.laufwerk || "dem Laufwerk")))))));
    // Land, Desktop-Symbol und Aktualisierung in einem Kasten
    const land = Land.aktuell();
    const auswahl = landAuswahl(land, async (neu) => {
      statusUngueltig();
      try { OW.status = await api("einstellungen", { land: neu.code, sprache: neu.sprache }); }
      catch (err) { await zeigeFehler("Das Land konnte nicht gespeichert werden.", err); return; }
      finally { statusUngueltig(); }
      // Vorgeschlagene Karte anpassen, solange noch keine Karte installiert ist
      if (!kat.karten.some(r => r.installiert) && neu.karte) { wahl.karten.clear(); wahl.karten.set(neu.karte, { bytes: null }); }
    });
    c.append(el("div", { class: "karte-box", style: "margin-top:16px;padding-top:8px;padding-bottom:8px" },
      el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, "Land"), el("small", {}, "Für Notrufnummern und die vorgeschlagene Karte." + (OW.status && OW.status.landErkannt ? " Aus Windows erkannt: " + OW.status.landErkannt + "." : ""))),
        auswahl),
      el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, "Symbol auf dem Desktop"), el("small", {}, "Damit startest du Fieldbook bequem vom Desktop aus.")),
        anAus(el("input", { type: "checkbox", checked: wahl.desktop, onchange: (e) => { wahl.desktop = e.target.checked; } }))),
      aktualisierungBox(akt, false, { kurz: true })));
    if (land && !(OW.status && OW.status.land)) api("einstellungen", { land: land.code, sprache: land.sprache }).then(s => { OW.status = s; statusUngueltig(); }).catch(() => { });
    knoepfe(null, () => geheZu(1));
  }

  // ------------------------------------------------ 2. KI

  function schrittKi() {
    const c = $("#setup-inhalt");
    const g = besteGpu(hw);
    const emp = empfehlung(hw, kat.modelle);
    c.innerHTML = "";
    c.append(el("h1", {}, "KI-Assistent wählen"),
      el("p", {}, "Die KI beantwortet Fragen anhand der Offline-Bibliothek.", el("br"),
        "Im Moment bietet Fieldbook nur Qwen 3.5 (4B) an.", el("br"),
        "Es läuft auf jedem Laptop mit 8 GB Arbeitsspeicher.", el("br"),
        "Weitere KIs folgen, sobald sie getestet sind."));
    if (g && g.vramGB >= 4) {
      c.append(el("p", {},
        el("label", { class: "schalter" },
          el("input", { type: "checkbox", checked: wahl.backend === "vulkan", onchange: (e) => { wahl.backend = e.target.checked ? "vulkan" : "cpu"; schrittKi(); } }),
          el("span", {}, "Grafikkarte nutzen (" + g.name + ", " + g.vramGB + " GB)")
        )));
    }
    const liste = el("div");
    const sortiert = kat.modelle.slice().sort((a, b) => a.bytes - b.bytes);
    for (const m of sortiert) {
      const p = passung(m, hw, wahl.backend);
      const tags = [];
      if (m.id === emp.modell && wahl.backend === emp.backend) tags.push(el("span", { class: "marke-tag tag-empf" }, "Empfohlen"));
      if (m.installiert) tags.push(el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden"));
      if (m.ausgemustert) tags.push(el("span", { class: "marke-tag tag-warn" }, m.ungetestet ? "noch nicht getestet" : "nicht mehr empfohlen"));
      if (p === "zu-gross") tags.push(el("span", { class: "marke-tag tag-warn" }, "zu groß für dein Gerät"));
      if (p === "langsam") tags.push(el("span", { class: "marke-tag tag-warn" }, "ohne Grafikkarte sehr langsam"));
      const tempo = p === "gpu" ? "Schnell (Grafikkarte)" : p === "cpu" ? (m.bytes < 2e9 ? "Antwortet in ca. 10–30 Sekunden" : m.bytes < 4e9 ? "Antwortet in ca. 20–60 Sekunden" : "Antwortet in ca. 1–2 Minuten") : "";
      liste.append(wahlZeile("radio", "modell", wahl.modell === m.id, () => { wahl.modell = m.id; schrittKi(); },
        [m.name, " · ", m.modell, ...tags], m.beschreibung + (tempo ? " " + tempo + "." : ""), groesse(m.bytes)));
    }
    liste.append(wahlZeile("radio", "modell", wahl.modell === null, () => { wahl.modell = null; schrittKi(); },
      ["Keine KI", ...(emp.modell === null ? [el("span", { class: "marke-tag tag-empf" }, "Empfohlen")] : [])], "Nur Bibliothek, Karten und Erste Hilfe. Spart Platz und Strom.", ""));
    c.append(liste);
    knoepfe(() => geheZu(0), () => geheZu(2));
  }

  function wahlZeile(typ, name, an, onWahl, titel, text, rechts, gesperrt) {
    const input = el("input", { type: typ, name, checked: an, disabled: gesperrt });
    const zeile = el("label", { class: "wahl" + (an ? " gewaehlt" : "") },
      input,
      el("div", { class: "w-text" }, el("div", { class: "w-titel" }, ...titel), text ? el("small", {}, text) : null),
      el("div", { class: "w-groesse" }, rechts || ""),
    );
    input.addEventListener("change", onWahl);
    return zeile;
  }

  // ------------------------------------------------ 3. Wissen

  function schrittWissen() {
    const c = $("#setup-inhalt");
    c.innerHTML = "";
    c.append(el("h1", {}, "Wissen auswählen"),
      el("p", {}, "Wähle, welche Offline-Bibliotheken auf das Gerät sollen. Mit „Englisch“ markierte Pakete kann die KI trotzdem auf Deutsch erklären."));
    const sets = wissenSets();
    c.append(vorauswahl("wissen", {
      aktuell: () => wahl.pakete, sets,
      bytes: id => paketBytes(id === "eigene" ? wahl.eigene.wissen : sets[id]),
      setze: id => { wahl.pakete = new Set(sets[id]); },
      kopie: () => new Set(wahl.pakete), zurueck: k => { wahl.pakete = new Set(k); },
    }, schrittWissen, "„Das Wichtigste“: " + (wichtigVorlage().text || "") + "."));
    if (!kat.katalogOnline) c.append(el("p", { class: "warnung" }, "Der Kiwix-Katalog ist gerade nicht erreichbar. Größen sind geschätzt."));

    // Jedes Paket unter seiner Hauptkategorie (der ersten), damit es nur einmal zur Wahl steht
    // Jede Kategorie klappt auf; zugeklappt steht darunter, was schon da und was ausgewählt ist
    const liste = el("div", { class: "klapp-liste-abschnitte", style: "margin-top:16px" });
    c.append(liste);
    for (const gr of kat.kategorien) {
      const pakete = kat.pakete.filter(p => (p.kategorien || [])[0] === gr.id);
      if (!pakete.length) continue;
      // Einträge: einzelne Pakete oder eine Variantengruppe (z. B. Wikipedia) als eine Zeile
      const eintraege = [];
      for (const p of pakete) {
        if (!p.gruppeExklusiv) eintraege.push({ titel: p.titel, pakete: [p] });
        else if (!eintraege.some(e => e.gruppe === p.gruppeExklusiv))
          eintraege.push({ gruppe: p.gruppeExklusiv, titel: (gruppen[p.gruppeExklusiv] || {}).titel || p.titel, pakete: pakete.filter(x => x.gruppeExklusiv === p.gruppeExklusiv) });
      }
      const gewaehlt = eintraege.filter(e => e.pakete.some(p => wahl.pakete.has(p.id)));
      // Zugeklappt kurz: alles, nichts oder die gewählten Namen
      const unter = !gewaehlt.length ? "Nichts ausgewählt" : gewaehlt.length === eintraege.length ? "Alles ausgewählt" : gewaehlt.map(e => {
        const g = e.pakete.filter(p => wahl.pakete.has(p.id));
        return e.titel + (e.gruppe ? " (" + g.map(p => p.variante).join(", ") + ")" : "");
      }).join(", ");
      const a = klappAbschnitt(aufgeklappt, gr.id, gr.icon, gr.titel, unter, gewaehlt.length + " von " + eintraege.length + " ausgewählt", true);
      liste.append(a.box);
      const c = a.innen;
      for (const e of eintraege) c.append(e.gruppe ? variantenWahl(e) : paketWahl(e.pakete[0]));
    }
    c.append(summenZeile());
    knoepfe(() => geheZu(1), () => geheZu(3));
  }

  function paketTags(p) {
    const tags = [];
    if (p.sprache === "en") tags.push(el("span", { class: "marke-tag tag-en" }, "Englisch"));
    if (p.installiert) tags.push(el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden"));
    if (p.update) tags.push(el("span", { class: "marke-tag tag-warn" }, "neue Version " + (p.datum || "").slice(0, 7)));
    if (!p.verfuegbar && kat.katalogOnline) tags.push(el("span", { class: "marke-tag tag-warn" }, "derzeit nicht im Katalog"));
    return tags;
  }

  function paketWahl(p) {
    return wahlZeile("checkbox", "p-" + p.id, wahl.pakete.has(p.id), (e) => {
      if (e.target.checked) wahl.pakete.add(p.id); else wahl.pakete.delete(p.id);
      schrittWissen();
    }, [p.titel, ...paketTags(p)], p.text, groesse(p.bytes), p.installiert && !p.update);
  }

  // Variantengruppe: eine Zeile mit Schalter. Ist eine Variante installiert, bleibt die Zeile gewählt;
  // eine andere Variante ersetzt die installierte nach dem Download.
  function variantenWahl(e) {
    const da = e.pakete.filter(p => p.installiert).sort((a, b) => b.bytes - a.bytes);
    const gew = e.pakete.filter(p => wahl.pakete.has(p.id)).sort((a, b) => (a.installiert ? 1 : 0) - (b.installiert ? 1 : 0) || b.bytes - a.bytes)[0];
    const p = gew || da[0] || e.pakete[0];
    const tags = paketTags(p).filter(t => !t.textContent.startsWith("✓"));
    if (p.installiert && gew) tags.push(el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden"));
    let hinweis = null;
    if (gew && !gew.installiert && da.length) hinweis = "Ersetzt „" + da.map(x => x.variante).join("“ und „") + "“, " + (da.length > 1 ? "die werden" : "die wird") + " nach dem Download gelöscht.";
    else if (da.length > 1) hinweis = ["Zusätzlich installiert: „" + da.slice(1).map(x => x.variante).join("“, „") + "“.", el("br"), "Die brauchst du nicht, löschen kannst du sie unter „Inhalte“."];
    return variantenZeile({ titel: e.titel, varianten: e.pakete, gewaehlt: gew ? gew.id : null, installiert: da.length ? da[0].id : null,
      standard: (gruppen[e.gruppe] || {}).standard, tags, gesperrt: da.length > 0, hinweis,
      onWahl: (id) => {
        e.pakete.forEach(x => wahl.pakete.delete(x.id));
        if (id) wahl.pakete.add(id);
        else da.forEach(x => wahl.pakete.add(x.id));
        // Zurück auf die installierte: auch weitere installierte Varianten bleiben
        if (id && da.some(x => x.id === id)) da.forEach(x => wahl.pakete.add(x.id));
        schrittWissen();
      } });
  }

  // ------------------------------------------------ 5. Sprachen

  function schrittSprachen() {
    const c = $("#setup-inhalt");
    const s = OW.status || {};
    c.innerHTML = "";
    c.append(el("h1", {}, "Sprachen auswählen"),
      el("p", {}, "Der Übersetzer hilft bei Gesprächen mit Menschen, die eine andere Sprache sprechen, und übersetzt englische Artikel aus der Bibliothek ins Deutsche. Alles läuft offline, die Technik stammt von Mozilla (wie in Firefox)."));

    // Artikel übersetzen (Englisch → Deutsch)
    const ueDa = !!(s.uebersetzer && !s.uebersetzerAlt);
    c.append(wahlZeile("checkbox", "uebersetzer", ueDa || wahl.uebersetzer, (e) => { wahl.uebersetzer = e.target.checked; schrittSprachen(); },
      ["Artikel übersetzen (Englisch → Deutsch)", ...(ueDa ? [el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden")] : [el("span", { class: "marke-tag tag-empf" }, "Empfohlen")])],
      "Englische Artikel in der Bibliothek beim Lesen ins Deutsche übersetzen.", groesse(42e6), ueDa));

    // Sprachen für Gespräche: je Sprache „Nur Text“ oder „Text + Sprache“ (mit Stimme zum Vorlesen)
    c.append(el("h2", {}, "Sprachen für Gespräche"),
      el("p", { class: "hinweis" }, "Jede Sprache übersetzt in beide Richtungen. Übersetzt wird über Englisch, deshalb kommen Englisch und „Artikel übersetzen“ automatisch mit. Mit „Text + Sprache“ liest Fieldbook die Übersetzungen auch vor."));
    const sets = sprachSets();
    c.append(vorauswahl("sprachen", {
      aktuell: () => sprachSchluessel(wahl.sprachen, wahl.stimmen), sets,
      bytes: id => { const x = ausSchluessel(id === "eigene" ? wahl.eigene.sprachen : sets[id]); return sprachPaketBytes(x.spr, x.stm); },
      setze: id => { const x = ausSchluessel(sets[id]); wahl.sprachen = x.spr; wahl.stimmen = x.stm; },
      kopie: () => sprachSchluessel(wahl.sprachen, wahl.stimmen),
      zurueck: k => { const x = ausSchluessel(k); wahl.sprachen = x.spr; wahl.stimmen = x.stm; },
    }, schrittSprachen, "„Alles“ lädt jede Sprache mit Stimme zum Vorlesen."));
    const da = new Set(s.sprachen || []), stimmenDa = new Set(s.stimmen || []);
    const knopf = (an, text, bytes, fn) => el("button", { class: "knopf knopf-klein" + (an ? " knopf-haupt" : ""), type: "button", "aria-pressed": String(an), onclick: fn }, text + " · " + groesse(bytes));
    const zeigeAlle = alleSprachen || sprachen.length <= 23;
    let versteckt = 0;
    sprachen.forEach((sp, i) => {
      const code = sp.code;
      const titel = sp.name === sp.eigen ? sp.name : sp.name + " · " + sp.eigen;
      const stimme = stimmeBytes(code);
      if (da.has(code)) {
        c.append(el("div", { class: "wahl installiert" }, el("span", { class: "w-haken", "aria-hidden": "true" }, "✓"),
          el("div", { class: "w-text" }, el("div", { class: "w-titel" }, titel, el("span", { class: "marke-tag tag-ok" }, stimmenDa.has(code) ? "vorhanden · Text + Sprache" : "vorhanden · Text")))));
        return;
      }
      if (!zeigeAlle && i >= 21 && !wahl.sprachen.has(code)) { versteckt++; return; }
      const w = !wahl.sprachen.has(code) ? null : wahl.stimmen.has(code) ? "sprache" : "text";
      const setze = (neu) => {
        if (w === neu) { wahl.sprachen.delete(code); wahl.stimmen.delete(code); }
        else { wahl.sprachen.add(code); if (neu === "sprache") wahl.stimmen.add(code); else wahl.stimmen.delete(code); }
        schrittSprachen();
      };
      c.append(el("div", { class: "wahl" + (w ? " gewaehlt" : ""), style: "align-items:center;cursor:default" },
        el("span", { class: "w-haken", "aria-hidden": "true" }),
        el("div", { class: "w-text" }, el("div", { class: "w-titel" }, titel), stimme ? null : el("small", {}, "Keine Stimme zum Vorlesen")),
        el("div", { class: "knopfreihe", style: "margin:0;flex-wrap:nowrap" },
          knopf(w === "text", "Nur Text", sp.mb * 1048576, () => setze("text")),
          stimme ? knopf(w === "sprache", "Text + Sprache", sp.mb * 1048576 + stimme, () => setze("sprache")) : null)));
    });
    if (versteckt) c.append(el("button", { class: "knopf knopf-klein", onclick: () => { alleSprachen = true; schrittSprachen(); } }, "Alle " + sprachen.length + " Sprachen zeigen"));

    // Spracheingabe
    const sprechDa = !!(s.spracheingabe && s.spracheingabeKomplett);
    c.append(el("h2", {}, "Spracheingabe"),
      wahlZeile("checkbox", "spracheingabe", sprechDa || wahl.spracheingabe, (e) => { wahl.spracheingabe = e.target.checked; schrittSprachen(); },
        ["Spracheingabe", ...(sprechDa ? [el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden")] : [])],
        "Im Übersetzer sprechen statt tippen, für alle Sprachen. Erkennt europäische Sprachen schnell und gut (Parakeet von NVIDIA), alle anderen mit Whisper von OpenAI.",
        groesse(s.spracheingabe ? Inhalte.SPRECHEN_ZUSATZ : Inhalte.SPRECHEN_BYTES), sprechDa));
    c.append(summenZeile());
    knoepfe(() => geheZu(3), () => geheZu(UEBERSICHT), "Weiter zur Übersicht →");
  }

  const stimmeBytes = (code) => { const v = stimmen.find(x => x.code === code); return v ? v.bytes : 0; };

  // Neue Sprachen (Englisch kommt mit, falls es fehlt) und ihre Größe samt Stimmen
  function sprachenNeu(spr) {
    const da = new Set((OW.status || {}).sprachen || []);
    const neu = [...(spr || wahl.sprachen)].filter(c => !da.has(c));
    if (neu.length && !da.has("en") && !neu.includes("en")) neu.push("en");
    return neu;
  }
  // Größe der Sprachen samt Stimmen (ohne „Artikel übersetzen“ und Spracheingabe)
  function sprachPaketBytes(spr, stm) {
    let b = 0;
    for (const c of sprachenNeu(spr)) { const sp = sprachen.find(x => x.code === c); if (sp) b += sp.mb * 1048576; }
    // Stimmen: Deutsch und das Vorleseprogramm (22 MB) kommen mit, falls sie fehlen
    const stDa = new Set((OW.status || {}).stimmen || []);
    const fehlen = [...stm].filter(c => stimmeBytes(c) && !stDa.has(c));
    if (fehlen.length) {
      if (!stDa.has("de") && !fehlen.includes("de")) fehlen.push("de");
      b += fehlen.reduce((x, c) => x + stimmeBytes(c), stDa.size ? 0 : 22477236);
    }
    return b;
  }
  function sprachenBytes() {
    const s = OW.status || {};
    let b = sprachPaketBytes(wahl.sprachen, wahl.stimmen);
    if (wahl.spracheingabe && !(s.spracheingabe && s.spracheingabeKomplett)) b += s.spracheingabe ? Inhalte.SPRECHEN_ZUSATZ : Inhalte.SPRECHEN_BYTES;
    // Die Sprachen brauchen „Artikel übersetzen“
    if (!wahl.uebersetzer && sprachenNeu().length && !(s.uebersetzer && !s.uebersetzerAlt)) b += 42e6;
    return b;
  }

  function neueBytes() {
    let b = 0;
    const m = kat.modelle.find(x => x.id === wahl.modell);
    if (m && !m.installiert) b += m.bytes;
    // Die Suchhilfe kommt mit der KI mit
    if (m && kat.suchhilfe && !kat.suchhilfe.installiert) b += kat.suchhilfe.bytes;
    for (const p of kat.pakete) if (wahl.pakete.has(p.id) && (!p.installiert || p.update)) b += p.bytes || 0;
    for (const [id, k] of wahl.karten) { const r = kat.karten.find(x => x.id === id); if (r && !r.installiert) b += k.bytes > 0 ? k.bytes : kartenSchaetzung(r, wahl.sparen); }
    if (wahl.routen && wahl.routenGroesse && wahl.routenGroesse.bytes > 0) b += wahl.routenGroesse.bytes + (OW.status && OW.status.routen ? 0 : 56e6);
    if (wahl.uebersetzer && !(OW.status && OW.status.uebersetzer)) b += 42e6;
    return b + sprachenBytes();
  }

  function summenZeile() {
    const b = neueBytes();
    const frei = hw.freiGB * 1e9;
    const passt = b < frei - 2e9;
    return el("div", { class: "summe" }, "Neu herunterzuladen: " + (b > 0 ? groesse(b) : "nichts") + " · Frei: " + groesse(frei) + " ",
      passt ? el("span", { class: "ok-text" }, "✓ passt") : el("span", { style: "color:var(--rot)" }, "✗ zu wenig Platz"));
  }

  // ------------------------------------------------ 4. Karten

  function schrittKarten() {
    const c = $("#setup-inhalt");
    c.innerHTML = "";
    c.append(el("h1", {}, "Karten auswählen"),
      el("p", {}, "Offline-Karten von OpenStreetMap mit Ortssuche. Du kannst mehrere Regionen wählen, zum Beispiel für eine Reise."));
    // Routenplanung ganz oben, für alle gewählten bzw. vorhandenen Kartenregionen
    const rg = wahl.routenGroesse;
    const routenText = !wahl.karten.size ? "Erst eine Karte auswählen." :
      rg == null ? "Größe wird berechnet …" :
      rg.bytes > 0 ? "Wegedaten ca. " + groesse(rg.bytes + (OW.status && OW.status.routen ? 0 : 56e6)) + " (inkl. Java-Laufzeit)" :
      "Wegedaten schon vorhanden.";
    c.append(wahlZeile("checkbox", "routen", wahl.routen && wahl.karten.size > 0, (e) => { wahl.routen = e.target.checked; schrittKarten(); },
      ["Routenplanung"], "Routen zu Fuß, mit dem Rad und mit dem Auto, offline auf der Karte. " + routenText, "", !wahl.karten.size),
      el("h2", {}, "Regionen"),
      el("p", {}, el("label", { class: "schalter" },
        el("input", { type: "checkbox", checked: wahl.sparen, onchange: (e) => { wahl.sparen = e.target.checked; for (const k of wahl.karten.values()) k.bytes = null; schrittKarten(); } }),
        el("span", {}, "Platz sparen (weniger Details beim starken Hineinzoomen)"))));
    const sets = kartenSets();
    const alsMap = ids => new Map([...ids].map(id => {
      const r = kat.karten.find(x => x.id === id), alt = wahl.karten.get(id);
      return [id, r && r.installiert ? { bytes: r.bytesInstalliert } : { bytes: alt ? alt.bytes : null }];
    }));
    c.append(vorauswahl("karten", {
      aktuell: () => new Set(wahl.karten.keys()), sets,
      bytes: id => kartenBytes(id === "eigene" ? wahl.eigene.karten : sets[id]),
      setze: id => { wahl.karten = alsMap(sets[id]); },
      kopie: () => new Set(wahl.karten.keys()), zurueck: k => { wahl.karten = alsMap(k); },
    }, schrittKarten, "„Alles“ ist die Karte von ganz Europa und die grobe Weltkarte."));
    for (const r of kat.karten) {
      const an = wahl.karten.has(r.id);
      const info = wahl.karten.get(r.id);
      const tags = r.installiert ? [el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden")] : [];
      const g = r.installiert ? groesse(r.bytesInstalliert) : (info && info.bytes > 0 ? "ca. " + groesse(info.bytes) : kartenSchaetzung(r, wahl.sparen) ? "ca. " + groesse(kartenSchaetzung(r, wahl.sparen)) : an ? "wird berechnet …" : "");
      c.append(wahlZeile("checkbox", "k-" + r.id, an, (e) => {
        if (e.target.checked) { wahl.karten.set(r.id, { bytes: null }); } else wahl.karten.delete(r.id);
        schrittKarten();
      }, [r.titel, ...tags], null, g, r.installiert));
    }
    c.append(summenZeile());
    knoepfe(() => geheZu(2), () => geheZu(4));
    berechneKartengroessen();
    berechneRoutengroesse();
  }

  let routenAnfrage = "";
  async function berechneRoutengroesse() {
    const ids = [...wahl.karten.keys()].join(",");
    if (!ids || ids === routenAnfrage) return;
    routenAnfrage = ids;
    wahl.routenGroesse = null;
    const r = await api("routengroesse?ids=" + encodeURIComponent(ids)).catch(() => null);
    if (routenAnfrage !== ids) return;
    wahl.routenGroesse = r || { bytes: 0 };
    if (schritt === 3 && kat && location.hash.startsWith("#setup")) schrittKarten();
  }

  function maxzoom(r) { return r.maxzoom || (wahl.sparen ? 13 : 15); }

  let rechnet = false;
  async function berechneKartengroessen() {
    if (rechnet) return;
    rechnet = true;
    try {
      for (const [id, k] of wahl.karten) {
        const r = kat.karten.find(x => x.id === id);
        if (!r || r.installiert || k.bytes) continue;
        const erg = await api("kartengroesse?id=" + encodeURIComponent(id) + "&maxzoom=" + maxzoom(r)).catch(e => ({ fehler: e.message }));
        // Nach „Einrichtung abschließen“ ist der Katalog weg (kat = null): nichts mehr zeichnen
        if (!kat) return;
        if (!wahl.karten.has(id)) continue;
        k.bytes = erg.bytes > 0 ? erg.bytes : -1;
        if (erg.fehler) k.fehler = erg.fehler;
        if (schritt === 3 && location.hash.startsWith("#setup")) schrittKarten();
      }
    } finally { rechnet = false; }
  }

  // ------------------------------------------------ 5. Übersicht und Abschluss

  function zeigeUebersicht() {
    const c = $("#setup-inhalt");
    c.innerHTML = "";
    c.append(el("h1", {}, "Übersicht"));
    // Tabelle: links das Thema (Link zum Schritt), rechts die Auswahl; Wissen und Karten als Liste, eine Zeile je Eintrag
    const tabelle = el("table", { class: "hw-tabelle uebersicht" });
    const zeile = (titel, schrittNr, ...inhalt) => tabelle.append(el("tr", {},
      el("td", {}, schrittNr == null ? titel : el("a", { href: "#setup?schritt=" + schrittNr }, titel)), el("td", {}, ...inhalt)));
    const vorhanden = () => el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden");
    // Je Bereich höchstens zwei Zeilen: was schon da ist und was neu dazukommt
    const daNeu = (da, neu) => [
      da ? el("div", {}, el("span", { class: "hinweis" }, "Schon da: "), da) : null,
      el("div", {}, el("span", { class: "hinweis" }, "Neu: "), neu || "nichts")];
    const liste = (namen, max) => namen.length <= max ? namen.join(", ") : namen.length + " Stück";
    const st = OW.status || {};
    const m = kat.modelle.find(x => x.id === wahl.modell);
    zeile("KI-Assistent", 1, m ? m.name + " · " + m.modell : "keine",
      m ? el("div", { class: "hinweis klein" }, (wahl.backend === "vulkan" ? "mit Grafikkarte" : "auf dem Prozessor") + (m.installiert ? "" : " · " + groesse(m.bytes))) : null,
      m && m.installiert ? vorhanden() : null);
    // Wissen: Zahl der Pakete, die Liste zum Aufklappen (nach Hauptkategorie gruppiert, wie im Schritt „Wissen“)
    const pk = kat.pakete.filter(p => wahl.pakete.has(p.id));
    const pkDa = pk.filter(p => p.installiert && !p.update), pkNeu = pk.filter(p => !p.installiert || p.update);
    const wissen = el("div", {}, ...daNeu(pkDa.length ? pkDa.length + (pkDa.length === 1 ? " Paket" : " Pakete") : null,
      pkNeu.length ? (pkNeu.length <= 3 ? pkNeu.map(p => p.titel).join(", ") : pkNeu.length + " Pakete") + " (" + groesse(paketBytes(new Set(pkNeu.map(p => p.id)))) + ")" : null));
    if (pk.length) {
      const alle = el("details", { class: "fb-details", style: "margin-top:6px" }, el("summary", {}, "Alle Pakete zeigen"));
      for (const gr of kat.kategorien) {
        const inGr = pk.filter(p => (p.kategorien || [])[0] === gr.id);
        if (!inGr.length) continue;
        alle.append(el("div", { class: "uebersicht-gruppe" }, gr.titel),
          el("ul", { class: "uebersicht-liste" }, ...inGr.map(p => el("li", {}, p.titel, " ",
            p.installiert && !p.update ? vorhanden() : el("span", { class: "hinweis klein" }, groesse(p.bytes))))));
      }
      const ohneGr = pk.filter(p => !kat.kategorien.some(g => g.id === (p.kategorien || [])[0]));
      if (ohneGr.length) alle.append(el("ul", { class: "uebersicht-liste" }, ...ohneGr.map(p => el("li", {}, p.titel))));
      wissen.append(alle);
    }
    zeile("Wissen", 2, wissen);
    // Karten samt Routenplanung
    const kk = kat.karten.filter(r => wahl.karten.has(r.id));
    const kDa = kk.filter(r => r.installiert).map(r => r.titel), kNeu = kk.filter(r => !r.installiert).map(r => r.titel);
    const routen = wahl.routen && kk.length;
    const kNeuTeile = [];
    if (kNeu.length) kNeuTeile.push(liste(kNeu, 4) + " (" + groesse(kartenBytes(new Set(kk.filter(r => !r.installiert).map(r => r.id)))) + ")");
    if (routen && !st.routen) kNeuTeile.push("Routenplanung");
    zeile("Karten", 3, ...daNeu(kDa.length ? liste(kDa, 4) + (st.routen ? " · Routenplanung" : "") : null, kNeuTeile.join(" · ") || null));
    // Sprachen samt „Artikel übersetzen“ und Spracheingabe
    const spName = c => { const sp = sprachen.find(x => x.code === c); return sp ? sp.name : c; };
    const spDa = (st.sprachen || []).map(spName);
    if (st.uebersetzer && !st.uebersetzerAlt) spDa.unshift("Artikel übersetzen");
    if (st.spracheingabe && st.spracheingabeKomplett) spDa.push("Spracheingabe");
    const spNeu = [...wahl.sprachen].filter(c => !(st.sprachen || []).includes(c)).map(c => spName(c) + (wahl.stimmen.has(c) ? " (Text + Sprache)" : ""));
    if ((wahl.uebersetzer || spNeu.length) && !(st.uebersetzer && !st.uebersetzerAlt)) spNeu.unshift("Artikel übersetzen");
    if (wahl.spracheingabe && !(st.spracheingabe && st.spracheingabeKomplett)) spNeu.push("Spracheingabe");
    zeile("Sprachen", 4, ...daNeu(spDa.length ? liste(spDa, 5) : null, spNeu.length ? liste(spNeu, 5) + (sprachenBytes() ? " (" + groesse(sprachenBytes()) + ")" : "") : null));
    zeile("Einstellungen", 0, "Desktop-Symbol " + (wahl.desktop ? "an" : "aus"), el("br"),
      "Automatische Aktualisierung " + (akt.an ? "an" : "aus"));
    c.append(el("div", { class: "karte-box" }, tabelle), summenZeile());
    if (downloadAktiv) {
      c.append(el("p", { class: "warnung" }, "Gerade laufen noch Downloads. Bitte warte, bis sie fertig sind, oder brich sie unter ",
        el("a", { href: "#inhalte" }, "Inhalte"), " ab. Danach kannst du die Einrichtung abschließen."));
      knoepfe(() => geheZu(UEBERSICHT - 1), () => { location.hash = "#inhalte"; }, "Zu den Downloads →");
      return;
    }
    // Bitte um Zustimmung zur Nutzungsstatistik (Standard aus)
    if (OW.status && OW.status.statistikEingerichtet) {
      if (!wahl.statistik) wahl.statistik = { fehler: !!OW.status.statistikFehler, nutzung: !!OW.status.statistikNutzung };
      c.append(el("h2", {}, "Eine Bitte"), el("div", { class: "karte-box" }, statistikBitte(wahl.statistik)));
    }
    c.append(el("p", { class: "hinweis" }, "Nach dem Abschließen startet der Download.", el("br"), "Den Fortschritt siehst du unter „Inhalte“.", el("br"), "Fieldbook kannst du währenddessen schon benutzen: Fertige Pakete stehen sofort zur Verfügung."));
    knoepfe(() => geheZu(UEBERSICHT - 1), abschliessen, "✓ Einrichtung abschließen und herunterladen");
  }

  let abschliesst = false;
  async function abschliessen(ev) {
    // Doppelklick-Sperre
    if (abschliesst) return;
    abschliesst = true;
    const k = ev && ev.currentTarget;
    if (k) k.disabled = true;
    try { await abschliessenStarten(); }
    catch (err) { await zeigeFehler("Die Einrichtung konnte nicht gestartet werden.", err); }
    finally { abschliesst = false; if (k && k.isConnected) k.disabled = false; }
  }

  async function abschliessenStarten() {
    const karten = [];
    for (const [id, k] of wahl.karten) {
      const r = kat.karten.find(x => x.id === id);
      if (r && !r.installiert) karten.push({ id, maxzoom: String(maxzoom(r)), bytes: k.bytes > 0 ? k.bytes : 0 });
    }
    const pakete = kat.pakete.filter(p => wahl.pakete.has(p.id) && (!p.installiert || p.update)).map(p => p.id);
    const routen = wahl.routen ? [...wahl.karten.keys()] : [];
    const r = await api("installieren", { modell: wahl.modell || "", backend: wahl.backend, pakete, karten, routen, uebersetzer: !!wahl.uebersetzer,
      sprachen: [...wahl.sprachen], stimmen: [...wahl.stimmen], spracheingabe: !!wahl.spracheingabe, abschliessen: true });
    if (r.fehler) { await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
    if (wahl.statistik) await api("statistik/einstellen", wahl.statistik).catch(() => { });
    // Desktop-Symbol anlegen oder entfernen (nebenbei, blockiert den Download nicht)
    if (wahl.desktop !== !!(OW.status && OW.status.desktopSymbol)) api("desktopsymbol", { an: !!wahl.desktop }).catch(() => { });
    hw = null; kat = null; // beim nächsten Öffnen neu laden
    await aktualisiereStatus();
    location.hash = "#inhalte";
  }

  return { zeigen, empfehlung, besteGpu, passung, stufe };
})();
