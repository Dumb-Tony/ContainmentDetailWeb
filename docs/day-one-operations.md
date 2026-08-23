# Day-one operations and rollback

GDD §23 Milestone 6 asks for a *"day-one operations and rollback plan rehearsed"*. This is
that plan, and it was rehearsed rather than written from memory — the measured numbers are
at the bottom, with what was measured and what was inferred marked separately.

**Read this first if you are about to ship or unship something.**

---

## What "deploy" means in this repository

Push is the deploy. There is no build step, no bundler, no artefact and no second repo:

- GitHub Pages serves branch `main` at `/` (confirmed from the Pages API: `source.branch
  main`, `source.path /`, `build_type legacy`).
- `index.html` is at the repository root, `.nojekyll` is beside it.
- The live URL is <https://dumb-tony.github.io/ContainmentDetailWeb/>.
- `git push` publishes. Nothing else does, and nothing else can.

Two consequences that shape everything below:

1. **A rollback is a revert and a push.** It is not a redeploy of an old artefact, because
   there is no artefact. The bytes in the commit are the bytes on the wire.
2. **The unit of deployment is the whole tree.** You cannot roll back one file's worth of
   behaviour without reverting the commit that changed it, and a revert is the correct tool
   precisely because it is a new commit rather than a rewrite of a published one.

---

## Before you push something that ships

```
powershell -ExecutionPolicy Bypass -File tools/run-tests.ps1 -BasePort 8481
powershell -ExecutionPolicy Bypass -File tools/licence-audit.ps1 -Strict
powershell -ExecutionPolicy Bypass -File tools/stamp-build.ps1
git commit -am "…"      # the stamp names the commit you are about to make
git push
powershell -ExecutionPolicy Bypass -File tools/verify-live.ps1
```

`stamp-build.ps1` writes `<short-sha> <committer-date>` into
`<meta name="cd-build">` in `index.html`, and it names the **parent** commit — you run it,
then commit, so the stamp identifies the commit it ships in. That is also why
`stamp-build.ps1 -Check` exits 1 in the ordinary steady state immediately after a stamping
commit: it compares the stamp against the *current* HEAD, which is by then one ahead. **Do
not put "expect `-Check` to exit 0" on a checklist.** It is the wrong assertion and it will
cry wolf on every single deploy.

---

## ⚠ How to tell a bad deploy is bad

There are four instruments and exactly one of them is trustworthy on its own.

### 1. What the URL actually returns — `tools/verify-live.ps1`

This is the only source of truth. It compares the **git blob hash** of each file at `HEAD`
against a hash of the bytes Pages actually serves, with a fresh cache-busting query per
attempt because Pages serves `max-age=600`.

```
powershell -ExecutionPolicy Bypass -File tools/verify-live.ps1
powershell -ExecutionPolicy Bypass -File tools/verify-live.ps1 -Paths index.html
```

Blob hashes and not byte counts, because the working copy is CRLF and Pages serves LF, so a
length comparison is off by one per line and never matches. Exit 0 means the live URL is
serving this commit; exit 1 means it timed out with files still stale, and it names them
with what is being served and what was wanted.

### 2. ⚠ The Pages build API, which misleads in **both** directions

Do not use `pages/builds/latest` to decide anything. Measured on this repository:

| Commit | API says | Reality |
|---|---|---|
| `0e4a0aa` | `errored`, `"Page build failed."`, duration 0ms | the site served it |
| `db45944` | `errored`, `"Page build failed."`, duration 0ms | `verify-live.ps1` confirmed the live URL was serving it, by blob hash |

It also goes the other way — it describes the *previous* build for a while after a push, so
a green `built` can be about the commit before yours. **Poll the URL. Do not read the API.**

### 3. The build stamp, and the way it is currently wrong

`buildId()` reads `<meta name="cd-build">`, and the stamp is the first line of every crash
report (`build 0e4a0aa 2026-08-21T10:24:11-04:00`). Read it off a live page with:

```js
document.querySelector('meta[name="cd-build"]').content
```

⚠ **Measured 2026-08-23: the live site is serving commit `81cb4f9` — confirmed by blob hash
with `verify-live.ps1` — and its stamp reads `0e4a0aa`, three commits and two days stale.
Measured again forty minutes later in the same session: `main` had moved to `73e60ce` and
the live stamp still read `0e4a0aa`.** It is drifting further with every commit, not
holding. The stamp is only true if `stamp-build.ps1` is run before every shipping commit,
and it currently is not. Until that is fixed, a crash report from production names the wrong
commit, and an operator who believes it will bisect against a tree that has nothing to do
with the fault.

The two measurements are the point rather than the numbers: **whatever the stamp says today,
check it against `verify-live.ps1` before you act on it.**

Treat the stamp as a **hint that is right when somebody remembered**, and `verify-live.ps1`
as the fact. Fixing this is one line in a pre-push habit; it is listed under Known gaps.

### 4. The crash boundary

If the bad build throws, players get a banner with a `CD-XXXXXXX` reference and a
**Copy report** button. Two things about the reference:

- It is derived from the top three stack frames with the origin stripped, so **the same bug
  gives the same reference on every machine** — two reports are comparable.
- It embeds `line:col`, so it **changes when the code moves**. A `CD-` reference identifies
  a bug *in a build*, not a bug. Always take the build line with it.

The boundary halts the game after 3 of the same signature or 30 errors in total. That is a
decision, not a failure to recover: a game that throws every frame and keeps painting shows
a world that animates over a HUD that stopped updating twenty seconds ago.

⚠ **A boot-level break produces no banner at all.** The boundary is installed by
`src/main.js`. If the failure is in loading `main.js` itself — a bad path, a syntax error, a
missing module — nothing installs it, and the page sits on the `#boot` div reading *"Loading
the site, the manifest, and the anomaly's rules…"* indefinitely. **A permanent loading
screen with a silent console is the signature of a boot-level bad deploy**, and it is the
one shape the crash instrumentation cannot report on. Check the browser console and the
network tab for a 404 on a module.

---

## The rollback

### Revert. Never force-push.

`main` is published history. `git push --force` to move it backwards would work, and it is
the wrong tool: it rewrites what other clones have already fetched, it destroys the record
of what went out, and it makes the bad commit unfindable when somebody later asks what the
`CD-` reference in a bug report was pointing at. A revert leaves the bad commit in the
history where it can be read, and ships the old bytes.

### The sequence

```
git log --oneline -5                       # find the bad commit
git revert --no-edit <bad-sha>             # ships the previous bytes as a NEW commit
git rev-parse HEAD:index.html              # sanity: the blob should equal the good one
powershell -ExecutionPolicy Bypass -File tools/stamp-build.ps1
git commit -am "Restamp after rollback"
git push
powershell -ExecutionPolicy Bypass -File tools/verify-live.ps1
```

If the bad deploy was several commits, `git revert --no-edit <oldest>^..<newest>` reverts
the range in one go and is still a forward-only operation.

### ⚠ Restamp after the revert — it costs nothing and it is the only way to tell

A revert restores the previous bytes *exactly*, and that includes the previous build stamp.
Measured in the rehearsal:

| State | `index.html` blob |
|---|---|
| last good commit | `0892dfd7589e37f9dbc33d4646d4399c12b54f1b` |
| after `git revert` | `0892dfd7589e37f9dbc33d4646d4399c12b54f1b` — identical |
| after restamp | `0242c17ef12f84b3dcec75b07d4f3fa8b3bb6323`, stamp `63d65c4` |

So without a restamp, a rolled-back build is byte-identical to the build from before the bad
one, and **you cannot distinguish "the rollback landed" from "a stale cache is still serving
the pre-bad build"** — the stamp says the same thing in both cases. Restamping makes the
rolled-back build name its own revert commit, which is unambiguous, and `verify-live.ps1`
works either way because it compares against `HEAD`, not against the old blob.

### How long it takes

| Phase | Measured | How |
|---|---|---|
| decision → bytes ready to push | **5.60 s** | stopwatch over the rehearsal below; `git log` 0.47s, `git revert` 0.41s, blob check 0.05s, restamp 3.24s, restamp commit 0.60s |
| `git push` | not measured | deliberately not performed — see the rehearsal note |
| Pages rebuild | **17.6 s – 60.4 s**, median 21.1 s, mean 26.7 s | the duration of all 13 successful builds this repository has on record |
| confirming with `verify-live.ps1` | **0.9 s – 1.2 s** per round, for 1–2 files | measured twice against the live URL |

**Decision to the live URL serving the old bytes: roughly 25 to 70 seconds**, dominated
entirely by the Pages rebuild. `verify-live.ps1` polls every 15 s for up to 300 s, so in
practice an operator sees `MATCH` on the first or second poll.

The two outliers in that range (58.3 s and 60.4 s) were consecutive, which is worth knowing:
if a rebuild is slow, the next one probably will be too. Do not start a second rollback
because the first "is taking too long" at forty seconds.

---

## What a player experiences

### On the bad build, mid-operation

**Nothing changes for them at the moment you roll back.** A loaded page keeps running the
code it loaded. Rolling back `main` does not reach into an open tab; the player keeps
playing the bad build until they reload, and a player who never reloads never sees the fix.

What they see depends on how the build is bad:

- **A throwing build:** the operation keeps running until the boundary's limit — 3 of one
  fault, or 30 in total — and then the game stops with the banner, the `CD-` reference and
  the Copy report button. Their operation ends there. Progress from that operation is lost,
  because the campaign is only written at debrief.
- **A build that is wrong but does not throw:** they play a broken operation to the end and
  it is filed in their history as a normal one. This is the expensive case, and it is the
  argument for `run-tests.ps1` before every push rather than after a complaint.
- **A boot-level break:** anyone loading the page during the bad window gets the permanent
  "Loading…" screen described above. They are not mid-operation, which is the small mercy —
  nothing of theirs is at risk, and a reload after the rollback fixes it completely.

### On reload, after the rollback

They get the older build. **In most rollbacks nothing at all happens to their campaign**:
the save format is versioned independently of the build, so a rollback within one
`PROGRESSION_VERSION` is completely save-neutral, and the overwhelming majority are.

### ⚠ A rollback across a save-format bump is a different thing, and it is tested

If the bad build had bumped `PROGRESSION_VERSION`, any player who played on it has a save
the older build cannot read. This is not hypothetical and it is not assumed — it is
`tools/audit-tests.js` **section G**, which drives the real storage path with a profile one
version ahead. Measured behaviour, in order:

1. `loadProfileWithReport` **refuses** the save rather than reading it wrongly. Outcome
   `refused`. (G2)
2. The session starts on a default profile: 340 requisition, one operative, empty
   everything. Their 21-operation campaign is not in it. (G3, G4)
3. The refused save is copied **byte for byte** to `cd.profile.unreadable`. (G7)
4. ⚠ **The very first autosave of that fresh session overwrites `cd.profile.v1`.** (G8, G9)

Point 4 is the trap and the whole reason this section exists. **Rolling the deploy forward
again does not bring the campaign back.** By then it exists only in the quarantine slot,
which is a single slot on a newest-wins policy — a second unreadable save at any later point
overwrites the rescue (G13). Rolling forward is the safe direction on its own terms (an
older save is upgraded and nothing is lost, G14–G16), but it does not undo point 4.

**What to tell a player in that situation:**

> Your campaign is not gone. Open the browser console on the game's page and run:
>
> ```js
> localStorage.setItem('cd.profile.v1', localStorage.getItem('cd.profile.unreadable'))
> ```
>
> then reload — but only once the newer build is live again, because this build still cannot
> read it. Copy the text out of `cd.profile.unreadable` and keep it somewhere first: it is
> one slot, and the next unreadable save will overwrite it.

That recovery is tested, not asserted: G10–G12 restore the quarantined bytes and confirm the
campaign comes back with all 21 operations and its requisition intact.

⚠ **And the game does not tell them any of this.** `migrateWithReport` writes the
explanation into `report.notices` — *"This profile was written by a newer build … open the
newer build to pick it up where you left off"* — `Progression.migration` carries it, and
**nothing under `src/ui` reads it**. Today a rollback across a save bump presents to the
player as a campaign that is simply gone, with no explanation, which is exactly the §18.1
misrepresentation that `progression.js`'s own comment says must not happen. It is measured
in section G rather than asserted, and it is the first item under Known gaps.

---

## The rehearsal, and what was and was not performed

Done on 2026-08-23.

**Performed for real, in a throwaway clone** (`git clone` of the repository, `origin`
removed so nothing could reach GitHub):

1. Cloned at `81cb4f9`, recorded `index.html` blob `0892dfd7…`.
2. Committed a deliberately bad deploy — `src/main.js` misspelt as `src/maim.js` in the
   module script tag, which is a boot-level break with no crash banner.
3. Started a stopwatch at "decision to roll back".
4. `git log --oneline -5`, `git revert --no-edit HEAD`, verified the reverted blob, ran
   `stamp-build.ps1`, committed the restamp. **5.60 s total.**
5. Confirmed the revert restored the exact previous blob and that the module tag was back.
6. Confirmed the restamp produced a different blob whose stamp names the revert commit.

**Measured against the live site and the real repository:**

- `verify-live.ps1` run twice, exit 0 both times, 1.19 s and 0.88 s — the live URL is
  serving `81cb4f9` by blob hash.
- All 13 successful Pages builds on record, for the rebuild duration figures above.
- The two `errored`-but-actually-serving builds, for the API-misleads finding.
- The live `cd-build` stamp, which is three commits stale.

**Deliberately not performed: the `git push`.** At the time of the rehearsal the working
tree carried three other agents' in-progress edits — `src/game.js`, `src/net/net.js`,
`index.html`, `content/locales/en-GB.json` — and pushing `main` would have deployed
half-finished work to the live URL to measure a stopwatch. The push is one command and its
latency is the Pages rebuild, which is measured from thirteen real instances of exactly that
command. The git half is measured directly. **The one number that is arithmetic rather than
a single stopwatch reading is the 25–70 s end-to-end total**, and it is marked as such.

---

## Known gaps

Ordered by how much they will cost on day one.

1. **A rolled-back player is told nothing.** `Progression.migration` carries the
   explanation and no UI module reads it. One paragraph on the base screen closes it. Owner:
   UI. Measured by `audit-tests.js` section G.
2. **The build stamp is stale in production.** Live bytes are `81cb4f9`; the stamp says
   `0e4a0aa`. Every crash report from the live site currently names the wrong commit. Fix
   is to run `stamp-build.ps1` before each shipping commit — or better, to make the pre-push
   step fail if the stamp does not name the commit being pushed. Owner: tooling.
3. **The quarantine slot is not durable.** One slot, newest wins, and nothing exports it.
   A player who hits a second bad load loses the rescue. Owner: progression.
4. **`stamp-build.ps1 -Check` is expected to fail in the steady state.** Not a defect, but
   it will be read as one by anybody who puts it on a checklist. Documented here; worth a
   line in the script's own help.
5. **There is no staging URL.** Every push is to production. `tools/serve.ps1` on localhost
   is the only pre-flight, which is why `run-tests.ps1` before a push is not optional.

---

## See also

- `docs/licensing-audit.md` — the standing attribution and licence record, and the §25.8
  content-lock gate.
- `assets/lib/NOTICE.md` — the vendored third-party inventory, hash-pinned.
- `content/provenance.json` — content provenance coverage, §25.3's attribution database,
  and the §25.8 gate as data.
