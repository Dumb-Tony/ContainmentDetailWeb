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

    c.strokeStyle = ink; c.globalAlpha = 0.75;
    for (const r of g.site.blockingRects()) {
      c.strokeRect(px(r[0]), py(r[3]), (r[2] - r[0]) * s, (r[3] - r[1]) * s);
    }
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
    const t = g.clock.simTimeMs;

    /* ── top left: where, when, how bad ── */
    const room = g.site.roomNameAt(p.x, p.z);
    const left = g.site.circuits;
    const power = Array.from(left.values()).map((c) => `<i class="${c.on ? 'on' : 'off'}"></i>${c.displayName.replace(' circuit', '')}`).join('');
    this._set('tl', this.topLeft, `
      <div class="row big">${room}</div>
      <div class="row">${GameClock.formatMs(t)} · ${m.phase}</div>
      <div class="row stage s${m.stage}">Incident pressure: <b>${m.stageName}</b></div>
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
        sub = `<em class="${mins < 2 ? 'warn' : ''}">${mins.toFixed(1)}m${on ? ' · ON' : ''}</em>`;
      }
      return `<div class="slot ${held ? 'held' : ''} ${item ? '' : 'empty'}">
        <b>${i + 1}</b><span>${item ? item.displayName : '—'}</span>${sub}</div>`;
    }).join('');
    const hands = p.hands ? `<div class="slot hands held"><b>✋</b><span>${g.itemsById.get(p.hands).displayName}</span></div>` : '';
    this._set('slots', this.slots, slotHtml + hands);

    /* ── condition and stress ── */
    const c = p.conditions;
    const cond = [];
    if (c.exposure.severity) cond.push(`<div class="cond sev${c.exposure.severity}">Exposure ${'▮'.repeat(c.exposure.severity)}${c.exposure.stabilised ? ' · stabilised' : ''}</div>`);
    if (c.mobility.severity) cond.push(`<div class="cond sev${c.mobility.severity}">Mobility injury ${'▮'.repeat(c.mobility.severity)}${c.mobility.stabilised ? ' · stabilised' : ''}</div>`);
    const st = p.stressNorm;
    if (st > 0.35) cond.push(`<div class="cond stress">${st > 0.75 ? 'Breathing hard' : 'Unsteady'}</div>`);
    this._set('cond', this.conditions, cond.join(''));

    /* ── the squad (GDD §18.2 "squad status indicators", §11.2 split information) ──
     * Solo shows nothing: a roster of one is clutter. The moment there are two, where
     * everybody is and what state they are in becomes the most important thing on screen,
     * because the whole design is that you cannot do this alone and cannot see it all. */
    if (g.players.length > 1) {
      const rows = g.players.map((q) => {
        const d = dist(p.x, p.z, q.x, q.z);
        const state = !q.alive ? 'lost' : q.downed ? 'down' : !q.connected ? 'off' : q.injured ? 'hurt' : 'ok';
        const word = !q.alive ? 'lost' : q.downed ? `DOWN ${Math.max(0, Math.ceil((CONFIG.player.bleedOutMs - q.downedMs) / 1000))}s`
          : !q.connected ? 'no radio' : q.injured ? 'injured' : 'ok';
        return `<div class="mate ${state} ${q === p ? 'self' : ''}">
          <b>${escapeHtml(q.name)}</b>
          <span class="w">${word}</span>
          <span class="d">${q === p ? '' : `${d.toFixed(0)}m · ${escapeHtml(g.site.roomNameAt(q.x, q.z))}`}</span>
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
      const state = a.isLoose ? a.state : 'contained';
      const held = a.isHeld;
      this.bezel.classList.toggle('held', held);
      this.bezel.classList.toggle('hot', a.stateKind === 'hunting');
      const lanes = a.escapes === undefined ? '—' : a.escapes;
      this.bezelLabel.innerHTML = `<span>${CONFIG.heat.gradientThresholdC}C contour · white</span>`
        + `<span>${held ? 'HELD' : `${lanes} lane${lanes === 1 ? '' : 's'} open`} · ${state}</span>`;
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
      if (carrier === me) return 'Carry the case to the stair head.';
      if (carrier) return `${carrier.name} has the case. Cover them to the stairs.`;
      return 'Lift the case and get it to the stair head.';
    }
    if (g.custody === 'sealed') {
      const held = g.anomaly.sealedIn ? g.anomaly.sealedIn.custodyHeldMs / 1000 : 0;
      return `Hold custody — ${held.toFixed(0)}s of ${CONFIG.anomaly.custodyVerifySeconds}s. Keep the case powered.`;
    }
    if (g.anomaly.isHeld) return 'It is held. Get the case within 1.5m and seal it.';
    if (g.mission.procedure) return 'Execute the committed procedure.';
    return 'Establish what it is and what stops it. Plan on the tablet (TAB).';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export { escapeHtml };
