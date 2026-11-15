# Drittanbieter und Lizenzen

Fieldbook selbst steht unter der MIT-Lizenz. Es bündelt bzw. lädt folgende Bausteine,
die ihre eigenen Lizenzen haben.

## Im Paket enthalten (`app/web/vendor`)

| Baustein | Lizenz |
|---|---|
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 5.24.0 | BSD-3-Clause (`LICENSE-maplibre.txt`) |
| [PMTiles](https://github.com/protomaps/PMTiles) 4.5.0 | BSD-3-Clause (`LICENSE-pmtiles.txt`) |
| [SunCalc](https://github.com/mourner/suncalc) 1.9.0 (Sonnenauf- und -untergang, Dämmerung und Mondphase auf der Karte) | BSD-2-Clause (`LICENSE-suncalc.txt`) |
| [Protomaps Basemaps](https://github.com/protomaps/basemaps) 5.7.2 | BSD-3-Clause (`LICENSE-basemaps.txt`) |
| [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (PDF-Leser und Text aus PDF-Büchern für die KI, in `vendor/pdfjs`) | Apache-2.0 (`LICENSE-pdfjs.txt`) |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) 1.8.0 (zeigt eigene Word-Dateien an und liest ihren Text für Suche und KI aus, `vendor/mammoth.browser.min.js`) | BSD-2-Clause (`LICENSE-mammoth.txt`) |
| [Lucide](https://lucide.dev) 0.460.0 (Symbole, als `app/web/symbole.svg`) | ISC (`LICENSE-lucide.txt`) |
| [franc](https://github.com/wooorm/franc) 6.2.0 mit trigram-utils, n-gram und collapse-white-space (erkennt im Sprechmodus die Sprache eines Satzes, in `vendor/franc`) | MIT (`LICENSE-franc.txt`) |
| [FrequencyWords](https://github.com/hermitdave/FrequencyWords) von Hermit Dave, Stand 2018, aus Untertiteln von [OpenSubtitles](https://www.opensubtitles.org) (je Sprache die 5000 häufigsten Wörter, erkennen im Sprechmodus die Sprache eines Satzes, in `app/config/woerter`, gebaut mit `tools/woerter-bauen.ps1`) | CC BY-SA 4.0 (Inhalt), die gekürzten Listen stehen unter derselben Lizenz |
| [Barlow Semi Condensed](https://github.com/jpt/barlow) (Schrift für Überschriften, in `app/web/schrift`) | SIL Open Font License 1.1 (`schrift/LICENSE-barlow.txt`) |

## Bilder im Erste-Hilfe-Kurs (`app/web/bilder/erstehilfe`)

Die Bilder stammen von Wikimedia Commons.\
Ausnahme sind vier eigene Zeichnungen für Fieldbook (Schocklage, Lagerung bei Herzinfarkt, Verbrennung kühlen, Kühlen bei Hitze), sie stehen unter der MIT-Lizenz von Fieldbook.\
Die Quelle steht auch unter jedem Bild im Kurs.

| Bild | Urheber | Lizenz |
|---|---|---|
| Stabile Seitenlage, 6 Schritte, aus [Stabilt sidoläge.svg](https://commons.wikimedia.org/wiki/File:Stabilt_sidol%C3%A4ge.svg) (in Einzelbilder aufgeteilt) | Hibernate | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Herzdruckmassage, aus [CPR 3.png](https://commons.wikimedia.org/wiki/File:CPR_3.png) und [CPR 9.png](https://commons.wikimedia.org/wiki/File:CPR_9.png) (verkleinert, Augen geändert) | Francesca Moretti | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Rückenschläge, aus [Back blows (back slaps) against choking for adult people.jpg](https://commons.wikimedia.org/wiki/File:Back_blows_(back_slaps)_against_choking_for_adult_people.jpg) (verkleinert, Hintergrund durchsichtig) | Trakotako | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Heimlich-Handgriff, [AbdominalThrust HeimlichManoeuvre.svg](https://commons.wikimedia.org/wiki/File:AbdominalThrust_HeimlichManoeuvre.svg) | Evolution and evolvability | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Druckverband, [Druckverband.svg](https://commons.wikimedia.org/wiki/File:Druckverband.svg) | Tkarcher | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Abbinden mit Knebel, aus [Tourniquet (PSF).png](https://commons.wikimedia.org/wiki/File:Tourniquet_(PSF).png) (Beschriftung übersetzt, verkleinert) | Pearson Scott Foresman | gemeinfrei |
| Rautek-Griff, aus [Rautek-maneuver.png](https://commons.wikimedia.org/wiki/File:Rautek-maneuver.png) (verkleinert, Hintergrund durchsichtig) | Baedr-9439 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Wegziehen auf einer Decke, aus [Blanket-drag.png](https://commons.wikimedia.org/wiki/File:Blanket-drag.png) (verkleinert, Hintergrund durchsichtig) | Baedr-9439 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Handfläche als Maß bei Verbrennungen, aus [Palmar-view-of-hand.png](https://commons.wikimedia.org/wiki/File:Palmar-view-of-hand.png) (verkleinert, Hintergrund durchsichtig) | Baedr-9439 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Adrenalin-Pen, aus [Epinephrine-injection.png](https://commons.wikimedia.org/wiki/File:Epinephrine-injection.png) (verkleinert, Hintergrund durchsichtig) | Baedr-9439 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Unterkühlte Person einpacken, 3 Schritte, aus [Hypothermia-wrap.png](https://commons.wikimedia.org/wiki/File:Hypothermia-wrap.png) (in Einzelbilder aufgeteilt) | Baedr-9439 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Kopf überstrecken, aus [Head-tilt-chin-lift-maneuver.jpg](https://commons.wikimedia.org/wiki/File:Head-tilt-chin-lift-maneuver.jpg) (verkleinert) | Another-anon-artist-234 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Atemweg verlegt und frei, [Tongue blocking airway.svg](https://commons.wikimedia.org/wiki/File:Tongue_blocking_airway.svg) | Vassia Atanassova, Vektorgrafik Offnfopt | gemeinfrei |
| Atmung prüfen, aus [Checking respiration2 - high contrast (new).jpg](https://commons.wikimedia.org/wiki/File:Checking_respiration2_-_high_contrast_(new).jpg) (verkleinert) | Scriptir nach Rama | [CC BY-SA 3.0 FR](https://creativecommons.org/licenses/by-sa/3.0/fr/) |
| Elektroden des Defibrillators, aus [Defibrilation electrode placement svg hariadhi.svg](https://commons.wikimedia.org/wiki/File:Defibrilation_electrode_placement_svg_hariadhi.svg) (Beschriftung übersetzt) | Hariadhi | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Wiederbelebung beim Säugling, aus [CPR Infant Chest Compression.png](https://commons.wikimedia.org/wiki/File:CPR_Infant_Chest_Compression.png) (Beschriftung entfernt, verkleinert) | BruceBlaus | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Säugling beim Verschlucken, aus [Heimlich Infant.png](https://commons.wikimedia.org/wiki/File:Heimlich_Infant.png) (in zwei Bilder geteilt, Beschriftung entfernt) | BruceBlaus | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Armschlinge, 4 Schritte, aus [Sling-and-swathe.svg](https://commons.wikimedia.org/wiki/File:Sling-and-swathe.svg) (in Einzelbilder aufgeteilt) | Baedr-9439 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |

## Vom Setup heruntergeladen

| Baustein | Lizenz |
|---|---|
| [kiwix-tools](https://github.com/kiwix/kiwix-tools) (kiwix-serve) | GPL-3.0 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (llama-server) | MIT |
| [go-pmtiles](https://github.com/protomaps/go-pmtiles) | BSD-3-Clause |
| [BRouter](https://github.com/abrensch/brouter) (Routenplanung) | MIT |
| [Eclipse Temurin](https://adoptium.net) (Java-Laufzeit für BRouter) | GPL-2.0 mit Classpath Exception |
| [Protomaps Basemaps Assets](https://github.com/protomaps/basemaps-assets) (Schriften, Symbole) | Schriften: SIL Open Font License, Symbole: siehe Repository |
| [Bergamot Translator](https://github.com/browsermt/bergamot-translator) 0.4.9 (Offline-Übersetzer) | MPL-2.0 |
| Übersetzungsmodell Englisch → Deutsch aus [firefox-translations-models](https://github.com/mozilla/firefox-translations-models) (Mozilla) | siehe Repository (MPL-2.0) |
| Sprachmodelle für Gespräche: Übersetzungsmodelle von Firefox (Mozilla, [Firefox Translations](https://github.com/mozilla/translations)) | MPL-2.0 |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (Spracheingabe, `whisper-cli` und `parakeet-cli`) | MIT |
| [Whisper small und tiny](https://github.com/openai/whisper) (OpenAI, Spracherkennung; tiny bestimmt im Sprechmodus die Sprache), Fassungen [ggml-small-q8_0 und ggml-tiny-q8_0](https://huggingface.co/ggerganov/whisper.cpp) | MIT |
| [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (NVIDIA, Spracherkennung für europäische Sprachen), Fassung [ggml-org/parakeet-GGUF](https://huggingface.co/ggml-org/parakeet-GGUF) | CC BY 4.0 (Modell), MIT (Umwandlung) |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) 1.8.0 (`piper-tts`, Vorlesen im Übersetzer und in der Bibliothek), enthält [espeak-ng](https://github.com/espeak-ng/espeak-ng); läuft als eigenständiges Programm neben Fieldbook | GPL-3.0 |
| [Python](https://www.python.org) 3.12.10, Windows-Fassung „embeddable“ (für Piper) | PSF License |
| Python-Bausteine für Piper (von PyPI): [ONNX Runtime](https://github.com/microsoft/onnxruntime) 1.32.0, [ONNX](https://github.com/onnx/onnx) 1.23.2, [NumPy](https://numpy.org) 2.5.4, [Protocol Buffers](https://github.com/protocolbuffers/protobuf) 7.36.2, [ml_dtypes](https://github.com/jax-ml/ml_dtypes) 0.6.0, [FlatBuffers](https://github.com/google/flatbuffers) 25.12.19, [packaging](https://github.com/pypa/packaging) 26.3, [typing_extensions](https://github.com/python/typing_extensions) 4.16.0, [pathvalidate](https://github.com/thombashi/pathvalidate) 3.3.1 | MIT (ONNX Runtime, pathvalidate), Apache-2.0 (ONNX, ml_dtypes, FlatBuffers, packaging), BSD-3-Clause (NumPy, Protocol Buffers), PSF License (typing_extensions) |
| [Piper](https://github.com/rhasspy/piper) 2023.11.14-2 (nur ältere Installationen bis Fieldbook 0.8.4, wird durch die Aktualisierung ersetzt) | MIT (Piper, ONNX Runtime), GPL-3.0 (espeak-ng) |

## Stimmen zum Vorlesen

Aus [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), je Sprache eine Stimme.
Die Lizenz richtet sich nach den Aufnahmen, mit denen die Stimme trainiert wurde (steht in der Datei `MODEL_CARD` jeder Stimme).
Stimmen mit Nicht-kommerziell-Lizenz oder unklarer Lizenz lädt Fieldbook nicht.

| Lizenz | Stimmen |
|---|---|
| CC0 | Deutsch (thorsten), Niederländisch (alex), Schwedisch (nst), Norwegisch (nvcc), Finnisch (harri), Dänisch (talesyntese), Spanisch (davefx), Portugiesisch (faber), Polnisch (gosia), Tschechisch (jirka), Slowakisch (lili), Ungarisch (anna), Griechisch (rapunzelina), Russisch (denis), Lettisch (aivars), Albanisch (edon), Bulgarisch (dimitar), Rumänisch (mihai), Ukrainisch (ukrainian_tts), Persisch (amir) |
| gemeinfrei | Englisch (cori, Aufnahmen von LibriVox) |
| CC BY 4.0 | Französisch (siwis, SIWIS-Korpus), Italienisch (serena), Slowenisch (artur, ARTUR-Korpus), Litauisch (reginute1, LIEPA-Korpus der Universität Vilnius), Baskisch (maider), Isländisch (ugla, Talrómur von Reykjavík University), Telugu (padmavathi), Vietnamesisch (vais1000) |
| CC BY (META-SHARE, uneingeschränkte Nutzung) | Estnisch (news, Korpus estnischer Nachrichtensätze der Universität Tartu) |
| CC BY-SA 3.0 ES | Katalanisch (upc_ona, Universitat Politècnica de Catalunya) |
| CC BY-SA 4.0 | Marathi und Bengalisch (google, Korpora von Google) |

## Inhalte

| Inhalt | Lizenz |
|---|---|
| Wikipedia, Wikibooks, Wikivoyage, Wiktionary, Wikiversity, Wikisource, Wikiquote | CC BY-SA 4.0 |
| iFixit | CC BY-NC-SA 3.0 |
| Klexikon | CC BY-SA 4.0 |
| Stack Exchange | CC BY-SA |
| weitere Kiwix-Pakete | siehe jeweilige Paketbeschreibung auf [library.kiwix.org](https://library.kiwix.org) |
| Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende | ODbL 1.0 |
| Kartenkacheln über [Protomaps](https://protomaps.com) | ODbL 1.0 |
| Ortsnamen von [GeoNames](https://www.geonames.org) | CC BY 4.0 |
| Wegedaten für die Routenplanung von [brouter.de](https://brouter.de) (aus OpenStreetMap) | ODbL 1.0 |

## KI-Modelle

| Modell | Lizenz |
|---|---|
| Qwen 3.5 (Alibaba) in der Größe 4B | Apache 2.0 |
| [EmbeddingGemma 300M](https://huggingface.co/google/embeddinggemma-300m) (Google), Suchhilfe für die KI | [Gemma Terms of Use](https://ai.google.dev/gemma/terms) |

Weitere Modelle folgen, sobald sie getestet sind.\
Die KI-Modelle werden in der GGUF-Fassung von [Unsloth](https://huggingface.co/unsloth) geladen, die Suchhilfe in der von [ggml-org](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF).
