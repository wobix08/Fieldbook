// Eigene Startseite für ein Wissenspaket (bisher das Klexikon, "startseite.eigene" in pakete.json):
// Suche über die Titel, Zufall, Themen, zwölf zufällige Artikel und alle Artikel von A bis Z.
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

  async function zeigen(params) {
    const id = params.get("buch");
    const c = $("#paketstart-inhalt");
    const buecher = await Kiwix.buecher();
    buch = buecher.find(b => b.id === id);
    if (!buch) {
      c.innerHTML = "";
      // Kurz nach dem Start läuft die Bibliothek noch nicht und kennt noch keine Pakete: warten statt „nicht installiert“
      if (!buecher.length && (OW.status || {}).wissen > 0) {
        c.append(el("p", { class: "hinweis" }, "Die Bibliothek wird gerade gestartet …"));
        setTimeout(async () => { if (location.hash.startsWith("#paketstart")) { OW.buecher = null; await aktualisiereStatus(); zeigen(params); } }, 3000);
        return;
      }
      c.append(el("p", { class: "fehlerbox" }, "Dieses Paket ist nicht installiert."), el("a", { href: "#bibliothek" }, "Zur Bibliothek"));
      return;
    }
    if (buchId !== id) { buchId = id; artikel = null; buchstabe = "A"; }
    zeichne();
    if (!artikel) laden();
  }

  async function laden() {
    const id = buchId;
    const r = await api("artikelliste?buch=" + encodeURIComponent(id)).catch(e => ({ fehler: e.message }));
    if (id !== buchId || !location.hash.startsWith("#paketstart")) return;
    if (r.status === "fertig") { artikel = r.artikel; zeichne(); return; }
    const z = $("#ps-laden");
    if (z) z.textContent = r.fehler ? "Die Liste aller Artikel ist gerade nicht verfügbar: " + r.fehler
      : "Die Liste aller Artikel wird einmalig erstellt … (" + (r.gelesen || 0) + " Artikel)";
    if (!r.fehler) setTimeout(laden, 2000);
  }

  function zeichne() {
    const c = $("#paketstart-inhalt");
    const st = buch.startseite || {};
    c.innerHTML = "";
    c.append(el("div", { class: "ps-kopf" },
      el("img", { class: "ps-logo", src: buch.bild || "icon.svg", alt: "" }),
      el("div", {}, el("h1", {}, buch.titel.replace(/ \(.*\)$/, "")), el("p", { class: "hinweis" }, buch.text || ""))));

    // Suche: tippen filtert die Titel sofort, Enter sucht im ganzen Text
    const feld = el("input", { type: "search", id: "ps-feld", placeholder: "Was willst du wissen?", autocomplete: "off", "aria-label": "Artikel suchen" });
    const treffer = el("div", { class: "ps-treffer" });
    feld.addEventListener("input", () => zeigeTreffer(feld.value, treffer));
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

  function kachel(a) {
    const bild = bildUrl(a);
    return el("a", { class: "ps-kachel", href: lesen(a.P, a.T) },
      bild ? el("img", { src: bild, alt: "", loading: "lazy" }) : el("span", { class: "ps-ohne-bild", "aria-hidden": "true" }, ersterBuchstabe(a.T)),
      el("span", {}, a.T));
  }

  function zeigeTreffer(q, ziel) {
    q = q.trim().toLowerCase();
    ziel.innerHTML = "";
    if (q.length < 2 || !artikel) return;
    const anfang = [], drin = [];
    for (const a of artikel) { const t = a.T.toLowerCase(); if (t.startsWith(q)) anfang.push(a); else if (t.includes(q)) drin.push(a); }
    const alle = anfang.concat(drin);
    ziel.append(alle.length
      ? el("div", { class: "ps-kacheln" }, alle.slice(0, 24).map(kachel))
      : el("p", { class: "hinweis" }, "Kein Artikel heißt so.", el("br"), "Mit „Suchen“ findest du das Wort auch im Text der Artikel."));
  }

  return { zeigen };
})();
