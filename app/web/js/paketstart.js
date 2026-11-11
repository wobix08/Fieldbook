// Eigene Startseite für ein Wissenspaket:
// Klexikon ("startseite.eigene" in pakete.json): Suche über die Titel, Zufall, Themen, zwölf zufällige Artikel und alle Artikel von A bis Z.
// iFixit ("startseite.ifixit"): Suche, Zufall und der Geräte-Baum.
// Die Artikelliste liest der Server einmal aus (/api/artikelliste), danach liegt sie im Cache.
"use strict";

const Paketstart = (() => {
  let buchId = null, buch = null, artikel = null, buchstabe = "A";

  const ersterBuchstabe = (t) => {
    const z = (t || "").charAt(0).toUpperCase();
    return { "Ä": "A", "Ö": "O", "Ü": "U" }[z] || (/[A-Z]/.test(z) ? z : "#");
  };
  const lesen = (pfad, titel) => "#lesen?url=" + encodeURIComponent(buch.start + "/" + pfad) + "&titel=" + encodeURIComponent(titel);
  const bildUrl = (a) => a && a.B ? "/kiwix/content/" + encodeURIComponent(buchId) + "/" + a.B : null;

  // Timer der Abfrage-Schleifen: je Art nur einer, sonst vervielfachen sie sich bei Hin und Zurück
  let startTimer = null, listeTimer = null, ifixitTimer = null;

  async function zeigen(params) {
    clearTimeout(startTimer); clearTimeout(listeTimer); clearTimeout(ifixitTimer);
    const id = params.get("buch");
    const c = $("#paketstart-inhalt");
    const buecher = await Kiwix.buecher();
    buch = buecher.find(b => b.id === id);
    if (!buch) {
      c.innerHTML = "";
      // Kurz nach dem Start läuft die Bibliothek noch nicht und kennt noch keine Pakete: warten statt „nicht installiert“
      if (!buecher.length && (OW.status || {}).wissen > 0) {
        c.append(el("p", { class: "hinweis" }, "Die Bibliothek wird gerade gestartet …"));
        startTimer = setTimeout(async () => { if (location.hash.startsWith("#paketstart")) { OW.buecher = null; await aktualisiereStatus(); zeigen(params); } }, 3000);
        return;
      }
      c.append(el("p", { class: "fehlerbox" }, "Dieses Paket ist nicht installiert."), el("a", { href: "#bibliothek" }, "Zur Bibliothek"));
      return;
    }
    if (buchId !== id) { buchId = id; artikel = null; buchstabe = "A"; }
    if ((buch.startseite || {}).ifixit) { zeichneIfixitSeite(params.get("pfad") || ""); return; }
    zeichne();
    if (!artikel) laden();
  }

  async function laden() {
    const id = buchId;
    clearTimeout(listeTimer);
    const r = (await api("artikelliste?buch=" + encodeURIComponent(id)).catch(e => ({ fehler: e.message }))) || {};
    if (id !== buchId || !location.hash.startsWith("#paketstart")) return;
    if (r.status === "fertig" && Array.isArray(r.artikel)) { artikel = r.artikel; zeichne(true); return; }
    const z = $("#ps-laden");
    if (z) z.textContent = r.fehler ? "Die Liste aller Artikel ist gerade nicht verfügbar: " + r.fehler
      : "Die Liste aller Artikel wird einmalig erstellt … (" + (r.gelesen || 0) + " Artikel)";
    if (!r.fehler) listeTimer = setTimeout(laden, 2000);
  }

  function zeichne(behalten) {
    const c = $("#paketstart-inhalt");
    const st = buch.startseite || {};
    // Beim Neuzeichnen nach dem Laden: Suchfeld (Wert, Fokus, Cursor) merken
    const f0 = behalten && c.querySelector("#ps-feld");
    const alt = f0 ? { wert: f0.value, fokus: document.activeElement === f0, von: f0.selectionStart, bis: f0.selectionEnd } : null;
    c.innerHTML = "";
    c.append(el("div", { class: "ps-kopf" },
      el("img", { class: "ps-logo", src: buch.bild || "icon.svg", alt: "" }),
      el("div", {}, el("h1", {}, buch.titel.replace(/ \(.*\)$/, "")), el("p", { class: "hinweis" }, ...zeilen(buch.text || "")))));

    // Suche: tippen filtert die Titel sofort, Enter sucht im ganzen Text
    const feld = el("input", { type: "search", id: "ps-feld", placeholder: "Was willst du wissen?", autocomplete: "off", "aria-label": "Artikel suchen" });
    const treffer = el("div", { class: "ps-treffer" });
    let tippTimer = null; // Eingabe entprellen: nicht bei jedem Tastendruck filtern
    feld.addEventListener("input", () => { clearTimeout(tippTimer); tippTimer = setTimeout(() => zeigeTreffer(feld.value, treffer), 120); });
    if (alt) {
      // Neu gezeichnet (Liste fertig geladen): Eingabe, Fokus und Cursor erhalten
      feld.value = alt.wert;
      if (alt.fokus) { feld.focus(); try { feld.setSelectionRange(alt.von, alt.bis); } catch { } }
      if (alt.wert) zeigeTreffer(alt.wert, treffer);
    }
    c.append(el("form", { class: "suche-gross", onsubmit: (e) => {
      e.preventDefault();
      const q = feld.value.trim();
      if (q) location.hash = "#lesen?url=" + encodeURIComponent(buch.start) + "&titel=" + encodeURIComponent(buch.titel) + "&suche=" + encodeURIComponent(q);
    } }, feld, el("button", { type: "submit" }, "Suchen")),
      el("div", { class: "knopfreihe", style: "margin:10px 0 0" },
        el("a", { class: "knopf", href: "#lesen?url=" + encodeURIComponent(buch.start) + "&titel=" + encodeURIComponent(buch.titel) + "&zufall=1" }, sym("shuffle"), "Zufälliger Artikel")),
      treffer);

    if ((st.kacheln || []).length)
      c.append(el("h2", {}, "Themen"), el("div", { class: "paket-themen" },
        st.kacheln.map(k => el("a", { class: "knopf", href: lesen(k.pfad, k.titel) }, k.titel))));

    // Zwölf zufällige Artikel zum Entdecken, bei jedem Öffnen andere (nur solche mit Bild)
    if (artikel) {
      const mitBild = artikel.filter(a => a.B);
      const wahl = [];
      while (wahl.length < 12 && wahl.length < mitBild.length) {
        const a = mitBild[Math.floor(Math.random() * mitBild.length)];
        if (!wahl.includes(a)) wahl.push(a);
      }
      c.append(el("h2", {}, "Zufällige Artikel"), el("div", { class: "ps-kacheln" }, wahl.map(kachel)));
    }

    c.append(el("h2", {}, "Alle Artikel von A bis Z"));
    if (!artikel) { c.append(el("p", { class: "hinweis", id: "ps-laden" }, "Die Liste aller Artikel wird geladen …")); }
    else {
      const anzahl = {};
      for (const a of artikel) { const b = ersterBuchstabe(a.T); anzahl[b] = (anzahl[b] || 0) + 1; }
      const leiste = el("div", { class: "ps-abc", role: "tablist" });
      const liste = el("div", { class: "ps-kacheln" });
      const waehle = (b) => {
        buchstabe = b;
        leiste.querySelectorAll("button").forEach(k => k.setAttribute("aria-selected", String(k.dataset.b === b)));
        liste.replaceChildren(...artikel.filter(a => ersterBuchstabe(a.T) === b).map(kachel));
      };
      for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split(""))
        if (anzahl[b]) leiste.append(el("button", { type: "button", role: "tab", "data-b": b, title: anzahl[b] + " Artikel", onclick: () => waehle(b) }, b === "#" ? "0–9" : b));
      c.append(el("p", { class: "hinweis klein", style: "margin:-6px 0 10px" }, artikel.length.toLocaleString("de-DE") + " Artikel"), leiste, liste);
      waehle(anzahl[buchstabe] ? buchstabe : "A");
    }

    c.append(el("p", { class: "hinweis", style: "margin-top:28px" },
      el("a", { href: "#lesen?url=" + encodeURIComponent(buch.start) + "&titel=" + encodeURIComponent(buch.titel) }, "Über " + (st.ueber || "dieses Paket"))));
  }

  // Kopf mit Logo, Name und Beschreibung, darunter Suche im ganzen Text und „Zufälliger Artikel“
  function kopfUndSuche(c, platzhalter, zufallText) {
    const zuLesen = (extra) => "#lesen?url=" + encodeURIComponent(buch.start) + "&titel=" + encodeURIComponent(buch.titel) + extra;
    c.append(el("div", { class: "ps-kopf" },
      el("img", { class: "ps-logo", src: buch.bild || "icon.svg", alt: "" }),
      el("div", {}, el("h1", {}, buch.titel.replace(/ \(.*\)$/, "")), el("p", { class: "hinweis" }, ...zeilen(buch.text || "")))));
    const feld = el("input", { type: "search", placeholder: platzhalter, autocomplete: "off", "aria-label": "Im Paket suchen" });
    c.append(el("form", { class: "suche-gross", onsubmit: (e) => {
      e.preventDefault();
      const q = feld.value.trim();
      if (q) location.hash = zuLesen("&suche=" + encodeURIComponent(q));
    } }, feld, el("button", { type: "submit" }, "Suchen")),
      el("div", { class: "knopfreihe", style: "margin:10px 0 0" },
        el("a", { class: "knopf", href: zuLesen("&zufall=1") }, sym("shuffle"), zufallText)));
  }

  // Startseite für iFixit: Geräte-Baum (nur Zweige mit Anleitungen). Der Bereich steht in der Adresse („&pfad=“),
  // so geht Zurück Bereich für Bereich, und aus der Bibliothek beginnt man immer bei „Alle Bereiche“
  const ifixitLink = (pfad) => "#paketstart?buch=" + encodeURIComponent(buchId) + (pfad ? "&pfad=" + encodeURIComponent(pfad) : "");
  let ifixitKnoten = null;
  function zeichneIfixitSeite(knoten) {
    const c = $("#paketstart-inhalt");
    let baum = c.querySelector(".ifixit-baum");
    // Nur der Bereich wechselt: Kopf und Suche bleiben stehen
    if (!baum || c.dataset.buch !== buchId) {
      c.innerHTML = "";
      c.dataset.buch = buchId;
      kopfUndSuche(c, "Gerät oder Fehler, z. B. Waschmaschine pumpt nicht ab", "Zufällige Anleitung");
      baum = el("div", { class: "ifixit-baum" });
      c.append(el("h2", {}, "Nach Gerät suchen"), baum);
    }
    zeichneIfixit(baum, knoten);
  }

  async function zeichneIfixit(ziel, knoten) {
    const id = buchId;
    ifixitKnoten = knoten;
    clearTimeout(ifixitTimer);
    const r = (await api("ifixit?buch=" + encodeURIComponent(id) + "&pfad=" + encodeURIComponent(knoten)).catch(e => ({ fehler: e.message }))) || {};
    if (ifixitKnoten !== knoten || buchId !== id || !ziel.isConnected) return;
    ziel.innerHTML = "";
    if (r.status === "laeuft") {
      ziel.append(el("p", { class: "hinweis" }, "Die Übersicht wird einmalig erstellt, das dauert ein paar Minuten (" + (r.gelesen || 0) + " Seiten gelesen).", el("br"), "Suche und Zufall gehen schon."));
      ifixitTimer = setTimeout(() => { if (ziel.isConnected && location.hash.startsWith("#paketstart")) zeichneIfixit(ziel, knoten); }, 3000);
      return;
    }
    if (r.fehler || !Array.isArray(r.weg) || !Array.isArray(r.kinder) || !Array.isArray(r.anleitungen)) {
      ziel.append(el("p", { class: "fehlerbox" }, "Übersicht nicht verfügbar" + (r.fehler ? ": " + r.fehler : "."))); return;
    }
    const gehe = (pfad, ...inhalt) => el("a", { href: ifixitLink(pfad) }, ...inhalt);
    const anz = (n) => n === 1 ? "1 Anleitung" : n.toLocaleString("de-DE") + " Anleitungen";
    ziel.append(el("h3", { class: "ifixit-weg" },
      gehe("", "Alle Bereiche"), ...r.weg.flatMap(w => [" › ", w.pfad === r.pfad ? w.titel : gehe(w.pfad, w.titel)])));
    if (r.kinder.length)
      ziel.append(el("div", { class: "ifixit-zweige" },
        r.kinder.map(k => gehe(k.pfad, el("b", {}, k.titel), el("small", {}, anz(k.anzahl))))));
    if (r.anleitungen.length)
      ziel.append(el("h3", {}, r.kinder.length ? "Anleitungen direkt hier" : anz(r.anleitungen.length)),
        ...r.anleitungen.map(a => el("a", { class: "treffer", href: lesen(a.pfad, a.titel) }, el("b", {}, a.titel))));
  }

  function kachel(a) {
    const bild = bildUrl(a);
    return el("a", { class: "ps-kachel", href: lesen(a.P, a.T) },
      bild ? el("img", { src: bild, alt: "", loading: "lazy" }) : el("span", { class: "ps-ohne-bild", "aria-hidden": "true" }, ersterBuchstabe(a.T)),
      el("span", {}, a.T));
  }

  // Kleingeschriebene Titel einmal je Artikelliste merken (nicht bei jedem Tastendruck neu bilden)
  let kleinFuer = null, klein = [];
  function zeigeTreffer(q, ziel) {
    q = q.trim().toLowerCase();
    ziel.innerHTML = "";
    if (q.length < 2 || !artikel) return;
    if (kleinFuer !== artikel) { kleinFuer = artikel; klein = artikel.map(a => a.T.toLowerCase()); }
    const anfang = [], drin = [];
    for (let i = 0; i < artikel.length; i++) { const t = klein[i]; if (t.startsWith(q)) anfang.push(artikel[i]); else if (t.includes(q)) drin.push(artikel[i]); }
    const alle = anfang.concat(drin);
    ziel.append(alle.length
      ? el("div", { class: "ps-kacheln" }, alle.slice(0, 24).map(kachel))
      : el("p", { class: "hinweis" }, "Kein Artikel heißt so.", el("br"), "Mit „Suchen“ findest du das Wort auch im Text der Artikel."));
  }

  return { zeigen };
})();
