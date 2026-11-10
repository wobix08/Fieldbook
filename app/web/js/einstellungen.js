// Einstellungen: Kategorien zum Aufklappen (Programm und Updates, Darstellung, KI, Inhalte, Datenschutz, Erweitert).
// Zugeklappt steht unter jeder Kategorie, wie sie gerade eingestellt ist. Inhalte verwaltet inhalte.js.
"use strict";

const Einstellungen = (() => {
  // Aufgeklappte Kategorie (bleibt beim Neuzeichnen offen); es ist immer höchstens eine offen
  const aufgeklappt = new Set();

  // behalten: Neuaufbau aus einem Knopf heraus, die Scrollposition bleibt (von außen: false, dann ganz oben)
  async function zeigen(behalten = true) {
    const c = $("#einst-inhalt");
    const y = behalten ? window.scrollY : 0;
    c.innerHTML = '<p class="hinweis">Wird geladen …</p>';
    const [kat, s, hw, akt] = await Promise.all([api("katalog"), api("status"), api("hardware").catch(() => ({})), api("aktualisierung")]);
    c.innerHTML = "";
    // Gibt es eine neue Fieldbook-Version, ist „Fieldbook und Updates“ gleich offen (der Hinweis oben führt hierher)
    if ((s.programmNeu || s.programmBereit) && !aufgeklappt.size) aufgeklappt.add("programm");
    const liste = el("div", { class: "klapp-liste-abschnitte einst-liste" });
    c.append(liste);
    const kategorie = (schluessel, icon, titel, unter) => {
      const a = klappAbschnitt(aufgeklappt, schluessel, icon, titel, unter || " ", null, true);
      liste.append(a.box);
      const u = a.box.querySelector(".klapp-unter");
      return { box: a.box, innen: a.innen, unter: (t) => { u.textContent = t; } };
    };
    const zeileMitSchalter = (titel, text, input) => el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, titel), text ? el("small", {}, ...[].concat(text)) : null), anAus(input));

    // ---------------- Fieldbook und Updates (ganz oben, mit der Version)
    const prog = kategorie("programm", "refresh-cw", "Fieldbook und Updates");
    let programmInfo = { eingerichtet: true, neu: s.programmNeu, verfuegbar: !!s.programmNeu, bereit: s.programmBereit };
    const progText = el("small"), progExtra = el("div");
    const programmStatus = (u) => !u.eingerichtet ? "Programm-Updates sind noch nicht eingerichtet (kein GitHub-Repository in app\\config\\fieldbook.json)."
      : u.entwicklung ? "Entwicklungsordner: Hier wird nicht automatisch aktualisiert."
      : u.fehler ? "Suche fehlgeschlagen (Internet?)."
      : u.bereit ? "Version " + u.bereit + " ist heruntergeladen und wird beim nächsten Start eingespielt."
      : u.verfuegbar ? "Neue Version " + u.neu + " verfügbar" + (u.bytes ? " (" + groesse(u.bytes) + ")" : "") + "."
      : u.neu ? "Das ist die neueste Version." : "";
    const inhalteStatus = () => "Inhalte: " + (akt.geprueft ? "zuletzt geprüft " + akt.geprueft + " · " +
      (akt.anzahl ? akt.anzahl + " Aktualisierung(en), ca. " + groesse(akt.bytes) : "alles aktuell") : "noch nicht geprüft");
    const zeichneProgramm = () => {
      const u = programmInfo;
      const st = programmStatus(u);
      progText.replaceChildren(...(st ? [st, el("br")] : []), inhalteStatus());
      progExtra.innerHTML = "";
      if (u.verfuegbar && u.notizen) progExtra.append(el("details", {}, el("summary", {}, "Was ist neu in " + u.neu + "?"), el("pre", { style: "white-space:pre-wrap;font-family:inherit" }, u.notizen)));
      if ((u.verfuegbar || u.bereit) && !u.entwicklung) {
        progExtra.append(el("div", { class: "knopfreihe" }, el("button", { class: "knopf knopf-haupt", onclick: async () => {
          const ziel = u.verfuegbar ? u.neu : u.bereit;
          const ok = await dialog("Fieldbook aktualisieren?",
            "Fieldbook lädt Version " + ziel + " herunter, beendet sich kurz und startet neu. Deine Wissenspakete, KI-Modelle, Karten und Einstellungen bleiben erhalten. Vom bisherigen Programm wird vorher eine Sicherung angelegt.",
            [{ text: "Abbrechen", wert: false }, { text: "Jetzt aktualisieren", wert: true, haupt: true }]);
          if (!ok) return;
          const r = await api("programmupdate/installieren", {});
          if (r.fehler) { await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
          if (r.neustart) neustartAnzeigen(r.neu);
          else location.hash = "#inhalte";
        } }, u.bereit && !u.verfuegbar ? "⟳ Jetzt neu starten und einspielen" : "⟳ Auf Version " + u.neu + " aktualisieren")));
      }
      const kurz = u.bereit ? "Version " + u.bereit + " wird beim nächsten Start eingespielt"
        : u.verfuegbar ? "Neue Version " + u.neu + " verfügbar"
        : u.entwicklung ? "Entwicklungsordner" : u.neu ? "aktuell" : "";
      prog.unter("Version " + s.version + (kurz ? " · " + kurz : "") + " · Inhalte " + (akt.an ? "werden automatisch aktuell gehalten" : "nicht automatisch aktuell"));
    };
    // Ein Knopf sucht beides: neue Fieldbook-Version und neue Inhalte
    const suchKnopf = el("button", { class: "knopf knopf-klein", onclick: async (e) => {
      const k = e.currentTarget, t = k.textContent;
      k.disabled = true; k.textContent = "Suche …";
      programmInfo = await api("programmupdate").catch(err => ({ fehler: err.message, eingerichtet: true }));
      zeichneProgramm();
      k.textContent = t;
      const r = await jetztAktualisieren(k, { programmNeu: programmInfo.verfuegbar && !programmInfo.entwicklung ? programmInfo.neu : null });
      if (r) { Object.assign(akt, { geprueft: r.geprueft, anzahl: r.anzahl, bytes: r.bytes, titel: r.titel }); zeichneProgramm(); }
    } }, "Nach Updates suchen");
    prog.innen.append(
      el("div", { class: "einst-zeile", style: "padding-top:0" }, el("div", {}, el("b", {}, "Fieldbook-Version " + s.version), progText), suchKnopf),
      progExtra,
      zeileMitSchalter("Beim Start nach neuer Fieldbook-Version fragen",
        ["Fieldbook fragt beim Start kurz bei GitHub, ob es eine neue Programmversion gibt.", el("br"), "Heruntergeladen wird dabei nichts."],
        el("input", { type: "checkbox", checked: s.updateBeimStart !== false, onchange: async (e) => {
          s.updateBeimStart = e.target.checked;
          OW.status = await api("einstellungen", { updateBeimStart: e.target.checked });
        } })),
      el("h3", { style: "margin-top:14px" }, "Automatische Aktualisierung"),
      aktualisierungBox(akt, true, { eingebettet: true, programm: true, geaendert: zeichneProgramm }));
    zeichneProgramm();
    if (s.updateBeimStart !== false) api("programmupdate").then(u => { programmInfo = u; zeichneProgramm(); }).catch(() => { });

    // ---------------- Darstellung und Land
    const dar = kategorie("darstellung", "sun", "Darstellung und Land");
    const THEMA = { dark: "Dunkel", light: "Hell", system: "Wie Windows" };
    const darUnter = () => dar.unter((THEMA[aktuellesThema()] || "Dunkel") + " · " + Land.text((Land.aktuell() || {}).name) + " · Desktop-Symbol " + (s.desktopSymbol ? "an" : "aus"));
    const sel = el("select", { onchange: (e) => { setzeThema(e.target.value); darUnter(); } },
      el("option", { value: "dark" }, "Dunkel (Standard)"), el("option", { value: "light" }, "Hell (gut zum Lernen und Lesen)"), el("option", { value: "system" }, "Wie Windows"));
    sel.value = aktuellesThema();
    const landSel = landAuswahl(Land.aktuell(), async (neu) => {
      OW.status = await api("einstellungen", { land: neu.code, sprache: neu.sprache });
      darUnter();
    });
    dar.innen.append(
      el("div", { class: "einst-zeile", style: "padding-top:0" }, el("b", {}, "Farbschema"), sel),
      el("div", { class: "einst-zeile" }, el("div", {}, el("b", {}, "Land"), el("small", {}, "Bestimmt die Notrufnummern")), landSel),
      zeileMitSchalter("Desktop-Symbol", "Fieldbook vom Desktop aus starten", el("input", { type: "checkbox", checked: !!s.desktopSymbol, onchange: async (e) => {
        const r = await api("desktopsymbol", { an: e.target.checked });
        if (r.fehler) { alert("Das Desktop-Symbol konnte nicht geändert werden: " + r.fehler); e.target.checked = !!r.vorhanden; e.target.nextElementSibling.textContent = e.target.checked ? "an" : "aus"; return; }
        s.desktopSymbol = e.target.checked;
        darUnter();
      } })));
    darUnter();

    // ---------------- KI-Assistent
    const ki = kategorie("ki", "message-circle", "KI-Assistent");
    const inst = kat.modelle.filter(m => m.installiert);
    const gpu = Setup.besteGpu(hw);
    const kiUnter = () => {
      const m = inst.find(x => x.id === s.modell);
      ki.unter(!inst.length ? "Keine KI installiert" : (m ? m.name + " · " + m.modell : inst.length + " installiert") +
        (s.sparmodus ? " · Sparmodus an" : gpu && gpu.vramGB >= 4 ? (s.backend === "vulkan" ? " · mit Grafikkarte" : " · auf dem Prozessor") : ""));
    };
    if (!inst.length) ki.innen.append(el("p", { style: "margin-top:0" }, "Keine KI installiert.", el("br"), el("a", { href: "#inhalte" }, "Unter „Inhalte“ kannst du eine laden.")));
    for (const m of inst) {
      const aktiv = s.modell === m.id;
      ki.innen.append(el("div", { class: "einst-zeile", style: "padding-top:0" },
        el("div", {}, el("b", {}, m.name + " · " + m.modell), el("small", {}, groesse(m.bytes) + (aktiv ? " · aktiv" : ""))),
        el("div", { class: "knopfreihe", style: "margin:0" },
          aktiv ? el("span", { class: "ok-text" }, "✓ aktiv") : el("button", { class: "knopf knopf-klein", onclick: async () => { await api("einstellungen", { modell: m.id }); zeigen(); } }, "Benutzen"),
          el("button", { class: "knopf knopf-klein knopf-rot", onclick: () => entfernen("modell", m.id, m.name) }, "Löschen"))));
    }
    if (gpu && gpu.vramGB >= 4) ki.innen.append(zeileMitSchalter("Grafikkarte nutzen",
      [gpu.name + ", " + gpu.vramGB + " GB. Die KI antwortet damit viel schneller.", el("br"), "Ohne rechnet der Prozessor."],
      el("input", { type: "checkbox", checked: s.backend === "vulkan", onchange: async (e) => {
        const box = e.target;
        box.disabled = true;
        try { await rechenwegSetzen(box.checked ? "vulkan" : "cpu"); }
        catch (err) { box.checked = !box.checked; alert("Der Rechenweg konnte nicht umgestellt werden.\n" + err.message); }
        finally { box.disabled = false; }
        zeigen();
      } })));
    if (inst.length) ki.innen.append(zeileMitSchalter("Sparmodus",
      ["Schaltet die KI ab und gibt den Arbeitsspeicher frei, den sie belegt.", el("br"), "Fragen an die KI gehen dann nicht, alles andere funktioniert wie gewohnt."],
      el("input", { type: "checkbox", checked: s.sparmodus, onchange: (e) => { s.sparmodus = e.target.checked; kiUnter(); schalteKi(!e.target.checked); } })));
    if (s.ki.fehler) ki.innen.append(el("p", { class: "fehlerbox" }, s.ki.fehler));
    kiUnter();

    // ---------------- Inhalte
    const pk = kat.pakete.filter(p => p.installiert).length, kk = kat.karten.filter(r => r.installiert).length;
    const inh = kategorie("inhalte", "package", "Inhalte", pk + " Wissenspakete · " + kk + " Karten" + (s.routen ? " · Routenplanung" : ""));
    inh.innen.append(
      el("div", { class: "einst-zeile", style: "padding-top:0" },
        el("div", {}, el("b", {}, "Installiert"), el("small", {}, pk + " Wissenspakete · " + kk + " Karten" + (s.routen ? " · Routenplanung" : ""))),
        el("a", { class: "knopf knopf-klein", href: "#inhalte" }, "Verwalten")),
      el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, "Einrichtung neu starten"), el("small", {}, "Alles noch einmal Schritt für Schritt auswählen, wie beim ersten Start.", el("br"), "Was schon installiert ist, bleibt.")),
        el("a", { class: "knopf knopf-klein", href: "#setup?schritt=0&neu=1" }, sym("rotate-ccw"), "Neu starten")));

    // ---------------- Rückmeldung und Datenschutz (nur wenn in fieldbook.json ein Dienst eingetragen ist)
    // Reihenfolge fest, auch wenn die Antworten verschieden schnell kommen
    const rm = kategorie("datenschutz", "messages-square", "Rückmeldung und Datenschutz", "Rückmeldung an den Entwickler");
    rm.box.hidden = true;
    const fbPlatz = el("div"), statPlatz = el("div");
    rm.innen.append(fbPlatz, statPlatz);
    api("feedback").then(fb => { if (fb && fb.eingerichtet) { fbPlatz.append(rueckmeldungTeil(fb)); rm.box.hidden = false; } }).catch(() => { });
    api("statistik").then(st => { if (st && st.eingerichtet) { statPlatz.append(statistikTeil(st, rm.unter)); rm.box.hidden = false; } }).catch(() => { });

    // ---------------- Erweitert: Verbindungstest und Proxy für Firmen- und Schulnetze
    const erw = kategorie("erweitert", "settings", "Erweitert", "Internetverbindung prüfen · Proxy für Firmen- und Schulnetze");
    erw.innen.append(el("div", { class: "einst-zeile", style: "padding-top:0" },
      el("div", {}, el("b", {}, "Verbindung prüfen"), el("small", {}, "Zeigt, ob ein Werbeblocker, eine Firewall oder ein Filter Downloads sperrt.")),
      el("button", { class: "knopf knopf-klein", onclick: (e) => verbindungPruefen(e.currentTarget) }, "Prüfen")));
    const proxyFeld = el("input", { type: "text", value: s.proxy || "", placeholder: "automatisch (wie Windows)", "aria-label": "Proxy", style: "width:260px" });
    const proxyStatus = el("small", {}, "Nur nötig, wenn Downloads im Firmen- oder Schulnetz nicht gehen.", el("br"), "Beispiel: proxy.schule.de:8080");
    erw.innen.append(el("div", { class: "einst-zeile", style: "border-bottom:0" },
      el("div", {}, el("b", {}, "Proxy"), proxyStatus),
      el("div", { class: "knopfreihe", style: "margin:0;flex-wrap:nowrap" }, proxyFeld,
        el("button", { class: "knopf knopf-klein", onclick: async () => {
          OW.status = await api("einstellungen", { proxy: proxyFeld.value.trim() });
          proxyStatus.textContent = proxyFeld.value.trim() ? "Gespeichert. Downloads laufen jetzt über diesen Proxy." : "Gespeichert. Fieldbook nimmt wieder den Proxy aus Windows (falls vorhanden).";
        } }, "Speichern"))));

    c.append(el("p", { class: "hinweis klein" }, "Fieldbook " + s.version + " · Protokolle im Ordner daten\\logs · Beenden über den Aus-Knopf oben rechts"));
    if (behalten && location.hash.startsWith("#einstellungen")) window.scrollTo(0, y);
  }

  // „Rückmeldung geben“: eine Zeile mit Knopf, darunter klappt das Formular auf (Text, freiwillige
  // Kontaktadresse, auf Wunsch Logdateien). Vor dem Absenden ist sichtbar, was genau mitgeht.
  function rueckmeldungTeil(fb) {
    const box = el("div", { class: "fb-formular", hidden: true });
    const wartendText = fb.wartend ? (fb.wartend === 1 ? " Eine frühere Rückmeldung wartet noch auf Internet." : " " + fb.wartend + " frühere Rückmeldungen warten noch auf Internet.") : "";
    const oeffnen = el("button", { class: "knopf knopf-klein", onclick: () => {
      box.hidden = !box.hidden;
      oeffnen.textContent = box.hidden ? "Schreiben" : "Schließen";
      zeile.style.borderBottom = box.hidden ? "0" : "";
      if (!box.hidden) text.focus();
    } }, "Schreiben");
    const zeile = el("div", { class: "einst-zeile", style: "border-bottom:0" },
      el("div", {}, el("b", {}, "Rückmeldung geben"),
        el("small", {}, "Fehler gefunden, eine Idee oder etwas, das dir gefällt? Schreib es direkt an den Entwickler. Ohne Internet schickt Fieldbook die Nachricht später." + wartendText)),
      oeffnen);
    const text = el("textarea", { rows: 5, maxlength: 5000, placeholder: "Was ist dir aufgefallen? Bei einem Fehler hilft: Was hast du gemacht, und was ist passiert?", "aria-label": "Deine Rückmeldung" });
    const kontakt = el("input", { type: "text", maxlength: 200, autocomplete: "email", placeholder: "E-Mail-Adresse, falls du eine Antwort möchtest (freiwillig)", "aria-label": "Kontaktadresse", style: "margin-top:8px" });
    const mitLogs = el("input", { type: "checkbox" });

    // Was mitgeht, genau so, wie es der Server verschickt
    const sys = fb.system || {};
    const liste = el("ul", { class: "fb-liste" },
      el("li", {}, "Dein Text und, falls angegeben, deine Kontaktadresse"),
      el("li", {}, "Fieldbook " + fb.version + " · Windows " + (sys.Windows || "?") + " · " + (sys.Arbeitsspeicher || "?") + " Arbeitsspeicher · KI: " + (sys.KI || "keine")));
    const logZeile = el("li", { hidden: true }, "Logdateien (jeweils das Ende): " +
      (fb.logs.length ? fb.logs.map(l => l.name + " (" + groesse(l.bytes) + ")").join(", ") : "keine vorhanden"));
    liste.append(logZeile);
    mitLogs.addEventListener("change", () => { logZeile.hidden = !mitLogs.checked; });

    const status = el("p", { class: "klein", style: "margin:8px 0 0" });
    const senden = el("button", { class: "knopf knopf-haupt", onclick: async () => {
      if (text.value.trim().length < 3) { status.className = "klein fehlerbox"; status.textContent = "Bitte schreib ein paar Worte."; text.focus(); return; }
      senden.disabled = true; senden.textContent = "Wird gesendet …";
      const r = await api("feedback/senden", { text: text.value, kontakt: kontakt.value, logs: mitLogs.checked }).catch(e => ({ fehler: e.message }));
      senden.disabled = false; senden.textContent = "Absenden";
      if (r.fehler) { status.className = "klein fehlerbox"; status.textContent = r.fehler; return; }
      text.value = ""; kontakt.value = "";
      status.className = "klein ok-text";
      status.textContent = r.gesendet ? "✓ Danke! Deine Rückmeldung ist angekommen."
        : r.zuViele ? "✓ Danke! Gerade kommen zu viele Rückmeldungen an. Fieldbook schickt deine später von selbst."
        : "✓ Danke! Gerade gibt es keine Verbindung. Fieldbook schickt die Rückmeldung, sobald Internet da ist.";
    } }, "Absenden");

    box.append(text, kontakt,
      el("label", { class: "schalter", style: "margin-top:10px" }, mitLogs, "Logdateien mitschicken (hilft bei Fehlern)"),
      el("details", { class: "fb-details" }, el("summary", {}, "Was wird mitgeschickt?"), liste,
        el("p", { class: "klein hinweis" }, "Chats, Fragen an die KI und deine Einträge (Erste Hilfe, Vorsorge) gehen nie mit. In den Logdateien werden dein Benutzername und deine Ordnerpfade unkenntlich gemacht. Die Rückmeldung läuft über einen kleinen Dienst bei Cloudflare und landet in einem privaten GitHub-Repository, das nur der Entwickler sieht. Sie wird nicht veröffentlicht.")),
      el("div", { class: "knopfreihe" }, senden), status);
    return el("div", {}, zeile, box);
  }

  // Zwei Schalter (Fehlerberichte, Nutzungsstatistik) und das nächste Paket zum Ansehen
  // unterSetzen: schreibt die Zusammenfassung unter die zugeklappte Kategorie
  function statistikTeil(st, unterSetzen) {
    const teil = el("div");
    const zeichnen = (st) => {
      teil.innerHTML = "";
      if (unterSetzen) unterSetzen("Rückmeldung an den Entwickler · Fehlerberichte " + (st.fehler ? "an" : "aus") + " · Nutzungsstatistik " + (st.nutzung ? "an" : "aus"));
      const schalter = (feld, titel, text) => el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, titel), el("small", {}, text)),
        anAus(el("input", { type: "checkbox", checked: !!st[feld], onchange: async (e) => {
          const neu = await api("statistik/einstellen", { [feld]: e.target.checked });
          await aktualisiereStatus();
          zeichnen(neu);
        } })));
      teil.append(
        schalter("fehler", "Fehlerberichte senden", "Fehler, die in Fieldbook auftreten, dein Gerät (Prozessor, Arbeitsspeicher, Grafik) und wie schnell die KI antwortet. Hilft mir, Probleme zu finden."),
        schalter("nutzung", "Nutzungsstatistik senden", "Wie oft du die einzelnen Bereiche öffnest, welche Pakete und Karten installiert sind und dein Land. Zeigt mir, was wirklich genutzt wird."));
      const info = el("small", { class: "hinweis" }, "Das erste kleine Paket geht gleich nach dem Einschalten raus, danach eins pro Woche, nie über einen Handy-Hotspot.", el("br"),
        "Fragen, Chats, Suchbegriffe und Einträge gehen nie mit.",
        ...(st.gesendet ? [el("br"), "Zuletzt gesendet: " + new Date(st.gesendet).toLocaleDateString("de-DE") + "."] : []));
      teil.append(el("div", { style: "padding:8px 0 0" }, info));
      if (st.entwickler) teil.append(el("p", { class: "warnung", style: "margin-top:8px" },
        "In diesem Ordner liegt die Datei „.keine-statistik“.", el("br"), "Deshalb sendet Fieldbook hier nichts, auch wenn die Schalter an sind."));
      if (st.paket) {
        teil.append(el("details", { class: "fb-details" }, el("summary", {}, "Was wird gesendet?"),
          el("p", { class: "klein hinweis" }, "Das nächste Paket, genau so, wie es verschickt wird. „id“ ist eine zufällige Kennung, damit ein Gerät nicht doppelt gezählt wird. Sie hat nichts mit dir oder deinem Gerät zu tun."),
          el("pre", { class: "stat-paket" }, JSON.stringify(st.paket, null, 2)),
          el("button", { class: "knopf knopf-klein", onclick: async () => zeichnen(await api("statistik/neueid", {})) }, "Neue zufällige Kennung")));
      }
    };
    zeichnen(st);
    return teil;
  }

  async function entfernen(art, id, titel) {
    if (!confirm("„" + titel + "“ wirklich löschen? Zum Wiederherstellen muss es neu heruntergeladen werden.")) return;
    const r = await api("entfernen", { art, id });
    if (r.fehler) alert(r.fehler);
    OW.buecher = null;
    await aktualisiereStatus();
    zeigen();
  }

  return { zeigen: () => zeigen(false) };
})();

// „Wie Windows“: Wechselt Windows zwischen hell und dunkel, zieht Fieldbook sofort mit
try {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (aktuellesThema() !== "system") return;
    wendeThemaAn("system");
    if (typeof Karten !== "undefined" && Karten.themaGeaendert) Karten.themaGeaendert();
    if (typeof PdfLeser !== "undefined") PdfLeser.themaGeaendert();
  });
} catch { }

// Farbschema: "dark" (Standard), "light" oder "system" (wie Windows)
function aktuellesThema() {
  try { return localStorage.getItem("thema") || "dark"; } catch { return "dark"; }
}
function wendeThemaAn(t) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const k = document.getElementById("thema-knopf");
  if (k) {
    const dunkel = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    k.replaceChildren(sym(dunkel ? "sun" : "moon"));
    k.title = dunkel ? "Helle Ansicht" : "Dunkle Ansicht";
  }
}
function setzeThema(t) {
  try { localStorage.setItem("thema", t); } catch { }
  wendeThemaAn(t);
  if (typeof Karten !== "undefined" && Karten.themaGeaendert) Karten.themaGeaendert();
  if (typeof PdfLeser !== "undefined") PdfLeser.themaGeaendert();
}
wendeThemaAn(aktuellesThema());
document.getElementById("thema-knopf").addEventListener("click", () => {
  const dunkel = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  setzeThema(dunkel ? "light" : "dark");
});
