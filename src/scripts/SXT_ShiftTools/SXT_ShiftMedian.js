// ============================================================================
// SXT_ShiftMedian.js  -  StarXTerminator mit verschobenem Kachelraster,
//                         Ergebnisse per gewichtetem MEDIAN kombiniert
//
// Wie SXT_ShiftAverage: Das Bild wird gespiegelt um PAD Pixel vergroessert und
// pro Durchgang um (dx, dy) verschoben, damit das SXT-Kachelraster jedes Mal
// woanders liegt. SXT laeuft jeweils auf dem ganzen Bild.
//
// Unterschied: Alle Durchgaenge werden im Speicher gehalten und am Ende pro
// Pixel per GEWICHTETEM MEDIAN kombiniert. Ein einzelner Durchgang, in dem SXT
// einen Stern stehen laesst oder eine Kachel daneben liegt, faellt damit
// heraus, statt (wie beim Mittelwert) anteilig durchzuschlagen.
// Gewicht je Durchgang und Pixel: hoch in der Mitte des SXT-Blocks, fast 0 an
// der Blockkante.
//
// Ergebnis (neue Fenster):
//   <id>_sxt_med     gewichteter Median (sternlos)        <- Hauptergebnis
//   <id>_sxt_avg     gewichteter Mittelwert (zum Vergleich)
//   <id>_sxt_stars   Original - med
//
// Speicherbedarf: Durchgaenge x Bildgroesse, bei 6105x3987 RGB und 16
// Durchgaengen ca. 4.7 GB RAM. Wird vorab in der Konsole angezeigt.
//
// Benutzung:
//   1. Optional: SXT-Einstellungen als Prozess-Icon "SXT" ablegen. Ohne Icon:
//      SXT-Standardwerte. Tile Overlap wird immer auf 0 gesetzt, Generate
//      Star Image immer aus.
//   2. Bild aktivieren, Script > Run Script File... > diese Datei.
// ============================================================================

#feature-id    Utilities > SXT ShiftMedian
#feature-info  StarXTerminator mit verschobenem Kachelraster, gewichteter Median.

#include <pjsr/UndoFlag.jsh>
#include <pjsr/SampleType.jsh>

// ---------------------------- Einstellungen ---------------------------------
var STEP       = 128;   // Rasterverschiebung pro Durchgang (px) -> (PAD/STEP)^2 Durchgaenge
var PAD        = 512;   // Gesamtpolster pro Achse (= eine Kachelperiode)
var TILE       = 512;   // maximale SXT-Blockgroesse
var ICON_NAME  = "SXT"; // Prozess-Icon mit deinen SXT-Einstellungen
var EDGE_FLOOR = 0.02;  // Gewicht direkt an einer Blockkante (Mitte = 1)
var STRIP_ROWS = 128;   // Zeilen pro Arbeitsstreifen beim Kombinieren
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

function axisWeights(L, L2, d)
{
   var s = blockSize(L2);
   var w = new Float32Array(L);
   for (var i = 0; i < L; ++i)
   {
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
      console.writeln("Kein Prozess-Icon '" + ICON_NAME + "' - nutze SXT mit Standardwerten.");
      P = new StarXTerminator;
   }
   else
      console.writeln("SXT-Einstellungen aus Icon '" + ICON_NAME + "'.");
   try { P.stars = false; } catch (e) {}
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

function newImage(W, H, C, colorSpace)
{
   return new Image(W, H, C, colorSpace, 32, SampleType_Real);
}

function showResult(id, image, isColor)
{
   var w = new ImageWindow(image.width, image.height, image.numberOfChannels,
                           32, true, isColor, id);
   w.mainView.beginProcess(UndoFlag_NoSwapFile);
   w.mainView.image.assign(image);
   w.mainView.endProcess();
   w.show();
}

function fmtTime(sec)
{
   sec = Math.round(sec);
   var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
   return (h > 0 ? h + "h " : "") + m + "m " + s + "s";
}

function checkAbort(what)
{
   processEvents();
   if (console.abortRequested)
      throw new Error("Abgebrochen (" + what + ").");
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
   var isColor = src.isColor, cs = src.colorSpace;
   var W2 = W + PAD, H2 = H + PAD;

   var offs = [];
   for (var d = 0; d < PAD; d += STEP)
      offs.push(d);
   var K = offs.length * offs.length;

   console.writeln("<b>SXT ShiftMedian</b>: " + W + "x" + H + ", " + K + " Durchgaenge");
   console.writeln(format("Erwartete SXT-Bloecke im Original: %.1f x %.1f px, im gepolsterten Bild: %.1f x %.1f px",
                          blockSize(W), blockSize(H), blockSize(W2), blockSize(H2)));
   console.writeln(format("Speicher fuer die Zwischenergebnisse: ca. %.1f GB",
                          K * W * H * C * 4 / 1073741824));

   var P = getSXT();

   // Quelle einlesen
   var full = new Rect(W, H), full2 = new Rect(W2, H2);
   var srcA = [];
   for (var c = 0; c < C; ++c)
   {
      var a = new Float32Array(W * H);
      src.getSamples(a, full, c);
      srcA.push(a);
   }

   var passes = [];   // { img, wx, wy }
   var b = new Float32Array(W2 * H2), crop = new Float32Array(W * H);
   var mx = new Int32Array(W2), my = new Int32Array(H2);

   // ---------------------------- SXT-Durchgaenge ----------------------------
   var t0 = Date.now(), n = 0;
   for (var iy = 0; iy < offs.length; ++iy)
      for (var ix = 0; ix < offs.length; ++ix)
      {
         var dx = offs[ix], dy = offs[iy];
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
            pv.image.setSamples(b, full2, c);
         }
         pv.endProcess();

         P.executeOn(pv, false);

         // zurueckschneiden und als Durchgang speichern
         var img = newImage(W, H, C, cs);
         for (var c = 0; c < C; ++c)
         {
            pv.image.getSamples(b, full2, c);
            for (var y = 0; y < H; ++y)
            {
               var o = y * W, o2 = (y + dy) * W2 + dx;
               for (var x = 0; x < W; ++x)
                  crop[o + x] = b[o2 + x];
            }
            img.setSamples(crop, full, c);
         }
         pw.forceClose();
         passes.push({ img: img, wx: axisWeights(W, W2, dx), wy: axisWeights(H, H2, dy) });
         ++n;

         var el = (Date.now() - t0) / 1000;
         console.writeln(format("Durchgang %d/%d (dx=%d, dy=%d)  vergangen %s, Rest ca. %s",
                                n, K, dx, dy, fmtTime(el), fmtTime(el / n * (K - n))));
         checkAbort("nach " + n + " Durchgaengen");
      }
   b = null; crop = null;

   // ---------------------- Gewichteter Median pro Pixel ----------------------
   console.writeln("Kombiniere (gewichteter Median) ...");
   var t1 = Date.now();
   var med = newImage(W, H, C, cs), avg = newImage(W, H, C, cs), stars = newImage(W, H, C, cs);
   var strips = new Array(K);
   var v = new Float64Array(K), w = new Float64Array(K);
   var outM = new Float32Array(W * STRIP_ROWS), outA = new Float32Array(W * STRIP_ROWS);
   var outS = new Float32Array(W * STRIP_ROWS), orig = new Float32Array(W * STRIP_ROWS);
   var totalStrips = C * Math.ceil(H / STRIP_ROWS), doneStrips = 0;

   for (var c = 0; c < C; ++c)
      for (var y0 = 0; y0 < H; y0 += STRIP_ROWS)
      {
         var y1 = Math.min(H, y0 + STRIP_ROWS), rows = y1 - y0, npx = rows * W;
         var r = new Rect(0, y0, W, y1);
         for (var k = 0; k < K; ++k)
         {
            if (!strips[k] || strips[k].length != npx)
               strips[k] = new Float32Array(npx);
            passes[k].img.getSamples(strips[k], r, c);
         }
         if (orig.length != npx)
         {
            orig = new Float32Array(npx); outM = new Float32Array(npx);
            outA = new Float32Array(npx); outS = new Float32Array(npx);
         }
         src.getSamples(orig, r, c);

         for (var yy = 0; yy < rows; ++yy)
         {
            var y = y0 + yy;
            for (var x = 0; x < W; ++x)
            {
               var i = yy * W + x;
               var sw = 0, sv = 0;
               for (var k = 0; k < K; ++k)
               {
                  var wk = passes[k].wy[y] * passes[k].wx[x];
                  var vk = strips[k][i];
                  sw += wk; sv += wk * vk;
                  // Einfuegesortierung nach Wert, Gewicht wandert mit
                  var j = k - 1;
                  while (j >= 0 && v[j] > vk) { v[j + 1] = v[j]; w[j + 1] = w[j]; --j; }
                  v[j + 1] = vk; w[j + 1] = wk;
               }
               var half = 0.5 * sw, cum = 0, m = v[K - 1];
               for (var k = 0; k < K; ++k)
               {
                  cum += w[k];
                  if (cum >= half) { m = v[k]; break; }
               }
               outM[i] = m;
               outA[i] = sv / sw;
               outS[i] = Math.max(0, orig[i] - m);
            }
         }
         med.setSamples(outM, r, c);
         avg.setSamples(outA, r, c);
         stars.setSamples(outS, r, c);

         ++doneStrips;
         if (doneStrips % 10 == 0 || doneStrips == totalStrips)
         {
            var el = (Date.now() - t1) / 1000;
            console.writeln(format("  %d%%  (Rest ca. %s)", Math.round(100 * doneStrips / totalStrips),
                                   fmtTime(el / doneStrips * (totalStrips - doneStrips))));
         }
         checkAbort("beim Kombinieren");
      }

   passes = null; strips = null;
   showResult(id + "_sxt_med",   med,   isColor);
   showResult(id + "_sxt_avg",   avg,   isColor);
   showResult(id + "_sxt_stars", stars, isColor);
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
