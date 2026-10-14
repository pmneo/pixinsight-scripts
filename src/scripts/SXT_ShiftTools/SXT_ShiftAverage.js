// ============================================================================
// SXT_ShiftAverage.js  -  StarXTerminator mehrfach mit verschobenem Kachelraster
//
// Beobachtung: SXT teilt das Bild in ceil(Breite/512) x ceil(Hoehe/512) gleich
// grosse Bloecke auf. Das Raster haengt also von der Bildgroesse ab.
//
// Vorgehen: Das Bild wird gespiegelt um PAD Pixel vergroessert, dabei wird es
// pro Durchgang um (dx, dy) verschoben. Die Gesamtgroesse bleibt gleich, also
// verschiebt sich das SXT-Raster bei jedem Durchgang genau um (dx, dy).
// SXT laeuft jeweils auf dem GANZEN Bild, das Ergebnis wird zurueckgeschnitten
// und gemittelt. Dabei zaehlt jedes Pixel umso mehr, je naeher es an der Mitte
// seines SXT-Blocks lag; Blockkanten bekommen fast kein Gewicht.
//
// Ergebnis (neue Fenster):
//   <id>_sxt_avg     gewichteter Mittelwert aller Durchgaenge (sternlos)
//   <id>_sxt_stars   Original - avg
//
// Benutzung:
//   1. Optional: SXT-Einstellungen als Prozess-Icon "SXT" ablegen (Dreieck auf
//      den Arbeitsbereich ziehen, umbenennen). Ohne Icon: SXT-Standardwerte.
//      Tile Overlap wird immer auf 0 gesetzt, Generate Star Image immer aus -
//      die Ueberblendung macht dieses Skript.
//   2. Bild aktivieren, Script > Run Script File... > diese Datei.
//   Durchgaenge = (PAD/STEP)^2, mit den Standardwerten 16.
// ============================================================================

#feature-id    Utilities > SXT ShiftAverage
#feature-info  StarXTerminator mit verschobenem Kachelraster, Ergebnisse gewichtet gemittelt.

#include <pjsr/UndoFlag.jsh>

// ---------------------------- Einstellungen ---------------------------------
var STEP             = 64;   // Rasterverschiebung pro Durchgang (px)
var PAD              = 512;   // Gesamtpolster pro Achse (= eine Kachelperiode)
var TILE             = 512;   // maximale SXT-Blockgroesse
var ICON_NAME        = "SXT"; // Prozess-Icon mit deinen SXT-Einstellungen
var USE_GRID_WEIGHTS = true;  // Blockkanten abwerten (false = einfacher Mittelwert)
var EDGE_FLOOR       = 0.02;  // Gewicht direkt an einer Blockkante (Mitte = 1)
// ----------------------------------------------------------------------------

function reflect(i, L)
{
   while (i < 0 || i >= L)
   {
      if (i < 0) i = -i;
      if (i >= L) i = 2 * L - 2 - i;
   }
   return i;
}

function blockSize(L2)
{
   return L2 / Math.ceil(L2 / TILE);
}

// Gewicht jeder Bildspalte/-zeile im aktuellen Durchgang (sin^2 ueber den SXT-Block)
function axisWeights(L, L2, d)
{
   var s = blockSize(L2);
   var w = new Float32Array(L);
   for (var i = 0; i < L; ++i)
   {
      if (!USE_GRID_WEIGHTS) { w[i] = 1; continue; }
      var u = i + d + 0.5;
      var t = (u - Math.floor(u / s) * s) / s;
      var v = Math.sin(Math.PI * t);
      w[i] = EDGE_FLOOR + (1 - EDGE_FLOOR) * v * v;
   }
   return w;
}

function getSXT()
{
   var P = null;
   try { P = ProcessInstance.fromIcon(ICON_NAME); } catch (e) { P = null; }
   if (P == null)
   {
      console.warningln("Kein Prozess-Icon '" + ICON_NAME + "' gefunden - nutze SXT mit Standardwerten.");
      P = new StarXTerminator;
   }
   else
      console.writeln("SXT-Einstellungen aus Icon '" + ICON_NAME + "'.");
   try { P.stars = false; } catch (e) {}
   // Overlap immer auf 0 - die Ueberblendung uebernimmt dieses Skript
   if (typeof P.overlap !== "undefined")
   {
      if (P.overlap != 0)
         console.writeln("SXT Tile Overlap " + P.overlap + " -> 0 gesetzt.");
      P.overlap = 0;
   }
   else
      console.warningln("Parameter 'overlap' nicht gefunden - bitte Tile Overlap im SXT-Icon auf 0 stellen.");
   return P;
}

function showResult(id, arrays, W, H, isColor)
{
   var C = arrays.length;
   var w = new ImageWindow(W, H, C, 32, true, isColor, id);
   var v = w.mainView;
   v.beginProcess(UndoFlag_NoSwapFile);
   for (var c = 0; c < C; ++c)
      v.image.setSamples(arrays[c], new Rect(W, H), c);
   v.endProcess();
   w.show();
}

function fmtTime(sec)
{
   sec = Math.round(sec);
   var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
   return (h > 0 ? h + "h " : "") + m + "m " + s + "s";
}

function main()
{
   console.show();
   console.abortEnabled = true;

   var win = ImageWindow.activeWindow;
   if (win.isNull)
      throw new Error("Kein Bild aktiv.");
   var src = win.mainView.image;
   var id = win.mainView.id;
   var W = src.width, H = src.height, C = src.numberOfChannels;
   var isColor = src.isColor;
   var W2 = W + PAD, H2 = H + PAD;

   var offs = [];
   for (var d = 0; d < PAD; d += STEP)
      offs.push(d);
   var total = offs.length * offs.length;

   console.writeln("<b>SXT ShiftAverage</b>: " + W + "x" + H + ", " + total + " Durchgaenge");
   console.writeln(format("Erwartete SXT-Bloecke im Original: %.1f x %.1f px " +
                          "(mit deinem Preview vergleichen)", blockSize(W), blockSize(H)));
   console.writeln(format("Bloecke im gepolsterten Bild (%dx%d): %.1f x %.1f px",
                          W2, H2, blockSize(W2), blockSize(H2)));

   var P = getSXT();

   // Quelle einlesen, Akkumulatoren anlegen
   var srcA = [], sumA = [];
   for (var c = 0; c < C; ++c)
   {
      var a = new Float32Array(W * H);
      src.getSamples(a, new Rect(W, H), c);
      srcA.push(a);
      sumA.push(new Float32Array(W * H));
   }
   var wsum = new Float32Array(W * H);
   var b = new Float32Array(W2 * H2);
   var mx = new Int32Array(W2), my = new Int32Array(H2);

   var t0 = Date.now(), n = 0;
   for (var iy = 0; iy < offs.length; ++iy)
      for (var ix = 0; ix < offs.length; ++ix)
      {
         var dx = offs[ix], dy = offs[iy];

         // gespiegelt gepolstertes, verschobenes Bild erzeugen
         for (var x2 = 0; x2 < W2; ++x2) mx[x2] = reflect(x2 - dx, W);
         for (var y2 = 0; y2 < H2; ++y2) my[y2] = reflect(y2 - dy, H);

         var pw = new ImageWindow(W2, H2, C, 32, true, isColor, "sxt_shift_tmp");
         var pv = pw.mainView;
         pv.beginProcess(UndoFlag_NoSwapFile);
         for (var c = 0; c < C; ++c)
         {
            var a = srcA[c];
            for (var y2 = 0; y2 < H2; ++y2)
            {
               var srow = my[y2] * W, drow = y2 * W2;
               for (var x2 = 0; x2 < W2; ++x2)
                  b[drow + x2] = a[srow + mx[x2]];
            }
            pv.image.setSamples(b, new Rect(W2, H2), c);
         }
         pv.endProcess();

         // SXT auf das ganze Bild
         P.executeOn(pv, false);

         // zurueckschneiden und gewichtet aufsummieren
         var wx = axisWeights(W, W2, dx), wy = axisWeights(H, H2, dy);
         for (var c = 0; c < C; ++c)
         {
            pv.image.getSamples(b, new Rect(W2, H2), c);
            var s = sumA[c];
            for (var y = 0; y < H; ++y)
            {
               var o = y * W, o2 = (y + dy) * W2 + dx, wyv = wy[y];
               for (var x = 0; x < W; ++x)
               {
                  var w = wyv * wx[x];
                  s[o + x] += b[o2 + x] * w;
                  if (c == 0) wsum[o + x] += w;
               }
            }
         }
         pw.forceClose();
         ++n;

         var el = (Date.now() - t0) / 1000;
         console.writeln(format("Durchgang %d/%d (dx=%d, dy=%d)  vergangen %s, Rest ca. %s",
                                n, total, dx, dy, fmtTime(el), fmtTime(el / n * (total - n))));
         processEvents();
         if (console.abortRequested)
            throw new Error("Abgebrochen nach " + n + " Durchgaengen.");
      }

   // Mittelwert und Sterne
   var stars = [];
   for (var c = 0; c < C; ++c)
   {
      var s = sumA[c], a = srcA[c], st = new Float32Array(W * H);
      for (var i = 0; i < s.length; ++i)
      {
         s[i] = wsum[i] > 0 ? s[i] / wsum[i] : a[i];
         st[i] = Math.max(0, a[i] - s[i]);
      }
      stars.push(st);
   }
   showResult(id + "_sxt_avg", sumA, W, H, isColor);
   showResult(id + "_sxt_stars", stars, W, H, isColor);
   console.writeln("<b>Fertig</b> in " + fmtTime((Date.now() - t0) / 1000) + ".");
}

try
{
   main();
}
catch (e)
{
   console.criticalln(e.message || e);
}
