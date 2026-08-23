# Attribution and licence audit — standing record

GDD §23 Milestone 6 gates on *"complete attribution and license audit"*. §25.8 states the
licensing gate an Incident Package must clear before content lock. This is the record those
two clauses ask for, and it is generated-adjacent rather than generated: `tools/licence-audit.ps1`
re-derives everything checkable from the tree on every run, and this page holds the things a
script cannot know — who made an asset, and what is still open.

```
powershell -ExecutionPolicy Bypass -File tools/licence-audit.ps1           # is anything untrue?
powershell -ExecutionPolicy Bypass -File tools/licence-audit.ps1 -Strict   # is the §25.8 gate clear?
powershell -ExecutionPolicy Bypass -File tools/smoketest.ps1 -Tests tools/audit-tests.js -Port 8491
```

The two script runs answer different questions and both matter. The default run fails on
things that are wrong. `-Strict` fails on things that are not finished.

## ✅ Status: the §25.8 content lock is clear

**`-Strict` exits 0.** It reported **20 failures** before this pass and reports **0** now.
Milestone 6's content-lock condition is met.

| | before | after |
|---|---|---|
| `licence-audit.ps1 -Strict` | 20 failures | **0 failures, 0 warnings** |
| content files declaring provenance | 6 of 26 | **28 of 28** |
| vendored libraries shipping their licence text | 0 of 2 | **2 of 2** |
| §25.3 attribution database | did not exist | `content/provenance.json`, twelve fields, enforced |
| §25.8 gate | not answered anywhere | seven clauses, none open, checked every run |
| `audit-tests.js` | 241 assertions | **296 assertions** |

---

## The headline

**No SCP-derived material is in this build.** Every anomaly is original. Every
`licensingRecordId` in `content/` is `null` **and says in a sentence why it is null**, all
eight designations in `content/site.json` are marked `(provisional)`, and no `SCP-###`
string appears anywhere in `content/`. The audit checks all four of those on every run,
because the moment any of them changes is the moment this project starts making a licensing
claim nobody has cleared. It is not a formality: the check caught a sentence in
`content/provenance.json` that quoted the article number §25.6 warns about, which is exactly
the job.

Two libraries are vendored, both MIT, both unmodified, both hash-pinned in
`assets/lib/NOTICE.md`, and both now carrying their licence text in the directory beside the
code — with one recorded gap, finding 8.

---

## Standing findings

| # | Section | What | Status | Owner |
|---|---|---|---|---|
| 1 | C | `content/anomalies/graybox-draught.json` carried `licensingRecordId: null` with no `_licensingNote` | **fixed** | content |
| 2 | C | `content/anomalies/stillwater-figure.json` — same | **fixed** | content |
| 3 | C | Every incident package, map, locale, the equipment file and `site.json` declared no provenance at all | **fixed** — see below | content |
| 4 | E | Six screenshots in `docs/` had no asset record | fixed — recorded below | — |
| 5 | B | `three.min.js` names `www.w3.org` four times | not a finding — see below | — |
| 6 | — | §25.3's twelve-field attribution database did not exist as a file | **fixed** — `content/provenance.json` | production |
| 7 | — | §25.4's in-game notice was named by `content/site.json` and nothing rendered it | **content landed**, renderer outstanding | UI |
| 8 | A | `peerjs.min.js` carries **no copyright notice** and none has been invented | **open, recorded** | production |
| 9 | B | "reaches exactly one network host" is not true of a session | **prose fixed here; `README.md` still says it** | docs |
| 10 | — | Other players' typed callsigns persist in the host's campaign roster | **open** | progression |
| 11 | E | The install icons rasterise a glyph from a system typeface | **open, low risk, not cleared** | production |

### 1–3. Provenance, now declared everywhere

Every file under `content/` states where its material came from, in the shape the anomalies
already used — `licensingRecordId` plus a `_licensingNote` that says what the null means.
Sixteen files gained one in this pass: nine incident packages, four maps, the equipment
manifest, the onboarding file and `site.json`.

⚠ **A bare `null` and a missing field are indistinguishable, and that is the whole point of
the field.** `null` can mean *"we checked, it is original, here is why"* or *"nobody has
looked at this one yet"*, and §25.3 makes the record a prerequisite for implementation — so
the difference between those two readings is the difference between clearing the gate and
not. The audit now fails on a bare null anywhere in `content/`, not only in the anomalies.

Two files are covered from **outside** rather than inline, and the reason is worth
recording rather than treating as an exception:

> `content/locales/**` is generated and owned by the internationalisation work. A
> declaration inserted into a generated file survives until the next generation and then
> silently is not there — which is this audit's own failure mode arriving through the front
> door. So `content/provenance.json` covers them from where the coverage cannot be
> regenerated away.

The manifest is not a loophole. `licence-audit.ps1` section F fails a coverage entry that
names a file which is absent, that carries no reason, that carries no note, or **that names
a file which has since grown its own inline declaration** — because two statements of
provenance in two places is one more than can be kept true.

### 6. §25.3's attribution database now exists, with no rows

`content/provenance.json` carries the twelve required fields as a table. It has **no rows**,
which is a measurement rather than an oversight: nothing here is SCP-derived, so there is
nothing to record.

The value of an empty table is that the schema exists. The audit enforces the link in both
directions — every non-null `licensingRecordId` anywhere in `content/` must have a row whose
`recordId` matches, and every row must fill all twelve fields — so the first derived item
somebody proposes fails the audit until its record is written. **An absent table is what
lets that item ship with no record at all, because there is nothing for it to fail.**

### 7. §25.4's in-game notice — the content exists now

`content/site.json` gained a `notices` block: five documents (credits, attribution, privacy,
terms of use, support) as ordered sections of plain-text paragraphs and bullets, hung off the
Archive terminal, which is §25.4's *"accessible from the main menu, not buried exclusively in
end credits"*.

They are **content and not translation keys**, deliberately. Unlike the room furniture, these
are legal and privacy statements whose exact wording is the point, and a locale that
paraphrased one would be making a different claim.

`audit-tests.js` F22–F25 assert the five documents exist, that each has a title, a summary
and sections, that every section is a heading over plain-text paragraphs or bullets, and
that none of them contains markup — a stray tag in a privacy statement is either broken text
or a hole, depending on where the text came from.

✅ **Closed.** The Archive room renders them: an index of five documents with summaries, and
a page per document. The screen contains no prose of its own — five furniture keys, asserted
exactly — and `i18n-tests.js` J4 asserts all 61 paragraphs and bullets across all five
documents reach it. The room comes from `notices.room`, so moving the documents is a content
edit rather than a code change.

### 8. ⚠ PeerJS carries no copyright notice, and none has been invented

**This is the one gap this pass could not close, and closing it wrongly would have been
worse than leaving it open.**

MIT requires the copyright notice and the permission notice to accompany the software.
Neither library shipped its licence text; both do now, in `r128/LICENSE` and
`peerjs-1.5.4/LICENSE`. But the copyright lines are not equally available:

| Library | Copyright line | Where it came from |
|---|---|---|
| Three.js r128 | `Copyright 2010-2021 Three.js Authors` | transcribed verbatim from the `@license` header in the first five lines of `three.min.js` |
| PeerJS 1.5.4 | **UNKNOWN** | the vendored bundle carries none. Measured: `copyright` appears **0 times** in its 92,873 bytes, in any case. There is no header comment at all — the file opens directly with `(()=>{function e(e,t,n,r){` |

The bundle does embed its own package metadata — `"license":"MIT"`, a homepage, a repository
and a contributors list beginning `Michelle Bu <michelle@michellebu.com>`. **A contributors
list is not a copyright line and must not be typed into one.** An attribution audit that
fabricates an attribution is worse than one that reports a gap: a gap is a known unknown
somebody can close, and a fabrication is a false statement with a green tick beside it.

So `NOTICE.md` records the copyright column as the literal token `none-in-vendored-file`,
and the audit checks the claim of absence **in both directions**:

- a recorded copyright line must appear verbatim in the library **and** in the `LICENSE`
- `none-in-vendored-file` must be **true** — the library is re-measured for the string
  `copyright` on every run, and a nonzero count fails

The gap prints in yellow on every audit run with what it would take to close it.
`audit-tests.js` F18–F19 assert the same two things from the browser, including that the
`LICENSE` says `UNKNOWN` rather than filling in a plausible name.

**To close it:** obtain the upstream PeerJS 1.5.4 release's own `LICENSE`, put its copyright
line into `NOTICE.md`'s seventh column and into `assets/lib/peerjs-1.5.4/LICENSE`, and the
audit starts checking it the way it checks Three.js's. That needs network access to an
upstream artefact, which is the one thing this audit is deliberately built not to require.

### 9. ⚠ "Exactly one network host" was true of a file and not of the software

This page and `NOTICE.md` both used to say the build reaches exactly one host. That sentence
was written from `src/net/net.js`, which names the signalling broker and nothing else. It is
not true of a session.

Measured directly from the vendored bytes: `PEER_OPTS` sets `host`, `port`, `secure` and
`debug` and does **not** set `config`, so PeerJS falls back to its own `defaultConfig` — a
STUN server at `stun.l.google.com` and TURN relays at `eu-0.turn.peerjs.com` and
`us-0.turn.peerjs.com`. An online session can reach **four** hosts.

Nothing about this is a defect in the networking code; it is how WebRTC works, and a solo
operation still contacts nothing. What was wrong was the claim. `NOTICE.md` is corrected,
the player-facing privacy page names all four, and `audit-tests.js` F27–F29 assert that the
three ICE hosts are in the library, that `PEER_OPTS` does not override them, and that the
privacy page names them — so the claim cannot quietly revert to the tidier version.

✅ **Closed.** `README.md` and `src/main.js` both carried it and both are corrected. The
README keeps the wrong sentence visible next to the right one, because the reason it was
wrong is the finding: the one host is the only one *this repository's own code* names, and
every check was pointed at this repository's own code. `src/main.js` had stated a true claim
about `telemetry.js` — that nothing in it can reach the network — *because* of the false
count, which is how a true sentence gets retired along with a false one.

### 10. ⚠ Other players' typed callsigns are written to the host's disk

Not a licensing finding, but it belongs in the same file as everything else this audit
learned, and it is the one place where a privacy statement written from the code's own
comments would have been wrong.

`src/net/lobby.js` states that other people's typed names are kept in memory and never in
`localStorage`, and **for the objects it is about — the moderation log and the block list —
that is true and asserted** (`net-tests.js` Q12–Q15, O38). But at debrief, the machine
running the simulation writes the squad into `profile.roster` so injuries follow the right
operative, and roster entries carry names. After a co-op operation the host's
`cd.profile.v1` holds the callsigns the other players typed — up to five entries of at most
fourteen characters — indefinitely.

GDD §21.2 says *"Do not record raw voice, free-text chat, or unnecessary personal data."*
Nothing transmits it and nobody else receives it, so this is a retention question rather than
a leak. **The player-facing privacy page states it plainly** rather than repeating the
comment, because a privacy statement that is accurate about everything except the one
inconvenient case is worse than none.

No test covers it. `audit-tests.js` section G's storage fixtures are the nearest thing, and
they are about migration rather than about names. Owner: progression.

### 4. Media assets, recorded

§25.5 requires source, author, license, modifications and attribution per asset, and says to
reject anything of unknown provenance. There are six media files in the tree and all six are
first-party program output. The audit looks for each path **in this file**, so this table is
what makes them accounted for rather than merely assumed.

| File | What it is | Source | Licence | Modified |
|---|---|---|---|---|
| `docs/m0-fence.png` | screenshot: the fence, held | `tools/shot.ps1 -Setup tools/_shot-fence.js` | project-original | no |
| `docs/m0-loadout.png` | screenshot: the loadout screen | `tools/shot.ps1` | project-original | no |
| `docs/m1-squad.png` | screenshot: the squad panel | `tools/shot.ps1` | project-original | no |
| `docs/m3-briefing.png` | screenshot: the briefing tab | `tools/shot.ps1 -Setup tools/_shot-brief.js` | project-original | no |
| `docs/m3-settings.png` | screenshot: the settings screen | `tools/shot.ps1 -Setup tools/_shot-settings.js` | project-original | no |
| `docs/m6-figure.png` | screenshot: the figure in aisle B | `tools/shot.ps1 -Setup tools/_shot-figure.js -Query "incident=cold-storage-figure"` | project-original | no |
| `docs/m3-site.png` | screenshot: the base | `tools/shot.ps1 -Setup tools/_shot-base.js` | project-original | no |
| `assets/icons/icon-512.png` | install icon, 512px | rendered by `tools/make-icons.ps1` | project-original | no |
| `assets/icons/icon-maskable-512.png` | install icon, maskable variant | rendered by `tools/make-icons.ps1` | project-original | no |
| `assets/icons/icon-192.png` | install icon, 192px | `tools/make-icons.ps1`, bicubic resample of `icon-512.png` | project-original | resampled from the 512 |
| `assets/icons/icon-48.png` | install icon, 48px | `tools/make-icons.ps1`, bicubic resample of `icon-512.png` | project-original | resampled from the 512 |

Every screenshot is a headless Chrome capture of this build rendering its own content. The
four install icons landed with the PWA work and are program output of the same pipeline:
`tools/make-icons.ps1` reads the mark out of `COMMS_KIND.evidence.glyph` in
`src/sim/comms.js` and the palette out of `index.html`'s `:root`, renders them in headless
Chrome, and resamples the two small sizes with `System.Drawing`. Nothing was drawn by hand,
downloaded, or traced. **No third-party image, texture or model is in this tree**, the world
is generated geometry, and §25.6's warning about the former image of the article it singles
out does not engage because there is no representational art at all.

⚠ **One open question about the icons, recorded rather than waved through.** The mark is the
character U+25C9, and `make-icons.ps1` renders it through the font chain
`"Segoe UI Symbol", "Segoe UI", Inter, "DejaVu Sans", "Arial Unicode MS", sans-serif`. On
Windows that resolves to Segoe UI Symbol — *inferred from the chain and the platform, not
measured from the render*. **No typeface file is redistributed by this project**; what ships
is a raster of glyph output, which is the ordinary use of an installed font and the same
thing every screenshot in the table above already contains. §25.5 nevertheless names
typefaces explicitly, and whether a rasterised glyph used as a product mark is distinct from
a screenshot is a question for counsel and not for this file. Recorded as **open, low risk,
not cleared**. Rendering the ring and dot as an SVG path would remove the question entirely
and is the cheap fix if anybody wants it gone.

### 5. `three.min.js` names `www.w3.org`, and that is not a network reach

The host sweep flags it. Measured: four occurrences, one distinct host, every one of them
inside

```js
document.createElementNS("http://www.w3.org/1999/xhtml", "canvas")
```

which is the XHTML **namespace identifier**. A namespace URI is a name, not an address;
nothing dereferences it and no request is made.

⚠ The audit subtracts the four known namespace URIs **by exact string** and prints how many
it subtracted, rather than loosening the pattern until the match goes away. Widening a
pattern to silence a false positive is how the next true positive gets through the same
hole. See `$NamespaceUris` in `tools/licence-audit.ps1`. The same discipline is why
`assets/lib/peerjs-1.5.4/LICENSE` — which quotes the homepage and repository the bundle
declares about itself — is exempted **by name** in `$AllowedHosts` rather than by extension.

---

## The §25.8 gate, answered

`content/provenance.json` carries §25.8's seven clauses with a status and a recorded reason
each. `-Strict` fails if any is `open`, and `audit-tests.js` F5–F7 assert there are seven of
them, that each records a reason, and that none is open — the clause count is asserted
because a gate that quietly lost a clause would still pass.

| Clause | Status |
|---|---|
| Article attribution is complete | not-applicable — there is no article |
| The captured source revision is archived internally | not-applicable — nothing was captured |
| All assets have provenance and compatible permissions | cleared |
| Changes are documented | cleared |
| Required notices are generated and reviewed | cleared |
| Any special restrictions are resolved | cleared |
| Legal review status is recorded | cleared — **recorded as NOT OBTAINED** |

⚠ The last row is the one to read twice. The clause asks that the status be *recorded*, and
the status is: no qualified intellectual-property attorney has reviewed this project. That
is the honest answer and it clears the clause. **It must not be edited to say anything else
by anybody who has not actually obtained a review.**

`not-applicable` is only honest because sections C and D re-prove the premise every run:
every `licensingRecordId` is null, every designation is provisional, and no `SCP-###` string
exists in `content/`.

---

## What the audit checks, and what it cannot

**Checks, from the tree, every run:**

- SHA-256, byte size and the embedded version string of every vendored file, against the
  `audit` block in `assets/lib/NOTICE.md` — the only check that catches a library edited in
  place or swapped for a different build
- that a `LICENSE` sits beside each vendored library, that it carries the MIT grant, the
  inclusion clause and the warranty disclaimer, and that the copyright column agrees with
  both the library and the notice — **in both directions**, so a fabricated line fails and a
  recorded absence is re-measured
- that every file under `assets/` has a row in that block, and every row has a file
- that exactly three shipped files name a network host, and which three
- that no game state sits within 400 characters of the broker options
- every `licensingRecordId` and whether a null one explains itself, over **every** content
  file rather than only the anomalies
- every coverage entry in `content/provenance.json`: that its file exists, that it says why
  and what, and that it has not gone stale
- §25.3's twelve fields, and the link between a claimed record and a database row
- §25.8's seven clauses, and that none is open
- every `designation`, and that each is marked provisional while its record is null
- any `SCP-###` string anywhere in `content/`
- every file in the tree that is neither first-party nor declared third-party
- every media file, against the table above

**And from a browser, `tools/audit-tests.js` sections F and G:**

- that every content file **parses with `JSON.parse`**. This is not redundant with the
  script: PowerShell's `ConvertFrom-Json` accepts a raw newline inside a JSON string and a
  browser does not, and three content files in this repository once passed a PowerShell check
  and were invalid in the browser that had to load them. Only a browser parse counts.
- that the licence files are actually **served**, over http, as a player's browser would get
  them
- that the five Milestone 6 documents exist as renderable content and carry no markup
- what an older build does to a newer save — the rollback case, driven through the real
  storage path rather than assumed. See `docs/day-one-operations.md`.

**Cannot check, and does not pretend to:**

- that the vendored copies match their upstream releases. The digests pin them to *what was
  reviewed here*; proving that equals what three.js and PeerJS published needs the upstream
  artefacts, and the provenance in `NOTICE.md` is a chain of copies between projects on this
  machine rather than a download. Recorded as a claim, not as a verified fact.
- **PeerJS's copyright line.** See finding 8. Recorded as UNKNOWN, and the absence is
  itself re-measured every run so that it cannot quietly become a guess.
- what the signalling broker or the TURN relays log or retain. That is outside this
  codebase, and the privacy page says so.
- anything about counsel. §25 opens by saying it is production guidance and not legal advice,
  and so is this.
