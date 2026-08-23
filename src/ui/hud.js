/* The in-world overlay — GDD §18.2. Minimal by default.
 *
 * Three rules this file obeys:
 *   · It never shows a number the operative could not measure. Pressure is a WORD, because
 *     §5.4 says pressure is a director input and not a visible rage meter. Battery is
 *     MINUTES, because a battery is a thing you can read off a unit.
 *   · Every critical state carries redundant channels (§18.1): colour AND shape AND text.
 *     The imager bezel goes red and gains a border AND says the word.
 *   · It states what the SIMULATION says. There is exactly one resolver for the context
 *     verb (`game.contextAction`), so the prompt and the key can never disagree.
 *
 * Rebuilt from state each frame, diffed by signature so the DOM is not rewritten at 60Hz.
 */

import { CONFIG, SLOTS } from '../config.js';
import { GameClock } from '../core/clock.js';
import { ANOMALY_STATE } from '../sim/anomaly.js';
import { dist } from '../sim/geometry.js';
import { operativeNoiseDb } from '../sim/sound.js';
import { t, plural } from '../core/i18n.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

export class Hud {
  constructor(root, game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.root = root;
    this._sig = {};

    this.crosshair = el('div', 'cd-crosshair', root);
    this.topLeft = el('div', 'cd-topleft', root);
    this.topRight = el('div', 'cd-topright', root);
    this.prompt = el('div', 'cd-prompt', root);
    this.slots = el('div', 'cd-slots', root);
    this.conditions = el('div', 'cd-conditions', root);
    this.noise = el('div', 'cd-noise', root);
    this.mic = el('div', 'cd-mic', root);
    this.notices = el('div', 'cd-notices', root);
    this.bezel = el('div', 'cd-bezel', root);
    this.bezelLabel = el('div', 'cd-bezel-label', this.bezel);
    this.squad = el('div', 'cd-squad', root);

    /**
     * §18.2's navigation aid. 'off' by default and the default is the design: "no permanent
     * minimap in standard mode. Maps are held devices or command displays; accessibility
     * settings can add navigation aids." So this is the one place in the build where the
     * standard HUD may be exceeded, and only because a player asked for it in §19.1.
     *
     * ⚠ IT SHOWS THE BUILDING, NOT THE INCIDENT. The minimap draws walls, doors, the
     * extraction and your own squad. It does NOT draw the anomaly, and it never will: the
     * thermal imager is how you find out where the thing is, that search is most of the
     * game, and an aid that answered it would be handing back the §7.4 question rather
     * than making the floor navigable. The suite asserts the anomaly's position never
     * reaches this element.
     */
    this.navAid = el('canvas', 'cd-navaid', root);
    this.navAid.width = 180; this.navAid.height = 180;
    this.navAid.style.display = 'none';
    this.navMode = 'off';
  }

  /**
   * Called from applySettings; 'off' | 'compass' | 'minimap'.
   *
   * The backing store is resized to match the CSS box for the mode. A canvas whose
   * attribute size and layout size disagree does not clip — it SCALES, so a 180×180 strip
   * stretched into a 240×56 box draws a compass with squashed letters and bearings that
   * are subtly wrong, which is worse than no compass.
   */
  setNavigationAid(mode) {
    this.navMode = ['compass', 'minimap'].includes(mode) ? mode : 'off';
    this.navAid.style.display = this.navMode === 'off' ? 'none' : 'block';
    this.navAid.classList.toggle('compass', this.navMode === 'compass');
    if (this.navMode === 'compass') { this.navAid.width = 240; this.navAid.height = 56; }
    else { this.navAid.width = 180; this.navAid.height = 180; }
    this._sig.nav = null;
    return this.navMode;
  }

  /**
   * The aid, redrawn each frame. Cheap: a couple of hundred line segments on a 180px
   * canvas, and nothing at all when it is off.
   *
   * Forward is (-sin yaw, -cos yaw), the same convention the camera, the movement code and
   * the perception cones use. Getting it backwards here would draw a compass that points
   * behind the player, which is the kind of thing that reads as "roughly right" until
   * somebody trusts it in the dark.
   */
  _drawNavAid() {
    if (this.navMode === 'off') return;
    const g = this.game, p = g.viewPlayer, c = this.navAid.getContext('2d');
    const W = this.navAid.width, H = this.navAid.height;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--cyan').trim() || '#5fd0d8';
    const warm = css.getPropertyValue('--amber').trim() || '#e5a13a';
    c.clearRect(0, 0, W, H);
    c.lineWidth = 1;

    if (this.navMode === 'compass') {
      /* A bearing strip: cardinal letters, and the bearing to extraction — the one question
       * a lost operative carrying a sealed case actually has.
       *
       * ⚠ THE SIGN. `player.yaw -= dx * sensitivity`, so turning RIGHT DECREASES yaw. A
       * bearing therefore sits at `player.yaw − targetYaw` on the strip, and the obvious
       * `target − current` puts every marker on the wrong side. It reads as a working
       * compass right up until somebody follows it, which is the only time it is used.
       * One helper, so the letters and the marker cannot disagree about which way is right.
       */
      const HALF_FOV = 1.2;
      const offset = (targetYaw) => {
        let d = p.yaw - targetYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return d;
      };
      const screenX = (d) => W / 2 + (d / HALF_FOV) * (W / 2 - 10);

      c.strokeStyle = ink; c.globalAlpha = 0.5;
      c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
      c.globalAlpha = 1;
      c.font = '11px ui-monospace, monospace'; c.textAlign = 'center';
      /* Cardinals as the YAW that faces them, not as bearings — forward is
       * (-sin yaw, -cos yaw), so facing +z (north, and up on the minimap) is yaw π. */
      for (const [label, ang] of [['N', Math.PI], ['E', -Math.PI / 2], ['S', 0], ['W', Math.PI / 2]]) {
        const d = offset(ang);
        if (Math.abs(d) > HALF_FOV) continue;
        const x = screenX(d);
        c.fillStyle = ink;
        c.fillText(label, x, H / 2 - 6);
        c.beginPath(); c.moveTo(x, H / 2 - 3); c.lineTo(x, H / 2 + 3); c.stroke();
      }
      const ex = g.site.extraction;
      const de = offset(Math.atan2(-(ex.x - p.x), -(ex.z - p.z)));
      c.fillStyle = warm;
      c.textAlign = 'center';
      const exLabel = `stair ${dist(p.x, p.z, ex.x, ex.z).toFixed(0)}m`;
      if (Math.abs(de) <= HALF_FOV) {
        const x = screenX(de);
        c.beginPath(); c.moveTo(x, H / 2 + 5); c.lineTo(x - 4, H / 2 + 12); c.lineTo(x + 4, H / 2 + 12); c.closePath(); c.fill();
        c.fillText(exLabel, x, H / 2 + 24);
      } else {
        /* Off the strip: an arrow at the edge you would turn toward. */
        c.textAlign = de > 0 ? 'right' : 'left';
        c.fillText(`${de > 0 ? '▶' : '◀'} ${exLabel}`, de > 0 ? W - 6 : 6, H / 2 + 22);
      }
      return;
    }

    /* Minimap: north-up, the whole floor scaled to fit. North-up rather than heading-up
     * because a rotating map is harder to read for exactly the people most likely to have
     * turned this on, and because the room names in the log are written north-up too. */
    const b = g.site.bounds;
    const s = Math.min(W / (b.maxX - b.minX), H / (b.maxZ - b.minZ)) * 0.92;
    const ox = W / 2 - ((b.minX + b.maxX) / 2) * s;
    const oy = H / 2 + ((b.minZ + b.maxZ) / 2) * s;
    const px = (x) => ox + x * s;
    const py = (z) => oy - z * s;

    /**
     * ⚠ SOLID AND POROUS ARE DRAWN DIFFERENTLY, because on some floors they are mostly the
     * same line and mean opposite things.
     *
     * This drew everything from `blockingRects()`, which is what stops a PERSON. Indoors
     * that was a small lie — the steel racking in the cold-store aisles reads as wall and
     * is not one to the draught. On the forest reserve it is not small: 441.8m of the map's
     * 491m of built length is deer fence, chain-link, timber and tree line, so nine tenths
     * of the drawn map would have been a wall to the squad and nothing at all to the thing
     * they are fencing. A navigation aid that tells you a chain-link fence will hold a
     * draught is worse than one that shows nothing.
     *
     * Solid is a continuous outline; porous is dashed. Two channels, not colour — §19.2,
     * and the aid has to work in the colour-vision presets.
     */
    const insulated = new Set(g.site.insulatedRects());
    c.globalAlpha = 0.75;
    for (const r of g.site.blockingRects()) {
      const solid = insulated.has(r);
      c.strokeStyle = ink;
      c.setLineDash(solid ? [] : [2, 2]);
      c.globalAlpha = solid ? 0.85 : 0.45;
      c.strokeRect(px(r[0]), py(r[3]), (r[2] - r[0]) * s, (r[3] - r[1]) * s);
    }
    c.setLineDash([]);
    c.globalAlpha = 1;
    /* An open door is a gap you can walk through and it is drawn as one. */
    c.strokeStyle = warm;
    for (const d of g.site.doors) {
      if (!d.open) continue;
      const r = d.rect;
      c.beginPath(); c.moveTo(px(r[0]), py(r[1])); c.lineTo(px(r[2]), py(r[3])); c.stroke();
    }
    const ex = g.site.extraction;
    c.fillStyle = warm;
    c.fillRect(px(ex.x) - 3, py(ex.z) - 3, 6, 6);
    /* The squad, then you, so you are never hidden under a teammate. */
    for (const q of g.players) {
      if (q === p || !q.alive) continue;
      c.fillStyle = ink;
      c.beginPath(); c.arc(px(q.x), py(q.z), 2.5, 0, Math.PI * 2); c.fill();
    }
    c.save();
    c.translate(px(p.x), py(p.z));
    c.rotate(p.yaw);
    c.fillStyle = warm;
    c.beginPath(); c.moveTo(0, -5); c.lineTo(3.5, 4); c.lineTo(-3.5, 4); c.closePath(); c.fill();
    c.restore();
  }

  _set(key, node, html) {
    if (this._sig[key] === html) return;
    this._sig[key] = html;
    node.innerHTML = html;
  }

  update() {
    const g = this.game, p = g.viewPlayer, m = g.mission, a = g.anomaly;
    const now = g.clock.simTimeMs;

    /* ── top left: where, when, how bad ── */
    const room = g.site.roomNameAt(p.x, p.z);
    const left = g.site.circuits;
    const power = Array.from(left.values()).map((c) => `<i class="${c.on ? 'on' : 'off'}"></i>${escapeHtml(String(c.displayName || '').replace(' circuit', ''))}`).join('');
    /**
     * ⚠ `t()` INTERPOLATES RAW, AND A MISSING KEY RETURNS THE KEY.
     *
     * Both halves matter and only together. `t('phase.' + m.phase)` looks like a lookup
     * against a closed vocabulary, and it is — until `m.phase` comes off a snapshot, at
     * which point an unknown phase resolves to the literal string `phase.<whatever the host
     * sent>` and `t('hud.clock', {phase})` drops it into this template unescaped. The wire
     * layer now refuses a phase that is not an id, and this escapes what survives; neither
     * alone is enough, because the wire cannot know this ends up in `innerHTML` and this
     * cannot know the value came from a stranger.
     */
    this._set('tl', this.topLeft, `
      <div class="row big">${escapeHtml(room)}</div>
      <div class="row">${t('hud.clock', {
    time: GameClock.formatMs(now), phase: escapeHtml(t(`phase.${m.phase}`)),
  })}</div>
      <div class="row stage s${m.stage}">${t('hud.pressure', { stage: `<b>${t(`pressure.${m.stageName}`)}</b>` })}</div>
      <div class="row power">${power}</div>`);

    /* ── top right: the objective, in the order it actually happens ── */
    const obj = this._objective();
    this._set('tr', this.topRight, `<div class="obj-title">Primary</div><div class="obj">${obj}</div>`);

    /* Everything below is about the LOCAL operative — the one whose eyes these are. On a
     * client that is not operative one, so nothing here may read `g.player`. */
    const on = g.imagerOnIds.has(p.id);

    /* ── the context verb ── */
    const act = g.contextAction(p.id);
    const key = act && act.kind === 'blocked' ? '' : '<kbd>F</kbd>';
    this._set('prompt', this.prompt, act
      ? `<span class="${act.kind === 'seal' ? 'seal' : act.kind === 'blocked' ? 'blocked' : ''}">${key} ${act.text}</span>`
      : '');

    /* ── slots ── */
    const slotHtml = SLOTS.map((s, i) => {
      const id = p.slots.get(s.id);
      const item = id ? g.itemsById.get(id) : null;
      const held = p.heldSlot === s.id;
      let sub = '';
      if (id === 'thermal-imager') {
        const mins = g.batteryFor('thermal-imager') / 60000;
        sub = `<em class="${mins < 2 ? 'warn' : ''}">${t(on ? 'hud.imagerChargeOn' : 'hud.imagerCharge', { minutes: mins.toFixed(1) })}</em>`;
      }
      return `<div class="slot ${held ? 'held' : ''} ${item ? '' : 'empty'}">
        <b>${i + 1}</b><span>${item ? item.displayName : t('hud.slotEmpty')}</span>${sub}</div>`;
    }).join('');
    /* ⚠ `itemsById.get(p.hands).displayName` WITH NO GUARD, ON THE 60 Hz PATH. `p.hands` is
     * written by `applySnapshot` from a field the host chose, so one item id this build does
     * not have threw out of the HUD on every frame for the rest of the session — a client
     * killed by two characters of somebody else's JSON. The wire layer drops unknown ids
     * now; this is the guard that should always have been here. */
    const handItem = p.hands ? g.itemsById.get(p.hands) : null;
    const hands = handItem ? `<div class="slot hands held"><b>✋</b><span>${escapeHtml(handItem.displayName)}</span></div>` : '';
    this._set('slots', this.slots, slotHtml + hands);

    /* ── condition and stress ── */
    const c = p.conditions;
    const cond = [];
    /* ⚠ ' · stabilised' WAS A FRAGMENT CONCATENATED ONTO A SENTENCE, and a fragment is the
     * one thing a message table may not contain: the word order it assumes is English's.
     * Two whole messages, and the code picks between them. */
    if (c.exposure.severity) {
      cond.push(`<div class="cond sev${c.exposure.severity}">${t(c.exposure.stabilised
        ? 'hud.cond.exposureStabilised' : 'hud.cond.exposure', { bars: '▮'.repeat(c.exposure.severity) })}</div>`);
    }
    if (c.mobility.severity) {
      cond.push(`<div class="cond sev${c.mobility.severity}">${t(c.mobility.stabilised
        ? 'hud.cond.mobilityStabilised' : 'hud.cond.mobility', { bars: '▮'.repeat(c.mobility.severity) })}</div>`);
    }
    const st = p.stressNorm;
    if (st > 0.35) cond.push(`<div class="cond stress">${t(st > 0.75 ? 'hud.stress.hard' : 'hud.stress.unsteady')}</div>`);
    this._set('cond', this.conditions, cond.join(''));

    /**
     * ⚠ HOW MUCH NOISE YOU ARE MAKING HAD NO OUTPUT CHANNEL AT ALL.
     *
     * The sound field is fully simulated — four levels off SPEED, wall loss, occluders,
     * masking, a whole instrument to read it — and `blackthorn-caller` hunts it and is
     * restrained by silence, so on that floor it is the entire game. Nothing showed it.
     * Not the HUD, and not the mix either: `audio.js` has no footstep cue, so a player
     * with headphones on was in exactly the same position as one with the sound off.
     *
     * That is §8.2 before it is §19.2. Every rule has to be OBSERVABLE, and the quantity
     * this one is about was legible only to the anomaly.
     *
     * NO NUMBER AND NO THRESHOLD MARK. The figure the caller wakes at is a rule the squad
     * learns from evidence (§7.4), and printing "46 dB" beside a live readout would hand
     * back the question the whole investigation phase exists to ask. What this shows is
     * the thing the player is DOING, which they chose and are entitled to see: still,
     * crouched, walking, running. The bands come off CONFIG's own four figures rather than
     * being redrawn here, so a tuning pass moves the readout with the rule.
     */
    const noiseDb = operativeNoiseDb(p);
    const { stillNoiseDb: q0, crouchNoiseDb: q1, walkNoiseDb: q2 } = CONFIG.player;
    const band = noiseDb <= q0 + 0.5 ? 1
      : noiseDb <= q1 + 0.5 ? 2
        : noiseDb <= q2 + 0.5 ? 3 : 4;
    const NOISE_KEY = ['', 'hud.noise.still', 'hud.noise.careful', 'hud.noise.walking', 'hud.noise.running'];
    this.noise.className = `cd-noise n${band}`;
    this._set('noise', this.noise, `
      <span class="bars">${[1, 2, 3, 4].map((i) => `<i class="${i <= band ? 'lit' : ''}"></i>`).join('')}</span>
      <span>${t(NOISE_KEY[band])}</span>`);

    /**
     * ⚠ THE DIRECTIONAL MICROPHONE HAD NO SCREEN. `micReading` modelled the whole
     * instrument — polar pattern, on-axis gain, off-axis and diffuse rejection, handling
     * noise up the handle, masking arithmetic done in the microphone's own frame — and
     * nothing outside `sound.js` ever called it. A squad could spend a general slot and
     * twelve minutes of cell on an item that did nothing. The imager's opposite number.
     *
     * A BEARING, NOT A POSITION, which is what the item's own summary promises. Degrees off
     * the axis you are pointing, with a side, and the level in decibels because that is
     * what an instrument is FOR — the whole reason to carry it is that it tells you more
     * than your ears. It does not name what a source is beyond its kind, and it never
     * mentions the anomaly, which is not a sound source and cannot be: what this resolves
     * is your own squad and your own kit, and finding that out is the caller's lesson.
     */
    const mic = g.micReadingFor(p.id);
    this.mic.className = mic ? 'cd-mic on' : 'cd-mic';
    if (mic) {
      const rows = mic.resolved.slice(0, 3).map((r) => {
        const degrees = Math.round(Math.abs(r.offAxisRad) * 180 / Math.PI);
        const bearing = degrees <= 4 ? t('hud.mic.bearing.ahead')
          : t(r.offAxisRad > 0 ? 'hud.mic.bearing.right' : 'hud.mic.bearing.left', { degrees });
        const what = t(r.kind === 'operative' ? 'hud.mic.what.body' : 'hud.mic.what.equipment');
        return `<div class="src"><span>${t('hud.mic.row', { what, bearing })}</span>`
          + `<b>${t('hud.mic.level', { db: r.db.toFixed(1) })}</b></div>`;
      }).join('');
      this._set('mic', this.mic, `<div class="head">${t('hud.mic.title')}</div>${rows
        || `<div class="none">${t('hud.mic.none')}</div>`}<div class="floor">${
        t('hud.mic.floor', { room: mic.floorDb.toFixed(1), handling: mic.selfNoiseDb.toFixed(0) })}</div>`);
    }

    /* ── the squad (GDD §18.2 "squad status indicators", §11.2 split information) ──
     * Solo shows nothing: a roster of one is clutter. The moment there are two, where
     * everybody is and what state they are in becomes the most important thing on screen,
     * because the whole design is that you cannot do this alone and cannot see it all. */
    if (g.players.length > 1) {
      const rows = g.players.map((q) => {
        const d = dist(p.x, p.z, q.x, q.z);
        const state = !q.alive ? 'lost' : q.downed ? 'down' : !q.connected ? 'off' : q.injured ? 'hurt' : 'ok';
        const word = !q.alive ? t('hud.squad.lost')
          : q.downed ? t('hud.squad.down', { seconds: Math.max(0, Math.ceil((CONFIG.player.bleedOutMs - q.downedMs) / 1000)) })
            : !q.connected ? t('hud.squad.noRadio') : q.injured ? t('hud.squad.injured') : t('hud.squad.ok');
        return `<div class="mate ${state} ${q === p ? 'self' : ''}">
          <b>${escapeHtml(q.name)}</b>
          <span class="w">${word}</span>
          <span class="d">${q === p ? '' : t('hud.squad.position', {
    metres: d.toFixed(0), room: escapeHtml(g.site.roomNameAt(q.x, q.z)),
  })}</span>
        </div>`;
      }).join('');
      this._set('squad', this.squad, rows);
      this.squad.style.display = 'flex';
    } else {
      this.squad.style.display = 'none';
    }

    /* ── notices ── */
    this._set('notice', this.notices,
      g.recentNotices().map((n) => `<div class="notice">${escapeHtml(n.text)}</div>`).join(''));

    /* ── the imager bezel ── */
    if (on) {
      const r = this.renderer.imagerRectCss();
      this.bezel.style.display = 'block';
      this.bezel.style.left = `${r.left}px`;
      this.bezel.style.top = `${r.top}px`;
      this.bezel.style.width = `${r.size}px`;
      this.bezel.style.height = `${r.size}px`;
      /* ⚠ THE ANOMALY'S STATE COMES OFF THE WIRE AND GOES INTO `innerHTML`. `a.state` is
       * written by `applySnapshot`; it lands in `t('hud.bezel.held', {state})`, which
       * interpolates raw, and then in `bezelLabel.innerHTML` below. It is an id at the wire
       * and it is escaped here, for the same both-layers reason as the phase above. */
      const state = escapeHtml(a.isLoose ? a.state : 'contained');
      const held = a.isHeld;
      this.bezel.classList.toggle('held', held);
      this.bezel.classList.toggle('hot', a.stateKind === 'hunting');
      /* ⚠ `n === 1 ? '' : 's'` IS NOT A PLURAL RULE, it is English's plural rule written
       * out. Polish has three forms and Arabic six, and `Intl.PluralRules` already knows
       * which one this locale wants — so the message table authors the categories and the
       * code asks for a count. */
      const right = held ? t('hud.bezel.held', { state })
        : a.escapes === undefined ? t('hud.bezel.lanesUnknown', { state })
          : plural('hud.bezel.lanes', a.escapes, { state });
      this.bezelLabel.innerHTML = `<span>${t('hud.bezel.contour', { celsius: CONFIG.heat.gradientThresholdC })}</span>`
        + `<span>${right}</span>`;
    } else {
      this.bezel.style.display = 'none';
    }

    this._drawNavAid();
  }

  _objective() {
    const g = this.game;
    const me = g.viewPlayer;
    if (g.custody === 'verified') {
      const carrier = g.players.find((q) => q.hands === 'reinforced-transit-case');
      if (carrier === me) return t('hud.objective.carry');
      /* ⚠ THE ONE PLACE A CALLSIGN REACHED `innerHTML` UNESCAPED. The squad list, the notice
       * feed, the lobby roster, the comms feed and the moderation log all escape; this line
       * did not, because `t()` looks like it is doing something and all it does is
       * `String(params[name])`. A callsign is fourteen characters a stranger typed, and the
       * objective panel is on screen for the whole operation. */
      if (carrier) return t('hud.objective.carrierHas', { name: escapeHtml(carrier.name) });
      return t('hud.objective.lift');
    }
    if (g.custody === 'sealed') {
      const held = g.anomaly.sealedIn ? g.anomaly.sealedIn.custodyHeldMs / 1000 : 0;
      return t('hud.objective.hold', { held: held.toFixed(0), need: CONFIG.anomaly.custodyVerifySeconds });
    }
    /**
     * The distributed set (GDD §26.2). What the HUD is allowed to say here is the whole
     * design of the family, so it is worth being explicit about the line it does not cross.
     *
     * ⚠ IT REPORTS THE CASE'S COUNT AND NEVER THE TOTAL. The count is a reading off an
     * instrument the squad is standing next to, so it is theirs. The total is on the
     * stocktake sheet in the office, and a HUD that printed "3 of 5" would hand over the
     * one fact the entire incident is organised around finding — §7.4 asks for confidence
     * rather than checklist completion, and a checklist is exactly what that would be.
     *
     * It also never says the case is contaminated. The case takes a wrong object silently
     * and the number does not move; noticing THAT is the mechanic.
     */
    if (g.anomaly.isDistributed) {
      const n = g.instances.counted;
      const carrying = g.instances.carriedBy(me.id);
      if (carrying) return t('hud.objective.instancesCarrying', { count: n });
      if (n === 0) return t('hud.objective.instancesNone');
      /* ⚠ "The account is closed. Seal it." was here, and it was the game answering the
       * question. Nothing tells you when you are finished: the case reports what it holds,
       * the sheet in the office says how many there should be, and the seal is a decision
       * you make on those two numbers. */
      return t('hud.objective.instances', { count: n });
    }

    /* ⚠ 1.5m WAS SPELLED INTO THE SENTENCE and the seal radius is authored on the trigger.
     * Read it, so a package that seals at a different distance says so. */
    if (g.anomaly.isHeld) {
      const seal = (g.anomaly.def.triggers || []).find((x) => x.when && x.when.sense === 'enclosed-by');
      const metres = seal && seal.when.radiusMetres !== undefined ? seal.when.radiusMetres : 1.5;
      return t('hud.objective.held', { metres });
    }
    if (g.mission.procedure) return t('hud.objective.procedure');
    return t('hud.objective.investigate');
  }
}

/**
 * The one escaper, exported and used by every screen in the build.
 *
 * ⚠ THE APOSTROPHE WAS NOT ON THE LIST. Four characters were escaped and `'` was not, which
 * is correct for every attribute in this build TODAY because every one of them is written
 * with double quotes — and is a landmine, because the day somebody writes
 * `title='${escapeHtml(x)}'` the escaper says it handled it and it did not. An escaper that
 * is only safe if you also remember a convention is not an escaper. Five characters, always,
 * so the guarantee is about the function and not about the caller.
 *
 * ⚠ AND IT IS NOT THE ONLY LAYER. `src/net/protocol.js` refuses a wire string that will be
 * used as a message KEY or an object lookup, because escaping does nothing about
 * `t('phase.' + x)` returning its own key or `PHRASES['constructor']` being truthy. Both
 * layers, always: this file cannot see the wire and that one cannot see the DOM.
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export { escapeHtml };
