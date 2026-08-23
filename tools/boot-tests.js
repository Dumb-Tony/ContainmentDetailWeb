/* Does the game start? — every incident, through `src/main.js` itself.
 *
 * ⚠ NOTHING IN THIS REPO HAD EVER BOOTED THE REAL ENTRY POINT. Ten suites and 1,946
 * assertions, and every one of them builds a world the same way: `loadContent()`, then
 * `new Game(...)`. That is the right shape for testing rules — it is what lets a whole
 * containment run headless in milliseconds — and it means the file that actually starts the
 * game was covered by nothing at all.
 *
 * `main.js` is not a thin wrapper. It installs the crash boundary, resolves a locale and
 * awaits a message table, reads `?incident=` and `?scenario=`, loads content, constructs a
 * WebGL renderer, an AudioContext, an Input, a Progression against real storage, a lobby
 * and a net session, wires `window.__CD`, and registers a service worker. Every one of those
 * is a way for a build to be broken for a player while every suite stays green — and two of
 * them have been added by other people this session.
 *
 * So this boots all nine incidents, in iframes, in a real browser, and asks the page what it
 * became. It is deliberately its OWN suite file rather than a section of `m0-tests.js`:
 * nine WebGL contexts and nine audio graphs in one page is the heaviest thing the harness
 * does, and `tools/run-tests.ps1` gives every suite its own browser precisely so the
 * expensive one cannot take the others down with it.
 *
 * ⚠ AND IT WAITS ON `cd-ready` WITH A TIMEOUT, never on a bare event. A boot that throws
 * before the dispatch never fires it — which is exactly the failure this suite exists to
 * catch — so a hang would report as a hang rather than as a failure. See
 * `tools/bench.js` `instrumentCheck` for what that costs when you get it wrong: 3,134
 * seconds of nothing.
 */

import { lines, counts, ok, eq, note, emit, run, heading, suite } from './harness.js';

const BOOT_TIMEOUT_MS = 25000;

/** Every incident the content ships, read from the same place the game reads it. */
const { INCIDENTS } = await import('../src/sim/content.js');

/** The six shapes `renderer.js` knows. Named here so a boot that produces an unknown one
 *  fails in this suite too, rather than only in the one that owns the vocabulary. */
const FORMS = ['mass', 'figure', 'bed', 'fixture', 'carried', 'none'];

/**
 * Boot one incident in an iframe and return what the page became.
 *
 * The iframe is parked off-screen rather than hidden: `display: none` gives a zero-sized
 * canvas, and a renderer that has never had a size is not the renderer a player gets.
 */
function boot(incident) {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'width:900px;height:600px;position:fixed;left:-9999px;top:0;border:0';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      /* Read the banner BEFORE the frame goes, then take the frame down: nine live WebGL
       * contexts is over Chrome's cap and the ones it drops are silent. */
      try { f.remove(); } catch { /* already gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ incident, ok: false, why: `no cd-ready in ${BOOT_TIMEOUT_MS}ms` }), BOOT_TIMEOUT_MS);
    /**
     * ⚠ A PAGE THAT REFUSED IS NOT A PAGE THAT HUNG, AND THEY LOOK THE SAME FROM OUT HERE.
     *
     * Two different elements say two different things and neither is `cd-ready`:
     * `#err-banner` is the crash boundary, and `#boot` is where the content refusal writes
     * "Content refused" when `loadContent` throws. The first version of this suite watched
     * only the banner, so a deliberate, correct, well-worded refusal was reported as "no
     * cd-ready in 25000ms" — a working guard read as a hang, twice, at 25 seconds each.
     *
     * Polled rather than checked once, because the refusal is written after an await and
     * there is no event for it.
     */
    let polls = 0;
    const watch = setInterval(() => {
      if (done) { clearInterval(watch); return; }
      if (++polls > 40) { clearInterval(watch); return; }
      const d = f.contentDocument;
      if (!d) return;
      const banner = d.getElementById('err-banner');
      if (banner && banner.textContent && banner.textContent.trim()) {
        clearTimeout(timer); clearInterval(watch);
        finish({ incident, ok: false, refused: true, why: `crash banner: ${banner.textContent.trim().slice(0, 90)}` });
        return;
      }
      const bootEl = d.getElementById('boot');
      const h1 = bootEl && bootEl.querySelector('h1');
      if (h1) {
        clearTimeout(timer); clearInterval(watch);
        finish({ incident, ok: false, refused: true, why: `refused: ${h1.textContent.trim()} — ${(bootEl.querySelector('.err') || {}).textContent || ''}`.slice(0, 140) });
      }
    }, 250);
    f.src = `/?incident=${encodeURIComponent(incident)}`;
    document.body.appendChild(f);
    f.addEventListener('error', () => { clearTimeout(timer); finish({ incident, ok: false, why: 'iframe error' }); });
    /* The event is dispatched on the framed window, so it has to be listened for there —
     * `cd-ready` does not cross into the parent. */
    const attach = () => {
      const w = f.contentWindow;
      if (!w) return;
      w.addEventListener('cd-ready', (e) => {
        clearTimeout(timer);
        const cd = e.detail, g = cd.game;
        const banner = f.contentDocument && f.contentDocument.getElementById('err-banner');
        finish({
          incident,
          ok: true,
          anomaly: g.anomaly.def.id,
          form: (g.anomaly.def.presence || {}).form,
          map: g.site.id,
          evidence: g.ledger.rules.size,
          phase: g.mission.phase,
          hasCd: !!(cd.game && cd.renderer && cd.hud && cd.panels && cd.settings),
          record: typeof cd.sessionRecord === 'function',
          banner: banner && banner.textContent ? banner.textContent.trim().slice(0, 90) : null,
        });
      });
    };
    attach();
  });
}

async function sectionA() {
  heading('A. every incident starts, through the file that starts the game');
  const results = [];
  for (const id of INCIDENTS) results.push(await boot(id));

  const failed = results.filter((r) => !r.ok);
  for (const f of failed) note(`  ${f.incident}: ${f.why}`);
  eq(`A1 all ${INCIDENTS.length} incidents reach \`cd-ready\`${failed.length ? ` — ${failed.map((f) => f.incident).join(', ')}` : ''}`,
    failed.length, 0);

  const good = results.filter((r) => r.ok);
  for (const r of good) {
    note(`  ${r.incident.padEnd(24)} ${String(r.anomaly).padEnd(24)} ${String(r.form).padEnd(8)} ${String(r.map).padEnd(22)} ${r.evidence} sources`);
  }

  eq('A2 and none of them painted a crash banner on the way up',
    good.filter((r) => r.banner).length, 0);
  eq('A3 every one exposes the whole of `__CD` — a boot that half-finishes is a boot that fails a player later',
    good.filter((r) => !r.hasCd).length, 0);
  eq('A4 including §21\'s session record, which is pulled from the console and would be missing quietly',
    good.filter((r) => !r.record).length, 0);
  eq('A5 each lands in Briefing rather than mid-operation',
    good.filter((r) => r.phase !== 'Briefing').length, 0);
  eq('A6 each has evidence on the floor — an incident that places none cannot be played, only walked',
    good.filter((r) => !(r.evidence > 0)).length, 0);
  const badForm = good.filter((r) => !FORMS.includes(r.form));
  eq(`A7 and each anomaly came up as a shape the renderer knows${badForm.length ? ` — ${badForm.map((r) => `${r.anomaly}=${r.form}`).join(', ')}` : ''}`,
    badForm.length, 0);

  /* Three buildings and eight anomalies through one entry point, which is the §15.2 claim
   * the README makes and the only place it is checked end to end. */
  const maps = new Set(good.map((r) => r.map));
  const things = new Set(good.map((r) => r.anomaly));
  note(`  ${good.length} operations over ${maps.size} buildings and ${things.size} anomalies`);
  ok(`A8 the nine operations really do share buildings — ${maps.size} maps under ${good.length} incidents`,
    maps.size >= 3 && maps.size < good.length, [...maps].join(', '));
  ok(`A9 and share anomalies — ${things.size} things under ${good.length} incidents`,
    things.size >= 6 && things.size < good.length, [...things].join(', '));
}

async function sectionB() {
  heading('B. the boot refuses the things a URL can say');
  /* ⚠ THE QUERY STRING IS UNTRUSTED INPUT. It is the one part of this build a stranger can
   * set by sending somebody a link, and `?incident=` is read straight into a content load. */
  const junk = await boot('no-such-incident');
  note(`  a made-up incident: ${junk.ok ? `booted as ${junk.anomaly}` : junk.why}`);
  ok('B1 an incident that does not exist does not boot a random one', !junk.ok);
  ok('B2 and it REFUSES IN WORDS rather than sitting on "Loading the site" — a page that hung and a page that stopped look the same to the person in front of it',
    junk.refused === true, junk.why);

  const nasty = await boot('../../etc/passwd');
  note(`  a path traversal: ${nasty.ok ? `booted as ${nasty.anomaly}` : nasty.why}`);
  ok('B3 nor does a path out of the content directory reach anything', !nasty.ok);
  ok('B4 and that refuses in words too', nasty.refused === true, nasty.why);
}

suite('boot', async () => {
  await run('A', () => sectionA());
  await run('B', () => sectionB());
});
