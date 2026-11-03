# Fieldbook

**Wissen, wo kein Netz ist**\
Wikipedia, KI-Assistent, Karten, Kochen und Erste Hilfe auf dem Laptop, komplett ohne Internet.

Fieldbook ist ein portables Windows-Programm für Stromausfall, Reisen ohne Netz oder einfach für unterwegs.\
Es braucht kein Linux, kein Docker und keine Installation: Ordner entpacken, Doppelklick, fertig.\
Inspiriert von [Project NOMAD](https://www.projectnomad.us/) und [Internet-in-a-Box](https://internet-in-a-box.org/).

## Inhalt

- [Warum Fieldbook?](#warum-fieldbook)
- [Was drin ist](#was-drin-ist)
- [Schnellstart](#schnellstart)
- [Ist das sicher?](#ist-das-sicher)
- [Systemanforderungen](#systemanforderungen)
- [Downloads in Firmen- und Schulnetzen](#downloads-in-firmen--und-schulnetzen)
- [Welche KI passt zu meinem Gerät?](#welche-ki-passt-zu-meinem-gerät)
- [So funktioniert die Frage-Antwort-Funktion](#so-funktioniert-die-frage-antwort-funktion)
- [Aufbau](#aufbau)
- [Entwicklung](#entwicklung)
- [Automatische Aktualisierung (optional)](#automatische-aktualisierung-optional)
- [Programm-Updates (Fieldbook selbst)](#programm-updates-fieldbook-selbst)
- [Länder und Sprachen](#länder-und-sprachen)
- [Datenschutz](#datenschutz)
- [Lizenz](#lizenz)

## Warum Fieldbook?

Project NOMAD hat mich sehr beeindruckt: Wikipedia, Karten, Anleitungen und eine KI, alles auf einem Gerät und ohne Internet.\
Dafür braucht man aber ein eigenes Linux-System oder eine virtuelle Maschine, und darauf hatte ich keine Lust.\
Ich wollte dieselbe Idee auf einem ganz normalen Windows-Laptop haben: entpacken, doppelklicken, fertig.

Außerdem soll so eine Wissenssammlung nicht nur etwas für Technikbegeisterte sein.\
Jeder, der einen Laptop hat, soll sie nutzen können, ob im Stromausfall, auf Reisen oder in einer einsamen Hütte im Wald.

Fieldbook habe ich mit Hilfe der KI Claude entwickelt.\
Ideen, Auswahl der Inhalte und alle Entscheidungen stammen von mir.

## Was drin ist

| | Bereich | Was es kann |
|---|---|---|
| <img src=".github/icons/ask.svg" width="32" height="32" align="left" alt=""> | **Fragen** | Eine lokale KI beantwortet Fragen anhand der Offline-Bibliothek, mit Quellenangabe |
| <img src=".github/icons/library.svg" width="32" height="32" align="left" alt=""> | **Bibliothek** | Wikipedia, Medizin, iFixit-Reparaturanleitungen, Lehrbücher, Kinderlexikon, Reiseführer und mehr, alles im Fieldbook-Design (hell oder dunkel), mit Übersetzer Englisch → Deutsch |
| <img src=".github/icons/cooking.svg" width="32" height="32" align="left" alt=""> | **Kochen** | Rezepte zu dem, was du da hast, und Faustregeln zu Trinkwasser, Vorräten und Stromausfall |
| <img src=".github/icons/maps.svg" width="32" height="32" align="left" alt=""> | **Karten** | OpenStreetMap-Karten offline, Länder einzeln laden und nahtlos zusammen ansehen, Ortssuche, Routenplanung, Ärzte, Apotheken und Trinkwasser in der Nähe |
| <img src=".github/icons/translate.svg" width="32" height="32" align="left" alt=""> | **Übersetzer** | Gespräche in zwei Sprachen: abwechselnd schreiben oder einfach sprechen (Sprechmodus erkennt, wer spricht), offline übersetzt und vorgelesen, 52 Sprachen zum Nachladen |
| <img src=".github/icons/first-aid.svg" width="32" height="32" align="left" alt=""> | **Erste&nbsp;Hilfe** | Ein Kurs zum Vorbereiten mit Lektionen, Quiz und Fallbeispielen, dazu Spickzettel für den Ernstfall |
| <img src=".github/icons/preparedness.svg" width="32" height="32" align="left" alt=""> | **Vorsorge** | Checklisten zum Abhaken: Vorräte für 10 Tage, Stromausfall, Dokumente, Notgepäck |

> [!WARNING]
> Der Erste-Hilfe-Kurs folgt gängigen Erste-Hilfe-Regeln, ersetzt aber keinen echten Erste-Hilfe-Kurs und keine ärztliche Hilfe.\
> KI-Antworten können Fehler enthalten.\
> Bei wichtigen Entscheidungen immer die Quellen lesen.

## Schnellstart

1. **[Fieldbook 0.7.0 herunterladen](https://github.com/wobix08/Fieldbook/releases/download/v0.7.0/Fieldbook-0.7.0.zip)** (ZIP-Datei, etwa 1,3 MB) und entpacken, zum Beispiel nach `C:\Fieldbook` oder auf einen USB-Stick.\
   Frühere Versionen und was sich geändert hat, stehen unter [Releases](../../releases).
2. **`Fieldbook.exe`** doppelklicken.
3. Der Einrichtungs-Assistent öffnet sich im Browser.\
   Er erkennt die Hardware, schlägt eine passende KI vor und lädt die gewählten Inhalte herunter.
4. Ab dann funktioniert alles offline.

Eine ausführliche Schritt-für-Schritt-Anleitung steht in der [GUIDE.md](GUIDE.md).

> Windows zeigt beim ersten Start „Der Computer wurde durch Windows geschützt“, weil das Programm neu und nicht signiert ist.\
> Dann auf **Weitere Informationen → Trotzdem ausführen** klicken.\
> Das ist nur einmal nötig.\
> Warum das harmlos ist, steht unter [Ist das sicher?](#ist-das-sicher).

## Ist das sicher?

Ein unbekanntes Programm aus dem Internet zu starten, erfordert Vertrauen.\
Deshalb ist bei Fieldbook alles offen und überprüfbar:

- **Der komplette Quellcode liegt in diesem Repository**\
  Es gibt keine versteckten Teile.\
  Auch die Startdatei `Fieldbook.exe` wird aus [`tools/Starter.cs`](tools/Starter.cs) gebaut (rund 90 Zeilen).\
  Sie macht nur eines: `app\Start.bat` starten.
- **Ohne .exe starten**\
  Wer keine .exe starten möchte, kann stattdessen `app\Start.bat` doppelklicken.\
  Das ist eine lesbare Textdatei, genau wie der restliche Programmcode in `app\`.
- **Keine Installation, keine Administratorrechte**\
  Fieldbook verändert nichts an Windows und schreibt nur in seinen eigenen Ordner.\
  Zum Entfernen genügt es, den Ordner zu löschen.\
  Einzige Ausnahme: Die *optionale* automatische Aktualisierung legt zwei Aufgaben in der Windows-Aufgabenplanung an.\
  Ausschalten in den Einstellungen entfernt sie wieder.
- **Deine Daten bleiben bei dir**\
  Kein Konto, keine Werbung.\
  Alles läuft auf `localhost`, also nur auf deinem Gerät.\
  Fragen an die KI, Chats und alles, was du in Fieldbook einträgst, verlassen dein Gerät nicht.\
  Fehlerberichte und Nutzungsstatistik verschickt Fieldbook nur, wenn du ausdrücklich zustimmst, und du kannst das jederzeit wieder abschalten.\
  Fieldbook fragt einmal danach, beide Haken sind am Anfang aus.\
  Ganz ehrlich: Ich kann jeden verstehen, der das ausgeschaltet lässt, bei anderen Programmen mache ich es genauso.\
  Über jedes Ja würde ich mich trotzdem sehr freuen.\
  Fieldbook läuft auf ganz unterschiedlicher Hardware, und ohne solche Rückmeldungen bekomme ich kaum mit, wo es hakt oder zu langsam ist.
- **Rückmeldungen nur, wenn du sie abschickst**\
  Unter *Einstellungen → Rückmeldung geben* kannst du mir selbst schreiben, was gut läuft und was nicht.\
  Die Nachricht geht erst raus, wenn du auf *Absenden* klickst.\
  Sie läuft über einen kleinen Dienst bei Cloudflare (`fieldbook-feedback.wobix08.workers.dev`, Quellcode in [`tools/feedback-worker.js`](tools/feedback-worker.js)) und landet in einem privaten GitHub-Repository, das nur ich sehe.\
  Mit geht nur, was im Formular unter *Was wird mitgeschickt?* steht.\
  Logdateien schickt Fieldbook nur mit, wenn du den Haken dafür setzt, und macht darin deinen Benutzernamen und deine Ordnerpfade unkenntlich.\
  Gegen Missbrauch nimmt der Dienst je Absender nur wenige Rückmeldungen pro Stunde an.\
  Dafür merkt er sich eine Stunde lang einen unumkehrbaren Kurzwert, deine IP-Adresse selbst speichert er nicht.\
  Alles Weitere steht unter [Datenschutz](#datenschutz).
- **Downloads nur aus offiziellen Quellen**\
  Alle stehen in [`app/config/programme.json`](app/config/programme.json) und den anderen Konfigurationsdateien:

  | Was | Woher |
  |---|---|
  | Wissenspakete, kiwix-serve | download.kiwix.org (Kiwix / Wikimedia) |
  | KI-Modelle, Modelle für die Spracheingabe, Stimmen zum Vorlesen | huggingface.co |
  | llama.cpp, whisper.cpp, Piper, BRouter, PMTiles, Java (Eclipse Temurin) | github.com (offizielle Releases der Projekte) |
  | Karten | build.protomaps.com (OpenStreetMap-Daten) |
  | Wegedaten | brouter.de |
  | Ortsnamen | download.geonames.org |
  | Übersetzer (Bergamot) | cdn.jsdelivr.net (npm-Paket `@browsermt/bergamot-translator`, feste Version) |
  | Übersetzungsmodelle (Artikel und Gespräche) | firefox.settings.services.mozilla.com und firefox-settings-attachments.cdn.mozilla.net (Mozilla, dieselben Modelle wie in Firefox, Prüfsumme wird nach dem Download kontrolliert) |

- **Prüfsumme**\
  Zu jedem Release gibt es eine Datei `.sha256`.\
  Damit lässt sich prüfen, dass die heruntergeladene ZIP nicht verändert wurde:

  ```powershell
  Get-FileHash .\Fieldbook-0.7.0.zip -Algorithm SHA256
  ```

  Der angezeigte Wert muss mit dem in der `.sha256`-Datei übereinstimmen.
- **Selbst prüfen lassen**\
  Wer möchte, lädt die ZIP bei [VirusTotal](https://www.virustotal.com) hoch.\
  Dort prüfen rund 70 Virenscanner gleichzeitig.

## Systemanforderungen

- Windows 10 oder 11 (64 Bit)
- Mindestens 4 GB Arbeitsspeicher, empfohlen 8 GB oder mehr
- Speicherplatz je nach Auswahl: ca. 6 GB (Reise-Set) bis über 100 GB (alles)
- Internet nur für die Einrichtung

## Downloads in Firmen- und Schulnetzen

Fieldbook braucht Internet nur zum Herunterladen.\
Sperren ein Werbeblocker (z. B. Pi-hole, AdGuard), eine Firewall oder ein Jugendschutzfilter einzelne Adressen, schlagen Downloads fehl.

- **Verbindung prüfen**\
  Unter *Einstellungen → Internetverbindung → Prüfen* testet Fieldbook alle Adressen und sagt, welche gesperrt ist.\
  Derselbe Knopf erscheint, wenn ein Download scheitert.
- **Proxy**\
  Fieldbook übernimmt den Proxy aus den Windows-Einstellungen automatisch.\
  Falls nötig, lässt sich unter *Einstellungen → Internetverbindung* ein eigener eintragen (z. B. `proxy.schule.de:8080`).
- **Ohne Internet**\
  Pakete, Karten und KI-Modelle lassen sich auch von einem USB-Stick oder einem anderen Ordner übernehmen (*Inhalte → Von USB-Stick oder Ordner übernehmen*).\
  So kann man zum Beispiel einen zweiten Laptop bestücken, ohne alles neu zu laden.

Diese Adressen müssen erreichbar sein (zum Freigeben in Firewall oder Werbeblocker):

| Wofür | Adressen |
|---|---|
| Wissenspakete | `library.kiwix.org`, `download.kiwix.org` und dessen Spiegelserver (z. B. `ftp.fau.de`, `mirror.download.kiwix.org`) |
| Karten | `build-metadata.protomaps.dev`, `build.protomaps.com` |
| KI-Modelle, Spracheingabe und Stimmen | `huggingface.co`, `*.hf.co` (Download-Server von Hugging Face) |
| Hilfsprogramme und Updates | `github.com`, `api.github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` |
| Übersetzer | `cdn.jsdelivr.net`, `firefox.settings.services.mozilla.com`, `firefox-settings-attachments.cdn.mozilla.net` |
| Ortsnamen | `download.geonames.org` |
| Wegedaten | `brouter.de` |
| Rückmeldungen, Fehlerberichte und Statistik (nur mit Zustimmung) | `fieldbook-feedback.wobix08.workers.dev` |

## Welche KI passt zu meinem Gerät?

Der Assistent misst Arbeitsspeicher und Grafikkarte und schlägt automatisch vor:

| Gerät | Vorschlag | Download |
|---|---|---|
| 4 GB RAM | Qwen 3.5 (2B) | 1,3 GB |
| 8 GB RAM, ohne Grafikkarte | Qwen 3.5 (4B) | 2,7 GB |
| 16 GB RAM | Qwen 3.5 (9B) | 5,7 GB |
| 32 GB RAM, ohne starke Grafikkarte | Qwen 3.5 (35B-A3B) | 22 GB |
| Grafikkarte ab 10 GB | Gemma 4 (12B) | 7,1 GB |
| Grafikkarte ab 20 GB | Qwen 3.5 (27B) | 16,7 GB |

Grafikkarten von NVIDIA, AMD und Intel Arc werden über Vulkan genutzt.\
Es ist keine Treiber-Zusatzinstallation wie CUDA nötig.\
Ob die Grafikkarte genutzt wird, lässt sich jederzeit in den Einstellungen oder unter *Inhalte* umschalten.\
Die Liste steht in [`app/config/modelle.json`](app/config/modelle.json) und lässt sich leicht erweitern.

## So funktioniert die Frage-Antwort-Funktion

```
Frage ──► KI erzeugt Suchbegriffe ──► Suche in allen Wissenspaketen (Kiwix)
                                            │
Antwort mit Quellen [1] [2] ◄── KI liest die besten Abschnitte
```

Die KI antwortet nur anhand der gefundenen Artikel und nennt die Quellen.\
Englische Quellen (z. B. medizinische Handbücher) übersetzt sie sinngemäß ins Deutsche.\
Pakete aus PDF-Büchern (z. B. die Medizin-Handbücher) kann Kiwix nicht durchsuchen.\
Deshalb liest Fieldbook ihren Text nach der Installation einmal im Hintergrund aus (mit pdf.js) und legt ihn unter `daten\wissen\pdf-texte` ab.\
Eingescannte Bücher ohne Text bleiben dabei außen vor.\
Im **Sparmodus** ist die KI aus.\
Dann zeigt der Bereich „Fragen“ die passenden Artikel direkt an.

## Aufbau

```
Fieldbook.exe           Startdatei (sucht app\Start.bat neben sich)
app\
  Start.bat, start.ps1        Starter (PowerShell, in Windows enthalten)
  Server.cs                   Kleiner lokaler Server, wird beim Start kompiliert
  config\                     Modelle, Wissenspakete, Karten, Kochen, Erste Hilfe (JSON)
  web\                        Dashboard (HTML, CSS, JavaScript, MapLibre)
programme\                    Wird vom Setup gefüllt: kiwix-serve, llama-server, pmtiles
daten\                        Wird vom Setup gefüllt: wissen\*.zim, modelle\*.gguf, karten\*.pmtiles
```

Alles läuft auf `localhost`.\
Deine Fragen, Chats und Einträge bleiben auf deinem Gerät.\
Nach der Einrichtung geht Fieldbook nur noch in vier Fällen ins Internet:
- **Beim Start** fragt es kurz bei GitHub nach, ob es eine neue Version gibt.\
  Heruntergeladen wird sie erst, wenn du dies bestätigst.\
  Auch diese Anfrage kannst du in den Einstellungen abschalten.
- **Neue Inhalte** lädt es, wenn du sie auf der Seite *Inhalte* auswählst.
- **Automatische Aktualisierung**, wenn du sie einschaltest (standardmäßig aus).\
  Dann prüft Fieldbook einmal pro Woche, ob es neue Inhalte gibt (auf Wunsch auch eine neue Fieldbook-Version), und fragt vorher oder lädt sie selbst, je nach Einstellung.\
  Mehr dazu unter [Automatische Aktualisierung](#automatische-aktualisierung-optional).
- **Links ins Internet** in einem Artikel: Fieldbook fragt die Adresse kurz an.\
  Mit Internet öffnet sie sich in einem neuen Tab, ohne erscheint ein kurzer Hinweis.

Verwendete Bausteine:
- [Kiwix](https://kiwix.org) (`kiwix-serve`) für die ZIM-Wissenspakete
- [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`) für die KI
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) mit Parakeet (NVIDIA) und Whisper (OpenAI) für die Spracheingabe
- [Piper](https://github.com/rhasspy/piper) mit freien Stimmen zum Vorlesen im Übersetzer
- [Protomaps / PMTiles](https://protomaps.com) und [MapLibre](https://maplibre.org) für die Karten
- [pdf.js](https://mozilla.github.io/pdf.js/) für den Text aus PDF-Büchern
- [GeoNames](https://www.geonames.org) für die Ortssuche

## Entwicklung

Der Code braucht keinen Build-Schritt.\
Zum Testen `app\Start.bat` starten.

- Startdatei mit Symbol neu bauen: `powershell -ExecutionPolicy Bypass -File tools\starter-bauen.ps1`
- Release-ZIP bauen: `powershell -ExecutionPolicy Bypass -File tools\release-bauen.ps1 -Version 0.1.0`
- Rückmeldungen: `tools/feedback-worker.js` läuft als Cloudflare Worker, die Adresse steht unter `feedback` in `app/config/fieldbook.json` (leer = Formular aus)
- Neue Wissenspakete: Eintrag in `app/config/pakete.json` mit `name` und `flavour` wie im [Kiwix-Katalog](https://library.kiwix.org)
- Eigene ZIM-Dateien kann man einfach in `daten\wissen` legen.\
  Sie werden automatisch eingebunden.

## Automatische Aktualisierung (optional)

Hält die Inhalte aktuell (Wissenspakete, Karten, Wegedaten).\
Im Assistenten ganz am Anfang einschaltbar oder später in den Einstellungen im Kasten *Inhalte*, standardmäßig aus.\
Es gibt keinen Autostart und kein Programm, das dauerhaft im Hintergrund läuft.\
Stattdessen legt Fieldbook zwei Aufgaben in der Windows-Aufgabenplanung an:

| Aufgabe | Wann | Was |
|---|---|---|
| *Fieldbook Daten pruefen* | einmal pro Woche (Sonntag 19 Uhr oder beim nächsten Einschalten) | ein paar kleine Anfragen, dauert unter einer Sekunde; im Modus „Vorher fragen“ danach ein Pop-up |
| *Fieldbook Daten herunterladen* | nur wenn der Computer 10 Minuten unbenutzt am Strom hängt | lädt freigegebene Daten mit niedrigster Priorität; bei Maus, Tastatur oder Akkubetrieb sofort Pause, beim nächsten Leerlauf geht es weiter |

Nicht über getaktete Verbindungen (z. B. Handy-Hotspot).\
Aktualisiert werden Wissenspakete (neue Ausgaben im Kiwix-Katalog), Wegedaten (höchstens monatlich) und Karten (etwa halbjährlich).\
Ausschalten in den Einstellungen entfernt beide Aufgaben wieder.\
Protokoll: `daten\logs\aktualisierung.log`.

## Programm-Updates (Fieldbook selbst)

**Du entscheidest über Updates**\
Fieldbook spielt nie eine neue Version ein, ohne dass du zugestimmt hast.\
Beim Start fragt es nur kurz bei GitHub nach, ob es eine neue Version gibt, und zeigt dann einen Hinweis (in den Einstellungen im Kasten *Fieldbook-Programm*).\
Heruntergeladen und eingespielt wird sie erst, wenn du dies bestätigst.\
Möchtest du auch diese kurze Anfrage nicht, schaltest du sie dort bei *Beim Start nach neuer Fieldbook-Version fragen* aus.\
Dann sucht Fieldbook nur noch, wenn du selbst auf *Nach neuer Version suchen* klickst oder die automatische Aktualisierung neue Versionen mitladen darf.

**Mit automatischer Aktualisierung**\
Die automatische Aktualisierung ist für die Inhalte gedacht (Wissenspakete, Karten, Wegedaten) und standardmäßig aus.\
Ist sie eingeschaltet, kann sie auch neue Fieldbook-Versionen mitladen: Schalter *Neue Fieldbook-Versionen bei der automatischen Aktualisierung mitladen* im Kasten *Fieldbook-Programm*.\
Im Modus „Vorher fragen“ fragt Fieldbook dich, im Modus „Automatisch herunterladen“ lädt es die neue Version selbst und spielt sie beim nächsten Start ein.\
Schaltest du das Mitladen aus, aktualisiert die Automatik nur noch Inhalte.

**So läuft ein Update ab**\
Fieldbook sucht in den GitHub-Releases nach den Dateien `Fieldbook-<version>.zip` und `Fieldbook-<version>.zip.sha256` (beide erzeugt `tools\release-bauen.ps1`).

1. Herunterladen und Prüfsumme kontrollieren, dann unter `daten\cache\update\bereit` ablegen.
2. Fieldbook startet neu.\
   `app\start.ps1` sichert den bisherigen Programmteil nach `daten\cache\update\sicherung` und spielt die neue Version ein, **bevor** der Server geladen wird.
3. Lässt sich die neue Version nicht laden, wird automatisch die Sicherung wiederhergestellt.

Der Ordner `daten` wird dabei nie verändert.\
Im Git-Entwicklungsordner sind Programm-Updates gesperrt.\
Das Repository steht in [`app/config/fieldbook.json`](app/config/fieldbook.json) (`"github": "wobix08/Fieldbook"`).

## Länder und Sprachen

Vorerst ist Fieldbook auf Deutsch und für Deutschland, Österreich und die Schweiz eingerichtet.\
Für andere Länder ist es vorbereitet:

- Das Land wird aus der Windows-Regionseinstellung erkannt und lässt sich im Assistenten und in den Einstellungen ändern.
- Notrufnummern und die vorgeschlagene Karte kommen aus [`app/config/laender.json`](app/config/laender.json).\
  Ein neues Land braucht nur einen Eintrag dort (`"aktiv": true`).\
  In den Erste-Hilfe-Texten steht `{notruf}`, das durch die Nummer des Landes ersetzt wird.
- Sprachen: Deutsch und Englisch.\
  Die Antwortsprache der KI folgt der Sprache des Landes.\
  Die Oberfläche selbst ist noch nicht übersetzt.

## Datenschutz

Fieldbook läuft auf deinem Gerät.\
Fragen an die KI, Chats und alles, was du in Fieldbook einträgst, bleiben dort und werden nie übertragen.\
Aufnahmen der Spracheingabe werden auf deinem Gerät erkannt und gleich danach gelöscht.\
Ins Internet geht Fieldbook nur für Downloads, für die Frage nach einer neuen Version, für Rückmeldungen, die du selbst abschickst, und für Fehlerberichte und Nutzungsstatistik, wenn du zugestimmt hast.\
Klickst du in einem Artikel auf einen Link ins Internet, fragt Fieldbook diese Adresse kurz an, um zu sehen, ob es Internet gibt.\
Ohne Internet erscheint dann ein kurzer Hinweis statt einer Fehlerseite.

**Rückmeldungen**\
Was übertragen wird, steht im Formular unter *Was wird mitgeschickt?*:\
dein Text, auf Wunsch eine Kontaktadresse, die Fieldbook-Version, die Windows-Version, die Größe des Arbeitsspeichers, der Name der eingerichteten KI und, nur mit Haken, die Enden der Logdateien.\
In den Logdateien macht Fieldbook deinen Benutzernamen und deine Ordnerpfade unkenntlich.\
Schreib bitte nichts in den Text, was du nicht teilen möchtest.

**Fehlerberichte und Nutzungsstatistik**\
Beides ist aus, bis du es einschaltest (bei der Einrichtung oder unter *Einstellungen → Fieldbook-Programm*), und lässt sich dort jederzeit wieder ausschalten.\
Solange es aus ist, sammelt Fieldbook auch nichts.\
*Fehlerberichte* enthalten Fehler, die in Fieldbook auftreten (Benutzername und Ordnerpfade unkenntlich gemacht), dein Gerät (Prozessor, Kerne, Arbeitsspeicher, Grafik), die Windows-Version und wie schnell die KI lädt und antwortet.\
Die *Nutzungsstatistik* enthält, wie oft du die einzelnen Bereiche öffnest, welche Wissenspakete und Karten installiert sind (selbst hinzugefügte Pakete nur als „eigenes Paket“) und dein Land.\
Nie dabei sind Fragen, Chats, Suchbegriffe, gelesene Artikel, Orte oder Einträge.\
Fieldbook zählt auf deinem Gerät mit und schickt einmal pro Woche ein kleines Paket, nie über eine getaktete Verbindung wie einen Handy-Hotspot.\
Das nächste Paket kannst du dir unter *Was wird gesendet?* genau ansehen.\
Statt eines Namens trägt es eine zufällige Kennung, damit ein Gerät nicht doppelt gezählt wird; du kannst sie jederzeit neu würfeln.\
Schaltest du beides aus, löscht Fieldbook alles bisher Gesammelte.

**Wohin die Daten gehen**\
Rückmeldungen und Wochenpakete laufen über einen kleinen Dienst bei Cloudflare (`fieldbook-feedback.wobix08.workers.dev`, Quellcode in [`tools/feedback-worker.js`](tools/feedback-worker.js)).\
Cloudflare verarbeitet dabei wie jeder Internetdienst deine IP-Adresse, um die Anfrage zuzustellen ([Datenschutz bei Cloudflare](https://www.cloudflare.com/de-de/privacypolicy/)).\
Der Dienst selbst speichert die IP-Adresse nicht.\
Gegen Missbrauch zählt er nur einen unumkehrbaren Kurzwert, der nach spätestens einer Stunde von selbst gelöscht wird.\
Die Rückmeldung landet als Eintrag in einem privaten GitHub-Repository, das nur der Entwickler sehen kann ([Datenschutz bei GitHub](https://docs.github.com/de/site-policy/privacy-policies/github-general-privacy-statement)).\
Sie wird nicht veröffentlicht, nicht weitergegeben und nur genutzt, um Fieldbook zu verbessern und dir auf Wunsch zu antworten.\
Die Wochenpakete landen in einer Datenbank bei Cloudflare (D1), die nur der Entwickler auswerten kann.\
Ist eine Fehlerart neu, legt der Dienst dafür zusätzlich einen Eintrag im privaten Repository an (nur der Fehlertext, Version, Windows und Gerät).

**Wie lange und wie löschen**\
Rückmeldungen werden gelöscht, sobald sie erledigt sind, spätestens nach zwei Jahren.\
Wochenpakete löscht der Dienst nach einem Jahr von selbst.\
Möchtest du, dass etwas früher gelöscht wird, schreib das in eine Rückmeldung (bei der Statistik mit der Kennung aus *Was wird gesendet?*) oder melde dich über das GitHub-Konto [wobix08](https://github.com/wobix08).

**Ohne Zustimmung**\
Schickst du keine Rückmeldung ab und lässt Fehlerberichte und Nutzungsstatistik aus, wird nichts übertragen.

## Lizenz

Der Code dieses Projekts steht unter der [MIT-Lizenz](LICENSE).\
Die heruntergeladenen Programme und Inhalte haben eigene Lizenzen, siehe [THIRD-PARTY.md](THIRD-PARTY.md).
