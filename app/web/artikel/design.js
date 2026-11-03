// Fieldbook-Design für Artikel aus Kiwix (vom Server in jeden Artikel eingesetzt, siehe ArtikelDesign in Server.cs).
// Setzt html[data-fb="dunkel"|"hell"] passend zum Design von Fieldbook, noch bevor die Seite gezeichnet wird.
(function () {
  function thema() {
    var t = null;
    try { t = localStorage.getItem("thema"); } catch (e) { }
    t = t || "dark";
    if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    return t === "light" ? "hell" : "dunkel";
  }
  function setze() {
    var html = document.documentElement, t = thema();
    html.setAttribute("data-fb", t);
    // Farbschema und Grund wie im kleinen Skript vorne im Kopf (Server.cs), damit Umschalten beides mitnimmt
    html.style.colorScheme = t === "hell" ? "light" : "dark";
    html.style.background = t === "hell" ? "#fff" : "#1c1d1b";
    // Wikipedia & Co. haben ein eigenes Nachtdesign nach der Systemeinstellung. Das immer abschalten:
    // Hell soll hell bleiben, und Dunkel macht dieses Design selbst.
    if (/\bskin-theme-clientpref-(os|night)\b/.test(html.className))
      html.className = html.className.replace(/\bskin-theme-clientpref-(os|night)\b/, "skin-theme-clientpref-day");
  }
  setze();
  // Links ins Internet: erst fragen, ob es Internet gibt. Mit Internet öffnet die Seite in einem neuen Tab,
  // ohne zeigt Fieldbook kurz „Kein Internet“ statt einer Fehlerseite des Browsers.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0) return;
    var url;
    try { url = new URL(a.href, document.baseURI); } catch (x) { return; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === location.origin) return;
    e.preventDefault();
    e.stopPropagation();
    var html = document.documentElement;
    html.style.cursor = "progress";
    fetch("/api/internet?url=" + encodeURIComponent(url.href)).then(function (r) { return r.json(); })
      .catch(function () { return { online: false }; })
      .then(function (r) {
        html.style.cursor = "";
        if (r.online) window.open(url.href, "_blank", "noopener");
        else keinInternet();
      });
  }, true);

  // PhET: Im Fenster vor dem Start steht statt der fehlenden Beschreibung das Wort „undefined“
  document.addEventListener("click", function () {
    setTimeout(function () {
      var d = document.querySelector(".swal2-html-container .description");
      if (d && d.textContent.trim() === "undefined") d.style.display = "none";
    }, 50);
  });

  function keinInternet() {
    var alt = document.getElementById("fb-offline");
    if (alt) alt.remove();
    var box = document.createElement("div");
    box.id = "fb-offline";
    box.innerHTML = '<div class="fb-offline-box"><h1>Kein Internet</h1>' +
      '<p>Dieser Link führt zu einer Webseite im Internet.<br>Gerade gibt es keine Verbindung.</p>' +
      '<button type="button">Zurück</button></div>';
    box.querySelector("button").addEventListener("click", function () { box.remove(); });
    document.body.appendChild(box);
    box.querySelector("button").focus();
  }

  // Design in Fieldbook umgeschaltet (anderes Dokument, gleicher Speicher) oder im System geändert
  addEventListener("storage", function (e) { if (e.key === "thema") setze(); });
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", setze); } catch (e) { }
})();
