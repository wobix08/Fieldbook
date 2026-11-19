// Notizen (Ansicht „#notiz?datei=…“): eigene Texte mit Überschriften, Fett, Kursiv, Listen und Tabellen.
// Gespeichert als kleine HTML-Datei in daten/eigene (Titel = Dateiname), automatisch beim Tippen.
// Suche und KI finden den Text über „Eigene Unterlagen“. Angezeigt und gespeichert wird nur gefiltertes HTML
// (erlaubte Tags, keine Skripte), auch wenn jemand eine fremde .html-Datei in den Ordner legt.
"use strict";

const Notizen = (() => {
  const text = $("#notiz-text");
  const titelFeld = $("#notiz-titel");
  const status = $("#notiz-status");
  const groesse = $("#notiz-groesse");
  const tabellenKnoepfe = $("#notiz-tabelle-knoepfe");
  let datei = null, timer = null, offen = false, lauf = 0;

  // ---------------------------------------------------------------- Filtern

  const ERLAUBT = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "H1", "H2", "H3", "UL", "OL", "LI",
    "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "DIV", "SPAN", "A"]);
  const WEG = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH", "LINK", "META", "TITLE", "HEAD", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "IMG", "VIDEO", "AUDIO"]);
  function filtern(wurzel) {
    for (const x of [...wurzel.querySelectorAll("*")]) {
      if (!x.isConnected) continue;
      if (WEG.has(x.tagName)) { x.remove(); continue; }
      if (!ERLAUBT.has(x.tagName)) { x.replaceWith(...x.childNodes); continue; }
      for (const at of [...x.attributes]) {
        const n = at.name.toLowerCase();
        const ok = (n === "class" && at.value === "klein") ||
          ((x.tagName === "TD" || x.tagName === "TH") && (n === "colspan" || n === "rowspan") && /^\d{1,2}$/.test(at.value)) ||
          (x.tagName === "A" && n === "href" && /^(https?:|mailto:|tel:)/i.test(at.value.trim()));
        if (!ok) x.removeAttribute(at.name);
      }
    }
    return wurzel;
  }
  function sauber(html) {
    const doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
    return filtern(doc.body).innerHTML;
  }

  // ---------------------------------------------------------------- Öffnen und speichern

  async function zeigen(params) {
    await sichern();
    const mein = ++lauf;
    datei = params.get("datei") || "";
    offen = false;
    titelFeld.value = Eigene.ohneEndung(datei);
    status.textContent = "";
    text.contentEditable = "false";
    text.replaceChildren(el("p", { class: "hinweis" }, "Wird geöffnet …"));
    let html;
    try {
      const r = await fetch(Eigene.url(datei), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 404 ? "nicht gefunden" : "Fieldbook antwortet mit " + r.status);
      html = new DOMParser().parseFromString(await r.text(), "text/html").body.innerHTML;
    } catch (e) {
      if (mein !== lauf) return;
      text.replaceChildren(fehlerBox(/nicht gefunden/.test(e.message) ? "Diese Notiz gibt es nicht mehr.\nVielleicht wurde sie umbenannt oder gelöscht." : "Die Notiz ließ sich nicht öffnen.", null, null, e.message));
      return;
    }
    if (mein !== lauf) return;
    text.innerHTML = sauber(html) || "<p><br></p>";
    text.contentEditable = "true";
    offen = true;
    werkzeugeAnpassen();
    // Neue, leere Notiz: gleich den Titel markieren, sonst in den Text
    if (/^Neue Notiz( \(\d+\))?$/.test(titelFeld.value) && !text.textContent.trim()) { titelFeld.focus(); titelFeld.select(); }
    else text.focus();
  }

  function vormerken() {
    if (!offen) return;
    status.textContent = "…";
    clearTimeout(timer);
    timer = setTimeout(sichern, 800);
  }

  async function sichern() {
    clearTimeout(timer);
    if (!offen || timer === null) return;
    timer = null;
    let r;
    try { r = await api("eigene/notiz/speichern", { datei, html: sauber(text.innerHTML) }); } catch (e) { r = { fehler: NICHT_ERREICHBAR }; }
    if (r.fehler) { status.textContent = "Nicht gespeichert"; status.title = r.fehler; timer = 0; return; }
    status.textContent = "Gespeichert";
    status.title = "";
    Eigene.geaendert();
    Eigene.anstossen();   // Text für Suche und KI neu auslesen
  }
  text.addEventListener("input", vormerken);
  // Beim Verlassen der Ansicht sofort speichern
  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#notiz")) sichern(); });
  window.addEventListener("beforeunload", () => { if (timer) sichern(); });

  // Titel = Dateiname: Umbenennen beim Verlassen des Feldes oder mit Enter
  async function umbenennen() {
    const neu = titelFeld.value.trim();
    if (!datei || !neu || neu === Eigene.ohneEndung(datei)) { titelFeld.value = Eigene.ohneEndung(datei); return; }
    await sichern();
    let r;
    try { r = await api("eigene/umbenennen", { datei, neu }); } catch (e) { r = { fehler: NICHT_ERREICHBAR }; }
    if (r.fehler) { titelFeld.value = Eigene.ohneEndung(datei); await dialog("Umbenennen", el("div", {}, zeilen(r.fehler)), [{ text: "OK", wert: 1, haupt: true }]); return; }
    datei = r.datei;
    titelFeld.value = Eigene.ohneEndung(datei);
    history.replaceState(null, "", "#notiz?datei=" + encodeURIComponent(datei));
    status.textContent = "Gespeichert";
    Eigene.geaendert();
  }
  titelFeld.addEventListener("change", umbenennen);
  titelFeld.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); text.focus(); } });

  $("#notiz-zurueck").addEventListener("click", () => {
    if (window.navigation ? navigation.currentEntry.index > 0 : history.length > 1) history.back();
    else location.hash = "#bibliothek";
  });

  // ---------------------------------------------------------------- Bearbeiten

  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { }

  // Block (Absatz, Überschrift, Listenpunkt) an der Schreibmarke
  function block() {
    const s = getSelection();
    if (!s.rangeCount) return null;
    let n = s.anchorNode;
    if (!n || !text.contains(n)) return null;
    if (n.nodeType === 3) n = n.parentNode;
    return n.closest ? n.closest("p, h1, h2, h3, div, li, td, th") : null;
  }
  const zelle = () => { const b = block(); return b && b.closest("td, th"); };

  // Schriftgröße: Absatz in Überschrift, kleinen Text oder normalen Text verwandeln
  groesse.addEventListener("change", () => {
    const wert = groesse.value;
    text.focus();
    let b = block();
    if (!b || b.closest("li, td, th")) {
      // In Listen und Tabellen nur „klein“ oder normal
      const ziel = b && b.closest("li, td, th");
      if (ziel) { ziel.classList.toggle("klein", wert === "klein"); if (!ziel.classList.length) ziel.removeAttribute("class"); }
      else document.execCommand("formatBlock", false, wert === "klein" || wert === "p" ? "p" : wert);
    } else {
      const tag = wert === "klein" ? "p" : wert;
      if (b.tagName.toLowerCase() !== tag || (wert === "klein") !== b.classList.contains("klein")) {
        const neu = document.createElement(tag);
        if (wert === "klein") neu.className = "klein";
        neu.append(...b.childNodes);
        if (!neu.childNodes.length) neu.append(document.createElement("br"));
        b.replaceWith(neu);
        const r = document.createRange();
        r.selectNodeContents(neu); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    }
    vormerken();
    werkzeugeAnpassen();
  });

  const befehl = (cmd) => () => { text.focus(); document.execCommand(cmd, false, null); vormerken(); werkzeugeAnpassen(); };
  $("#notiz-fett").addEventListener("click", befehl("bold"));
  $("#notiz-kursiv").addEventListener("click", befehl("italic"));
  $("#notiz-liste").addEventListener("click", befehl("insertUnorderedList"));
  $("#notiz-nummern").addEventListener("click", befehl("insertOrderedList"));

  // Tabelle: 3 Spalten, Kopfzeile und zwei Zeilen; danach ein leerer Absatz zum Weiterschreiben
  $("#notiz-tabelle").addEventListener("click", () => {
    text.focus();
    if (zelle()) return;
    const kopf = "<tr>" + "<th><br></th>".repeat(3) + "</tr>", zeile = "<tr>" + "<td><br></td>".repeat(3) + "</tr>";
    document.execCommand("insertHTML", false, "<table data-neu=\"1\"><tbody>" + kopf + zeile + zeile + "</tbody></table><p><br></p>");
    // Schreibmarke in die erste Zelle
    const t = text.querySelector("table[data-neu]");
    if (t) {
      t.removeAttribute("data-neu");
      const r = document.createRange();
      r.selectNodeContents(t.querySelector("th, td")); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    vormerken();
    werkzeugeAnpassen();
  });

  function tabelleAendern(art) {
    const z = zelle();
    if (!z) return;
    const tr = z.parentElement, tabelle = z.closest("table");
    const index = [...tr.children].indexOf(z);
    const zeilen_ = [...tabelle.querySelectorAll("tr")];
    if (art === "zeile+") {
      const neu = document.createElement("tr");
      for (let i = 0; i < tr.children.length; i++) neu.append(el("td", {}, el("br")));
      tr.after(neu);
    } else if (art === "spalte+") {
      for (const r of zeilen_) { const c = r.children[index]; const neu = el(c && c.tagName === "TH" ? "th" : "td", {}, el("br")); if (c) c.after(neu); else r.append(neu); }
    } else if (art === "zeile-") {
      if (zeilen_.length <= 1) tabelle.remove(); else tr.remove();
    } else if (art === "spalte-") {
      if (tr.children.length <= 1) tabelle.remove(); else for (const r of zeilen_) if (r.children[index]) r.children[index].remove();
    }
    vormerken();
    werkzeugeAnpassen();
  }
  for (const k of tabellenKnoepfe.querySelectorAll("button")) k.addEventListener("click", () => { text.focus(); tabelleAendern(k.dataset.art); });

  // Werkzeuge an die Stelle anpassen: Größe im Auswahlfeld, Tabellen-Knöpfe nur in einer Tabelle
  function werkzeugeAnpassen() {
    const b = block();
    let wert = "p";
    if (b) {
      const t = b.closest("h1, h2, h3");
      if (t) wert = t.tagName.toLowerCase();
      else if (b.classList.contains("klein") || (b.closest(".klein"))) wert = "klein";
    }
    groesse.value = wert;
    tabellenKnoepfe.hidden = !zelle();
    try {
      $("#notiz-fett").setAttribute("aria-pressed", String(document.queryCommandState("bold")));
      $("#notiz-kursiv").setAttribute("aria-pressed", String(document.queryCommandState("italic")));
    } catch { }
  }
  document.addEventListener("selectionchange", () => { if (offen && document.activeElement === text) werkzeugeAnpassen(); });

  // Einfügen: nur erlaubte Formatierung übernehmen
  text.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    const html = cd.getData("text/html");
    if (html) document.execCommand("insertHTML", false, sauber(html));
    else document.execCommand("insertText", false, cd.getData("text/plain"));
    vormerken();
  });

  // Tastenkürzel: Strg+B fett, Strg+I kursiv (macht der Browser), Tab in Tabellen zur nächsten Zelle
  text.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const z = zelle();
    if (!z) return;
    e.preventDefault();
    const zellen = [...z.closest("table").querySelectorAll("td, th")];
    const ziel = zellen[zellen.indexOf(z) + (e.shiftKey ? -1 : 1)];
    if (!ziel) return;
    const r = document.createRange();
    r.selectNodeContents(ziel); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });

  // Links in Notizen: mit Strg+Klick öffnen (sonst würde man beim Bearbeiten ständig wegspringen)
  text.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); }
  });

  // Neue Notiz anlegen und öffnen
  async function neu() {
    let r;
    try { r = await api("eigene/notiz/neu", { titel: "Neue Notiz" }); } catch (e) { r = { fehler: NICHT_ERREICHBAR }; }
    if (r.fehler) { await dialog("Neue Notiz", el("div", {}, zeilen(r.fehler)), [{ text: "OK", wert: 1, haupt: true }]); return; }
    Eigene.geaendert();
    location.hash = "#notiz?datei=" + encodeURIComponent(r.datei);
  }

  return { zeigen, neu, sauber };
})();
