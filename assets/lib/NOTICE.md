# Vendored third-party libraries

This project makes **zero external requests at runtime**. Everything it needs is committed
here. Nothing in this directory is loaded from a CDN, and `tools/m0-tests.js` section K
fails the build if any source file names a network host.

---

## Three.js r128 — `r128/three.min.js`

- **License:** MIT (Three.js authors)
- **Provenance:** copied from `Dev\MoversFromHell\assets\lib\r128\three.min.js`, which took
  it from `Dev\Chameleon\assets\lib\r128\three.min.js` — the same build Chameleon,
  Something's Different and Movers From Hell all vendor.
- **Why this exact revision:** r128 predates the colour-space and lighting overhaul, and
  every reusable renderer function catalogued in `Dev\INDEX.md` — `camOcclude`, `skelWalk`,
  `canvasTex`, `buildShell`, `stampProjected` — was written against it. Keeping r128 is
  what makes that reuse free.
- **Modified:** no.
- Loaded as a **classic** script by `index.html`, publishing `window.THREE`.

**What this build actually uses it for:** two cameras over one scene, layer masks to keep
the anomaly out of the visible spectrum, a scissored second viewport for the imager
screen, and a `CanvasTexture` carrying the sampled heat field. No loaders, no post
pipeline, no physics — the simulation is planar and lives in `src/sim/`, which does not
import this file at all.
