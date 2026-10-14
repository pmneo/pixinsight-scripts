# ASI2600 Scripts – PixInsight Script-Repository

Enthält:

- **SXT ShiftAverage** – StarXTerminator mehrfach mit verschobenem Kachelraster, gewichteter Mittelwert
- **SXT ShiftMedian** – wie oben, aber gewichteter Median

Menüeintrag nach Installation: `Script > Utilities > SXT ShiftAverage / SXT ShiftMedian`.

## Struktur

```
src/scripts/SXT_ShiftTools/*.js   Quellen (Pfad entspricht dem PixInsight-Installationsordner)
build-repository.ps1              erzeugt repository/updates.xri + repository/<datum>-all.zip
repository/                       Inhalt, der auf den Webserver kommt
```

## Repository veröffentlichen

1. `powershell -ExecutionPolicy Bypass -File build-repository.ps1`
2. Den Ordner `repository/` auf einen Webserver legen, z. B. GitHub Pages
   (URL dann `https://<user>.github.io/<repo>/`, die `updates.xri` liegt direkt darin).
3. In PixInsight: `Resources > Updates > Manage Repositories > Add`, URL **mit abschließendem `/`** eintragen.
4. `Resources > Updates > Check for Updates` installiert die Skripte.

Bei jeder neuen Version das Skript erneut ausführen und `repository/` neu hochladen
(die zip bekommt das Datum im Namen, die SHA-1 wird automatisch in der `updates.xri` aktualisiert).

## Hinweise

- Voraussetzung: StarXTerminator ist installiert.
- Optional ein Prozess-Icon namens `SXT` mit eigenen SXT-Einstellungen anlegen.
- Versionsbereich in `build-repository.ps1` (`$pixVersion`) ggf. an die eigene PixInsight-Version anpassen.

## Neues Skript hinzufügen

1. Ordner `src/scripts/<Name>/` anlegen (Vorlage: `src/scripts/_Template/NewScript.js` kopieren;
   Ordner mit `_`-Präfix wie `_Template` werden nicht ausgeliefert).
2. `#feature-id Kategorie > Name` und `#feature-info` im Skript setzen.
3. `build-repository.ps1` ausführen – alle `.js` unter `src/` landen automatisch im Paket.
