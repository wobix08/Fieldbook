// Einstellungen: KI, Version, Aktualisierung, Darstellung. Inhalte verwaltet inhalte.js.
"use strict";

const Einstellungen = (() => {
  async function zeigen() {
    const c = $("#einst-inhalt");
    c.innerHTML = '<p class="hinweis">Wird geladen …</p>';
    const [kat, s] = await Promise.all([api("katalog"), api("status")]);
    c.innerHTML = "";

    // KI
    const ki = el("div", { class: "karte-box" }, el("h2", { style: "margin-top:0" }, "KI-Assistent"));
    const inst = kat.modelle.filter(m => m.installiert);
    if (!inst.length) ki.append(el("p", {}, "Keine KI installiert."));
    for (const m of inst) {
      const aktiv = s.modell === m.id;
      ki.append(el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, m.name + " · " + m.modell), el("small", {}, groesse(m.bytes) + (aktiv ? " · aktiv" : ""))),
        el("div", { class: "knopfreihe", style: "margin:0" },
          aktiv ? el("span", { class: "ok-text" }, "✓ aktiv") : el("button", { class: "knopf knopf-klein", onclick: async () => { await api("einstellungen", { modell: m.id }); zeigen(); } }, "Benutzen"),
          el("button", { class: "knopf knopf-klein knopf-rot", onclick: () => entfernen("modell", m.id, m.name) }, "Löschen"))));
    }
    ki.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Sparmodus"), el("small", {}, "Schaltet die KI ab und gibt den Arbeitsspeicher frei, den sie belegt. Fragen an die KI gehen dann nicht, alles andere funktioniert wie gewohnt.")),
      el("label", { class: "schalter" }, el("input", { type: "checkbox", checked: s.sparmodus, onchange: (e) => schalteKi(!e.target.checked) }), "an")));
    if (s.ki.fehler) ki.append(el("p", { class: "fehlerbox" }, s.ki.fehler));
    c.append(ki);

    // Ganz oben zwei getrennte Kästen: das Fieldbook-Programm und die Inhalte
    const pv = el("div"), mitladen = el("div");
    const programmBox = el("div", { class: "karte-box", style: "margin-bottom:16px" },
      el("h2", { style: "margin-top:0" }, "Fieldbook-Programm"), pv,
      el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, "Beim Start nach neuer Fieldbook-Version fragen"),
          el("small", {}, "Fieldbook fragt beim Start kurz bei GitHub, ob es eine neue Programmversion gibt. Heruntergeladen wird dabei nichts.")),
        el("label", { class: "schalter" }, el("input", { type: "checkbox", checked: s.updateBeimStart !== false, onchange: async (e) => {
          s.updateBeimStart = e.target.checked;
          OW.status = await api("einstellungen", { updateBeimStart: e.target.checked });
        } }), "an")),
      mitladen);
    const aktInfo = el("div"), autoTeil = el("div");
    const pk = kat.pakete.filter(p => p.installiert).length, kk = kat.karten.filter(r => r.installiert).length;
    const inhalteBox = el("div", { class: "karte-box", style: "margin-bottom:16px" },
      el("h2", { style: "margin-top:0" }, "Inhalte"),
      el("div", { class: "einst-zeile", style: "border:0;padding-top:0" },
        el("div", {}, el("b", {}, "Installiert"),
          el("small", {}, pk + " Wissenspakete · " + kk + " Karten" + (s.routen ? " · Routenplanung" : ""))),
        el("a", { class: "knopf knopf-klein", href: "#inhalte" }, "Verwalten")),
      aktInfo, autoTeil);
    c.prepend(programmBox, inhalteBox);
    // Rückmeldung an den Entwickler, im Kasten Fieldbook-Programm (nur wenn in fieldbook.json ein Dienst eingetragen ist)
    // Danach Fehlerberichte und Nutzungsstatistik (Reihenfolge fest, auch wenn die Antworten verschieden schnell kommen)
    const fbPlatz = el("div"), statPlatz = el("div");
    programmBox.append(fbPlatz, statPlatz);
    api("feedback").then(fb => { if (fb && fb.eingerichtet) fbPlatz.append(rueckmeldungTeil(fb)); }).catch(() => { });
    api("statistik").then(st => { if (st && st.eingerichtet) statPlatz.append(statistikTeil(st)); }).catch(() => { });
    const zeigeVersion = (u) => {
      pv.innerHTML = "";
      pv.append(
        el("div", { class: "einst-zeile", style: "border:0;padding-top:0" },
          el("div", {}, el("b", {}, "Fieldbook-Version " + s.version),
            el("small", {}, !u.eingerichtet ? "Programm-Updates sind noch nicht eingerichtet (kein GitHub-Repository in app\\config\\fieldbook.json)."
              : u.entwicklung ? "Entwicklungsordner: Hier wird nicht automatisch aktualisiert."
              : u.fehler ? "Suche fehlgeschlagen (Internet?)."
              : u.bereit ? "Version " + u.bereit + " ist heruntergeladen und wird beim nächsten Start eingespielt."
              : u.verfuegbar ? "Neue Version " + u.neu + " verfügbar" + (u.bytes ? " (" + groesse(u.bytes) + ")" : "") + "."
              : u.neu ? "Das ist die neueste Version." : "")),
          el("button", { class: "knopf knopf-klein", onclick: async (e) => {
            e.target.disabled = true; e.target.textContent = "Suche …";
            zeigeVersion(await api("programmupdate").catch(err => ({ fehler: err.message, eingerichtet: true })));
          } }, "Nach neuer Version suchen")));
      if (u.verfuegbar && u.notizen) pv.append(el("details", {}, el("summary", {}, "Was ist neu in " + u.neu + "?"), el("pre", { style: "white-space:pre-wrap;font-family:inherit" }, u.notizen)));
      if ((u.verfuegbar || u.bereit) && !u.entwicklung) {
        pv.append(el("div", { class: "knopfreihe" }, el("button", { class: "knopf knopf-haupt", onclick: async () => {
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
    };
    zeigeVersion({ eingerichtet: true, neu: s.programmNeu, verfuegbar: !!s.programmNeu, bereit: s.programmBereit });
    if (s.updateBeimStart !== false) api("programmupdate").then(zeigeVersion).catch(() => { });

    // Inhalte aktualisieren und automatische Aktualisierung der Inhalte
    const akt = await api("aktualisierung");
    const zeigeAkt = (a) => {
      aktInfo.innerHTML = "";
      aktInfo.append(el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, "Nach neuen Inhalten suchen"),
          el("small", {}, "Wissenspakete, Karten und Wegedaten · " +
            (a.geprueft ? "zuletzt geprüft: " + a.geprueft + " · " + (a.anzahl ? a.anzahl + " Aktualisierung(en), ca. " + groesse(a.bytes) + ": " + a.titel.join(", ") : "alles aktuell") : "noch nicht geprüft"))),
        el("button", { class: "knopf knopf-klein", onclick: async (e) => {
          const r = await jetztAktualisieren(e.currentTarget);
          if (r && location.hash.startsWith("#einstellungen")) zeigeAkt(r);
        } }, "⟳ Inhalte aktualisieren")));
    };
    zeigeAkt(akt);
    // Fieldbook-Versionen bei der wöchentlichen Aktualisierung mitladen (gehört zum Programm, wirkt nur mit eingeschalteter Automatik)
    const zeigeMitladen = () => {
      mitladen.innerHTML = "";
      mitladen.append(el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, "Neue Fieldbook-Versionen bei der automatischen Aktualisierung mitladen"),
          el("small", {}, akt.an
            ? "Sucht die wöchentliche Aktualisierung nach neuen Inhalten, sucht sie auch nach einer neuen Programmversion. Eingespielt wird sie beim nächsten Start."
            : "Wirkt nur, wenn bei den Inhalten „Inhalte automatisch aktuell halten“ eingeschaltet ist.")),
        el("label", { class: "schalter" }, el("input", { type: "checkbox", checked: akt.programm !== false, disabled: !akt.an,
          onchange: (e) => aktualisierungSpeichern(akt, { programm: e.target.checked }, true) }), "an")));
    };
    zeigeMitladen();
    autoTeil.append(el("h3", { style: "margin-top:12px" }, "Automatische Aktualisierung"),
      aktualisierungBox(akt, true, { eingebettet: true, geaendert: zeigeMitladen }));

    // Internetverbindung: Test und Proxy für Firmen- und Schulnetze
    const netz = el("div", { class: "karte-box", style: "margin-top:16px" }, el("h2", { style: "margin-top:0" }, "Internetverbindung"));
    netz.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Verbindung prüfen"), el("small", {}, "Zeigt, ob ein Werbeblocker, eine Firewall oder ein Filter Downloads sperrt.")),
      el("button", { class: "knopf knopf-klein", onclick: (e) => verbindungPruefen(e.currentTarget) }, "Prüfen")));
    const proxyFeld = el("input", { type: "text", value: s.proxy || "", placeholder: "automatisch (wie Windows)", "aria-label": "Proxy", style: "width:260px" });
    const proxyStatus = el("small", {}, "Nur nötig, wenn Downloads im Firmen- oder Schulnetz nicht gehen. Beispiel: proxy.schule.de:8080");
    netz.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Proxy"), proxyStatus),
      el("div", { class: "knopfreihe", style: "margin:0;flex-wrap:nowrap" }, proxyFeld,
        el("button", { class: "knopf knopf-klein", onclick: async () => {
          OW.status = await api("einstellungen", { proxy: proxyFeld.value.trim() });
          proxyStatus.textContent = proxyFeld.value.trim() ? "Gespeichert. Downloads laufen jetzt über diesen Proxy." : "Gespeichert. Fieldbook nimmt wieder den Proxy aus Windows (falls vorhanden).";
        } }, "Speichern"))));
    c.append(netz);

    // Darstellung
    const d = el("div", { class: "karte-box", style: "margin-top:16px" }, el("h2", { style: "margin-top:0" }, "Darstellung"));
    const sel = el("select", { onchange: (e) => setzeThema(e.target.value) },
      el("option", { value: "dark" }, "Dunkel (Standard)"), el("option", { value: "light" }, "Hell (gut zum Lernen und Lesen)"), el("option", { value: "system" }, "Wie Windows"));
    sel.value = aktuellesThema();
    d.append(el("div", { class: "einst-zeile" }, el("b", {}, "Farbschema"), sel));
    const land = Land.aktuell();
    const landSel = landAuswahl(land, async (neu) => {
      OW.status = await api("einstellungen", { land: neu.code, sprache: neu.sprache });
    });
    d.append(el("div", { class: "einst-zeile" }, el("div", {}, el("b", {}, "Land"), el("small", {}, "Bestimmt die Notrufnummern")), landSel));
    d.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Desktop-Symbol"), el("small", {}, "Fieldbook vom Desktop aus starten")),
      el("label", { class: "schalter" }, el("input", { type: "checkbox", checked: !!s.desktopSymbol, onchange: async (e) => {
        const r = await api("desktopsymbol", { an: e.target.checked });
        if (r.fehler) { alert("Das Desktop-Symbol konnte nicht geändert werden: " + r.fehler); e.target.checked = !!r.vorhanden; }
      } }), "an")));
    c.append(d);

    c.append(el("p", { class: "hinweis klein" }, "Fieldbook " + s.version + " · Protokolle im Ordner daten\\logs · Beenden über den Aus-Knopf oben rechts"));
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
  function statistikTeil(st) {
    const teil = el("div");
    const zeichnen = (st) => {
      teil.innerHTML = "";
      const schalter = (feld, titel, text) => el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, titel), el("small", {}, text)),
        el("label", { class: "schalter" }, el("input", { type: "checkbox", checked: !!st[feld], onchange: async (e) => {
          const neu = await api("statistik/einstellen", { [feld]: e.target.checked });
          await aktualisiereStatus();
          zeichnen(neu);
        } }), "an"));
      teil.append(
        schalter("fehler", "Fehlerberichte senden", "Fehler, die in Fieldbook auftreten, dein Gerät (Prozessor, Arbeitsspeicher, Grafik) und wie schnell die KI antwortet. Hilft mir, Probleme zu finden."),
        schalter("nutzung", "Nutzungsstatistik senden", "Wie oft du die einzelnen Bereiche öffnest, welche Pakete und Karten installiert sind und dein Land. Zeigt mir, was wirklich genutzt wird."));
      const info = el("small", { class: "hinweis" }, "Einmal pro Woche ein kleines Paket, nie über einen Handy-Hotspot. Fragen, Chats, Suchbegriffe und Einträge gehen nie mit." +
        (st.gesendet ? " Zuletzt gesendet: " + new Date(st.gesendet).toLocaleDateString("de-DE") + "." : ""));
      teil.append(el("div", { style: "padding:8px 0 0" }, info));
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

  return { zeigen };
})();

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
}
wendeThemaAn(aktuellesThema());
document.getElementById("thema-knopf").addEventListener("click", () => {
  const dunkel = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  setzeThema(dunkel ? "light" : "dark");
});
