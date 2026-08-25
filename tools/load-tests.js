/* A full squad, sustained — GDD §23 Milestone 5's "load testing", which was the last of that
 * milestone's five goals with nothing behind it.
 *
 * WHAT THIS ASKS THAT NOTHING ELSE DOES.
 *
 * `net-tests.js` section R measures ten seconds of five-seat traffic and answers "how wide is
 * the pipe" — 155 B per operative, 454 kbit/s of host uplink, unusable below 192 kbit/s. That
 * is a bandwidth question and it is answered. `soak.ps1` runs thirty simulated minutes and
 * answers "does anything grow" — for a SOLO game, with no net session in it at all.
 *
 * Nobody had put the two together. A five-seat session held open for minutes is where a
 * per-seat buffer, a per-message log entry or a snapshot history shows up, and none of those
 * appear in ten seconds or in a solo run. So: four clients on one host, every one of them
 * sending intent at 60 Hz and acting at a human rate, for four simulated minutes.
 *
 * ⚠ IT MEASURES WORK, NOT MILLISECONDS, AND THAT IS NOT A COMPROMISE.
 *
 * Every suite here runs under `--virtual-time-budget`, and this session measured what that
 * does: 200,000,000 spin iterations across 0 ms of `Date.now()` and 0.0 ms of
 * `performance.now()`. Both clocks are frozen through a synchronous task. A "load test" that
 * timed anything under that would report zero and call it fast — so the timings live in
 * `tools/bench.ps1`, which runs in real time and posts its result, and this asserts bytes,
 * messages, refusals and counters. Those are exact under virtual time and a millisecond is
 * not.
 *
 * `rig` and `seatOn` are lifted from `tools/net-tests.js` with their names kept, per the
 * house rule about copied code staying greppable.
 */

import { lines, counts, ok, eq, near, note, emit, run, heading, suite } from './harness.js';
import { Game } from '../src/game.js';
import { loadContent } from '../src/sim/content.js';
import { NetSession, loopbackPair, ACT_BURST, ACT_PER_SEC } from '../src/net/net.js';
import { ACT, encodeCommand, MAX_SQUAD } from '../src/net/protocol.js';

const FPS = 60;
const MINUTES = 4;
const FRAMES = MINUTES * 60 * FPS;
/** Sampled every thirty simulated seconds, so a slope has somewhere to show up. */
const WINDOW_FRAMES = 30 * FPS;

function rig(content, seed = 'load') {
  const clock = { ms: 0 };
  const g = new Game(content, { seed });
  const n = new NetSession(g, { now: () => clock.ms });
  return { g, n, clock, tick: (ms) => { clock.ms += ms; } };
}

function seatOn(host, client, name, opts = {}) {
  const [hl, cl] = loopbackPair(opts);
  host.n.accept(hl);
  client.n.join(cl, { name });
  return { hl, cl };
}

/**
 * Every countable thing hanging off an object, one level deep.
 *
 * Deliberately shallow and deliberately dumb: the point is to find a structure NOBODY
 * remembered, so a hand-written list of the ones we know about would answer the wrong
 * question. `soak.js` makes the same argument at greater length and walks deeper; this one
 * only has to see the host's and a client's own fields.
 */
function countables(obj, prefix, out = new Map()) {
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    let v;
    try { v = obj[k]; } catch { continue; }
    if (Array.isArray(v)) out.set(`${prefix}.${k}`, v.length);
    else if (v instanceof Map || v instanceof Set) out.set(`${prefix}.${k}`, v.size);
  }
  return out;
}

function probe(host, client) {
  const m = new Map();
  countables(host.g, 'game', m);
  countables(host.g.mission, 'mission', m);
  countables(host.g.ledger, 'ledger', m);
  countables(host.g.anomaly, 'anomaly', m);
  countables(host.g.deployables, 'deployables', m);
  countables(host.n, 'host', m);
  countables(host.n.lobby, 'lobby', m);
  countables(client.g, 'client.game', m);
  countables(client.n, 'client', m);
  return m;
}

/* ── LA. four minutes at a full squad ─────────────────────────────────────── */
async function sectionLA() {
  heading(`LA. ${MAX_SQUAD} seats, ${MINUTES} simulated minutes, everybody sending`);
  const content = await loadContent({ incident: 'cold-storage-draught' });

  const host = rig(content);
  host.n.host();
  const clients = [];
  for (let i = 0; i < MAX_SQUAD - 1; i++) {
    const c = rig(content, `load-c${i}`);
    clients.push({ c, ...seatOn(host, c, `Operative ${i + 2}`) });
  }
  eq(`LA1 the host seats a full squad`, host.n.lobby.size, MAX_SQUAD);

  /* A command that is never the same twice, because a wire format that dedupes or a JSON
   * engine that interns would make a constant look cheaper than play is. */
  const cmdAt = (f) => ({
    axis: { x: Math.sin(f / 37) * 0.9, y: Math.cos(f / 41) * 0.9 },
    yaw: (f % 628) / 100, pitch: -0.1, sprint: f % 120 < 40, crouch: f % 300 < 30,
  });
  note(`  a command on the wire is ${JSON.stringify(encodeCommand(cmdAt(0))).length} B`);

  const first = probe(host, clients[0].c);
  const windows = [];
  let mark = { down: 0, up: 0, downMsgs: 0, upMsgs: 0 };
  let refusedDuringPlay = 0;
  const refusalsAt = () => [...host.n.lobby.log].filter((e) => /flood|rate|too many/i.test(JSON.stringify(e))).length;
  const refusedBefore = refusalsAt();

  for (let f = 0; f < FRAMES; f++) {
    host.tick(1000 / FPS);
    host.n.pump(1000 / FPS, null);
    for (let i = 0; i < clients.length; i++) {
      const s = clients[i];
      s.c.tick(1000 / FPS);
      s.c.n.pump(1000 / FPS, cmdAt(f + i * 7));
      /* A human rate: one discrete action every two seconds each, staggered. ACT_PER_SEC is
       * 12 and ACT_BURST is 30, so this is nowhere near the limiter — which is the point. */
      if ((f + i * 31) % (2 * FPS) === 0) s.c.n.act(ACT.IMAGER);
    }
    if ((f + 1) % WINDOW_FRAMES === 0) {
      const down = clients.reduce((a, s) => a + s.hl.bytes, 0);
      const up = clients.reduce((a, s) => a + s.cl.bytes, 0);
      const downMsgs = clients.reduce((a, s) => a + s.hl.sent, 0);
      const upMsgs = clients.reduce((a, s) => a + s.cl.sent, 0);
      windows.push({
        down: down - mark.down, up: up - mark.up,
        downMsgs: downMsgs - mark.downMsgs, upMsgs: upMsgs - mark.upMsgs,
      });
      mark = { down, up, downMsgs, upMsgs };
    }
  }
  refusedDuringPlay = refusalsAt() - refusedBefore;

  const secs = WINDOW_FRAMES / FPS;
  note(`  window   down kB/s   up kB/s   down msg/s   up msg/s`);
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    note(`  ${String(i + 1).padStart(3)}  ${(w.down / 1024 / secs).toFixed(2).padStart(10)}`
      + `${(w.up / 1024 / secs).toFixed(2).padStart(10)}`
      + `${(w.downMsgs / secs).toFixed(1).padStart(13)}${(w.upMsgs / secs).toFixed(1).padStart(11)}`);
  }

  const a = windows[0], z = windows[windows.length - 1];
  const drift = (x, y) => (y === 0 ? 0 : Math.abs(x - y) / y);
  ok(`LA2 the host's uplink is FLAT across ${MINUTES} minutes — ${(a.down / 1024 / secs).toFixed(2)} kB/s in the first window, ${(z.down / 1024 / secs).toFixed(2)} in the last`,
    drift(z.down, a.down) < 0.10, `${(100 * drift(z.down, a.down)).toFixed(1)}% drift`);
  ok(`LA3 and so is the squad's — ${(a.up / 1024 / secs).toFixed(2)} kB/s against ${(z.up / 1024 / secs).toFixed(2)}`,
    drift(z.up, a.up) < 0.10, `${(100 * drift(z.up, a.up)).toFixed(1)}% drift`);
  ok('LA4 message rates do not drift either, so the flatness above is not two changes cancelling',
    drift(z.downMsgs, a.downMsgs) < 0.05 && drift(z.upMsgs, a.upMsgs) < 0.05);

  /**
   * ⚠ THE LIMITER MUST NOT BITE AN HONEST SQUAD, AND NOBODY HAD CHECKED THAT DIRECTION.
   *
   * A rate limit is tested by flooding it, which proves it stops an attacker and says
   * nothing about whether it stops a player. Four operatives acting every two seconds for
   * four minutes is roughly 480 actions, and not one of them may be refused — a defence
   * that costs the people it defends is a bug wearing a security argument.
   */
  eq('LA5 four minutes of ordinary play by four operatives is refused exactly nothing', refusedDuringPlay, 0);
  note(`  ACT_BURST ${ACT_BURST}, ACT_PER_SEC ${ACT_PER_SEC}; the squad asked for about ${Math.round((FRAMES / (2 * FPS)) * clients.length)} actions`);

  const last = probe(host, clients[0].c);
  const grew = [];
  for (const [k, v] of last) {
    const was = first.get(k) || 0;
    if (v > was) grew.push({ k, was, v, d: v - was });
  }
  grew.sort((x, y) => y.d - x.d);
  for (const g of grew.slice(0, 12)) note(`  ${g.k.padEnd(34)} ${String(g.was).padStart(6)} → ${String(g.v).padStart(6)}`);
  note(`  ${grew.length} structure(s) larger at the end than at the start`);

  /**
   * Growth is not automatically a leak — a mission that ran for four minutes has more
   * notices in it than one that ran for none, and it should. What must not happen is
   * growth WITHOUT A CAP, so the check is against the caps the build already declares
   * rather than against zero.
   */
  const uncapped = grew.filter((g) => g.v > 512);
  eq(`LA6 nothing on either end passed 512 entries${uncapped.length ? ` — ${uncapped.map((g) => `${g.k}=${g.v}`).join(', ')}` : ''}`,
    uncapped.length, 0);

  return { host, clients, content };
}

/* ── LB. and the same limiter, from the other side ────────────────────────── */
async function sectionLB(ctx) {
  heading('LB. one seat floods, and the other three keep playing');
  const { host, clients } = ctx;

  const before = clients.map((s) => s.c.n.act(ACT.IMAGER));
  ok('LB1 every seat can still act after four minutes of session', before.every(Boolean));
  host.tick(1000 / FPS);
  host.n.pump(1000 / FPS, null);

  /* Drain one seat's bucket by asking for far more than ACT_BURST in a single frame. */
  const flooder = clients[0];
  for (let i = 0; i < 400; i++) flooder.c.n.act(ACT.IMAGER);
  host.tick(1000 / FPS);
  host.n.pump(1000 / FPS, null);

  /* ⚠ THE TEST IS WHETHER THE OTHERS ARE UNTOUCHED. A bucket keyed on the session rather
   * than on the seat would pass every flooding test ever written and take the squad down
   * with the flooder — which is a denial of service handed to any client that asks. */
  const others = clients.slice(1);
  for (const s of others) { s.c.n.act(ACT.IMAGER); s.c.tick(1000 / FPS); }
  host.tick(1000 / FPS);
  host.n.pump(1000 / FPS, null);

  const drained = host.n._actBudget.get('p2');
  const untouched = others.map((s, i) => host.n._actBudget.get(`p${i + 3}`));
  note(`  the flooder's bucket: ${drained ? drained.tokens.toFixed(1) : '(none)'} tokens of ${ACT_BURST}`);
  note(`  the others: ${untouched.map((b) => (b ? b.tokens.toFixed(1) : '—')).join(', ')}`);
  ok('LB2 the flooder is out of tokens', !!drained && drained.tokens < 1);
  ok('LB3 and every other seat still has most of its own, because the bucket is keyed on the SEAT',
    untouched.every((b) => b && b.tokens > ACT_BURST / 2),
    untouched.map((b) => (b ? b.tokens.toFixed(1) : 'missing')).join(', '));

  /* And it recovers on the clock rather than on a reconnect. */
  host.tick(3000);
  host.n.pump(1000 / FPS, null);
  flooder.c.n.act(ACT.IMAGER);
  host.tick(1000 / FPS);
  host.n.pump(1000 / FPS, null);
  const after = host.n._actBudget.get('p2');
  note(`  three seconds later it holds ${after ? after.tokens.toFixed(1) : '(none)'} tokens`);
  ok(`LB4 three seconds of not flooding buys back about ${3 * ACT_PER_SEC} actions, so a flood is a pause and not a ban`,
    !!after && after.tokens > ACT_PER_SEC, after ? after.tokens.toFixed(1) : 'missing');
}

/* ── LC. what a session costs a client that has been in it all along ──────── */
async function sectionLC(ctx) {
  heading('LC. the client end, which holds a world it did not simulate');
  const { host, clients } = ctx;
  const c = clients[0].c;

  eq('LC1 a client that has been connected for four minutes still has exactly one world',
    c.g.players.length, host.g.players.length);
  ok('LC2 and it agrees with the host about who is in it',
    c.g.players.map((p) => p.id).join() === host.g.players.map((p) => p.id).join(),
    `${c.g.players.map((p) => p.id).join()} vs ${host.g.players.map((p) => p.id).join()}`);
  eq('LC3 and about the phase', c.g.mission.phase, host.g.mission.phase);

  /**
   * ⚠ THE ONE THAT WOULD NOT SHOW UP IN TEN SECONDS. `lastSnapshot` is what makes a refused
   * frame different from a dropped one, and a client that KEPT them would be holding four
   * minutes of world history to answer a question about the current one.
   */
  const held = countables(c.n, 'client');
  const big = [...held].filter(([, v]) => v > 64);
  eq(`LC4 the client holds no history it does not need${big.length ? ` — ${big.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`,
    big.length, 0);

  /**
   * ⚠ THE POINT OF A SUSTAINED NUMBER IS THAT IT AGREES WITH THE BURST ONE.
   *
   * `net-tests.js` R8 measures ten seconds and asserts the host's uplink at a full squad
   * sits between 250 and 900 kbit/s; R12 finds 192 kbit/s to be the link speed at which the
   * backlog stops settling and starts growing — where a full squad stops being fair. Those
   * are a ceiling-band and a floor, and the first version of this assertion read the floor
   * as a budget and demanded the host stay UNDER it, which is exactly backwards: a host
   * that used less than 192 kbit/s would not be a well-behaved host, it would be one that
   * had stopped sending snapshots.
   *
   * So the claim is the one a load test is actually for: four minutes gives the same answer
   * as ten seconds, to the same band, with no drift in between.
   */
  const bytesPerSeat = clients.reduce((a, s) => a + s.hl.bytes, 0) / clients.length / (MINUTES * 60);
  const uplinkKbit = (bytesPerSeat * 8 * (MAX_SQUAD - 1)) / 1000;
  note(`  ${(bytesPerSeat / 1024).toFixed(2)} kB/s to each seat, sustained, over the whole run`);
  note(`  = ${uplinkKbit.toFixed(0)} kbit/s of host uplink, against the 250–900 band a ten-second run asserts`);
  ok(`LC5 four minutes agrees with ten seconds — ${uplinkKbit.toFixed(0)} kbit/s, inside the band, so the burst figure was not a burst`,
    uplinkKbit > 250 && uplinkKbit < 900, `${uplinkKbit.toFixed(0)} kbit/s`);
  ok(`LC6 and it is ${(uplinkKbit / 192).toFixed(1)}× the 192 kbit/s at which the backlog stops settling, which is the number to quote at somebody hosting on a phone`,
    uplinkKbit > 192);
}

suite('load', async () => {
  let ctx = null;
  await run('LA', async () => { ctx = await sectionLA(); });
  if (ctx) await run('LB', () => sectionLB(ctx));
  if (ctx) await run('LC', () => sectionLC(ctx));
});
