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
 * THE STORY IS NOW THE WHOLE OPERATION. Solo: board → loadout → cargo → the office fence
 * (m0 section I's winning playbook, performed through keys instead of through `g.*`) →
 * seal → 30s custody → carry to the stair head → THE DEBRIEF, which no one had ever
 * reached through the UI — and then past it: progression credited, one button back to the
 * operations board. Squad: host forms a room, a friend one-clicks in, the host plays the
 * same operation to the end while the friend stands in the world, and the driver measures
 * what each machine shows when the result lands — which is where the multiplayer walls are.
 *
 * Steering reads `__CD.game` coordinates as a navigation aid (a player reads the room);
 * every ACTION goes through the UI: keys, clicks, selects.
 *
 * It PHOTOGRAPHS the canvas at every step (render + toDataURL in the same task, which works
 * without preserveDrawingBuffer) and posts each frame to the dev server's `/__result`
 * write endpoint, plus a final text report of everything it saw. `tools/playtest.ps1`
 * decodes the frames into PNGs a person can look at.
 *
 * ⚠ REAL TIME, NO DUMP — the bench's lesson. The FULL story takes real minutes of wall
 * clock: the draught walks to the lure at its own speed and custody must hold 30 true
 * seconds, twice over (solo and squad legs). playtest.ps1's -WaitSeconds covers it.
 */

const PORT = location.port || '80';
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let shotN = 0;

function post(slot, body) {
  return fetch(`/__result?slot=${slot}`, { method: 'POST', body }).catch(() => {});
}

/* ⚠ THE STORY MUST SURVIVE ITS OWN TIMEOUT. The first full-mission run overran the
 * runner's ceiling mid-squad-leg, and because the report was only posted at the END, every
 * measured PT line died with the browser — the run was 25 minutes of evidence and left
 * none. Slot 800 is the running partial; playtest.ps1 prints it when the final report
 * never lands. Never post the partial to PORT: that filename is the runner's "finished"
 * signal, and writing it early would stop the run. */
const partial = () => post('800', `[PARTIAL — the run was still going]\n${out.join('\n')}`);

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
async function press(f, code, ms = 90) { if (!code) return; keyDown(f, code); await wait(ms); keyUp(f, code); }
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
 *  reads the room — this is a harness steering aid, not a claim about discoverability.
 *  `stop` lets a leg end early — the walk to extraction ends when the MISSION does, and a
 *  walker that keeps holding W into a paused world spins out its whole budget. */
async function walkTo(f, x, z, tol = 1.2, budgetMs = 20000, stop = null) {
  const cd = f.contentWindow.__CD;
  const t0 = performance.now();
  let lastX = cd.game.player.x, lastZ = cd.game.player.z, stalledMs = 0, strafe = null;
  keyDown(f, 'KeyW');
  while (performance.now() - t0 < budgetMs) {
    if (stop && stop()) break;
    const p = cd.game.player;
    const dx = x - p.x, dz = z - p.z;
    if (Math.hypot(dx, dz) <= tol) break;
    const want = Math.atan2(-dx, -dz);
    let err = want - p.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    /* player.look is yaw -= dx: mouse right turns clockwise, so the correction is the
     * NEGATED error. The first two runs orbited a cache 2.5m from spawn on this sign.
     * ⚠ AND THE CLAMP WAS ±45, WHICH IS A TURNING CIRCLE. At sprint speed a walker that
     * can only turn ~2 rad/s orbits every corner of the 2m freight lane and grinds its
     * whole budget on the walls — measured at nine real minutes for a ninety-second
     * withdrawal. A player flicks the mouse; so does this. */
    look(f, Math.max(-130, Math.min(130, -err * 300)));
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

async function route(f, pts, tol = 0.6, budgetMs = 45000, stop = null) {
  for (const [x, z] of pts) {
    const off = await walkTo(f, x, z, tol, budgetMs, stop);
    if (stop && stop()) return;
    if (off > tol + 0.5) say(`  route leg (${x},${z}) ended ${off.toFixed(1)}m off`);
  }
}

/** Turn in place until the view is on (x,z) — how a player lines up a deploy or an imager
 *  hold, driven through the same mousemove path the walk uses. */
async function aimAt(f, x, z, tolRad = 0.06, budgetMs = 4000) {
  const cd = f.contentWindow.__CD;
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    const p = cd.game.player;
    const want = Math.atan2(-(x - p.x), -(z - p.z));
    let err = want - p.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    if (Math.abs(err) <= tolRad) return true;
    look(f, Math.max(-110, Math.min(110, -err * 300)));
    await wait(40);
  }
  return false;
}

/** Poll a condition in real time. Returns elapsed ms, or -1 on budget exhausted. */
async function until(fn, budgetMs, pollMs = 250) {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    if (fn()) return Math.round(performance.now() - t0);
    await wait(pollMs);
  }
  return -1;
}

const heldIds = (cd) => [...cd.game.player.slots.values()].filter(Boolean);

/** Which number key selects the slot holding this item — the map is in SLOTS order. */
function slotDigit(cd, itemId) {
  const keys = [...cd.game.player.slots.keys()];
  const i = keys.findIndex((k) => cd.game.player.slots.get(k) === itemId);
  return i >= 0 ? `Digit${i + 1}` : null;
}

/** Walk up to a fixture until the context verb is the one wanted — m0's `workAt`, through
 *  the UI. A tolerance is not an approach: which side of the stop circle you land on
 *  decides which fixture is nearest, so close in until the prompt is right. */
async function workAt(f, x, z, kindRe, budgetMs = 20000) {
  const cd = f.contentWindow.__CD;
  for (const tol of [1.1, 0.7, 0.45, 0.3]) {
    await walkTo(f, x, z, tol, budgetMs);
    const a = cd.game.contextAction(cd.net.localPlayerId);
    if (a && kindRe.test(a.kind)) return a;
  }
  return cd.game.contextAction(cd.net.localPlayerId);
}

/** Press F only when the context verb is the one the step wants — the resolver is
 *  nearest-wins, and a blind F beside your own case RETRIEVES it. Measured: a case
 *  deployed onto the storage breaker made the breaker unreachable for the rest of the
 *  operation (the case is a movement blocker, so nothing can ever stand nearer the
 *  switch than the case sitting on it) and the blind press dismantled the lure. */
async function verbPress(f, kindRe, label) {
  const cd = f.contentWindow.__CD;
  /* Settle first: walkTo releases W but the operative keeps sliding for a few frames, and
   * doInteract re-resolves the verb AT PRESS TIME — run 4 read "throw the storage circuit",
   * drifted five centimetres, and pressed F into empty reach. A player stops, reads, then
   * presses; the pause is the stopping. */
  await wait(280);
  const a = cd.game.contextAction(cd.net.localPlayerId);
  if (!a || !kindRe.test(a.kind)) {
    say(`  ✗ wanted ${kindRe} at ${label} but the prompt offers ${a ? `${a.kind}: ${a.text}` : 'nothing'}`);
    return false;
  }
  await press(f, 'KeyF');
  await wait(450);
  return true;
}

/** Walk to the fixture, read the prompt, press, CHECK IT TOOK — and try again if not.
 *  The postcondition is the only proof a toggle toggled; a press that resolved to nothing
 *  is silent, and a suite that trusts the keypress reports the world it wanted. */
async function actAt(f, x, z, kindRe, doneFn, label) {
  for (let t = 0; t < 4; t++) {
    if (doneFn()) return true;
    await workAt(f, x, z, kindRe, 12000);
    await verbPress(f, kindRe, label);
    if (doneFn()) return true;
    await wait(300);
  }
  return doneFn();
}

const hudPrompt = (f) => ((f.contentWindow.document.querySelector('.cd-prompt') || {}).textContent || '').replace(/\s+/g, ' ').trim();

function opsCompleted(f) {
  try {
    const raw = f.contentWindow.localStorage.getItem('cd.profile.v1');
    return raw ? (JSON.parse(raw).operationsCompleted || 0) : 0;
  } catch { return -1; }
}

/**
 * Shape the open loadout to a wanted manifest through the screen's own +/- buttons —
 * what a player following the README's walkthrough does with the mouse.
 *
 * ⚠ THIS EXISTS BECAUSE THE PRE-FILLED MANIFEST HAS NO FENCE. `recommendedManifest` is
 * derived from the anomaly's SAFE procedure, and the draught's names heaters, barriers
 * and cameras — no floodlight-tripod anywhere on it. The README's playbook (and m0
 * section I, which commits the frozen RECOMMENDED_MANIFEST constant instead of the
 * derived one) builds the whole fence out of tripods. A first-timer who follows the
 * README with the default loadout reaches the office with nothing the walkthrough told
 * them to place. Measured here; reported to the content side. The driver plays the
 * README's player: it edits the wager to the documented kit before committing.
 */
async function shapeManifest(f, want) {
  const cd = f.contentWindow.__CD;
  const doc = () => f.contentWindow.document;
  const ids = [...doc().querySelectorAll('button[data-inc]')].map((b) => b.dataset.inc);
  for (const id of ids) {
    const w = want[id] || 0;
    let guard = 0;
    while ((cd.panels.manifest.get(id) || 0) > w && guard++ < 12) {
      const b = doc().querySelector(`button[data-dec="${id}"]`);
      if (!b || b.disabled) break;
      b.click(); await wait(70);
    }
    while ((cd.panels.manifest.get(id) || 0) < w && guard++ < 12) {
      const b = doc().querySelector(`button[data-inc="${id}"]`);
      if (!b) break;
      b.click(); await wait(70);
    }
  }
  return [...cd.panels.manifest.entries()].map(([k, v]) => `${k}x${v}`).join(' ');
}

const PLAYBOOK_MANIFEST = {
  'thermal-imager': 1, 'floodlight-tripod': 2, 'reinforced-transit-case': 1,
  'power-pack': 1, 'trauma-kit': 1,
};

/* ────────────────────────────── the story ────────────────────────────── */

const PASS = (cond, label) => say(`  ${cond ? 'PT-PASS' : 'PT-FAIL'} ${label}`);

/**
 * The whole operation, from "standing in the world with the loadout committed" to
 * `game.result`, performed through keys, clicks and selects. The playbook is m0-tests.js
 * section I — the positions are the ones that run proves — translated to the UI.
 * `P` prefixes the PT labels so the solo and squad-host performances stay distinguishable.
 */
async function playMission(f, P) {
  const cd = f.contentWindow.__CD;
  const game = cd.game;

  /* Kit: whatever the cargo manifest still owes us. */
  const wanted = ['thermal-imager', 'reinforced-transit-case', 'floodlight-tripod'];
  const extras = ['power-pack'];
  if ([...wanted, ...extras].some((id) => !heldIds(cd).includes(id))) {
    await walkTo(f, game.site.cache.x, game.site.cache.z, 0.6, 30000);
    let open = false;
    for (let t = 0; t < 4 && !open; t++) {
      await press(f, 'KeyF');
      await wait(600);
      open = !!f.contentWindow.document.querySelector('[data-take]');
    }
    for (const id of [...wanted, ...extras]) {
      if (heldIds(cd).includes(id)) continue;
      clickVisible(f, `button[data-take="${id}"]`);
      await wait(250);
    }
    clickVisible(f, 'button[data-close]');
    await wait(500);
  }
  const kit = heldIds(cd);
  PASS(wanted.every((id) => kit.includes(id)),
    `${P} the manifest hands over the whole fence kit — slots hold: ${kit.join(', ')}`);
  await partial();

  /* The survivor's statement — a real evidence source, taken with the context verb. */
  await actAt(f, 7.6, -8.2, /evidence/, () => game.ledger.has('survivor-account'), 'the witness');
  if (cd.panels.isOpen) { clickVisible(f, 'button[data-close]'); await wait(400); }
  PASS(game.ledger.has('survivor-account'), `${P} F takes the survivor's statement into the ledger`);

  /* The office is the cheap fence, and its breaker is out on the bay wall. */
  const sw = game.site.circuits.get('circuit-office');
  await actAt(f, sw.switchX, sw.switchZ, /circuit/, () => game.site.circuitOn('circuit-office'), 'the bay-wall breaker');
  say(`  breaker prompt was: "${hudPrompt(f)}"`);
  PASS(game.site.circuitOn('circuit-office'), `${P} the bay-wall breaker brings the office circuit up`);
  PASS(game.mission.phase === 'Investigation' || game.mission.phase === 'Arrival',
    `${P} phase reads ${game.mission.phase} after the command point`);

  const officeDoor = game.site.doors.find((d) => d.id === 'door-office');
  await actAt(f, -7.4, -9.75, /door/, () => !!officeDoor && officeDoor.open, 'the office door');
  PASS(!!officeDoor && officeDoor.open, `${P} the powered office door opens on F`);

  /* The office work happens BEFORE the case comes out of its slot.
   *
   * ⚠ THE CASE HEATER WAKES THE DRAUGHT FROM ACROSS THE FLOOR — its origin can sit
   * inside the heater's wake radius — and a deployed case starts luring THE MOMENT it
   * lands. m0's bot deployed first and got away with it by being fast; run 5 spent two
   * extra minutes at the desk and the draught walked into the office and took the
   * operative mid-setup. Reading the log and throwing the breaker first costs nothing
   * and keeps the lure switched off until the squad is ready to leave the room. */
  await actAt(f, -11.2, -11.4, /evidence/, () => game.ledger.has('maintenance-log'), 'the plant log');
  PASS(game.ledger.has('maintenance-log'), `${P} the disputed plant log is loggable at the desk`);
  await actAt(f, -10.0, -10.0, /circuit/, () => game.site.circuitOn('circuit-storage'), 'the storage breaker');
  const faulted = ((cd.content.variation && cd.content.variation.faults) || []);
  PASS(game.site.circuitOn('circuit-storage') || faulted.includes('circuit-storage'),
    `${P} the storage breaker answers OR the night declares it faulted (on=${game.site.circuitOn('circuit-storage')}, faults=[${faulted.join(', ')}] — §14.4's "a circuit that will not come up when thrown"; the operation card's conditions list carries it)`);

  /* NOW the lure: by the door — never deeper in, where it would bury the breaker or the
   * desk under a blocker nothing can reach past (run 3 measured that wall). */
  await walkTo(f, -8.6, -9.2, 0.4, 20000);
  await aimAt(f, -9.4, -9.6);
  const caseKey = slotDigit(cd, 'reinforced-transit-case');
  await press(f, caseKey);
  await wait(200);
  await press(f, 'KeyE');
  await wait(400);
  let kase = game.deployables.byItem('reinforced-transit-case')[0];
  if (!kase) {
    /* A refused drop (a wall or the desk in the way) is silent; a player steps aside and
     * tries again. Two more spots, then give up loudly. */
    for (const [px, pz, ax, az] of [[-8.9, -9.0, -9.5, -9.2], [-8.8, -9.9, -9.5, -10.0]]) {
      await walkTo(f, px, pz, 0.35, 12000);
      await aimAt(f, ax, az);
      await press(f, caseKey);
      await wait(200);
      await press(f, 'KeyE');
      await wait(400);
      kase = game.deployables.byItem('reinforced-transit-case')[0];
      if (kase) break;
    }
  }
  if (!kase) {
    /* The refusal words are the evidence; the first version of this loop swallowed them
     * and left a FAIL nobody could diagnose. The engine notices every refusal. */
    const d = f.contentWindow.document;
    const notes = [...d.querySelectorAll('.cd-notices div, .cd-feed div, .cd-notices, .cd-feed')].map((e) => e.textContent.trim()).filter(Boolean).slice(-3);
    say(`  deploy refused; held=${game.player.heldItemId}; notices: ${notes.join(' | ') || '(none)'}`);
    await shot(f, `${P}-deploy-refused`);
  }
  PASS(!!kase, `${P} ${caseKey} then E deploys the case in the office${kase ? ` at (${kase.x.toFixed(1)},${kase.z.toFixed(1)})` : ''}`);
  if (!kase) return game.result || null;

  /* The pack feeds every deployable within 5m — the case's own cell is 12 minutes, and a
   * slow night's lure plus 30s of custody verification outlives it (run 1 died exactly
   * there: sealed refused, case power false). One press, right beside the lure. */
  if (heldIds(cd).includes('power-pack')) {
    /* Not straight at the case — E drops 0.9m ahead, and ahead is where the case just
     * landed. A half-turn puts the pack beside it instead of inside it. */
    await aimAt(f, kase.x + 1.4, kase.z + 0.8, 0.1, 2000);
    const packKey = slotDigit(cd, 'power-pack');
    await press(f, packKey);
    await wait(200);
    await press(f, 'KeyE');
    await wait(400);
    const pack = game.deployables.byItem('power-pack')[0];
    PASS(!!pack, `${P} the power-pack lands beside the lure${pack ? ` (${Math.hypot(pack.x - kase.x, pack.z - kase.z).toFixed(1)}m from the case, feed radius 5)` : ''}`);
  }

  const imgKey = slotDigit(cd, 'thermal-imager');
  await press(f, imgKey);
  await wait(200);
  if (!game.imagerOn) { await press(f, 'KeyQ'); await wait(300); }
  PASS(game.imagerOn === true, `${P} the imager comes up for the approach`);
  if (game.result) { say('  mission resolved during the office work'); return game.result; }

  /* Out through the freight door — and only walk NORTH if the thing still needs waking.
   * The case heater usually beats us to it, and walking into an awake hunter's face is
   * how run 5's operative went down mid-setup. */
  await route(f, [[-6.6, -8.6], [-6.6, -6.6], [-8.2, -6.4]], 0.55, 30000);
  const freight = game.site.doors.find((d) => d.id === 'door-freight-cold');
  if (game.site.circuitOn('circuit-storage')) {
    await actAt(f, -8.0, -5.9, /door/, () => !!freight && freight.open, 'the freight door');
    PASS(!!freight && freight.open, `${P} the freight door is powered now and opens — the second lane is live`);
  } else {
    say(`  freight lane stays shut — the storage circuit is dead tonight, so the draught goes the long way (and so does the clock)`);
  }

  /* ⚠ AT THE REAL ORIGIN, NOT A TUNED WAYPOINT. The origin VARIES by night (14.4), and a
   * fixed point tuned for one origin left run 7 watching a latent draught for 273 seconds
   * from 5m outside its wake radius. The wake trigger is heat-within 12m for 4s; walk to
   * 10.5m of wherever it actually is tonight. */
  if (!game.anomaly.isAwake) await walkTo(f, game.anomaly.x, game.anomaly.z, 10.5, 60000);
  const wakeAt = await until(() => game.anomaly.isAwake, 15000, 400);
  const dWake = Math.hypot(game.player.x - game.anomaly.x, game.player.z - game.anomaly.z);
  PASS(wakeAt >= 0, `${P} it is awake — ${dWake.toFixed(1)}m from the operative (the case heater can reach its origin, so it may never have needed the walk north)`);
  await shot(f, `${P}-woke`);

  /* Hold it in the imager until the thermal void is on the ledger — from where we stand;
   * closing on an awake hunter is the run-5 mistake. */
  {
    const t0 = performance.now();
    while (performance.now() - t0 < 20000 && !game.ledger.has('thermal-void')) {
      const dNow = Math.hypot(game.player.x - game.anomaly.x, game.player.z - game.anomaly.z);
      if (dNow > 11) await walkTo(f, game.anomaly.x, game.anomaly.z, 10.0, 8000);
      if (game.result) return game.result;
      await aimAt(f, game.anomaly.x, game.anomaly.z, 0.05, 500);
      await wait(250);
    }
  }
  PASS(game.ledger.has('thermal-void'), `${P} holding it in the imager logs the thermal void`);

  /* Withdraw and let the lure do the walking. Sprint on the straights only — at sprint
   * speed the walker cannot make the freight lane's corners, and the first run spent nine
   * real minutes learning that against the panelling. */
  keyDown(f, 'ShiftLeft');
  await walkTo(f, -8.0, -4.0, 0.55, 25000);
  keyUp(f, 'ShiftLeft');
  const dOpened = Math.hypot(game.player.x - game.anomaly.x, game.player.z - game.anomaly.z);
  PASS(dOpened >= dWake - 0.3, `${P} a withdrawing operative is not losing ground: ${dWake.toFixed(1)}m -> ${dOpened.toFixed(1)}m`);
  await route(f, [[-8.0, -5.9], [-8.2, -6.6], [-6.6, -6.8]], 0.7, 30000);
  keyDown(f, 'ShiftLeft');
  await route(f, [[-4.0, -8.4], [4.0, -8.4], [10.5, -6.8]], 0.8, 40000);
  keyUp(f, 'ShiftLeft');
  await partial();

  let lureMs = -1;
  {
    const t0 = performance.now();
    let lastNote = 0;
    while (performance.now() - t0 < 300000) {
      if (game.result) { say('  mission resolved during the lure wait'); return game.result; }
      const d = Math.hypot(game.anomaly.x - kase.x, game.anomaly.z - kase.z);
      if (d <= 2.5) { lureMs = Math.round(performance.now() - t0); break; }
      if (performance.now() - t0 - lastNote > 30000) {
        lastNote = performance.now() - t0;
        say(`  … ${(lastNote / 1000).toFixed(0)}s: draught at (${game.anomaly.x.toFixed(1)},${game.anomaly.z.toFixed(1)}), ${d.toFixed(1)}m from the case, state ${game.anomaly.state}`);
        await partial();
      }
      await wait(1000);
    }
  }
  PASS(lureMs >= 0, `${P} the case heater lures it into the office in ${(lureMs / 1000).toFixed(0)}s of real time`);
  if (lureMs < 0) return game.result || null;

  /* Plug the doorway behind it: one tripod in a 1.5m opening is the whole fence. */
  await walkTo(f, -7.6, -9.75, 0.7, 60000);
  await aimAt(f, -8.6, -9.75);
  const triKey = slotDigit(cd, 'floodlight-tripod');
  await press(f, triKey);
  await wait(200);
  await press(f, 'KeyE');
  await wait(300);
  if (game.result) { say('  mission resolved before the fence went in'); return game.result; }
  const bankedMs = await until(() => game.anomaly.isHeld, 20000, 250);
  PASS(bankedMs >= 0, `${P} ${triKey} then E sets the doorway tripod and it banks in ${bankedMs}ms`);
  if (bankedMs < 0) {
    say(`  WALL: no bank on this night's geometry - abandoning the chain honestly rather than inventing a loss`);
    return null;
  }
  await shot(f, `${P}-banked`);
  const frostMs = await until(() => game.ledger.has('frost-boundary'), 8000, 250);
  PASS(frostMs >= 0, `${P} the frost boundary becomes observable exactly while it is held (${frostMs}ms)`);
  await partial();

  /* Commit the plan on the tablet — Tab, the procedure tab, four selects, a checkbox,
   * commit. The screens a squad would actually argue over. */
  await press(f, 'Tab');
  await wait(500);
  clickVisible(f, 'button[data-tab="procedure"]');
  await wait(400);
  const plan = {
    target: 'The cold mass itself',
    state: 'Held against a heat gradient it cannot cross',
    trigger: 'Transit case heater running at 39C as a lure',
    transfer: 'Case interior stable for 30s, then carry to the stair head',
  };
  for (const [field, value] of Object.entries(plan)) {
    const sel = f.contentWindow.document.querySelector(`select[data-field="${field}"]`);
    if (!sel) { say(`  x no select for ${field}`); continue; }
    sel.value = value;
    sel.dispatchEvent(new f.contentWindow.Event('change'));
  }
  const chk = f.contentWindow.document.querySelector('input[data-maint="0"]');
  if (chk && !chk.checked) chk.click();
  clickVisible(f, 'button[data-commit]');
  await wait(500);
  PASS(!!game.mission.procedure, `${P} the tablet's procedure commits (phase now ${game.mission.phase})`);

  /* Walk in past your own fence post and seal it.
   *
   * ⚠ ONLY WHEN THE PROMPT SAYS SEAL. The verb resolver is nearest-wins, and an unsealed
   * case's own verb is RETRIEVE — a blind F beside the case can pick the lure back up with
   * the draught two metres away, which is the operation dismantling itself. A player reads
   * the prompt before pressing; so does this, closing in until the verb is the seal. */
  let sealAct = null;
  const spots = [
    [kase.x + 1.2, kase.z + 0.9], [kase.x + 0.9, kase.z + 0.5],
    [(kase.x + game.anomaly.x) / 2, (kase.z + game.anomaly.z) / 2], [kase.x + 0.4, kase.z + 1.0],
  ];
  for (const [px, pz] of spots) {
    await walkTo(f, px, pz, 0.35, 15000);
    await aimAt(f, kase.x, kase.z);
    sealAct = cd.game.contextAction(cd.net.localPlayerId);
    if (sealAct && sealAct.kind === 'seal') break;
  }
  const dAC = Math.hypot(game.anomaly.x - kase.x, game.anomaly.z - kase.z);
  say(`  at the case the prompt says: "${hudPrompt(f)}" (verb ${sealAct ? sealAct.kind : 'none'}; draught ${dAC.toFixed(2)}m from the case; case power ${kase.hasPower})`);
  await shot(f, `${P}-seal-moment`);
  if (sealAct && sealAct.kind === 'seal') {
    await press(f, 'KeyF');
    await wait(400);
  }
  const refusal = game.recentNotices(2).map((n) => n.text).join(' | ');
  PASS(game.custody === 'sealed',
    `${P} the seal verb is offered and F takes it — custody '${game.custody}'${game.custody !== 'sealed' ? ` (notices: ${refusal})` : ''}`);
  await partial();
  if (game.custody !== 'sealed') return game.result || null;

  const verifyMs = await until(() => game.custody === 'verified', 45000, 500);
  PASS(verifyMs >= 0, `${P} custody HOLDS and verifies in ${(verifyMs / 1000).toFixed(1)}s (config says 30)${verifyMs < 0 ? ` — custody now '${game.custody}', case power ${kase.hasPower}` : ''}`);
  if (verifyMs < 0) return game.result || null;

  /* Step clear, lift, and carry it up the stairs. The mission may end mid-leg; the walker
   * stops the moment it does. Same discipline as the seal: F only on the carry verb. */
  let lifted = false;
  for (const [px, pz] of [[kase.x, kase.z + 1.0], [kase.x + 0.8, kase.z], [kase.x, kase.z + 0.7]]) {
    await walkTo(f, px, pz, 0.3, 12000);
    const a = cd.game.contextAction(cd.net.localPlayerId);
    if (!a || a.kind !== 'carry-case') continue;
    await press(f, 'KeyF');
    await wait(400);
    lifted = game.player.hands === 'reinforced-transit-case';
    if (lifted) break;
  }
  PASS(lifted, `${P} with custody verified the case lifts (hands: ${game.player.hands})`);
  if (!lifted) return game.result || null;

  const ended = () => !!game.result;
  await route(f, [[-8.0, -9.75], [-6.6, -8.8], [-3.0, -8.6], [4.0, -8.6], [8.2, -8.0]], 0.7, 90000, ended);
  if (!game.result) await walkTo(f, game.site.extraction.x, game.site.extraction.z, 1.0, 90000, ended);
  await until(() => !!game.result, 6000, 250);
  PASS(!!game.result, `${P} the stair head ends the operation — result ${game.result ? game.result.overall : 'never came'}${game.result && game.result.failReason ? ` (${game.result.failReason})` : ''}`);
  if (game.result) {
    say(`  mission time ${(game.clock.simTimeMs / 60000).toFixed(1)} min · custody ${game.custody} · evidence ${game.ledger.entries.length}`);
    for (const d of game.result.dims || []) say(`    ${d.name}: ${d.word}`);
  }
  await partial();
  return game.result;
}

/** The debrief walls — the screen nobody had ever reached through the UI. */
async function debriefChecks(f, P, opsBefore) {
  const cd = f.contentWindow.__CD;
  const openedMs = await until(() => cd.panels.open === 'debrief', 8000, 200);
  PASS(openedMs >= 0, `${P} the debrief OPENS BY ITSELF when the result lands (${openedMs}ms)`);
  const r = reportScreen(f, `${P} debrief`);
  PASS(r.free === true, `${P} pointer lock is released — the debrief is clickable (body.free=${r.free})`);
  const d = f.contentWindow.document;
  const ret = d.querySelector('.cd-panel [data-return]');
  const rep = d.querySelector('.cd-panel [data-report]');
  PASS(!!ret && ret.offsetParent !== null, `${P} it offers one obvious way on: [${ret ? ret.textContent.trim() : 'MISSING'}]`);
  PASS(!!rep && rep.offsetParent !== null, `${P} and a Copy playtest report button: [${rep ? rep.textContent.trim() : 'MISSING'}]`);
  await shot(f, `${P}-debrief`);

  const opsNow = opsCompleted(f);
  PASS(opsNow === opsBefore + 1,
    `${P} progression credited before the screen opened — cd.profile.v1 operationsCompleted ${opsBefore} -> ${opsNow}`);

  /* The §21 record is one click away, and the click survives a browser that refuses the
   * clipboard (the fallback textarea path). */
  const recLen = (cd.sessionRecordText() || '').length;
  if (rep) {
    const label0 = rep.textContent.trim();
    rep.click();
    await wait(350);
    const flipped = rep.textContent.trim() !== label0;
    PASS(recLen > 200 && flipped,
      `${P} Copy playtest report copies ${recLen} chars of §21 record and acknowledges (label flipped: ${flipped})`);
    await wait(2000);
  } else {
    PASS(false, `${P} Copy playtest report button missing`);
  }
  await partial();
  return ret;
}

async function solo() {
  say('=== SOLO: a friend clicks the link and deploys alone ===');
  const f = frame(1280, 720);
  let cd = await ready(f);
  await wait(600);
  const opsBefore = opsCompleted(f);
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

  const prefillTripods = cd.panels.manifest.get('floodlight-tripod') || 0;
  const prefillHeaters = cd.panels.manifest.get('portable-heater') || 0;
  const prefillBarriers = cd.panels.manifest.get('portable-barrier') || 0;
  PASS(prefillTripods + prefillHeaters + prefillBarriers >= 2,
    `the pre-filled manifest carries a fence (tripod x${prefillTripods} + heater x${prefillHeaters} + barrier x${prefillBarriers}) - three doctrines, all real: the README fences with tripods, the safe procedure with heaters AND BARRIERS, and a barrier is a wall the draught cannot pass at all`);
  const shaped = await shapeManifest(f, PLAYBOOK_MANIFEST);
  const depBtnSolo = f.contentWindow.document.querySelector('button[data-deploy]');
  PASS(!!depBtnSolo && !depBtnSolo.disabled,
    `the +/- buttons rebuild the README's kit inside the wager and Deploy stays live (manifest: ${shaped})`);
  clickVisible(f, 'button[data-deploy]');
  await wait(700);
  reportScreen(f, 'after committing the loadout');
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
  await walkTo(f, cache.x, cache.z, 0.55, 30000);
  say();
  /* The nearest interactable wins the prompt, and two witnesses stand near the vehicle --
   * a player presses F again after an accidental statement; so does this. */
  let gotCargo = false;
  for (let tries = 0; tries < 4 && !gotCargo; tries++) {
    await press(f, 'KeyF');
    await wait(600);
    gotCargo = !!f.contentWindow.document.querySelector('[data-take]');
  }
  reportScreen(f, 'after F at the vehicle');
  await shot(f, 'solo-cargo');
  PASS(gotCargo, 'F at the vehicle opens the cargo manifest');
  if (gotCargo) {
    clickSel(f, '[data-take="thermal-imager"]');
    await wait(250);
    clickVisible(f, 'button[data-close]');
    await wait(400);
  }
  const held = heldIds(cd);
  PASS(held.includes('thermal-imager'), `the imager is in a slot (${held.join(', ') || 'empty'})`);
  await press(f, 'KeyQ');
  await wait(400);
  PASS(cd.game.imagerOn === true, 'Q raises the imager');
  await shot(f, 'solo-imager');

  /* ── from here the leg is NEW: the whole operation, then the debrief ──── */
  await press(f, 'KeyQ');
  await wait(300);
  PASS(cd.game.imagerOn === false, 'Q lowers it again — the battery is a wager, not a tax');
  await partial();

  /* ⚠ THE MISSION CHAIN RUNS ON THE CANONICAL NIGHT. The board-derived first scenario
   * is a REAL night under 14.4 - runs 7 and 8 both drew the faulted storage circuit, and
   * run 8 ended with two contacts and 'Operative 1 stopped answering' while the driver
   * fumbled a dead breaker. That is the game working, and the wrong stage for a
   * regression chain. Everything above keeps exercising the derived night; the mission
   * below plays the canonical one the README documents and m0 section I bots. */
  f.contentWindow.location.href = '/?flow=solo&incident=cold-storage-draught';
  cd = await ready(f);
  await wait(800);
  await shapeManifest(f, PLAYBOOK_MANIFEST);
  clickVisible(f, 'button[data-deploy]');
  await wait(600);
  f.contentWindow.document.getElementById('view').click();
  await wait(250);
  lock(f, true);
  await wait(300);

  const result = await playMission(f, 'S');
  if (result) {
    const ret = await debriefChecks(f, 'S', opsBefore);
    /* The one obvious button leads back to the operations board — the minimum bar for
     * "play again": the fresh page must not be the night just closed. */
    if (ret) {
      ret.click();
      await wait(1400);
      cd = await ready(f);
      await wait(800);
      const rb = reportScreen(f, 'after Return to base');
      await shot(f, 'solo-board-after-debrief');
      PASS(rb.buttons.some((b) => /deploy solo/i.test(b)) && rb.buttons.some((b) => /form a squad/i.test(b)),
        'Return to base lands on the OPERATIONS BOARD, ready for the next night');
      const q = f.contentWindow.location.search;
      PASS(!/flow=|join=|scenario=/.test(q), `and the URL sheds the old night's parameters (search: "${q || '(none)'}")`);
      PASS(opsCompleted(f) === opsBefore + 1,
        `the board is standing on the credited profile (operationsCompleted=${opsCompleted(f)})`);
    }
  } else {
    say('  (mission never resolved — debrief leg skipped; see PT-FAILs above)');
  }
  say(`  end of solo leg: phase=${cd.game.mission.phase}`);
  f.remove();
}

async function squad() {
  say('=== SQUAD: host forms a room, a friend clicks the invite link ===');
  const A = frame(960, 540);
  let a = await ready(A);
  await wait(500);
  const opsBefore = opsCompleted(A);
  /* The board's Form-a-squad button is asserted on the S leg's board; the HOST here boots
   * the canonical night directly so the squad's containment chain shares section I's
   * geometry - the board-derived scenario put the origin outside the tuned lane in run 8. */
  A.contentWindow.location.href = '/?flow=squad&incident=cold-storage-draught';
  a = await ready(A);
  await wait(900);
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
  PASS(/incident=/.test(invite),
    'and it carries the incident, so the friend builds the same floor (no scenario tonight: the canonical night is the default everywhere)');
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
  const shapedA = await shapeManifest(A, PLAYBOOK_MANIFEST);
  say(`  host manifest shaped to: ${shapedA}`);
  clickVisible(A, 'button[data-deploy]');
  await wait(1500);

  const rB = reportScreen(B, 'friend, after the host deploys');
  await shot(B, 'squad-friend-world');
  PASS(!rB.layers.some((l) => /session lobby/i.test(l)),
    'the friend\'s lobby closed ITSELF when the squad deployed');
  PASS(b.game.players.length === 2, `the friend holds a two-operative world (${b.game.players.length})`);
  say(`  host phase=${a.game.mission.phase}; friend phase=${b.game.mission.phase}; friend status=${b.net.status}`);

  /* ── NEW: the host plays the operation to the END while the friend stands by, and the
   * driver measures what each machine shows when the result lands. This is the leg where
   * "play again with my friends" either exists or does not. ─────────────── */
  A.contentWindow.document.getElementById('view').click();
  await wait(250);
  lock(A, true);
  await wait(400);
  PASS(!a.game.clock.paused, 'the host\'s clock starts under lock with a client attached');
  await partial();

  const result = await playMission(A, 'H');
  if (result) {
    /* What the FRIEND sees, machine-measured. `rs` rides the next snapshot. */
    const rsMs = await until(() => !!b.game.result, 6000, 200);
    PASS(rsMs >= 0, `the sanitised result reaches the client in ${rsMs}ms (net's rs field)`);
    PASS(b.game.result && b.game.result.overall === result.overall,
      `and it is the HOST'S grade on the friend's machine (${b.game.result ? b.game.result.overall : 'none'} vs ${result.overall})`);
    const phaseMs = await until(() => b.game.mission.phase === 'Debrief', 4000, 200);
    PASS(phaseMs >= 0, `the friend's phase follows to Debrief (${phaseMs}ms)`);

    await debriefChecks(A, 'H', opsBefore);

    /* THE WALL: the friend's machine holds the result and shows NOTHING. Nothing on a
     * client emits MISSION_ENDED, so main.js's handler — exit lock, credit progression,
     * open the debrief — never runs. Fix reported for net.js (not this driver's file). */
    const bOpened = await until(() => b.panels.open === 'debrief', 5000, 250);
    PASS(bOpened >= 0,
      `the friend's debrief opens by itself too (WALL if FAIL: client applySnapshot sets game.result and nothing emits MISSION_ENDED — fix handed to net.js)`);
    const rBend = reportScreen(B, 'friend, at the host\'s mission end');
    say(`  friend result=${b.game.result ? b.game.result.overall : 'null'} panels.open=${b.panels.open} phase=${b.game.mission.phase}`);
    await shot(B, 'squad-friend-at-end');

    /* The host walks on through their one button; what is left for the squad? */
    const ret = A.contentWindow.document.querySelector('.cd-panel [data-return]');
    if (ret) {
      ret.click();
      await wait(2500);
      let bStatus = '';
      try { bStatus = String(b.net.status); } catch { bStatus = '(unreadable)'; }
      say(`  friend's net.status after the host returned to base: "${bStatus}"`);
      const together = /join|room|lobby/i.test((screenReport(B).layers || []).join(' '));
      PASS(together,
        `the squad has a path to GO AGAIN TOGETHER (WALL if FAIL: host's return-to-base kills the room; every client dead-ends at "${bStatus}" — regroup flow handed to net.js/lobby)`);
      await shot(B, 'squad-friend-after-host-left');
    }
  } else {
    say('  (host mission never resolved — squad debrief measurements skipped)');
  }
  A.remove(); B.remove();
}

(async () => {
  /* The watchdog: the rolling partial posts itself every 45s from here, so a silent
   * renderer death anywhere loses under a minute of story, not a leg — run 6's page died
   * AFTER its last screenshot and took the squad epilogue's measurements with it. */
  const watchdog = setInterval(partial, 45000);
  try {
    await solo();
    await squad();
    say('PLAYTEST-COMPLETE');
  } catch (e) {
    say(`PLAYTEST ABORTED: ${e && e.stack ? e.stack : e}`);
  }
  clearInterval(watchdog);
  const passN = out.filter((s) => s.includes('PT-PASS')).length;
  const failN = out.filter((s) => s.includes('PT-FAIL')).length;
  say(`PT-TALLY pass=${passN} fail=${failN}`);
  await post(PORT, out.join('\n'));
})();
