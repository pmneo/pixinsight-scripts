# ASI2600 Scripts – PixInsight script repository

Contains:

- **SXT Shift** – runs StarXTerminator several times with a shifted tile grid; weighted mean and/or median; parameters via dialog
- **Gaia Star Colors** – recolors a star image (e.g. SHO stars without background) with Gaia DR3 colors (BP−RP) to get RGB stars; the brightness stays from the image; parameters via dialog

Menu entries after installation: `Script > pmneoAstro > SXT Shift` and `Script > pmneoAstro > Gaia Star Colors`.

## Installation

1. In PixInsight open `Resources > Updates > Manage Repositories > Add` and enter
   `https://pmneo.github.io/pixinsight-scripts/repository/` (**with the trailing `/`**).
2. `Resources > Updates > Check for Updates` installs the scripts.

## Structure

```
src/scripts/SXT_ShiftTools/*.js   sources (the path matches the PixInsight installation folder)
src/scripts/Gaia_StarColors/*.js  dto.
build-repository.ps1              creates repository/updates.xri + repository/<date>-all.zip
repository/                       content that is served by the web server (GitHub Pages)
```

## Publishing the repository

1. `powershell -ExecutionPolicy Bypass -File build-repository.ps1`
2. Commit and push the sources and the `repository/` folder to `main`. GitHub Pages serves the root of the branch,
   so the update repository ends up at `https://pmneo.github.io/pixinsight-scripts/repository/`
   (the `updates.xri` lies directly inside).
3. In PixInsight use that URL (with the trailing `/`) as described under *Installation*.

For every new version run the build script again and push `repository/`
(the zip gets the date in its name, the SHA-1 in `updates.xri` is updated automatically).

## Notes

- Requirement for SXT Shift: StarXTerminator is installed.
- Optionally create a process icon named `SXT` with your own SXT settings.
- Requirements for Gaia Star Colors: PixInsight 1.9.5 or newer (V8 engine); the active image is a plate-solved
  stars-only image (ImageSolver); Gaia DR3 as a local XPSD database or online via VizieR.
  The result is a new window `<id>_RGB` with the astrometric solution and the STF of the source image.
  Stars without a Gaia entry (or without BP/RP) get a color estimated from their narrowband color: from the matched
  stars the script learns `BP−RP ≈ a + b·log(C3/C2) + c·log(C1/C2)` (e.g. O/H and S/H for SHO). The console prints R²;
  if the relation is too weak (R² < 0.2) these stars stay neutral.
- Adjust the version range in `build-repository.ps1` (`$pixVersion`) to your own PixInsight version if necessary.

## Adding a new script

1. Create a folder `src/scripts/<Name>/` (template: copy `src/scripts/_Template/NewScript.js`;
   folders with a `_` prefix such as `_Template` are not shipped).
2. Set `#feature-id Category > Name` and `#feature-info` in the script.
3. Run `build-repository.ps1` – all `.js` files under `src/` end up in the package automatically.
