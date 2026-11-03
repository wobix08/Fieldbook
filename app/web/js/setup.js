// Einrichtungs-Assistent: Gerät prüfen, KI wählen, Wissen, Karten und Sprachen wählen, abschließen.
// Die Downloads selbst laufen danach auf der Seite "Inhalte" (inhalte.js).
"use strict";

const Setup = (() => {
  const SCHRITTE = ["Dein Gerät", "KI-Assistent", "Wissen", "Karten", "Sprachen", "Übersicht"];
  const UEBERSICHT = SCHRITTE.length - 1;
  let sprachen = [], stimmen = [], alleSprachen = false;
  const STUFEN = [
    { name: "Sehr schwaches Gerät", text: "Nur eine winzige KI ist möglich." },
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
      sprachen: new Set(), stimmen: new Set(), spracheingabe: false };
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
    let passend = modelle.filter(m => passung(m, h, backend) === (backend === "vulkan" ? "gpu" : "cpu"));
    if (!passend.length) passend = modelle.filter(m => passung(m, h, "cpu") === "cpu");
    passend.sort((a, b) => b.bytes - a.bytes);
    return { modell: passend[0] ? passend[0].id : modelle[0].id, backend };
  }

  // ------------------------------------------------ Gerüst

  async function zeigen(params) {
    const start = parseInt(params && params.get("schritt"), 10);
    const neu = params && params.get("neu");
    if (!hw || !kat || neu) {
      if (neu) wahl = neueWahl(); // "Einrichtung neu starten": mit dem aktuellen Stand vorbelegen
      $("#setup-inhalt").innerHTML = '<p class="hinweis">Gerät wird geprüft …</p>';
      $("#setup-knoepfe").innerHTML = "";
      zeichneSchritte();
      try {
        let sk, st;
        [hw, kat, akt, sk, st] = await Promise.all([api("hardware"), api("katalog"), api("aktualisierung"),
          ladeKonfig("sprachen").catch(() => ({})), ladeKonfig("stimmen").catch(() => ({}))]);
        sprachen = sk.sprachen || [];
        stimmen = st.stimmen || [];
      } catch (e) {
        $("#setup-inhalt").innerHTML = '<div class="fehlerbox">Fehler: ' + esc(e.message) + "</div>";
        return;
      }
      vorbelegen();
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
      const vorlage = kat.vorlagen.find(v => v.id === (stufe(hw) <= 1 && hw.freiGB < 60 ? "reise" : "zuhause"));
      (inst.length ? inst : vorlage.pakete).forEach(id => wahl.pakete.add(id));
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
  }

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
      el("p", {}, "Der Assistent richtet alles in wenigen Schritten ein. Dafür wird einmal Internet gebraucht. Danach funktioniert alles offline."),
      el("div", { class: "karte-box" },
        el("h2", { style: "margin-top:0" }, "Dein Gerät"),
        el("table", { class: "hw-tabelle" },
          el("tr", {}, el("td", {}, "Prozessor"), el("td", {}, hw.cpu + " (" + hw.kerne + " Kerne)")),
          el("tr", {}, el("td", {}, "Arbeitsspeicher"), el("td", {}, Math.round(hw.ramGB) + " GB")),
          el("tr", {}, el("td", {}, "Grafikkarte"), el("td", {}, gpuText)),
          el("tr", {}, el("td", {}, "Freier Speicherplatz"), el("td", {}, Math.round(hw.freiGB) + " GB auf " + (hw.laufwerk || "dem Laufwerk"))),
        ),
        el("div", { class: "stufe" },
          el("span", { class: "stufe-punkte" }, "●".repeat(st) + "○".repeat(4 - st)),
          el("div", {}, el("b", {}, STUFEN[st].name), el("br"), STUFEN[st].text + (g && g.vramGB >= 4 ? " Die Grafikkarte wird für die KI genutzt." : "")),
        ),
      ),
    );
    // Land: bestimmt Notrufnummern und die vorgeschlagene Karte
    const land = Land.aktuell();
    const auswahl = landAuswahl(land, async (neu) => {
      OW.status = await api("einstellungen", { land: neu.code, sprache: neu.sprache });
      // Vorgeschlagene Karte anpassen, solange noch keine Karte installiert ist
      if (!kat.karten.some(r => r.installiert) && neu.karte) { wahl.karten.clear(); wahl.karten.set(neu.karte, { bytes: null }); }
    });
    c.append(el("div", { class: "karte-box", style: "margin-top:16px" },
      el("div", { class: "einst-zeile", style: "border:0;padding:0" },
        el("div", {}, el("b", {}, "Land"), el("small", {}, "Für Notrufnummern und die vorgeschlagene Karte." + (OW.status && OW.status.landErkannt ? " Aus Windows erkannt: " + OW.status.landErkannt + "." : ""))),
        auswahl)));
    c.append(el("div", { class: "karte-box", style: "margin-top:16px" },
      el("label", { class: "schalter" },
        el("input", { type: "checkbox", checked: wahl.desktop, onchange: (e) => { wahl.desktop = e.target.checked; } }),
        el("b", {}, "Symbol auf dem Desktop anlegen")),
      el("p", { class: "hinweis klein", style: "margin:6px 0 0" }, "Damit startest du Fieldbook bequem vom Desktop aus. Wird der Ordner verschoben, passt Fieldbook das Symbol beim nächsten Start an.")));
    c.append(aktualisierungBox(akt, false));
    if (land && !(OW.status && OW.status.land)) api("einstellungen", { land: land.code, sprache: land.sprache }).then(s => { OW.status = s; });
    if (!kat.katalogOnline) c.append(el("p", { class: "warnung" }, "Keine Internetverbindung erkannt. Zum Herunterladen wird Internet gebraucht. Bereits geladene Inhalte funktionieren trotzdem."));
    knoepfe(null, () => geheZu(1));
  }

  // ------------------------------------------------ 2. KI

  function schrittKi() {
    const c = $("#setup-inhalt");
    const g = besteGpu(hw);
    const emp = empfehlung(hw, kat.modelle);
    c.innerHTML = "";
    c.append(el("h1", {}, "KI-Assistent wählen"),
      el("p", {}, "Die KI beantwortet Fragen anhand der Offline-Bibliothek. Größere Modelle antworten besser, brauchen aber mehr Speicher und Strom."));
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
      if (p === "zu-gross") tags.push(el("span", { class: "marke-tag tag-warn" }, "zu groß für dein Gerät"));
      if (p === "langsam") tags.push(el("span", { class: "marke-tag tag-warn" }, "ohne Grafikkarte sehr langsam"));
      const tempo = p === "gpu" ? "Schnell (Grafikkarte)" : p === "cpu" ? (m.bytes < 2e9 ? "Antwortet in ca. 10–30 Sekunden" : m.bytes < 4e9 ? "Antwortet in ca. 20–60 Sekunden" : "Antwortet in ca. 1–2 Minuten") : "";
      liste.append(wahlZeile("radio", "modell", wahl.modell === m.id, () => { wahl.modell = m.id; schrittKi(); },
        [m.name, " · ", m.modell, ...tags], m.beschreibung + (tempo ? " " + tempo + "." : ""), groesse(m.bytes)));
    }
    liste.append(wahlZeile("radio", "modell", wahl.modell === null, () => { wahl.modell = null; schrittKi(); },
      ["Keine KI"], "Nur Bibliothek, Karten und Erste Hilfe. Spart Platz und Strom.", ""));
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
    // Nur „Alles“ und „Nichts“ (Vorlage „alles“ wählt je Variantengruppe die größte); Installiertes bleibt immer gewählt
    const installiert = () => kat.pakete.filter(p => p.installiert).map(p => p.id);
    const alles = kat.vorlagen.find(v => v.id === "alles");
    c.append(el("div", { class: "vorlagen" }, el("span", { class: "hinweis", style: "align-self:center" }, "Schnellwahl:"),
      alles ? el("button", { class: "knopf knopf-klein", onclick: () => { wahl.pakete = new Set(alles.pakete.concat(installiert())); schrittWissen(); } }, "Alles") : null,
      el("button", { class: "knopf knopf-klein", onclick: () => { wahl.pakete = new Set(installiert()); schrittWissen(); } }, "Nichts")));
    if (!kat.katalogOnline) c.append(el("p", { class: "warnung" }, "Der Kiwix-Katalog ist gerade nicht erreichbar. Größen sind geschätzt."));

    // Jedes Paket unter seiner Hauptkategorie (der ersten), damit es nur einmal zur Wahl steht
    // Jede Kategorie klappt auf; zugeklappt steht darunter, was schon da und was ausgewählt ist
    const liste = el("div", { class: "klapp-liste-abschnitte", style: "margin-top:16px" });
    c.append(liste);
    for (const gr of kat.kategorien) {
      const pakete = kat.pakete.filter(p => (p.kategorien || [])[0] === gr.id);
      if (!pakete.length) continue;
      const gewaehlt = pakete.filter(p => wahl.pakete.has(p.id));
      const unter = gewaehlt.length ? gewaehlt.map(p => p.titel + (p.installiert ? " (vorhanden)" : "")).join(", ") : "Nichts ausgewählt";
      const a = klappAbschnitt(aufgeklappt, gr.id, gr.icon, gr.titel, unter, gewaehlt.length + " von " + pakete.length + " ausgewählt");
      liste.append(a.box);
      const c = a.innen;
      for (const p of pakete) {
        const an = wahl.pakete.has(p.id);
        const tags = [];
        if (p.sprache === "en") tags.push(el("span", { class: "marke-tag tag-en" }, "Englisch"));
        if (p.installiert) tags.push(el("span", { class: "marke-tag tag-ok" }, "✓ vorhanden"));
        if (p.update) tags.push(el("span", { class: "marke-tag tag-warn" }, "neue Version " + (p.datum || "").slice(0, 7)));
        if (!p.verfuegbar && kat.katalogOnline) tags.push(el("span", { class: "marke-tag tag-warn" }, "derzeit nicht im Katalog"));
        c.append(wahlZeile(p.gruppeExklusiv ? "checkbox" : "checkbox", "p-" + p.id, an, (e) => {
          if (e.target.checked) {
            if (p.gruppeExklusiv) kat.pakete.filter(x => x.gruppeExklusiv === p.gruppeExklusiv && !x.installiert).forEach(x => wahl.pakete.delete(x.id));
            wahl.pakete.add(p.id);
          } else wahl.pakete.delete(p.id);
          schrittWissen();
        }, [p.titel, ...tags], p.text, groesse(p.bytes), p.installiert && !p.update));
      }
    }
    c.append(summenZeile());
    knoepfe(() => geheZu(1), () => geheZu(3));
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
  function sprachenNeu() {
    const da = new Set((OW.status || {}).sprachen || []);
    const neu = [...wahl.sprachen].filter(c => !da.has(c));
    if (neu.length && !da.has("en") && !neu.includes("en")) neu.push("en");
    return neu;
  }
  function sprachenBytes() {
    const s = OW.status || {};
    let b = 0;
    for (const c of sprachenNeu()) { const sp = sprachen.find(x => x.code === c); if (sp) b += sp.mb * 1048576; }
    // Stimmen: Deutsch und das Vorleseprogramm (22 MB) kommen mit, falls sie fehlen
    const stDa = new Set(s.stimmen || []);
    const fehlen = [...wahl.stimmen].filter(c => stimmeBytes(c) && !stDa.has(c));
    if (fehlen.length) {
      if (!stDa.has("de") && !fehlen.includes("de")) fehlen.push("de");
      b += fehlen.reduce((x, c) => x + stimmeBytes(c), stDa.size ? 0 : 22477236);
    }
    if (wahl.spracheingabe && !(s.spracheingabe && s.spracheingabeKomplett)) b += s.spracheingabe ? Inhalte.SPRECHEN_ZUSATZ : Inhalte.SPRECHEN_BYTES;
    // Die Sprachen brauchen „Artikel übersetzen“
    if (!wahl.uebersetzer && sprachenNeu().length && !(s.uebersetzer && !s.uebersetzerAlt)) b += 42e6;
    return b;
  }

  function neueBytes() {
    let b = 0;
    const m = kat.modelle.find(x => x.id === wahl.modell);
    if (m && !m.installiert) b += m.bytes;
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
    if (schritt === 3) schrittKarten();
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
        if (!wahl.karten.has(id)) continue;
        k.bytes = erg.bytes > 0 ? erg.bytes : -1;
        if (erg.fehler) k.fehler = erg.fehler;
        if (schritt === 3) schrittKarten();
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
    const m = kat.modelle.find(x => x.id === wahl.modell);
    zeile("KI-Assistent", 1, m ? m.name + " · " + m.modell : "keine",
      m ? el("div", { class: "hinweis klein" }, (wahl.backend === "vulkan" ? "mit Grafikkarte" : "auf dem Prozessor") + (m.installiert ? "" : " · " + groesse(m.bytes))) : null,
      m && m.installiert ? vorhanden() : null);
    const pk = kat.pakete.filter(p => wahl.pakete.has(p.id));
    const wissen = el("div");
    if (!pk.length) wissen.append("keine");
    // Nach Hauptkategorie gruppiert, wie im Schritt „Wissen“
    for (const gr of kat.kategorien) {
      const inGr = pk.filter(p => (p.kategorien || [])[0] === gr.id);
      if (!inGr.length) continue;
      wissen.append(el("div", { class: "uebersicht-gruppe" }, gr.titel),
        el("ul", { class: "uebersicht-liste" }, ...inGr.map(p => el("li", {}, p.titel, " ",
          p.installiert && !p.update ? vorhanden() : el("span", { class: "hinweis klein" }, groesse(p.bytes))))));
    }
    const ohneGr = pk.filter(p => !kat.kategorien.some(g => g.id === (p.kategorien || [])[0]));
    if (ohneGr.length) wissen.append(el("ul", { class: "uebersicht-liste" }, ...ohneGr.map(p => el("li", {}, p.titel))));
    zeile("Wissen (" + pk.length + " Pakete)", 2, wissen);
    const kk = kat.karten.filter(r => wahl.karten.has(r.id));
    zeile("Karten", 3, kk.length ? el("ul", { class: "uebersicht-liste" }, ...kk.map(r => el("li", {}, r.titel, " ", r.installiert ? vorhanden() : null))) : "keine");
    zeile("Routenplanung", 3, wahl.routen && kk.length ? "ja" : "nein");
    zeile("Artikel übersetzen", 4, OW.status && OW.status.uebersetzer ? vorhanden() : wahl.uebersetzer || sprachenNeu().length ? "ja" : "nein");
    const spNamen = [...wahl.sprachen].map(c => { const sp = sprachen.find(x => x.code === c); return sp ? sp.name + (wahl.stimmen.has(c) ? " (Text + Sprache)" : "") : c; });
    zeile("Sprachen", 4, spNamen.length ? el("ul", { class: "uebersicht-liste" }, ...spNamen.map(n => el("li", {}, n))) : "keine neuen");
    zeile("Spracheingabe", 4, OW.status && OW.status.spracheingabe && OW.status.spracheingabeKomplett ? vorhanden() : wahl.spracheingabe ? "ja" : "nein");
    zeile("Desktop-Symbol", 0, wahl.desktop ? "ja" : "nein");
    zeile("Automatische Aktualisierung", 0, akt.an ? (akt.modus === "auto" ? "an, automatisch" : "an, mit Nachfrage") + (akt.wann === "leerlauf" ? ", nur im Leerlauf" : ", sofort im Hintergrund") + (akt.mbit ? ", höchstens " + akt.mbit + " MBit/s" : "") : "aus");
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
    c.append(el("p", { class: "hinweis" }, "Nach dem Abschließen startet der Download. Den Fortschritt siehst du unter „Inhalte“. Das Dashboard kannst du währenddessen schon benutzen: Fertige Pakete stehen sofort zur Verfügung."));
    knoepfe(() => geheZu(UEBERSICHT - 1), abschliessen, "✓ Einrichtung abschließen und herunterladen");
  }

  async function abschliessen() {
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
