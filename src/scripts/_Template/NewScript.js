// ============================================================================
// NewScript.js  -  Short description
// ============================================================================

#feature-id    pmneoAstro > New Script
#feature-info  Short description for the feature dialog.

function main()
{
   console.show();
   var win = ImageWindow.activeWindow;
   if (win.isNull)
      throw new Error("No image is active.");
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
