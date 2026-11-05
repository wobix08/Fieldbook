# Anleitung: Fieldbook einrichten und benutzen

Diese Anleitung ist für alle gedacht, auch ohne Computer-Erfahrung.

---

## 1. Herunterladen und entpacken

1. Die Datei `Fieldbook-…zip` herunterladen.
2. Mit der rechten Maustaste auf die Datei klicken und **Alle extrahieren …** wählen.
3. Einen Ort auswählen, zum Beispiel `C:\Fieldbook` oder einen USB-Stick.\
   Auf dem Laufwerk sollte genug Platz frei sein, siehe Schritt 3.

Danach liegt im Ordner unter anderem die Datei **Fieldbook**.

## 2. Starten

Doppelklick auf **Fieldbook**.

### Beim allerersten Start: Windows-Warnung

Windows zeigt beim ersten Start sehr wahrscheinlich ein blaues Fenster:

> **Der Computer wurde durch Windows geschützt**\
> Von Microsoft Defender SmartScreen wurde der Start einer unbekannten App verhindert.

**Warum kommt die Warnung?**\
Windows warnt bei jedem Programm aus dem Internet, das noch nicht viele Menschen heruntergeladen haben oder das nicht mit einem kostenpflichtigen Zertifikat signiert ist.\
Die Meldung sagt nichts über einen Virus aus, sondern nur: „Microsoft kennt dieses Programm noch nicht.“\
Fieldbook ist ein kleines, freies Projekt.\
Woran du erkennst, dass es harmlos ist, steht in der README auf GitHub im Abschnitt **Ist das sicher?**.

So geht es weiter:

1. Auf **Weitere Informationen** klicken (kleiner Text unter der Meldung).
2. Unten erscheint der Knopf **Trotzdem ausführen**.\
   Darauf klicken.

Das musst du nur einmal machen.\
Danach startet Fieldbook ohne Nachfrage.

Wichtig: Fieldbook braucht **keine Administratorrechte**.\
Fragt Windows nach einem Administrator-Passwort, stimmt etwas nicht.\
Dann bitte abbrechen.

### Danach

- Unten in der Taskleiste erscheint ein kleines Fenster namens **Fieldbook**, es startet minimiert.\
  Darin läuft Fieldbook.\
  Lass es offen, solange du das Programm benutzt; schließt du es, wird Fieldbook beendet.\
  Zum Beenden gibt es außerdem den Aus-Knopf oben rechts in Fieldbook.
- Der Browser öffnet sich automatisch mit Fieldbook.\
  Ist Fieldbook dort schon offen, nimmt Fieldbook diesen Tab, statt einen neuen zu öffnen.

## 3. Einrichten (einmalig, mit Internet)

Der Assistent führt in sechs Schritten durch die Einrichtung:

1. **Dein Gerät**\
   Das Programm prüft Prozessor, Arbeitsspeicher, Grafikkarte und freien Platz.\
   Hier wählst du auch dein Land, ob ein **Symbol auf dem Desktop** angelegt werden soll und ob Fieldbook sich automatisch aktuell hält.
2. **KI-Assistent**\
   Die passende KI ist schon vorausgewählt („Empfohlen“).\
   Im Moment gibt es nur Qwen 3.5 (4B), das auf jedem Laptop mit 8 GB Arbeitsspeicher läuft.\
   Weitere KIs folgen, sobald sie getestet sind.\
   „Keine KI“ geht auch.
3. **Wissen**\
   Wähle die Bibliotheken aus.\
   Ein Klick auf eine Kategorie klappt ihre Pakete auf.\
   Oben steht ein Schalter mit **Nichts**, **Das Wichtigste**, **Alles** und **Eigene**, an jeder Stellung die Größe.\
   Vorausgewählt ist **Das Wichtigste**: Wikipedia, Medizin, Notlagen, Reparieren, Selbstversorgung, Lehrbücher, Kinderlexikon, Zitate und Reiseführer (etwa 31 GB, bei wenig Platz mit der kompakten Wikipedia etwa 17 GB).\
   Pakete mit mehreren Varianten (z. B. Wikipedia kompakt, ohne oder mit Bildern) stehen in einer Zeile mit eigenem Schalter.\
   Es ist immer nur eine Variante installiert: Wählst du eine andere, ersetzt sie nach dem Download die alte.\
   Änderst du einzelne Pakete, springt der Schalter auf **Eigene**.\
   Über **Eigene** kommst du später zu deiner Auswahl zurück.
4. **Karten**\
   Wähle ein oder mehrere Länder, ganz oben die Routenplanung.\
   Mehrere Länder werden auf der Karte nahtlos zusammen angezeigt.\
   Neben jedem Land steht die ungefähre Größe.\
   Der Schalter **Nichts**, **Alles** (Europa ganz und die Weltkarte) und **Eigene** wählt auf einen Klick.
5. **Sprachen**\
   **Artikel übersetzen** übersetzt englische Artikel aus der Bibliothek ins Deutsche (empfohlen), mit geladenen Sprachen auch weitere.\
   Darunter wählst du Sprachen für Gespräche, jeweils **Nur Text** oder **Text + Sprache** (mit Vorlesen), und die **Spracheingabe**.\
   Auch hier gibt es den Schalter **Nichts**, **Alles** und **Eigene**.\
   Das geht auch später unter **Inhalte**.
6. **Übersicht**\
   Prüfe deine Auswahl.\
   Darunter steht eine Bitte: Mit zwei Haken kannst du **Fehlerberichte** und eine **Nutzungsstatistik** erlauben, beide sind am Anfang aus.\
   Dann klicke auf **Einrichtung abschließen und herunterladen**.

Danach öffnet sich die Seite **Inhalte** mit dem Fortschritt der Downloads.\
Bis zu drei Downloads laufen gleichzeitig, kleine zuerst.\
Fertige Pakete kannst du sofort benutzen, auch wenn der Rest noch lädt.\
Du kannst das Fenster jederzeit schließen: Beim nächsten Start geht es an derselben Stelle weiter.\
Läuft gerade ein Download, zeigt oben in der Kopfzeile den Stand, etwa „40 %“; ein Klick darauf führt zu den Downloads.

## 4. Benutzen (offline)

### Fragen
Schreib eine Frage, zum Beispiel „Wie versorge ich eine Schnittwunde?“.\
Die KI sucht passende Artikel und antwortet mit Quellennummern wie [1].\
Klick auf eine Nummer öffnet den Artikel.\
Unter der Antwort stehen Suchbegriffe, mit denen du in der Bibliothek selbst weiterlesen kannst.\
Pakete aus PDF-Büchern (z. B. die Medizin-Handbücher) bereitet Fieldbook nach der Installation einmal für die KI vor.\
Das dauert ein, zwei Minuten, solange Fieldbook offen ist; oben im Bereich steht dann ein Hinweis.

- **Genau fragen:** Die KI auf deinem Gerät ist viel kleiner als große Online-KIs wie Claude oder ChatGPT.\
  Je genauer die Frage, desto besser die Antwort.\
  Also lieber „Radio lässt sich nicht einschalten, was kann ich prüfen?“ als „Radio reparieren“.
- **Neuer Chat** (links) beginnt ein neues Thema.\
  Im selben Chat versteht die KI Rückfragen wie „Und wenn ich kein Feuerzeug habe?“.\
  Für ein ganz anderes Thema lieber einen neuen Chat starten.
- **Frühere Chats** stehen links in der Liste (auf dem Handy unter **Verlauf**).\
  Ein Klick öffnet den Chat wieder, dort kannst du weiterfragen.\
  Mit ✕ löschst du einen Chat.\
  Die Chats liegen im Ordner `daten\chats` und wandern mit, wenn du Fieldbook auf einen USB-Stick kopierst.
- Eine Modellnummer oder einen Namen kannst du auch als eigene Nachricht hinterherschicken, zum Beispiel erst „Wie repariere ich einen Kühlschrank von LG?“ und dann „LFX25973“.
- **Lage** (unter dem Fragefeld) sagt der KI, was dir zur Verfügung steht: *Zuhause*, *Stromausfall* (keine Steckdose), *Draußen / unterwegs* (nur was du dabei hast oder findest) oder *Krise* (keine Läden, keine Hilfe).\
  Die KI erklärt immer, wie du es selbst machst, nicht wen du beauftragen sollst.
- **Einfach erklären** macht die Antwort kindgerecht, gut für den Unterricht.
- Auf schwachen Laptops dauert eine Antwort etwa 20 bis 60 Sekunden.

### Bibliothek
Die Pakete sind nach Themen sortiert: Grundwissen, Gesundheit & Erste Hilfe, Reparieren & Technik, Draußen & Überleben, Selbstversorgung & Haushalt, Lernen & Kinder sowie Beschäftigung & Lesen.\
Ein Klick auf eine Kategorie klappt ihre Pakete darunter auf, ein zweiter Klick klappt sie wieder zu.\
Ein Klick auf ein Paket klappt es ebenfalls auf: mit Suche im Paket, **Öffnen** und **Zufälliger Artikel**, bei manchen Paketen auch mit Themen zum direkten Einstieg.\
Über der Liste kannst du in allen Paketen gleichzeitig suchen.\
Das Klexikon öffnet eine eigene Startseite mit Themen, zwölf zufälligen Artikeln und allen Artikeln von A bis Z.\
Beim ersten Öffnen stellt Fieldbook die Liste einmal zusammen, das dauert etwa eine Minute.

**Lesen**\
Oben in der Mitte stehen **Startseite**, die Suche im geöffneten Paket und **Zufall**.\
Alle Artikel erscheinen in den Schriften und Farben von Fieldbook, hell oder dunkel wie der Rest.\
Bücher aus PDF-Paketen (z. B. Medizin-Handbücher, Knoten, Wasser) öffnen sich im eigenen PDF-Leser von Fieldbook.\
Bei diesen Paketen gibt es keinen Zufall, die Suche oben findet Stellen in allen Büchern des Pakets.\
Oben wählst du **Seite** (Text und Bilder an ihrem Platz wie im Buch) oder **Text** (nur der Text, wie ein Artikel).\
In der Seitenansicht steht der Text in Fieldbook-Schrift, du kannst ihn markieren und kopieren.\
Stellen, die sich nicht sauber nachbauen lassen (z. B. Tabellen), zeigt Fieldbook so, wie sie gedruckt sind.\
Im dunklen Design sind die Seiten dunkel mit heller Schrift, Fotos bleiben unverändert.\
**Original** zeigt die Seite genau so, wie sie gedruckt ist.\
Mit **−** und **+** machst du die Seiten kleiner oder größer, ein Klick auf die Prozentzahl stellt wieder die Fensterbreite ein.\
Fieldbook merkt sich die Größe für alle Bücher.\
Mit dem Suchfeld oben durchsuchst du das ganze Buch, ein Klick auf einen Treffer springt zur Seite.\
**Auf Deutsch** übersetzt den Text der Bücher offline, wie bei Artikeln.\
Bei Links ins Internet zeigt Fieldbook erst, wohin der Link führt.\
Mit **Im Browser öffnen** öffnet er sich in einem neuen Tab.\
Gibt es gerade kein Internet, zeigt Fieldbook stattdessen einen kurzen Hinweis.

**Fremdsprachige Artikel auf Deutsch lesen**\
Beim Lesen oben auf **Auf Deutsch** klicken.\
Der Artikel wird offline übersetzt, meist in wenigen Sekunden.\
Fieldbook erkennt die Sprache jedes Absatzes selbst und lässt deutsche Absätze stehen.\
Solange die Übersetzung an ist, werden auch weitere Artikel automatisch übersetzt, wenn du auf Links klickst.\
**Original** zeigt wieder den ursprünglichen Text.\
Die Übersetzung macht ein Programm, keine Person: Bei Fachbegriffen und Zahlen im Zweifel das Original prüfen.\
Dafür brauchst du **Artikel übersetzen** (42 MB), das wählst du im Assistenten oder unter **Inhalte** aus.\
Damit geht Englisch.\
Andere Sprachen gehen, wenn du sie unter **Inhalte** › **Übersetzer** lädst (z. B. Spanisch); fehlt eine, sagt Fieldbook das oben.

### Übersetzer
Hier führst du ein Gespräch in zwei Sprachen.\
Oben wählst du deine Sprache und die deines Gegenübers.\
Du schreibst links, dein Gegenüber rechts, jeweils mit **Übersetzen** oder der Eingabetaste.\
Mit der **Spracheingabe** (990 MB, unter **Inhalte** im Abschnitt **Übersetzer**) könnt ihr auch sprechen:\
Auf **Sprechen** klicken, sprechen, auf **Fertig** klicken.\
Der erkannte Text steht dann im Feld, du kannst ihn prüfen und mit **Übersetzen** abschicken.\
Beim ersten Mal fragt der Browser, ob Fieldbook das Mikrofon benutzen darf.\
Bei manchen Sprachen liegt die Erkennung oft daneben, darauf weist ein gelber Hinweis hin.\
Der Schalter **Chat | Groß** wählt die Ansicht:\
**Groß** zeigt die neueste Übersetzung groß in der Mitte über den Eingabefeldern.\
Darunter stehen Original und Rückübersetzung auf der Seite dessen, der geschrieben hat, und in seiner Sprache.\
Ältere Sätze stehen unter den Eingabefeldern, links in deiner Sprache, rechts in der deines Gegenübers.\
Ein Klick holt sie wieder groß nach oben.\
Der grüne Pfeil in der Mitte zeigt immer vom Original zur Übersetzung.\
**Chat** zeigt alle Sätze in zwei Spalten: links alles in deiner Sprache, rechts alles in der deines Gegenübers.\
Die Rückübersetzung steht unter dem Original, so kann der Absender beides direkt vergleichen.\
Mit dem Schiebeschalter ganz oben wechselst du von **Schreiben** zu **Sprechen**, dann geht es ohne Tippen und Klicken:\
Fieldbook hört zu, erkennt nach einer kurzen Sprechpause, wer welche Sprache gesprochen hat, übersetzt und liest die Übersetzung vor.\
Sprecht abwechselnd und macht nach jedem Satz eine kurze Pause.\
Während Fieldbook vorliest, hört es nicht zu; mit **Stop** schaltest du das Zuhören ab, mit **Weiter** wieder an.\
Beim Erkennen und Übersetzen hört es weiter zu: Redet jemand weiter, wird der neue Teil an seinen Satz angehängt und alles zusammen übersetzt und vorgelesen.\
Daneben stellst du die **Sprechpause** ein: **kurz** übersetzt schneller, schneidet aber bei Denkpausen ab; **lang** wartet geduldiger.\
Korrigieren kann man vorher nichts, deshalb im Sprechmodus besonders auf die Rückübersetzung achten.\
Das Mikrofon ist nur an, solange der Sprechmodus offen ist; beim nächsten Öffnen beginnt der Übersetzer wieder mit **Schreiben**.\
Zu jedem Satz gibt es eine **Rückübersetzung** in der Sprache dessen, der ihn geschrieben hat: Daran sieht er, ob der Sinn angekommen ist.\
**Vollbild** zeigt die Übersetzung bildschirmfüllend, dann kannst du den Laptop umdrehen.\
**Vorlesen** spricht die Übersetzung laut aus, ein zweiter Klick hält an.\
Dafür lädst du die Sprache unter **Inhalte** mit **Text + Sprache** statt **Nur Text** (die Stimme braucht etwa 60 bis 75 MB, Deutsch kommt einmal mit).\
Bei einer schon geladenen Sprache holst du die Stimme mit **+ Sprache** dazu.\
Für manche Sprachen gibt es keine freie Stimme, zum Beispiel Türkisch, Kroatisch und Arabisch; dort fehlt der Knopf.\
Weitere Sprachen lädst du mit **Sprachen hinzufügen** oben rechts (oder unter **Inhalte** im Abschnitt **Übersetzer**).\
Oben stehen die häufig gebrauchten, mit **Von Nord nach Süd** sortierst du um (erst Europa, dann der Rest).\
Eine Sprache braucht etwa 40 bis 75 MB, mit Stimme etwa 100 bis 150 MB (beides steht auf den Knöpfen).\
Englisch und **Artikel übersetzen** laden immer mit, weil über Englisch übersetzt wird.\
Japanisch, Koreanisch und Chinesisch gibt es noch nicht.\
Die Übersetzung macht ein Programm, keine Person: Bei kurzen Sätzen, Medikamenten und wichtigen Dingen lieber noch einmal anders nachfragen.

### Karten
Zoomen mit dem Mausrad, verschieben mit gedrückter Maustaste.\
Oben links nach Orten suchen.\
Alle installierten Länder sind zusammen zu sehen, mit **Springen zu …** kommst du schnell zu einem davon.\
Am Rand der geladenen Karten hält die Karte an, und ein Hinweis sagt, wie es weitergeht.\
Die Knöpfe wie „Arzt / Klinik“ oder „Apotheke“ zeigen Einrichtungen im sichtbaren Kartenausschnitt.\
Dafür vorher auf Stadt- oder Ortsebene hineinzoomen.

### Kochen
Unter **Was hast du da?** gibst du ein, was im Haus ist.\
Fieldbook sucht passende Rezepte im Koch-Wiki, zuerst die, für die du alles hast.\
Darunter stehen Faustregeln zu Trinkwasser, Vorräten und Kühlschrank im Stromausfall, auch ohne heruntergeladene Pakete.

### Erste Hilfe
Ganz oben stehen die Notrufnummern und Spickzettel für den Ernstfall mit je fünf Sofort-Schritten.\
Darunter folgt ein Kurs mit 12 Lektionen, Quiz und Fallbeispielen zum Üben.\
Er ersetzt keinen echten Erste-Hilfe-Kurs.

### Vorsorge
Checklisten zum Abhaken: Vorräte für 10 Tage (mit Vorratsrechner), Stromausfall, Aufbewahren, Dokumente und Notgepäck.\
Jedes Kapitel lässt sich ausdrucken.

## 5. Strom sparen

- Oben rechts siehst du den Akkustand.
- Strom braucht die KI vor allem, während sie antwortet: Dann rechnet der Laptop mit voller Kraft.\
  Wer Akku sparen will, stellt also lieber wenige, gezielte Fragen.
- Der **Sparmodus** schaltet die KI ganz ab und gibt den Arbeitsspeicher frei, den sie belegt.\
  Fragen an die KI gehen dann nicht, alles andere funktioniert wie gewohnt.\
  Einschalten: oben rechts auf „KI bereit“ klicken und „KI ausschalten (Sparmodus)“ wählen.\
  Im selben Menü wechselst du zwischen den installierten KIs.\
  Bei wenig Akku schlägt das Programm den Sparmodus selbst vor.
- Oben rechts wechselt der Knopf mit Sonne bzw. Mond zwischen heller und dunkler Ansicht.\
  Standard ist dunkel; hell ist zum Lesen und Lernen oft angenehmer.
- Bildschirmhelligkeit herunterdrehen spart am meisten.

## 6. Inhalte aktuell halten

Im ersten Schritt des Assistenten (oder später in den Einstellungen im Kasten **Inhalte**) kannst du **Inhalte automatisch aktuell halten** einschalten.\
Dann sieht Windows einmal pro Woche nach, ob es neue Ausgaben deiner Wissenspakete, Karten oder Wegedaten gibt.\
Wähle dann:

- **Vorher fragen**\
  Ein Fenster zeigt, was es Neues gibt, und fragt, ob es geladen werden soll.
- **Automatisch herunterladen**\
  Ohne Nachfrage, aber nie über getaktete Verbindungen wie einen Handy-Hotspot.

Außerdem wählst du, ob sofort im Hintergrund geladen wird oder nur, wenn der Computer am Strom hängt und gerade nicht benutzt wird.\
Geladen wird immer mit niedrigster Priorität, damit du normal weiterarbeiten kannst.\
Ohne Automatik geht es jederzeit von Hand mit **Inhalte aktualisieren**.

## 7. Später erweitern oder ändern

- Einstellungen (Zahnrad oben rechts) → **Inhalte hinzufügen oder aktualisieren** öffnet die Seite **Inhalte**.\
  Jeder Bereich klappt per Klick auf; zugeklappt steht darunter, was schon installiert ist.\
  Dort hakst du an, was neu dazukommen soll (Pakete, Karten für eine Reise, ein anderes KI-Modell, Routenplanung), und klickst auf **Auswahl herunterladen**.\
  Dort kannst du Inhalte auch löschen.\
  Neue Versionen werden markiert.
- **Einrichtung neu starten** (ebenfalls in den Einstellungen) führt noch einmal durch den ganzen Assistenten, zum Beispiel um die KI oder grundlegende Einstellungen zu ändern.\
  Bereits Installiertes bleibt erhalten und ist vorausgewählt.
- **Fieldbook selbst aktualisieren**\
  In den Einstellungen im Kasten **Fieldbook-Programm** steht, ob es eine neue Programmversion gibt.\
  Ein Klick lädt sie, Fieldbook startet kurz neu.\
  Deine Inhalte und Einstellungen bleiben erhalten.\
  Fieldbook fragt beim Start kurz nach einer neuen Version; das lässt sich dort mit **Beim Start nach neuer Fieldbook-Version fragen** abschalten.\
  Ist die automatische Aktualisierung der Inhalte eingeschaltet, kann sie neue Fieldbook-Versionen mitladen (Schalter **Neue Fieldbook-Versionen bei der automatischen Aktualisierung mitladen**).
- **Rückmeldung geben**\
  In den Einstellungen im Kasten **Fieldbook-Programm** kannst du über **Schreiben** dem Entwickler schreiben, was gut läuft, was nicht klappt oder was dir fehlt.\
  Eine Kontaktadresse ist freiwillig, gib sie an, wenn du eine Antwort möchtest.\
  Bei Fehlern hilft der Haken **Logdateien mitschicken**; unter **Was wird mitgeschickt?** steht genau, was dabei ist.\
  Ohne Internet merkt sich Fieldbook die Nachricht und schickt sie später.
- **Fehlerberichte und Nutzungsstatistik**\
  Im selben Kasten lassen sich beide ein- und ausschalten.\
  Unter **Was wird gesendet?** siehst du das nächste Wochenpaket genau so, wie es verschickt wird.\
  Schaltest du beides aus, löscht Fieldbook alles bisher Gesammelte.

## 8. Häufige Fragen

**Die Bibliothek sagt „Paket beschädigt“**\
Eine Datei ist unvollständig oder defekt, zum Beispiel nach einem Absturz beim Download.\
Fieldbook lässt sie aus und startet die anderen Pakete trotzdem.\
Unter **Inhalte** das betroffene Paket löschen und neu herunterladen.

**Der Browser öffnet sich nicht**\
Öffne ihn selbst und gib `http://localhost:8090` ein.

**„KI-Fehler“ oben rechts**\
Meist reicht der Arbeitsspeicher nicht.\
Andere Programme schließen, damit genug Arbeitsspeicher frei ist.\
Details stehen in `daten\logs\ki.log`.

**Kann ich den Ordner auf einen anderen Computer kopieren?**\
Ja.\
Den ganzen Ordner kopieren und dort **Fieldbook** doppelklicken.

**Kann ich eigene Wissenspakete hinzufügen?**\
Ja.\
ZIM-Dateien von [library.kiwix.org](https://library.kiwix.org) in den Ordner `daten\wissen` legen und Fieldbook neu starten.

**Wird etwas ins Internet geschickt?**\
Deine Fragen, Chats und Einträge nicht, sie bleiben auf deinem Gerät.\
Internet braucht Fieldbook nur für Downloads und um nach einer neuen Version zu fragen.\
Klickst du in einem Artikel auf einen Link ins Internet, fragt Fieldbook diese Adresse kurz an, um zu sehen, ob es Internet gibt.\
Eine **Rückmeldung** geht nur raus, wenn du sie selbst abschickst.\
Fehlerberichte und Nutzungsstatistik verschickt Fieldbook nur, wenn du zugestimmt hast, einmal pro Woche und nie über einen Handy-Hotspot.\
Was dabei übertragen wird, steht in der README auf GitHub im Abschnitt **Datenschutz**.
