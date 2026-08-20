/* The screens the operative actually reads: the operation card and the loadout wager, the
 * field tablet, the cargo manifest, and the debrief.
 *
 * THE TABLET DOES NOT KNOW THE ANSWER (GDD §7.3, §18.4). The board offers CLAIMS and the
 * player marks them; the planner offers procedure fields and the player fills them. Neither
 * validates. A planner that refused a wrong plan would be performing the deduction the
 * whole game exists to make the player perform, and a board that ticked itself would turn
 * §7.4's "confidence, not checklist completion" back into a checklist.
 *
 * The planner's option lists deliberately contain the false leads. "The failed chiller is
 * the anchor" is on the target list because the maintenance log says so, and choosing it
 * produces a perfectly executable plan that does not work.
 */

import { CONFIG } from '../config.js';
import { CLAIMS } from '../sim/evidence.js';
import { RECOMMENDED_MANIFEST as RECOMMENDED } from '../game.js';
import { GameClock } from '../core/clock.js';
import { escapeHtml } from './hud.js';

const PROCEDURE_FIELDS = [
  {
    key: 'target', label: 'Target', options: [
      'The cold mass itself',
      'The failed chiller in the plant room',
      'The building airflow carrying it',
      'The stair-head draught',
    ],
  },
  {
    key: 'state', label: 'Required state', options: [
      'Held against a heat gradient it cannot cross',
      'Shut inside a room with the door powered closed',
      'Reduced by sustained fire until it disperses',
      'Frozen in place by killing the ventilation',
    ],
  },
  {
    key: 'trigger', label: 'Trigger', options: [
      'Transit case heater running at 39C as a lure',
      'An operative standing in the lane as bait',
      'Recorded speech played back from a lure unit',
      'Restoring the storage circuit to draw it to the lights',
    ],
  },
  {
    key: 'transfer', label: 'Transfer and verification', options: [
      'Case interior stable for 30s, then carry to the stair head',
      'Photograph the frost edge and withdraw',
      'Leave the sealed case for a specialist unit',
    ],
  },
];

const MAINTAINED = [
  'A 40C gradient across every approach lane',
  'Case heater powered throughout',
  'Thermal coverage of the approach',
  'Freight and office doors closed on live circuits',
  'A second operative outside the fence',
];

const ABORTS = [
  'Any operative takes a second contact',
  'Fence power drops below the reserve needed to hold through the seal',
  'Thermal coverage of the approach lost for longer than 5s',
  'Pressure reaches Breach',
];

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

export class Panels {
  constructor(root, game, { onDeploy, onResume } = {}) {
    this.game = game;
    this.onDeploy = onDeploy || (() => {});
    this.onResume = onResume || (() => {});
    this.node = el('div', 'cd-panel', root);
    this.node.style.display = 'none';
    this.open = null;
    this.tab = 'briefing';
    this.manifest = new Map();
    this.plan = { target: '', state: '', trigger: '', transfer: '', maintained: new Set(), abort: ABORTS[0] };
  }

  get isOpen() { return this.open !== null; }

  hide() { this.open = null; this.node.style.display = 'none'; this.onResume(); }

  _shell(title, sub, body, footer) {
    this.node.style.display = 'flex';
    this.node.innerHTML = `
      <div class="sheet">
        <header><h1>${title}</h1><p>${sub}</p></header>
        <div class="body">${body}</div>
        <footer>${footer}</footer>
      </div>`;
  }

  /* ── phase A + B: the operation card and the wager ───────────────────────── */

  showLoadout() {
    this.open = 'loadout';
    if (this.manifest.size === 0) {
      for (const { itemId, qty } of RECOMMENDED) this.manifest.set(itemId, qty);
    }
    this._renderLoadout();
  }

  _renderLoadout() {
    const g = this.game;
    const budget = g.content.items.cargoVolumeBudget;
    const manifest = Array.from(this.manifest, ([itemId, qty]) => ({ itemId, qty }));
    const used = g.manifestVolume(manifest);

    const rows = g.content.items.items.map((it) => {
      const n = this.manifest.get(it.id) || 0;
      return `<tr class="${n ? 'taken' : ''}">
        <td class="name"><b>${it.displayName}</b><span>${escapeHtml(it.summary || '')}</span></td>
        <td class="vol">${it.cargoVolume}</td>
        <td class="qty">
          <button data-dec="${it.id}" ${n ? '' : 'disabled'}>−</button><b>${n}</b><button data-inc="${it.id}">+</button>
        </td></tr>`;
    }).join('');

    /* Coverage warnings describe the GAP and never prescribe the fix (GDD §10.7). */
    const warn = [];
    const have = (id) => (this.manifest.get(id) || 0) > 0;
    const heatUnits = (this.manifest.get('floodlight-tripod') || 0) + (this.manifest.get('portable-heater') || 0);
    if (!have('thermal-imager')) warn.push('No thermal instrument. You will be working from traces alone.');
    if (!have('reinforced-transit-case')) warn.push('No custody container. Nothing on this manifest can take custody of anything.');
    if (heatUnits === 0) warn.push('No heat-emitting equipment.');
    else if (heatUnits < 2) warn.push('One heat emitter. The storage aisles are 4.2m across.');
    if (!have('trauma-kit')) warn.push('No medical capacity.');

    this._shell('Operation card — Cold storage, level 2', 'Foundation regional response · solo deployment authorised', `
      <div class="cols">
        <section class="brief">
          <h2>Incident</h2>
          <p>${escapeHtml(g.content.map._incident.split('.')[0])}. A maintenance crew sealed the floor after reporting <em>"cold that moves"</em>. Two of the three came back.</p>
          <h2>Conditions</h2>
          <ul>
            <li>Mains down six days. Two circuits, both dead. The office breaker is on the bay wall; the storage breaker is <em>inside the office</em>.</li>
            <li>Ambient ${CONFIG.heat.ambientC}C and falling while the anomaly is loose.</li>
            <li>One surviving crew member is waiting at the stair head. <span class="conf">confidence: probable</span></li>
            <li>Plant log reports the chiller ran eleven days against a four-hour duty cycle. <span class="conf">confidence: disputed</span></li>
          </ul>
          <h2>Mandate</h2>
          <p><b>Primary:</b> establish custody of the anomaly and transfer it to the stair head.</p>
          <p><b>Optional:</b> recover all issued equipment · avoid a second contact · preserve a frost sample.</p>
          <p class="small">Reports may be incomplete. They are not deliberately false.</p>
        </section>
        <section class="kit">
          <h2>Cargo manifest</h2>
          <div class="budget ${used > budget ? 'over' : ''}">
            <div class="bar"><i style="width:${Math.min(100, (used / budget) * 100)}%"></i></div>
            <span>${used} of ${budget} volume</span>
          </div>
          <table class="items"><tbody>${rows}</tbody></table>
          ${warn.length ? `<div class="warn"><b>Coverage</b><ul>${warn.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : ''}
        </section>
      </div>`,
      `<button class="ghost" data-reset>Recommended manifest</button>
       <button class="go" data-deploy ${used > budget ? 'disabled' : ''}>Deploy</button>`);

    this.node.querySelectorAll('[data-inc]').forEach((b) => b.onclick = () => {
      const id = b.dataset.inc;
      this.manifest.set(id, (this.manifest.get(id) || 0) + 1);
      this._renderLoadout();
    });
    this.node.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => {
      const id = b.dataset.dec;
      const n = (this.manifest.get(id) || 0) - 1;
      if (n <= 0) this.manifest.delete(id); else this.manifest.set(id, n);
      this._renderLoadout();
    });
    this.node.querySelector('[data-reset]').onclick = () => {
      this.manifest = new Map(RECOMMENDED.map((r) => [r.itemId, r.qty]));
      this._renderLoadout();
    };
    this.node.querySelector('[data-deploy]').onclick = () => {
      const err = this.game.commitLoadout(Array.from(this.manifest, ([itemId, qty]) => ({ itemId, qty })));
      if (err) return;
      this.open = null;
      this.node.style.display = 'none';
      this.onDeploy();
    };
  }

  /* ── the field tablet ────────────────────────────────────────────────────── */

  showTablet(tab = this.tab) {
    this.open = 'tablet';
    this.tab = tab;
    this._renderTablet();
  }

  _renderTablet() {
    const g = this.game;
    const tabs = ['briefing', 'evidence', 'board', 'procedure'];
    const nav = tabs.map((t) => `<button data-tab="${t}" class="${t === this.tab ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
    let body = '';

    if (this.tab === 'briefing') {
      body = `<div class="pad">
        <h2>Mandate</h2>
        <p>Establish custody of the anomaly on level 2 and transfer it to the stair head.</p>
        <h2>Site</h2>
        <p>${escapeHtml(g.site.displayName)} — ${g.site.rooms.map((r) => r.name).join(' · ')}</p>
        <h2>What you know</h2>
        <ul><li>Two circuits, both dead on arrival.</li><li>Ambient falls while the anomaly is loose. It is now ${g.heat.ambientC.toFixed(1)}C.</li></ul>
        <h2>Controls</h2>
        <div class="keys">
          <div><kbd>W A S D</kbd> move · <kbd>Shift</kbd> sprint · <kbd>Ctrl</kbd> crouch</div>
          <div><kbd>F</kbd> the context verb (it says what it will do)</div>
          <div><kbd>E</kbd> use or deploy what is in hand · <kbd>1</kbd>–<kbd>5</kbd> select a slot</div>
          <div><kbd>Q</kbd> thermal imager on/off · <kbd>Tab</kbd> tablet · <kbd>Esc</kbd> release the mouse</div>
        </div></div>`;
    }

    if (this.tab === 'evidence') {
      const rows = g.ledger.entries.map((e) => `
        <li class="ev ${e.isFalseLead ? '' : ''}">
          <div class="head"><b>#${e.seq} ${e.type}</b>
            <span class="rel ${e.reliability}">${e.reliability}</span>
            <span class="when">${GameClock.formatMs(e.simTimeMs)} · ${escapeHtml(e.room)}</span></div>
          <p>${escapeHtml(e.raw)}</p>
          <div class="prov">recorded by ${e.source} · integrity ${e.integrity} · dimension: ${e.dimension}</div>
        </li>`).join('');
      body = `<div class="pad">
        <p class="small">Raw observations, in the order they were made. The ledger records what was seen; what it means is on the board.</p>
        <ul class="evlist">${rows || '<li class="empty">Nothing logged yet.</li>'}</ul></div>`;
    }

    if (this.tab === 'board') {
      const rows = CLAIMS.map((c) => {
        const sup = g.ledger.supportFor(c);
        const st = g.ledger.claimState.get(c.id);
        return `<li class="claim">
          <div class="txt">${escapeHtml(c.text)}<span class="dim">${c.dimension}</span></div>
          <div class="sup ${sup.word.replace(/ /g, '-')}">${sup.word}${sup.hits.length ? ` · ${sup.hits.length} observation${sup.hits.length === 1 ? '' : 's'}` : ''}</div>
          <div class="btns">
            <button data-claim="${c.id}" data-val="believed" class="${st === 'believed' ? 'on' : ''}">believe</button>
            <button data-claim="${c.id}" data-val="excluded" class="${st === 'excluded' ? 'on' : ''}">exclude</button>
          </div></li>`;
      }).join('');
      body = `<div class="pad">
        <p class="small">Contradictions stay on the board. Nothing here is ticked for you, and the support word never becomes a percentage.</p>
        <ul class="claims">${rows}</ul></div>`;
    }

    if (this.tab === 'procedure') {
      const sel = (f) => `<label>${f.label}
        <select data-field="${f.key}">
          <option value="">—</option>
          ${f.options.map((o) => `<option ${this.plan[f.key] === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select></label>`;
      const maint = MAINTAINED.map((m, i) => `<label class="chk"><input type="checkbox" data-maint="${i}" ${this.plan.maintained.has(m) ? 'checked' : ''}>${m}</label>`).join('');
      const abort = `<label>Abort condition<select data-abort>${ABORTS.map((a) => `<option ${this.plan.abort === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>`;
      const committed = g.mission.procedure;
      body = `<div class="pad plan">
        <p class="small">Five fields. The planner does not know whether your plan is right — it produces the checklist you said you would follow.</p>
        ${PROCEDURE_FIELDS.map(sel).join('')}
        <div class="maint"><span>Maintained conditions</span>${maint}</div>
        ${abort}
        ${committed ? `<div class="card"><b>Committed at ${GameClock.formatMs(committed.committedMs)}</b>
          <ol>${[committed.target, committed.state, committed.trigger, committed.transfer].filter(Boolean).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ol>
          <div class="ab">Abort: ${escapeHtml(committed.abort)}</div></div>` : ''}
      </div>`;
    }

    this._shell('Field tablet', `${g.mission.phase} · ${GameClock.formatMs(g.clock.simTimeMs)} · incident pressure ${g.mission.stageName}`,
      `<nav class="tabs">${nav}</nav>${body}`,
      this.tab === 'procedure'
        ? `<button class="ghost" data-close>Close</button><button class="go" data-commit>Commit procedure</button>`
        : `<button class="ghost" data-close>Close</button>`);

    this.node.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => this.showTablet(b.dataset.tab));
    this.node.querySelector('[data-close]').onclick = () => this.hide();
    this.node.querySelectorAll('[data-claim]').forEach((b) => b.onclick = () => {
      const cur = g.ledger.claimState.get(b.dataset.claim);
      g.ledger.setClaim(b.dataset.claim, cur === b.dataset.val ? null : b.dataset.val);
      this._renderTablet();
    });
    this.node.querySelectorAll('[data-field]').forEach((s) => s.onchange = () => { this.plan[s.dataset.field] = s.value; });
    this.node.querySelectorAll('[data-maint]').forEach((c) => c.onchange = () => {
      const m = MAINTAINED[Number(c.dataset.maint)];
      if (c.checked) this.plan.maintained.add(m); else this.plan.maintained.delete(m);
    });
    const ab = this.node.querySelector('[data-abort]');
    if (ab) ab.onchange = () => { this.plan.abort = ab.value; };
    const commit = this.node.querySelector('[data-commit]');
    if (commit) commit.onclick = () => {
      g.commitProcedure({ ...this.plan, maintained: Array.from(this.plan.maintained) });
      this.hide();
    };
  }

  /* ── the cargo manifest, in the field ────────────────────────────────────── */

  showCache() {
    this.open = 'cache';
    this._renderCache();
  }

  _renderCache() {
    const g = this.game;
    const rows = Array.from(g.cache, ([itemId, n]) => {
      const it = g.itemsById.get(itemId);
      return `<tr class="${n ? '' : 'gone'}">
        <td class="name"><b>${it.displayName}</b><span>${escapeHtml(it.summary || '')}</span></td>
        <td class="vol">${it.bulk}</td><td class="qty">${n}</td>
        <td><button data-take="${itemId}" ${n ? '' : 'disabled'}>Take</button></td></tr>`;
    }).join('');
    const held = g.player.heldItemId;
    this._shell('Cargo manifest', 'Mobile command point · everything you did not carry in is here',
      `<div class="pad"><table class="items"><tbody>${rows}</tbody></table>
       <p class="small">Slots: two belt (compact), two general, one long. Return anything you are not using — a mistake here is meant to be recoverable.</p></div>`,
      `${held ? `<button class="ghost" data-return>Return the ${g.itemsById.get(held).displayName}</button>` : ''}<button class="go" data-close>Close</button>`);

    this.node.querySelectorAll('[data-take]').forEach((b) => b.onclick = () => {
      const err = g.takeFromCache(b.dataset.take);
      if (err) g.notice(err);
      this._renderCache();
    });
    const ret = this.node.querySelector('[data-return]');
    if (ret) ret.onclick = () => { const e = g.returnToCache(); if (e) g.notice(e); this._renderCache(); };
    this.node.querySelector('[data-close]').onclick = () => this.hide();
  }

  /* ── the debrief ─────────────────────────────────────────────────────────── */

  showDebrief(result) {
    this.open = 'debrief';
    const g = this.game;
    const dims = result.dims.map((d) => `<li><b>${d.name}</b><span class="w">${d.word}</span><p>${escapeHtml(d.why)}</p></li>`).join('');
    const rules = CLAIMS.map((c) => {
      const s = g.ledger.claimState.get(c.id);
      const mark = s === null ? '—' : (s === 'believed') === c.truth ? '✓' : '✕';
      return `<li class="${mark === '✓' ? 'ok' : mark === '✕' ? 'bad' : 'un'}"><span>${mark}</span>${escapeHtml(c.text)}
        <em>${c.truth ? 'the site behaved this way' : 'the site never behaved this way'}</em></li>`;
    }).join('');
    const trans = g.anomaly.transitions.map((t) => `<li><b>${GameClock.formatMs(t.simTimeMs)}</b> ${t.from} → ${t.to} <em>(${t.triggerId})</em><p>${escapeHtml(t.telegraph)}</p></li>`).join('');

    this._shell(`Debrief — ${result.overall}`,
      result.failReason ? escapeHtml(result.failReason) : 'Operation closed.',
      `<div class="cols">
        <section><h2>Assessment</h2><ul class="dims">${dims}</ul></section>
        <section>
          <h2>What it did, and why</h2>
          <ul class="trans">${trans || '<li class="empty">It never changed state.</li>'}</ul>
          <h2>Rules, marked against the site</h2>
          <ul class="rules">${rules}</ul>
        </section>
      </div>`,
      `<button class="go" data-again>Run it again</button>`);
    this.node.querySelector('[data-again]').onclick = () => window.location.reload();
  }
}


export { PROCEDURE_FIELDS, MAINTAINED, ABORTS };
