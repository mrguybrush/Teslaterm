# Teslaterm (tesla_flight fork)

Angepasste Teslaterm-Version mit zusätzlichen Features gegenüber dem Original (u.a. Flight Recording,
MIDI-Playlist, virtuelle Klaviatur, konfigurierbare Scope-Farben, Frequency/Debug-Tabs, editierbarer
`max_tr_pw`-Parameter).

- **Windows-Build (fertig zum Download)**: https://github.com/mrguybrush/Teslaterm/releases
- **Firmware direkt herunterladen**: https://raw.githubusercontent.com/mrguybrush/UD3/master/firmware-builds/UD3_TQFP.cyacd

## ⚠️ Firmware-Update ist notwendig

Diese Teslaterm-Version erwartet zusätzliche Telemetriekanäle (Temp2 und Fres/Resonanzfrequenz), die in
der originalen UD3-Firmware nicht gesendet werden. **Ohne das Firmware-Update fehlen diese Anzeigen bzw.
funktionieren falsch.** Vor der ersten Nutzung also die passende Firmware
([UD3_TQFP.cyacd](https://raw.githubusercontent.com/mrguybrush/UD3/master/firmware-builds/UD3_TQFP.cyacd))
auf die Platine flashen.

## Firmware aktualisieren

**Voraussetzung:** Die Verbindung zur UD3 läuft über Fibernet (WiFi-Modul), und **im Fibernet steckt eine
SD-Karte**. Ohne SD-Karte kann das Modul die übertragene Firmware-Datei nicht zwischenspeichern und der
Upload schlägt fehl (`FTPError: 550 can't create the file`).

1. `UD3_TQFP.cyacd` herunterladen (Link oben).
2. Teslaterm starten und **mit der Spule verbinden** (Fibernet-Verbindung muss aktiv sein).
3. Die heruntergeladene `.cyacd`-Datei per Drag & Drop **auf das Terminal-Fenster von Teslaterm ziehen**.
4. Die Übertragung startet automatisch; die Firmware wird hochgeladen und vom Bootloader geflasht.
5. Nach Abschluss verbindet sich die UD3 neu mit der aktualisierten Firmware.

> Falls stattdessen eine USB-Verbindung genutzt wird: gleicher Ablauf (Datei aufs Terminal ziehen), es
> läuft dann über den seriellen Bootloader statt über FTP - eine SD-Karte wird in dem Fall nicht benötigt.

## Nutzung

Nach dem Verbinden stehen unten mehrere Tabs zur Verfügung:

- **Terminal** – klassische Kommandozeile zur UD3
- **MIDI Playlist** – MIDI-Dateien importieren und automatisch nacheinander abspielen
- **Piano** – virtuelle Klaviatur (Maus oder Computertastatur), mit Transpose, Oktavierer, Slide Time
  (Portamento) und Arpeggio (Dur/Moll per AltGr), zentrales Tempo per BPM-Feld oder Tap-Button
- **Frequency** – Live-Darstellung der Resonanzfrequenz als Mini-Oszilloskop
- **Debug** – rohe Telemetrie- und Konfigurationswerte der Firmware zur Fehlersuche

Einstellungen (Fenstergröße, Scope-Farben, Dark Mode, automatisches Flight Recording) über den blauen
**Settings**-Button auf dem Verbindungsbildschirm.
