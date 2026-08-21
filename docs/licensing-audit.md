# Attribution and licence audit — standing record

GDD §23 Milestone 6 gates on *"complete attribution and license audit"*. §25.8 states the
licensing gate an Incident Package must clear before content lock. This is the record those
two clauses ask for, and it is generated-adjacent rather than generated: `tools/licence-audit.ps1`
re-derives everything checkable from the tree on every run, and this page holds the things a
script cannot know — who made an asset, and what is still open.

```
powershell -ExecutionPolicy Bypass -File tools/licence-audit.ps1           # is anything untrue?
powershell -ExecutionPolicy Bypass -File tools/licence-audit.ps1 -Strict   # is the §25.8 gate clear?
```

The two runs answer different questions and both matter. The default run fails on things
that are wrong. `-Strict` fails on things that are not finished. Milestone 6 needs `-Strict`
to exit 0; today it does not.

---

## The headline

**No SCP-derived material is in this build.** Every anomaly is original. All six
`licensingRecordId` fields are `null`, all six designations in `content/site.json` are marked
`(provisional)`, and no `SCP-###` string appears anywhere in `content/`. The audit checks all
three of those on every run, because the moment any of them changes is the moment this
project starts making a licensing claim nobody has cleared.

Two libraries are vendored, both MIT, both unmodified, both hash-pinned in
`assets/lib/NOTICE.md`.

---

## Standing findings

| # | Section | What | Status | Owner |
|---|---|---|---|---|
| 1 | C | `content/anomalies/graybox-draught.json` carries `licensingRecordId: null` with **no `_licensingNote`** | **FAIL** | content |
| 2 | C | `content/anomalies/stillwater-figure.json` — same | **FAIL** | content |
| 3 | C | Every incident package, map, locale, the equipment file and `site.json` declare no provenance at all — run the audit for the current count | warn (fails `-Strict`) | content |
| 4 | E | Six screenshots in `docs/` had no asset record | fixed — recorded below | — |
| 5 | B | `three.min.js` names `www.w3.org` four times | not a finding — see below | — |
| 6 | — | §25.3's twelve-field attribution database does not exist as a file | open | production |
| 7 | — | §25.4's in-game notice is named by `content/site.json` but nothing renders it | open | UI |

### 1–2. Two anomalies say nothing about where they came from

Four of the six anomaly files carry the same sentence:

> *"Original, not an SCP. GDD §25 makes an attribution record a prerequisite for
> implementing SCP-derived content and §25.7's ShareAlike questions are unsettled. Nothing
> here is derived from anyone's work."*

`graybox-draught` and `stillwater-figure` carry `licensingRecordId: null` and no note.

⚠ **A bare `null` and a missing field are indistinguishable, and that is the whole problem.**
`null` can mean *"we checked, it is original, here is why"* or *"nobody has looked at this
one yet"*, and §25.3 makes the record a prerequisite for implementation — so the difference
between those two readings is the difference between clearing the gate and not. Four files
resolve the ambiguity in one sentence. Two do not, and there is no way to tell from the
repository which of the two things they mean.

**Fix:** add the `_licensingNote` the other four carry. One line each, in
`content/anomalies/`. Owned by the content agent, not by this audit.

### 3. Provenance is declared per anomaly, not per package

§25.8 states the gate at the **Incident Package** level, and an Incident Package is
`content/incidents/*.json` — the manifest that binds an anomaly to a map and a premise. None
of them declares anything. Nor do the maps, the equipment file, the locale files, the
onboarding file, or `content/site.json`, which is where the designations actually live. The
counts move as content lands; the audit prints the current ones and this page does not
duplicate them.

This is a warning rather than a failure because nothing about it is *untrue*: the material
really is original and the anomaly files really do say so. It is a failure under `-Strict`
because "the anomaly file says so" is not the same as "the package has a record", and
Milestone 6 asks for the second one.

**Fix:** the same `licensingRecordId` + `_licensingNote` pair on every content file, or a
single manifest that covers them. Owned by the content agent.

### 4. Media assets, recorded

§25.5 requires source, author, licence, modifications and attribution per asset, and says to
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
| `docs/m3-site.png` | screenshot: the base | `tools/shot.ps1 -Setup tools/_shot-base.js` | project-original | no |

Every one is a headless Chrome capture of this build rendering its own content. No
photograph, no third-party texture, no typeface file: the interface is system fonts and the
world is generated geometry, which is why there is nothing else in this table. §25.6's
warning about SCP-173's former image does not engage, because there is no bitmap art at all.

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
hole. See `$NamespaceUris` in `tools/licence-audit.ps1`.

### 6–7. What the repository cannot answer

Two of §25's requirements are not code and cannot be audited from the tree:

- **§25.3's attribution database** — twelve required fields per SCP-derived item, from
  article URL to legal review status. It has no rows because there is no SCP-derived
  content, but the *table* does not exist either, and §25.3 wants credits generated from it.
  The moment the first derived item is proposed, the absence of the database is what will
  let it ship without one.
- **§25.4's in-game notice** — attribution must be reachable from the main menu rather than
  buried in end credits. `content/site.json` lists *"Read the attribution and licensing
  record"* among the Archive terminal's affordances and names an attribution record in the
  room's purpose line, and the audit checks that the string is there. **Nothing renders it.**
  A menu item that names a document the game does not contain is a §18.1 problem as much as
  a §25 one.

Neither is in this milestone's scope to fix, and both belong on the Milestone 6 checklist
rather than in a comment nobody reads.

---

## What the audit checks, and what it cannot

**Checks, from the tree, every run:**

- SHA-256, byte size and the embedded version string of every vendored file, against the
  `audit` block in `assets/lib/NOTICE.md` — the only check that catches a library edited in
  place or swapped for a different build
- that every file under `assets/` has a row in that block, and every row has a file
- that exactly two shipped files name a network host, and which two
- that no game state sits within 400 characters of the broker options
- every `licensingRecordId` and whether a null one explains itself
- every `designation`, and that each is marked provisional while its record is null
- any `SCP-###` string anywhere in `content/`
- that §25.4's attribution route is at least named in the site
- every file in the tree that is neither first-party nor declared third-party
- every media file, against the table above

**Cannot check, and does not pretend to:**

- that the vendored copies match their upstream releases. The digests pin them to *what was
  reviewed here*; proving that equals what three.js and PeerJS published needs the upstream
  artefacts, and the provenance in `NOTICE.md` is a chain of copies between projects on this
  machine rather than a download. Recorded as a claim, not as a verified fact.
- that MIT is really the licence. No `LICENSE` text is vendored beside either library. That
  is worth fixing before distribution — MIT requires the notice to travel with the code.
- anything about counsel. §25 opens by saying it is production guidance and not legal advice,
  and so is this.
