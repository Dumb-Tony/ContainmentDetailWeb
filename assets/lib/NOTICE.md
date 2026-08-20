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

---

## PeerJS 1.5.4 — `peerjs-1.5.4/peerjs.min.js`

- **License:** MIT (PeerJS contributors)
- **Provenance:** copied from `Dev\Chameleon\assets\lib\peerjs.min.js`, the build Chameleon
  and Small Town Emergency Services both vendor.
- **SHA-256:** `9588f29cd17cb3505066b5513a536b106b5f77fd68392b2c4757ad7da2bc0154`
- **Size:** 92,873 bytes
- **Modified:** no.
- Loaded as a **classic** script by `index.html`, publishing `window.Peer`.

**The one exception to "zero external requests".** WebRTC needs a signalling step: two
browsers cannot find each other without something to introduce them. `src/net/net.js`
points at the public PeerJS broker (`0.peerjs.com`) for that introduction and nothing else
— once the connection is up, every command and every snapshot goes browser to browser and
the broker never sees any of it. Nothing is fetched from it, no game state is sent to it,
and a solo operation never contacts it at all.

That is a real change to a rule this project used to hold absolutely, so the suite states
it rather than letting it pass by accident: section K asserts that EXACTLY ONE file names
a network host, that it is this one, and that no game state is sent alongside it.
