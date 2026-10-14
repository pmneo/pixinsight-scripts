// ============================================================================
// NewScript.js  -  Kurzbeschreibung
// ============================================================================

#feature-id    Utilities > New Script
#feature-info  Kurzbeschreibung fuer den Feature-Dialog.

function main()
{
   console.show();
   var win = ImageWindow.activeWindow;
   if (win.isNull)
      throw new Error("Kein Bild aktiv.");
   console.writeln("<b>New Script</b> auf " + win.mainView.id);
}

try
{
   main();
}
catch (e)
{
   console.criticalln(e.message || e);
}
