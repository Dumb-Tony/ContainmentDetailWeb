/* The friend test: drive the SHIPPED page through nothing but what a player can touch.
 *
 * Every suite in this repo reaches around the interface: `setCommand`, `commitLoadout`,
 * `takeFromCache`, `net.joinPeer` — the right seams for testing rules, and the reason
 * 1,994 green assertions can coexist with the sentence "it's still unplayable". Nothing
 * had ever clicked the buttons, pressed the keys, or read the screens in order, so nothing
 * could see a wall a person hits: a button that navigates back to itself, a world that sits
 * frozen with no hint why, a prompt that never appears.
 *
 * So this loads the REAL index.html in an iframe and plays it: real `.click()` on the real
 * buttons, real KeyboardEvents into the real `Input`, real mousemove with `movementX` into
 * the real look handler. The only cheat is pointer lock, which headless Chrome will not
 * grant — `pointerLockElement` is shadowed on the child document and the real
 * `pointerlockchange` listener does the rest. Everything downstream of that line is the
 * shipped path.
 *
 * It PHOTOGRAPHS the canvas at every step (render + toDataURL in the same task, which works
 * without preserveDrawingBuffer) and posts each frame to the dev server's `/__result`
 * write endpoint, plus a final text report of everything it saw: which screens opened,
 * what every button said, what the HUD said, where the walls were. `tools/playtest.ps1`
 * decodes the frames into PNGs a person can look at.
 *
 * ⚠ REAL TIME, NO DUMP — the bench's lesson. The story takes a minute of wall clock and
 * the iframes' rAF loops have to actually run.
 */

const PORT = location.port || '80';
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let shotN = 0;

function post(slot, body) {
  return fetch(`/__result?slot=${slot}`, { method: 'POST', body }).catch(() => {});
}

async function shot(f, label) {
  try {
    const cd = f.contentWindow.__CD;
    if (cd && cd.renderer) { cd.renderer.render(); }
    const url = f.contentWindow.document.getElementById('view').toDataURL('image/png');
    shotN++;
    await post(String(910 + shotN), `${String(shotN).padStart(2, '0')}-${label}\n${url}`);
    say(`  [shot ${shotN}] ${label}`);
  } catch (e) { say(`  [shot FAILED] ${label}: ${e.message}`); }
}

/** What is actually on the screen right now, as a person would name it. */
function screenReport(f) {
  const d = f.contentWindow.document;
  const vis = (el) => el && el.offsetParent !== null;
  const clip = (s, n = 90) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const layers = [];
  for (const sel of ['.cd-panel', '.cd-base', '.cd-lobby', '#panels', '.sheet']) {
    for (const el of d.querySelectorAll(sel)) {
      if (vis(el)) { layers.push(`${sel}: "${clip(el.querySelector('h1,h2,header') ? el.querySelector('h1,h2,header').textContent : el.textContent, 60)}"`); break; }
    }
  }
  const buttons = [...d.querySelectorAll('button')].filter(vis).map((b) => {
    const ds = Object.keys(b.dataset).map((k) => `data-${k}${b.dataset[k] ? `=${b.dataset[k]}` : ''}`).join(' ');
    return `[${clip(b.textContent, 28)}${ds ? ` | ${ds}` : ''}]`;
  });
  const hud = {
    topleft: clip((d.querySelector('.cd-topleft') || {}).textContent),
    topright: clip((d.querySelector('.cd-topright') || {}).textContent),
    prompt: clip((d.querySelector('.cd-prompt') || {}).textContent),
    notices: clip((d.querySelector('.cd-notices, .cd-feed') || {}).textContent, 120),
  };
  return { layers, buttons: buttons.slice(0, 24), hud, free: d.body.classList.contains('free') };
}

function reportScreen(f, label) {
  const r = screenReport(f);
  say(`  ── ${label}`);
  say(`     layers: ${r.layers.join(' · ') || '(world only)'}   body.free=${r.free}`);
  if (r.buttons.length) say(`     buttons: ${r.buttons.join(' ')}`);
  say(`     hud: L"${r.hud.topleft}" R"${r.hud.topright}" P"${r.hud.prompt}"`);
  return r;
}

function frame(w, h) {
  const f = document.createElement('iframe');
  f.width = w; f.height = h;
  f.style.cssText = `width:${w}px;height:${h}px;border:1px solid #333;display:block`;
  f.src = '/';
  document.body.appendChild(f);
  return f;
}

/** Resolve with __CD for the CURRENT document in the frame — survives navigations by
 *  polling for a new window and re-attaching, and tolerates having missed the event. */
function ready(f, timeout = 30000) {
  const t0 = performance.now();
  let attached = null;
  return new Promise((res, rej) => {
    const iv = setInterval(() => {
      let w = null;
      try { w = f.contentWindow; } catch { /* mid-navigation */ }
      if (w && w.__CD) { clearInterval(iv); res(w.__CD); return; }
      if (w && attached !== w) {
        attached = w;
        try { w.addEventListener('cd-ready', (e) => { clearInterval(iv); res(e.detail); }, { once: true }); } catch { /* not ready */ }
      }
      if (performance.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`no cd-ready in ${timeout}ms`)); }
    }, 80);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* The pointer-lock shim: the ONE thing a headless playtest cannot do for real. */
function lock(f, on) {
  const w = f.contentWindow, d = w.document, c = d.getElementById('view');
  Object.defineProperty(d, 'pointerLockElement', { configurable: true, get: () => (on ? c : null) });
  d.dispatchEvent(new w.Event('pointerlockchange'));
}

const keyDown = (f, code) => f.contentWindow.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { code }));
const keyUp = (f, code) => f.contentWindow.dispatchEvent(new f.contentWindow.KeyboardEvent('keyup', { code }));
async function press(f, code, ms = 90) { keyDown(f, code); await wait(ms); keyUp(f, code); }
function look(f, dx, dy = 0) {
  const w = f.contentWindow;
  w.document.dispatchEvent(new w.MouseEvent('mousemove', { movementX: dx, movementY: dy }));
}

function clickSel(f, sel) {
  const el = f.contentWindow.document.querySelector(sel);
  if (!el) { say(`  ✗ nothing matches ${sel}`); return false; }
  el.click();
  return true;
}

function clickVisible(f, sel) {
  const els = [...f.contentWindow.document.querySelectorAll(sel)].filter((x) => x.offsetParent !== null && !x.disabled);
  if (!els.length) { say(`  x nothing visible matches ${sel}`); return false; }
  els[0].click();
  say(`  clicked visible ${sel} [${els[0].textContent.trim().slice(0, 30)}]`);
  return true;
}

/** Click the first visible button whose text or data attributes match. */
function clickButton(f, re) {
  const d = f.contentWindow.document;
  for (const b of d.querySelectorAll('button')) {
    if (b.offsetParent === null) continue;
    const hay = `${b.textContent} ${Object.keys(b.dataset).join(' ')}`;
    if (re.test(hay)) { b.click(); say(`  clicked [${b.textContent.trim().slice(0, 30) || Object.keys(b.dataset).join(',')}]`); return true; }
  }
  say(`  ✗ no visible button matches ${re}`);
  return false;
}

/** Steer to a point through the real look/move path. Reads coordinates the way a player
 *  reads the room — this is a harness steering aid, not a claim about discoverability. */
async function walkTo(f, x, z, tol = 1.2, budgetMs = 20000) {
  const cd = f.contentWindow.__CD;
  const t0 = performance.now();
  let lastX = cd.game.player.x, lastZ = cd.game.player.z, stalledMs = 0, strafe = null;
  keyDown(f, 'KeyW');
  while (performance.now() - t0 < budgetMs) {
    const p = cd.game.player;
    const dx = x - p.x, dz = z - p.z;
    if (Math.hypot(dx, dz) <= tol) break;
    const want = Math.atan2(-dx, -dz);
    let err = want - p.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    /* player.look is yaw -= dx: mouse right turns clockwise, so the correction is the
     * NEGATED error. The first two runs orbited a cache 2.5m from spawn on this sign. */
    look(f, Math.max(-45, Math.min(45, -err * 260)));
    /* Wedged on geometry: strafe out, alternating sides, the way the sim driver does. */
    const moved = Math.hypot(p.x - lastX, p.z - lastZ);
    lastX = p.x; lastZ = p.z;
    if (moved < 0.04) stalledMs += 60; else { stalledMs = 0; if (strafe) { keyUp(f, strafe); strafe = null; } }
    if (stalledMs >= 400) {
      if (strafe) keyUp(f, strafe);
      strafe = strafe === 'KeyA' ? 'KeyD' : 'KeyA';
      keyDown(f, strafe);
      stalledMs = 0;
    }
    await wait(60);
  }
  keyUp(f, 'KeyW');
  if (strafe) keyUp(f, strafe);
  const p = cd.game.player;
  return Math.hypot(x - p.x, z - p.z);
}

/* ────────────────────────────── the story ────────────────────────────── */

const PASS = (cond, label) => say(`  ${cond ? 'PT-PASS' : 'PT-FAIL'} ${label}`);

async function solo() {
  say('=== SOLO: a friend clicks the link and deploys alone ===');
  const f = frame(1280, 720);
  let cd = await ready(f);
  await wait(600);
  const r1 = reportScreen(f, 'first boot');
  await shot(f, 'first-boot');
  PASS(r1.buttons.some((b) => /deploy solo/i.test(b)) && r1.buttons.some((b) => /form a squad/i.test(b)),
    'the board offers the real choice: Deploy solo / Form a squad');

  clickButton(f, /deploy solo/i);
  await wait(1400);
  cd = await ready(f);
  await wait(700);
  const r2 = reportScreen(f, 'after Deploy solo (one navigation)');
  await shot(f, 'solo-loadout');
  PASS(r2.layers.some((l) => /loadout|manifest|equipment|cargo|wager/i.test(l)) || r2.buttons.some((b) => /data-inc|data-dec/.test(b)),
    'the fresh page lands IN THE LOADOUT — no board again, no lobby');
  PASS(!r2.layers.some((l) => /session lobby/i.test(l)), 'and the Session lobby is nowhere in sight');

  clickVisible(f, 'button[data-deploy]');
  await wait(700);
  const r3 = reportScreen(f, 'after committing the loadout');
  await shot(f, 'solo-world-unlocked');
  PASS(cd.game.mission.phase !== 'Briefing', `committing moved the phase (now ${cd.game.mission.phase})`);

  const hint = f.contentWindow.document.querySelector('.cd-freehint');
  PASS(!!hint && hint.offsetParent !== null && /click/i.test(hint.textContent),
    `the frozen screen now SAYS WHY: "${(hint ? hint.textContent : '').slice(0, 60)}"`);

  f.contentWindow.document.getElementById('view').click();
  await wait(250);
  lock(f, true);
  await wait(350);
  PASS(!cd.game.clock.paused, 'lock starts the clock');
  PASS(!!hint && hint.offsetParent === null, 'and the hint gets out of the way');

  const p0 = { x: cd.game.player.x, z: cd.game.player.z };
  keyDown(f, 'KeyW'); await wait(1500); keyUp(f, 'KeyW');
  const moved = Math.hypot(cd.game.player.x - p0.x, cd.game.player.z - p0.z);
  PASS(moved > 1.5, `W moves the operative — ${moved.toFixed(2)}m in 1.5s through the real Input`);
  for (let i = 0; i < 10; i++) { look(f, 26); await wait(40); }
  await shot(f, 'solo-walking');

  const cache = cd.game.site.cache;
  const off = await walkTo(f, cache.x, cache.z, 0.55, 30000);
  say();
  /* The nearest interactable wins the prompt, and two witnesses stand near the vehicle --
   * a player presses F again after an accidental statement; so does this. */
  let gotCargo = false;
  for (let tries = 0; tries < 4 && !gotCargo; tries++) {
    await press(f, 'KeyF');
    await wait(600);
    gotCargo = !!f.contentWindow.document.querySelector('[data-take]');
  }
  const r4 = reportScreen(f, 'after F at the vehicle');
  await shot(f, 'solo-cargo');
  PASS(gotCargo, 'F at the vehicle opens the cargo manifest');
  if (gotCargo) {
    clickSel(f, '[data-take="thermal-imager"]');
    await wait(250);
    clickVisible(f, 'button[data-close]');
    await wait(400);
  }
  const held = [...cd.game.player.slots.values()].filter(Boolean);
  PASS(held.includes('thermal-imager'), `the imager is in a slot (${held.join(', ') || 'empty'})`);
  await press(f, 'KeyQ');
  await wait(400);
  PASS(cd.game.imagerOn === true, 'Q raises the imager');
  await shot(f, 'solo-imager');
  say(`  end of solo leg: phase=${cd.game.mission.phase} pos=(${cd.game.player.x.toFixed(1)},${cd.game.player.z.toFixed(1)})`);
  f.remove();
}

async function squad() {
  say('=== SQUAD: host forms a room, a friend clicks the invite link ===');
  const A = frame(960, 540);
  let a = await ready(A);
  await wait(500);
  clickButton(A, /form a squad/i);
  await wait(1400);
  a = await ready(A);
  await wait(700);
  const r1 = reportScreen(A, 'host after Form a squad');
  await shot(A, 'squad-lobby');
  PASS(r1.layers.some((l) => /session lobby/i.test(l)), 'the fresh page lands IN THE LOBBY');

  clickButton(A, /open the room/i);
  let invite = '';
  for (let i = 0; i < 60 && !invite; i++) {
    await wait(250);
    const el = A.contentWindow.document.querySelector('[data-invite]');
    if (el && /join=[A-Z0-9]{5}/.test(el.value)) invite = el.value;
  }
  PASS(!!invite, `an invite link appears beside the code: ${invite || '(never)'}`);
  PASS(/incident=/.test(invite) && /scenario=/.test(invite),
    'and it carries the incident and scenario, so the friend builds the same floor');
  await shot(A, 'squad-room-open');

  /* The friend: ONE CLICK. The iframe src IS the invite link. */
  const B = document.createElement('iframe');
  B.width = 960; B.height = 540;
  B.style.cssText = 'width:960px;height:540px;border:1px solid #333;display:block';
  B.src = new URL(invite).pathname + new URL(invite).search;
  document.body.appendChild(B);
  const b = await ready(B);
  await wait(1000);

  let seats = 0;
  for (let i = 0; i < 80 && seats < 2; i++) { await wait(250); seats = a.net.lobby ? a.net.lobby.size : 0; }
  PASS(seats === 2, `the friend is on the roster with NO typing (${seats} seats)`);
  reportScreen(B, 'friend, auto-joined from the link');
  await shot(B, 'squad-friend-joined');

  clickButton(A, /report ready/i);
  clickButton(B, /report ready/i);
  await wait(900);
  const depBtn = [...A.contentWindow.document.querySelectorAll('[data-deploy]')].find((x) => x.offsetParent !== null);
  PASS(!!depBtn && !depBtn.disabled, 'both ready: the host\'s Take the operation is enabled');
  if (depBtn) depBtn.click();
  await wait(1200);
  const rA = reportScreen(A, 'host after taking the operation');
  await shot(A, 'squad-host-loadout');
  PASS(rA.layers.some((l) => /loadout|equipment|cargo|wager/i.test(l)) || rA.buttons.some((x) => /data-inc/.test(x)),
    'host lands in the loadout');
  clickVisible(A, 'button[data-deploy]');
  await wait(1500);

  const rB = reportScreen(B, 'friend, after the host deploys');
  await shot(B, 'squad-friend-world');
  PASS(!rB.layers.some((l) => /session lobby/i.test(l)),
    'the friend\'s lobby closed ITSELF when the squad deployed');
  PASS(b.game.players.length === 2, `the friend holds a two-operative world (${b.game.players.length})`);
  say(`  host phase=${a.game.mission.phase}; friend phase=${b.game.mission.phase}; friend status=${b.net.status}`);
  A.remove(); B.remove();
}

(async () => {
  try {
    await solo();
    await squad();
    say('PLAYTEST-COMPLETE');
  } catch (e) {
    say(`PLAYTEST ABORTED: ${e && e.stack ? e.stack : e}`);
  }
  await post(PORT, out.join('\n'));
})();
