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
  }

  _set(key, node, html) {
    if (this._sig[key] === html) return;
    this._sig[key] = html;
    node.innerHTML = html;
  }

  update() {
    const g = this.game, p = g.player, m = g.mission, a = g.anomaly;
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

    /* ── the context verb ── */
    const act = g.contextAction();
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
        const mins = g.imagerBatteryMs / 60000;
        sub = `<em class="${mins < 2 ? 'warn' : ''}">${mins.toFixed(1)}m${g.imagerOn ? ' · ON' : ''}</em>`;
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

    /* ── notices ── */
    this._set('notice', this.notices,
      g.recentNotices().map((n) => `<div class="notice">${escapeHtml(n.text)}</div>`).join(''));

    /* ── the imager bezel ── */
    if (g.imagerOn) {
      const r = this.renderer.imagerRectCss();
      this.bezel.style.display = 'block';
      this.bezel.style.left = `${r.left}px`;
      this.bezel.style.top = `${r.top}px`;
      this.bezel.style.width = `${r.size}px`;
      this.bezel.style.height = `${r.size}px`;
      const state = a.isLoose ? a.state : 'contained';
      const held = a.state === ANOMALY_STATE.BANKED;
      this.bezel.classList.toggle('held', held);
      this.bezel.classList.toggle('hot', a.state === ANOMALY_STATE.DRAWN);
      const lanes = a.escapes === undefined ? '—' : a.escapes;
      this.bezelLabel.innerHTML = `<span>${CONFIG.heat.gradientThresholdC}C contour · white</span>`
        + `<span>${held ? 'HELD' : `${lanes} lane${lanes === 1 ? '' : 's'} open`} · ${state}</span>`;
    } else {
      this.bezel.style.display = 'none';
    }
  }

  _objective() {
    const g = this.game;
    if (g.custody === 'verified') return g.player.hands ? 'Carry the case to the stair head.' : 'Lift the case and get it to the stair head.';
    if (g.custody === 'sealed') {
      const held = g.anomaly.sealedIn ? g.anomaly.sealedIn.custodyHeldMs / 1000 : 0;
      return `Hold custody — ${held.toFixed(0)}s of ${CONFIG.anomaly.custodyVerifySeconds}s. Keep the case powered.`;
    }
    if (g.anomaly.state === ANOMALY_STATE.BANKED) return 'It is held. Get the case within 1.5m and seal it.';
    if (g.mission.procedure) return 'Execute the committed procedure.';
    return 'Establish what it is and what stops it. Plan on the tablet (TAB).';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

export { escapeHtml };
