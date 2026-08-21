# Vendored third-party libraries

This project makes **almost zero external requests at runtime**. Everything it needs is
committed here; nothing in this directory is loaded from a CDN. The one exception is the
signalling broker described below, and it is named in exactly two shipped files.

`tools/licence-audit.ps1` checks every claim on this page against the tree and exits
non-zero if any of them has stopped being true. `tools/m0-tests.js` section K6 asserts the
network rule from inside the browser. Run both:

```
powershell -ExecutionPolicy Bypass -File tools/licence-audit.ps1
powershell -ExecutionPolicy Bypass -File tools/smoketest.ps1 -Tests tools/m0-tests.js -Port 8495
```

---

## The audit table

⚠ **THIS BLOCK IS READ BY A SCRIPT, AND IT IS THE POINT OF THE PAGE.** Prose ages and
nobody diffs it. `tools/licence-audit.ps1` parses the rows below, hashes each file on
disk, and fails if a size, a digest or a version string has moved — which is the only
mechanism that catches a vendored library being edited in place, upgraded without a note,
or swapped for a build nobody chose. Columns are `path | licence | version | bytes |
sha256 | modified`, pipe-separated, one file per row. A file under `assets/` with no row
here is reported as unaccounted for.

```audit
peerjs-1.5.4/peerjs.min.js | MIT | 1.5.4 | 92873 | 9588f29cd17cb3505066b5513a536b106b5f77fd68392b2c4757ad7da2bc0154 | no
r128/three.min.js | MIT | 128 | 603451 | 7ae04663bb431808bc025280122162029ea3a354efc5fcca8bd8f95d1a1933e9 | no
```

---

## Three.js r128 — `r128/three.min.js`

- **License:** MIT (Three.js authors)
- **Version:** r128. Verifiable inside the file: it minifies to `REVISION=e` with `e="128"`,
  and the audit checks for that string rather than trusting the directory name.
- **SHA-256:** `7ae04663bb431808bc025280122162029ea3a354efc5fcca8bd8f95d1a1933e9`
- **Size:** 603,451 bytes
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
- **Version:** 1.5.4, and the string `"1.5.4"` is in the file.
- **SHA-256:** `9588f29cd17cb3505066b5513a536b106b5f77fd68392b2c4757ad7da2bc0154`
- **Size:** 92,873 bytes
- **Provenance:** copied from `Dev\Chameleon\assets\lib\peerjs.min.js`, the build Chameleon
  and Small Town Emergency Services both vendor.
- **Modified:** no.
- Loaded as a **classic** script by `index.html`, publishing `window.Peer`.

**The one exception to "zero external requests".** WebRTC needs a signalling step: two
browsers cannot find each other without something to introduce them. `src/net/net.js`
points at the public PeerJS broker (`0.peerjs.com`) for that introduction and nothing else
— once the connection is up, every command and every snapshot goes browser to browser and
the broker never sees any of it. Nothing is fetched from it, no game state is sent to it,
and a solo operation never contacts it at all.

That is a real change to a rule this project used to hold absolutely, so it is asserted
rather than assumed, twice and from two directions:

- `tools/m0-tests.js` section K6 reads every **source** file in the browser, strips the
  comments, and requires that exactly one of them names a network host and that it is
  `src/net/net.js`. K7 requires that no game state is sent alongside the broker options.
- `tools/licence-audit.ps1` section B does the same sweep over **everything shipped**,
  which is the wider net: `assets/lib/**` is not on K6's file list, so the audit is what
  notices that `peerjs.min.js` itself names `0.peerjs.com`. Two shipped files name a host —
  the broker setting and the library that dials it — and a third would fail the audit.

⚠ The two checks overlap on purpose and neither replaces the other. K6 runs in a browser
against the module graph the game actually loads; the audit runs over the tree, including
the files no ES module imports. A build that passed only one of them would have a hole in
exactly the shape of the other.

---

## What is NOT third-party

Everything under `src/`, `content/`, `tools/`, `index.html` and `docs/` is original to this
project. In particular **the anomalies are original and are not SCP articles**: every file
in `content/anomalies/` carries `licensingRecordId: null`, and the designations in
`content/site.json` are all marked `(provisional)` because GDD §25.3 makes an attribution
record a prerequisite for a final designation and §25.7's ShareAlike questions are
unsettled. Nothing in this build prints a number it has not earned the right to print.

The audit checks that too, and it is not a formality: a designation losing its
`(provisional)` marker, or an `SCP-###` string appearing anywhere in `content/`, is the
exact moment this project would start making a licensing claim nobody has cleared. See
`tools/licence-audit.ps1` sections C and D, and `docs/licensing-audit.md` for the standing
findings and what is still open.
