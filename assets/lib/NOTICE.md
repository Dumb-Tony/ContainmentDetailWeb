# Vendored third-party libraries

This project makes **almost zero external requests at runtime**. Everything it needs is
committed here; nothing in this directory is loaded from a CDN. A solo operation contacts
nothing at all. The exceptions are the multiplayer connection hosts described below.

⚠ **THIS PAGE USED TO SAY "EXACTLY ONE NETWORK HOST" AND THAT WAS NOT TRUE OF A SESSION.**
It was true of `src/net/net.js`, which names the signalling broker and nothing else, and the
sentence was written from the source file rather than from the software. `PEER_OPTS` sets
`host`, `port`, `secure` and `debug` and does **not** set `config`, so PeerJS falls back to
its own default ICE servers — a STUN server at `stun.l.google.com` and two TURN relays at
`eu-0.turn.peerjs.com` and `us-0.turn.peerjs.com`, all three of them in the vendored bytes
of `peerjs.min.js`. An online session can therefore reach **four** hosts, not one.
`tools/audit-tests.js` F27–F29 now assert all three are in the library, that `PEER_OPTS`
does not override them, and that the player-facing privacy page names them. See
`docs/licensing-audit.md`, finding 9.

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
sha256 | modified | copyright`, pipe-separated, one file per row. A file under `assets/`
with no row here is reported as unaccounted for.

The seventh column is the **exact copyright line the vendored file itself carries**, or
the literal token `none-in-vendored-file` when it carries none. It is not decorative:
when a real line is recorded the audit requires that exact string to appear both inside
the library and inside the `LICENSE` beside it, and when `none-in-vendored-file` is
recorded the audit re-measures that the library really contains no copyright string at
all. Both directions are checked, because **a fabricated attribution is a worse outcome
than a recorded gap** and the only way to keep that true is to make the gap cost nothing
to admit and make the fabrication fail a test.

```audit
peerjs-1.5.4/peerjs.min.js | MIT | 1.5.4 | 92873 | 9588f29cd17cb3505066b5513a536b106b5f77fd68392b2c4757ad7da2bc0154 | no | none-in-vendored-file
r128/three.min.js | MIT | 128 | 603451 | 7ae04663bb431808bc025280122162029ea3a354efc5fcca8bd8f95d1a1933e9 | no | Copyright 2010-2021 Three.js Authors
```

---

## The licence text travels with the code

MIT is not satisfied by a table. It requires the copyright notice and the permission
notice to **accompany the software**, and a licence recorded one directory up from the
`.js` accompanies nothing. So each library directory carries its own `LICENSE`:

| File | Copyright line | Source of that line |
|---|---|---|
| `r128/LICENSE` | `Copyright 2010-2021 Three.js Authors` | transcribed verbatim from the `@license` header in the first five lines of `three.min.js` |
| `peerjs-1.5.4/LICENSE` | **none — recorded as UNKNOWN** | the vendored bundle carries no copyright notice; measured, the string `copyright` appears **zero** times in its 92,873 bytes |

⚠ **`peerjs-1.5.4/LICENSE` is a recorded gap and not a finished notice.** The bundle
embeds its own package metadata — `"license":"MIT"`, a homepage, a repository and a
contributors list beginning `Michelle Bu <michelle@michellebu.com>` — but a contributors
list is not a copyright line, and this project has not turned one into the other. Closing
it means fetching the upstream 1.5.4 release's own `LICENSE` and transcribing its
copyright line; that needs network access to an upstream artefact, which is the one thing
this audit is deliberately built not to require. Until then the gap prints on every audit
run and is carried in `docs/licensing-audit.md`.

`tools/licence-audit.ps1` section A checks that each declared library has a `LICENSE` in
its own directory, that the file carries the MIT permission and warranty text, and that
the copyright column agrees with both the library and the notice.

---

## Three.js r128 — `r128/three.min.js`

- **License:** MIT (Three.js authors). Full text in `r128/LICENSE`, with the copyright
  line transcribed from this file's own `@license` header: `Copyright 2010-2021 Three.js
  Authors`, `SPDX-License-Identifier: MIT`.
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

- **License:** MIT, on the library's own say-so — the bundle embeds `"license":"MIT"` in
  its package metadata. Permission text in `peerjs-1.5.4/LICENSE`. ⚠ **The copyright line
  is recorded as UNKNOWN**: the vendored file carries no copyright notice at all, and this
  project has not invented one. See the licence-text table above.
- **Version:** 1.5.4, and the string `"1.5.4"` is in the file.
- **SHA-256:** `9588f29cd17cb3505066b5513a536b106b5f77fd68392b2c4757ad7da2bc0154`
- **Size:** 92,873 bytes
- **Provenance:** copied from `Dev\Chameleon\assets\lib\peerjs.min.js`, the build Chameleon
  and Small Town Emergency Services both vendor.
- **Modified:** no.
- Loaded as a **classic** script by `index.html`, publishing `window.Peer`.

**The exception to "zero external requests".** WebRTC needs a signalling step: two browsers
cannot find each other without something to introduce them. `src/net/net.js` points at the
public PeerJS broker (`0.peerjs.com`) for that introduction and nothing else — once the
connection is up, every command and every snapshot goes browser to browser and the broker
never sees any of it. Nothing is fetched from it, no game state is sent to it, and a solo
operation never contacts it at all.

⚠ **The broker is not the only host a session reaches**, and the difference between "the
file names one host" and "the software reaches one host" is the whole of finding 9. Because
`PEER_OPTS` does not set `config`, connection setup also uses PeerJS's default ICE servers:

| Host | Role | Where it comes from |
|---|---|---|
| `0.peerjs.com` | signalling — introduces the two browsers | `PEER_OPTS` in `src/net/net.js`, by name |
| `stun.l.google.com` | address discovery | PeerJS's `defaultConfig`, in the vendored bytes |
| `eu-0.turn.peerjs.com` | relay, if no direct path exists | PeerJS's `defaultConfig` |
| `us-0.turn.peerjs.com` | relay, if no direct path exists | PeerJS's `defaultConfig` |

None of them is contacted by a solo operation, because nothing constructs a `Peer` until a
player hosts, joins, probes a room or advertises one. All four are named on the player-facing
privacy page in `content/site.json`, which is the only place it actually matters.

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
project, with one nuance worth stating: the design bible, the first anomaly, the first map
and the equipment manifest were **imported first-party from `Dumb-Tony/ContainmentDetail`**,
this project's own earlier Unity build, and each of those files records the revision it came
across at. Same author, same project, no third-party material at either end.

**Every file under `content/` now declares its provenance** — inline where it can, and from
`content/provenance.json` where it cannot, which is `content/locales/**` because those are
generated and a declaration inserted into a generated file survives until the next
generation. `tools/licence-audit.ps1 -Strict` is the §25.8 content-lock gate and it passes.

In particular **the anomalies are original and are not SCP articles**: every file
in `content/anomalies/` carries `licensingRecordId: null` *and a sentence saying why*, and
the designations in
`content/site.json` are all marked `(provisional)` because GDD §25.3 makes an attribution
record a prerequisite for a final designation and §25.7's ShareAlike questions are
unsettled. Nothing in this build prints a number it has not earned the right to print.

The audit checks that too, and it is not a formality: a designation losing its
`(provisional)` marker, or an `SCP-###` string appearing anywhere in `content/`, is the
exact moment this project would start making a licensing claim nobody has cleared. See
`tools/licence-audit.ps1` sections C and D, and `docs/licensing-audit.md` for the standing
findings and what is still open.
