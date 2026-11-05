# Drittanbieter und Lizenzen

Fieldbook selbst steht unter der MIT-Lizenz. Es bündelt bzw. lädt folgende Bausteine,
die ihre eigenen Lizenzen haben.

## Im Paket enthalten (`app/web/vendor`)

| Baustein | Lizenz |
|---|---|
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 5.24.0 | BSD-3-Clause (`LICENSE-maplibre.txt`) |
| [PMTiles](https://github.com/protomaps/PMTiles) 4.5.0 | BSD-3-Clause (`LICENSE-pmtiles.txt`) |
| [Protomaps Basemaps](https://github.com/protomaps/basemaps) 5.7.2 | BSD-3-Clause (`LICENSE-basemaps.txt`) |
| [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (PDF-Leser und Text aus PDF-Büchern für die KI, in `vendor/pdfjs`) | Apache-2.0 (`LICENSE-pdfjs.txt`) |
| [Lucide](https://lucide.dev) 0.460.0 (Symbole, als `app/web/symbole.svg`) | ISC (`LICENSE-lucide.txt`) |
| [franc](https://github.com/wooorm/franc) 6.2.0 mit trigram-utils, n-gram und collapse-white-space (erkennt im Sprechmodus die Sprache eines Satzes, in `vendor/franc`) | MIT (`LICENSE-franc.txt`) |
| [Barlow Semi Condensed](https://github.com/jpt/barlow) (Schrift für Überschriften, in `app/web/schrift`) | SIL Open Font License 1.1 (`schrift/LICENSE-barlow.txt`) |

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
| [Piper](https://github.com/rhasspy/piper) 2023.11.14-2 (Vorlesen im Übersetzer), enthält [espeak-ng](https://github.com/espeak-ng/espeak-ng) und [ONNX Runtime](https://github.com/microsoft/onnxruntime) | MIT (Piper, ONNX Runtime), GPL-3.0 (espeak-ng) |

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
| Wikipedia, Wikibooks, Wikivoyage, Wiktionary, Wikiversity, Wikisource | CC BY-SA 4.0 |
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

Weitere Modelle folgen, sobald sie getestet sind.\
Die Modelle werden in der GGUF-Fassung von [Unsloth](https://huggingface.co/unsloth) geladen.
