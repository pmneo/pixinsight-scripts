// ============================================================================
// SXT_Shift.js  -  StarXTerminator with a shifted tile grid
//
// SXT splits the image into ceil(width/512) x ceil(height/512) blocks of equal
// size. This script enlarges the image by PAD pixels (mirrored) and shifts it by
// (dx, dy) in every pass. The total size stays the same, so the SXT grid moves by
// exactly (dx, dy) with every pass. SXT always runs on the WHOLE image, the result
// is cropped back and combined per pixel. A pixel counts the more, the closer it
// was to the center of its SXT block; block edges get almost no weight.
//
// Combination (selectable in the dialog):
//   Average  weighted mean, memory friendly (streams the passes)
//   Median   weighted median, a single outlier pass drops out
//            (keeps all passes in RAM: passes x image size)
//   Both     both, stars are computed from the median
//
// Result (new windows):
//   <id>_sxt_med     weighted median (starless)
//   <id>_sxt_avg     weighted mean (starless)
//   <id>_sxt_stars   original - result (median, otherwise mean), optional
//
// Usage:
//   1. Optional: save your SXT settings as a process icon named "SXT". Without an
//      icon the SXT defaults are used. Tile Overlap is always set to 0 and Generate
//      Star Image to off - this script does the blending.
//   2. Activate an image, then Script > pmneoAstro > SXT Shift.
// ============================================================================

#feature-id    pmneoAstro > SXT Shift
#feature-info  StarXTerminator with a shifted tile grid, results combined by weighted mean and/or median.

#include <pjsr/UndoFlag.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/DataType.jsh>

// Fixed values: SXT works with blocks of at most 512 px, shifting by one grid
// period covers all positions.
var TILE = 512;
var PAD  = 512;

var MODE_AVG = 0, MODE_MED = 1, MODE_BOTH = 2;
var STEP_CHOICES = [32, 64, 128, 256];

// ------------------------------ Parameters ----------------------------------
var P = {
   mode:        MODE_BOTH,
   step:        128,
   makeStars:   true,
   gridWeights: true,
   edgeFloor:   0.02,
   iconName:    "SXT",
   stripRows:   128
};

var SETTINGS_KEY = "SXTShift/";

function loadSettings()
{
   var v;
   v = Settings.read(SETTINGS_KEY + "mode", DataType_Int32);
   if (Settings.lastReadOK && v >= 0 && v <= 2) P.mode = v;
   v = Settings.read(SETTINGS_KEY + "step", DataType_Int32);
   if (Settings.lastReadOK && STEP_CHOICES.indexOf(v) >= 0) P.step = v;
   v = Settings.read(SETTINGS_KEY + "makeStars", DataType_Boolean);
   if (Settings.lastReadOK) P.makeStars = v;
   v = Settings.read(SETTINGS_KEY + "gridWeights", DataType_Boolean);
   if (Settings.lastReadOK) P.gridWeights = v;
   v = Settings.read(SETTINGS_KEY + "edgeFloor", DataType_Double);
   if (Settings.lastReadOK) P.edgeFloor = v;
   v = Settings.read(SETTINGS_KEY + "iconName", DataType_String);
   if (Settings.lastReadOK) P.iconName = v;
}

function saveSettings()
{
   Settings.write(SETTINGS_KEY + "mode",        DataType_Int32,   P.mode);
   Settings.write(SETTINGS_KEY + "step",        DataType_Int32,   P.step);
   Settings.write(SETTINGS_KEY + "makeStars",   DataType_Boolean, P.makeStars);
   Settings.write(SETTINGS_KEY + "gridWeights", DataType_Boolean, P.gridWeights);
   Settings.write(SETTINGS_KEY + "edgeFloor",   DataType_Double,  P.edgeFloor);
   Settings.write(SETTINGS_KEY + "iconName",    DataType_String,  P.iconName);
}

// ------------------------------- Helper functions ----------------------------
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

// Weight of every image column/row in the current pass (sin^2 over the SXT block)
function axisWeights(L, L2, d)
{
   var s = blockSize(L2);
   var w = new Float32Array(L);
   for (var i = 0; i < L; ++i)
   {
      if (!P.gridWeights) { w[i] = 1; continue; }
      var u = i + d + 0.5;
      var t = (u - Math.floor(u / s) * s) / s;
      var v = Math.sin(Math.PI * t);
      w[i] = P.edgeFloor + (1 - P.edgeFloor) * v * v;
   }
   return w;
}

function passCount(step)
{
   var n = Math.ceil(PAD / step);
   return n * n;
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
      throw new Error("Aborted (" + what + ").");
}

function getSXT()
{
   var X = null;
   try { X = ProcessInstance.fromIcon(P.iconName); } catch (e) { X = null; }
   if (X == null)
   {
      console.warningln("No process icon '" + P.iconName + "' found - using SXT with default values.");
      X = new StarXTerminator;
   }
   else
      console.writeln("SXT settings from icon '" + P.iconName + "'.");
   try { X.stars = false; } catch (e) {}
   if (typeof X.overlap !== "undefined")
   {
      if (X.overlap != 0)
         console.writeln("SXT Tile Overlap " + X.overlap + " -> set to 0.");
      X.overlap = 0;
   }
   else
      console.warningln("Parameter 'overlap' not found - please set Tile Overlap in the SXT icon to 0.");
   return X;
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

// ------------------------------- Dialog -------------------------------------
function ShiftDialog(W, H, C)
{
   this.__base__ = Dialog;
   this.__base__();

   var self = this;
   var labelWidth = this.font.width("Block edge weight:") + 8;

   this.windowTitle = "SXT Shift";

   this.helpLabel = new Label(this);
   this.helpLabel.frameStyle = FrameStyle_Box;
   this.helpLabel.margin = 6;
   this.helpLabel.wordWrapping = true;
   this.helpLabel.useRichText = true;
   this.helpLabel.text =
      "<b>SXT Shift</b><br>Runs StarXTerminator several times with a shifted tile grid " +
      "and combines the results by weight. Block edges get hardly any weight.";

   // Mode
   this.modeLabel = new Label(this);
   this.modeLabel.text = "Combination:";
   this.modeLabel.minWidth = labelWidth;
   this.modeLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.modeCombo = new ComboBox(this);
   this.modeCombo.addItem("Average (weighted mean)");
   this.modeCombo.addItem("Median (weighted median)");
   this.modeCombo.addItem("Both");
   this.modeCombo.currentItem = P.mode;
   this.modeCombo.onItemSelected = function (i) { P.mode = i; self.updateInfo(); };
   this.modeSizer = new HorizontalSizer;
   this.modeSizer.spacing = 6;
   this.modeSizer.add(this.modeLabel);
   this.modeSizer.add(this.modeCombo, 100);

   // Step size
   this.stepLabel = new Label(this);
   this.stepLabel.text = "Step size (px):";
   this.stepLabel.minWidth = labelWidth;
   this.stepLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.stepCombo = new ComboBox(this);
   for (var i = 0; i < STEP_CHOICES.length; ++i)
      this.stepCombo.addItem(format("%d  (%d passes)", STEP_CHOICES[i], passCount(STEP_CHOICES[i])));
   this.stepCombo.currentItem = STEP_CHOICES.indexOf(P.step);
   this.stepCombo.onItemSelected = function (i) { P.step = STEP_CHOICES[i]; self.updateInfo(); };
   this.stepSizer = new HorizontalSizer;
   this.stepSizer.spacing = 6;
   this.stepSizer.add(this.stepLabel);
   this.stepSizer.add(this.stepCombo, 100);

   // Stars
   this.starsCheck = new CheckBox(this);
   this.starsCheck.text = "Create star image (original - result)";
   this.starsCheck.checked = P.makeStars;
   this.starsCheck.onClick = function (c) { P.makeStars = c; };

   // Weighting
   this.weightCheck = new CheckBox(this);
   this.weightCheck.text = "Down-weight block edges (off = plain mean)";
   this.weightCheck.checked = P.gridWeights;
   this.weightCheck.onClick = function (c) { P.gridWeights = c; self.edgeControl.enabled = c; };

   this.edgeControl = new NumericControl(this);
   this.edgeControl.label.text = "Block edge weight:";
   this.edgeControl.label.minWidth = labelWidth;
   this.edgeControl.setRange(0, 1);
   this.edgeControl.slider.setRange(0, 100);
   this.edgeControl.setPrecision(2);
   this.edgeControl.setValue(P.edgeFloor);
   this.edgeControl.toolTip = "Weight right at a block edge (block center = 1).";
   this.edgeControl.enabled = P.gridWeights;
   this.edgeControl.onValueUpdated = function (v) { P.edgeFloor = v; };

   // Icon
   this.iconLabel = new Label(this);
   this.iconLabel.text = "SXT process icon:";
   this.iconLabel.minWidth = labelWidth;
   this.iconLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.iconEdit = new Edit(this);
   this.iconEdit.text = P.iconName;
   this.iconEdit.toolTip = "Name of a process icon with your SXT settings. " +
                           "If not found: SXT default values.";
   this.iconEdit.onTextUpdated = function (t) { P.iconName = t; };
   this.iconSizer = new HorizontalSizer;
   this.iconSizer.spacing = 6;
   this.iconSizer.add(this.iconLabel);
   this.iconSizer.add(this.iconEdit, 100);

   // Info
   this.infoLabel = new Label(this);
   this.infoLabel.frameStyle = FrameStyle_Box;
   this.infoLabel.margin = 6;
   this.infoLabel.wordWrapping = true;
   this.infoLabel.useRichText = true;

   this.updateInfo = function ()
   {
      var K = passCount(P.step);
      var text = format("Image %d x %d, %d channel(s): <b>%d passes</b>", W, H, C, K);
      if (P.mode != MODE_AVG)
         text += format("<br>Memory for intermediate results: approx. <b>%.1f GB</b>",
                        K * W * H * C * 4 / 1073741824);
      self.infoLabel.text = text;
   };
   this.updateInfo();

   // Buttons
   this.okButton = new PushButton(this);
   this.okButton.text = "Start";
   this.okButton.defaultButton = true;
   this.okButton.onClick = function () { self.ok(); };

   this.cancelButton = new PushButton(this);
   this.cancelButton.text = "Cancel";
   this.cancelButton.onClick = function () { self.cancel(); };

   this.buttonSizer = new HorizontalSizer;
   this.buttonSizer.spacing = 6;
   this.buttonSizer.addStretch();
   this.buttonSizer.add(this.okButton);
   this.buttonSizer.add(this.cancelButton);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add(this.helpLabel);
   this.sizer.add(this.modeSizer);
   this.sizer.add(this.stepSizer);
   this.sizer.add(this.starsCheck);
   this.sizer.add(this.weightCheck);
   this.sizer.add(this.edgeControl);
   this.sizer.add(this.iconSizer);
   this.sizer.add(this.infoLabel);
   this.sizer.addSpacing(4);
   this.sizer.add(this.buttonSizer);

   this.adjustToContents();
   this.setMinWidth();
}
ShiftDialog.prototype = new Dialog;

// ------------------------------- Main run -----------------------------------
function main()
{
   console.show();
   console.abortEnabled = true;

   var win = ImageWindow.activeWindow;
   if (win.isNull)
      throw new Error("No image is active.");
   var src = win.mainView.image;
   var id = win.mainView.id;
   var W = src.width, H = src.height, C = src.numberOfChannels;
   var isColor = src.isColor, cs = src.colorSpace;
   var W2 = W + PAD, H2 = H + PAD;

   loadSettings();
   var dlg = new ShiftDialog(W, H, C);
   if (!dlg.execute())
      return;
   saveSettings();

   var wantAvg = P.mode != MODE_MED;
   var wantMed = P.mode != MODE_AVG;
   var store   = wantMed;   // the median needs all passes in RAM

   var offs = [];
   for (var d = 0; d < PAD; d += P.step)
      offs.push(d);
   var K = offs.length * offs.length;

   console.writeln(format("<b>SXT Shift</b>: %dx%d, %d passes, mode: %s, stars: %s",
                          W, H, K, ["Average", "Median", "Both"][P.mode],
                          P.makeStars ? "yes" : "no"));
   console.writeln(format("Expected SXT blocks in the original: %.1f x %.1f px, in the padded image: %.1f x %.1f px",
                          blockSize(W), blockSize(H), blockSize(W2), blockSize(H2)));
   if (store)
      console.writeln(format("Memory for the intermediate results: approx. %.1f GB",
                             K * W * H * C * 4 / 1073741824));

   var X = getSXT();

   // read the source
   var full = new Rect(W, H), full2 = new Rect(W2, H2);
   var srcA = [];
   for (var c = 0; c < C; ++c)
   {
      var a = new Float32Array(W * H);
      src.getSamples(a, full, c);
      srcA.push(a);
   }

   var passes = [];                    // median path: { img, wx, wy }
   var sumA = [], wsum = null;         // average path (streaming)
   if (!store)
   {
      for (var c = 0; c < C; ++c)
         sumA.push(new Float32Array(W * H));
      wsum = new Float32Array(W * H);
   }
   var b = new Float32Array(W2 * H2), crop = new Float32Array(W * H);
   var mx = new Int32Array(W2), my = new Int32Array(H2);

   // ---------------------------- SXT passes ---------------------------------
   var t0 = Date.now(), n = 0;
   for (var iy = 0; iy < offs.length; ++iy)
      for (var ix = 0; ix < offs.length; ++ix)
      {
         var dx = offs[ix], dy = offs[iy];
         for (var x2 = 0; x2 < W2; ++x2) mx[x2] = reflect(x2 - dx, W);
         for (var y2 = 0; y2 < H2; ++y2) my[y2] = reflect(y2 - dy, H);

         // create the mirror-padded, shifted image
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

         // SXT on the whole image
         X.executeOn(pv, false);

         var wx = axisWeights(W, W2, dx), wy = axisWeights(H, H2, dy);
         if (store)
         {
            // crop back and store as a pass
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
            passes.push({ img: img, wx: wx, wy: wy });
         }
         else
         {
            // crop back and accumulate with weights
            for (var c = 0; c < C; ++c)
            {
               pv.image.getSamples(b, full2, c);
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
         }
         pw.forceClose();
         ++n;

         var el = (Date.now() - t0) / 1000;
         console.writeln(format("Pass %d/%d (dx=%d, dy=%d)  elapsed %s, remaining approx. %s",
                                n, K, dx, dy, fmtTime(el), fmtTime(el / n * (K - n))));
         checkAbort("after " + n + " passes");
      }
   b = null; crop = null;

   // ------------------------------ Combining ---------------------------------
   if (!store)
   {
      // average only
      var avg = newImage(W, H, C, cs);
      var stars = P.makeStars ? newImage(W, H, C, cs) : null;
      for (var c = 0; c < C; ++c)
      {
         var s = sumA[c], a = srcA[c], st = P.makeStars ? new Float32Array(W * H) : null;
         for (var i = 0; i < s.length; ++i)
         {
            s[i] = wsum[i] > 0 ? s[i] / wsum[i] : a[i];
            if (st) st[i] = Math.max(0, a[i] - s[i]);
         }
         avg.setSamples(s, full, c);
         if (st) stars.setSamples(st, full, c);
      }
      sumA = null;
      showResult(id + "_sxt_avg", avg, isColor);
      if (stars) showResult(id + "_sxt_stars", stars, isColor);
   }
   else
   {
      console.writeln("Combining (weighted median) ...");
      var t1 = Date.now();
      var STRIP = P.stripRows;
      var med   = newImage(W, H, C, cs);
      var avg   = wantAvg ? newImage(W, H, C, cs) : null;
      var stars = P.makeStars ? newImage(W, H, C, cs) : null;
      var strips = new Array(K);
      var v = new Float64Array(K), w = new Float64Array(K);
      var outM = new Float32Array(W * STRIP), outA = new Float32Array(W * STRIP);
      var outS = new Float32Array(W * STRIP), orig = new Float32Array(W * STRIP);
      var totalStrips = C * Math.ceil(H / STRIP), doneStrips = 0;

      for (var c = 0; c < C; ++c)
         for (var y0 = 0; y0 < H; y0 += STRIP)
         {
            var y1 = Math.min(H, y0 + STRIP), rows = y1 - y0, npx = rows * W;
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
                     // insertion sort by value, the weight moves along
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
                  if (wantAvg) outA[i] = sv / sw;
                  if (stars) outS[i] = Math.max(0, orig[i] - m);
               }
            }
            med.setSamples(outM, r, c);
            if (avg)   avg.setSamples(outA, r, c);
            if (stars) stars.setSamples(outS, r, c);

            ++doneStrips;
            if (doneStrips % 10 == 0 || doneStrips == totalStrips)
            {
               var el = (Date.now() - t1) / 1000;
               console.writeln(format("  %d%%  (remaining approx. %s)", Math.round(100 * doneStrips / totalStrips),
                                      fmtTime(el / doneStrips * (totalStrips - doneStrips))));
            }
            checkAbort("while combining");
         }

      passes = null; strips = null;
      showResult(id + "_sxt_med", med, isColor);
      if (avg)   showResult(id + "_sxt_avg", avg, isColor);
      if (stars) showResult(id + "_sxt_stars", stars, isColor);
   }

   console.writeln("<b>Done</b> in " + fmtTime((Date.now() - t0) / 1000) + ".");
}

try
{
   main();
}
catch (e)
{
   console.criticalln(e.message || e);
}
