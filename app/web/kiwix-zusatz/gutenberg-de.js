
/* Fieldbook: Im deutschen Gutenberg-Paket fehlen die Namen der Bücherregale (lcc-shelf-*),
   die Regalliste bleibt dann leer. Diese Ergänzung hängt der Server an js/l10n.js an.
   Umlaute als \u-Escapes, weil Kiwix die Datei ohne Zeichensatz ausliefert. */
(function () {
  var w = document.webL10n;
  if (!w || !w.get) return;
  var namen = {
    A: "Allgemeine Werke",
    B: "Philosophie, Psychologie, Religion",
    C: "Hilfswissenschaften der Geschichte",
    D: "Weltgeschichte, Geschichte Europas, Asiens, Afrikas und Australiens",
    E: "Geschichte Amerikas",
    F: "Geschichte Amerikas (regional)",
    G: "Geographie, Anthropologie, Freizeit",
    H: "Sozialwissenschaften",
    J: "Politikwissenschaft",
    K: "Recht",
    L: "Bildung und Erziehung",
    M: "Musik und Bücher über Musik",
    N: "Bildende Kunst",
    P: "Sprache und Literatur",
    PA: "Griechische und lateinische Sprache und Literatur",
    PB: "Moderne und keltische Sprachen",
    PC: "Romanische Sprachen",
    PD: "Germanische und skandinavische Sprachen",
    PE: "Englische Sprache",
    PF: "Westgermanische Sprachen",
    PG: "Slawische, baltische und albanische Sprachen",
    PH: "Uralische Sprachen und Baskisch",
    PJ: "Orientalische Sprachen und Literatur",
    PK: "Indoiranische Sprachen und Literatur",
    PL: "Sprachen und Literatur Ostasiens, Afrikas und Ozeaniens",
    PM: "Indigene und künstliche Sprachen",
    PN: "Literatur allgemein",
    PQ: "Französische, italienische, spanische und portugiesische Literatur",
    PR: "Englische Literatur",
    PS: "Amerikanische Literatur",
    PT: "Deutsche, niederländische und skandinavische Literatur",
    PZ: "Erzählungen und Jugendliteratur",
    Q: "Naturwissenschaften",
    R: "Medizin",
    S: "Landwirtschaft",
    T: "Technik",
    U: "Militärwesen",
    V: "Seefahrt und Marine",
    Z: "Bibliographie und Bibliothekswesen"
  };
  var get = w.get;
  w.get = function (schluessel) {
    var text = get.apply(this, arguments);
    if (!text && /^lcc-shelf-/.test(schluessel)) {
      var code = schluessel.slice(10);
      return namen[code] ? code + " – " + namen[code] : code;
    }
    return text;
  };
})();
