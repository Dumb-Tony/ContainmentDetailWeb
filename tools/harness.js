/* The test harness, extracted so more than one suite can use it.
 *
 * `tools/smoketest.ps1` injects ONE module after `main.js`, serves the page, drives it in
 * headless Chrome and greps the dumped DOM for the block between the two markers. That
 * contract is all a suite has to satisfy, and it does not care how many files the suite is
 * made of — so this is the shared part, and each suite file is a topic.
 *
 * ⚠ WHY THIS EXISTS. `m0-tests.js` reached six thousand lines and 875 assertions with the
 * helpers, the counters and the DOM block declared at the top of it, which meant a second
 * suite had to copy them and a second suite written by somebody else had to copy them
 * slightly differently. Four agents working at once all wanted to append a section to the
 * same file, and the splice conflicts cost more than the tests did.
 *
 * The counters live HERE, module-scoped, so several suite files loaded into one page share
 * one total and one report. A page that loads one suite gets that suite's total; a page
 * that loads three gets all three, in load order, under one ALL-PASS.
 */

export const lines = [];
export const counts = { passes: 0, fails: 0 };

export function ok(name, cond, detail = '') {
  if (cond) { counts.passes++; lines.push(`PASS  ${name}`); }
  else { counts.fails++; lines.push(`FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}

export const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
export const near = (n, a, b, tol) => ok(n, Math.abs(a - b) <= tol, `got ${a}, want ${b} +/- ${tol}`);
export const note = (s) => lines.push(`      ${s}`);
export const heading = (s) => lines.push(`--- ${s} ---`);

/* Emitted after EVERY section, not only at the end: the harness greps the dumped DOM, so a
 * suite that throws half way must still say how far it got. A silent page teaches nothing. */
let _pre = null;
export function emit(status) {
  if (!_pre) {
    _pre = document.createElement('pre');
    _pre.id = 'test-out';
    _pre.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#06080c;'
      + 'color:#cfe;font:11px ui-monospace,Consolas,monospace;padding:12px;white-space:pre';
    document.body.appendChild(_pre);
  }
  const tail = status
    || (counts.fails === 0 ? `ALL-PASS  ${counts.passes} assertions`
      : `FAILURES  ${counts.fails} of ${counts.passes + counts.fails}`);
  _pre.textContent = '==CDTEST-BEGIN==\n' + lines.join('\n') + '\n\n' + tail + '\n==CDTEST-END==';
}

/**
 * ⚠ ONE SECTION THROWING MUST NOT DELETE EVERY SECTION AFTER IT.
 *
 * This was a single try/catch around a whole run, and a suite of forty assertions can
 * afford that. At seven hundred it cannot: an evidence source authored 2.7m from a breaker
 * made one section's bot throw on an undefined transit case, and the report that came back
 * was 112 assertions of a 700-assertion suite — five hundred and eighty results silently
 * absent, none of them broken, with no indication that anything had been skipped. The
 * failure looked ten times worse than it was, and the six hundred passing results that
 * would have located it were the ones that went missing.
 *
 * So each section is isolated. A section that throws is one FAILURE with its stack, and the
 * run continues. The only thing that stops a suite now is the harness itself.
 */
export async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    lines.push(`FAIL  section ${name} threw: ${e && e.stack ? e.stack : e}`);
    counts.fails++;
    emit();
  }
}

/* ⚠ MEASURED (Dev/INDEX.md): headless Chrome delivers one to three rAF callbacks in TOTAL
 * and then stops, so a bare `await new Promise(r => requestAnimationFrame(r))` hangs a
 * suite forever on the second call — and a hung suite reports nothing at all. Race it
 * against a timer, which keeps running under virtual time. */
export const yieldToLoop = () => new Promise((r) => {
  let done = false;
  const fire = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(fire);
  setTimeout(fire, 120);
});

/** Wrap a whole suite file: runs it, reports what threw, and always emits. */
export async function suite(name, fn) {
  try {
    await fn();
  } catch (e) {
    lines.push(`FAIL  suite ${name} itself threw: ${e && e.stack ? e.stack : e}`);
    counts.fails++;
  }
  emit();
}
