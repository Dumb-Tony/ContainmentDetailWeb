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
 *
 * ── WHAT IS KEYED HERE AND WHAT IS INTERPOLATED (GDD §23 Milestone 5) ─────────
 *
 * Every sentence this file says on its own behalf is a key in content/locales. Every
 * sentence it repeats on somebody else's behalf is interpolated: an incident's headline, an
 * item's displayName, a room's name, a claim's text, a planner option, a refusal string
 * progression.js composed. The test is not "is it prose" but "who reviews it" — a briefing
 * has a designer's reviewer and a button label has the UI's, and the two must not end up in
 * one file.
 *
 * ⚠ THE IMPORT IS `msg`, NOT `t`. Three functions in this file bind a local `t` (a tab id,
 * a transition, a list line), and a shadowed translator fails as "t is not a function" at
 * the one moment the screen is being drawn.
 */

import { CONFIG } from '../config.js';
import { recommendedManifest } from '../game.js';
import { INCIDENTS } from '../sim/content.js';
import { GameClock } from '../core/clock.js';
import { escapeHtml } from './hud.js';
import { t as msg, plural } from '../core/i18n.js';

/**
 * The procedure card — GDD §18.4. Five fields the squad fills in and commits to, never
 * validated for correctness, because the planner does not know the answer either.
 *
 * ⚠ THESE WERE THE DRAUGHT'S OPTIONS, SHOWN FOR EVERY ANOMALY.
 *
 * Read them. Every one is about a cold mass, a heat gradient, a chiller, a freight door.
 * A squad planning the containment of `blackthorn-caller` — which hunts SOUND and is
 * restrained by SILENCE — was offered "Held against a heat gradient it cannot cross" and
 * "Restoring the storage circuit to draw it to the lights", and nothing at all about being
 * quiet. Four of the five fields could not be filled in truthfully.
 *
 * That is exactly the defect the hypothesis board had: seven claims written for the draught,
 * frozen in code, and shown for all six anomalies. The board was moved into content earlier
 * this session; this is the other half of the same tablet with the same bug, and it went on
 * looking correct for longer because a planner that offers wrong options still offers
 * options — the squad picks one, commits, and finds out in the field.
 *
 * `plannerFor(anomalyDef)` reads `containment.planner` from the anomaly. These arrays stay
 * exported as the DOCUMENTED FALLBACK for a package that has not authored one yet, which is
 * the same shape `CLAIMS` took in `sim/evidence.js` — and, like `CLAIMS`, a suite reports
 * every anomaly still relying on it, so the fallback cannot quietly become the design.
 *
 * ⚠ AND THAT IS WHY THEY ARE NOT IN content/locales. These options are CONTENT: they are one
 * anomaly's procedure card standing in for an unauthored one, with a designer's reviewer,
 * and the en-GB `_note` forbids content prose in the UI locale. A translated fallback would
 * be the draught's opinions, reviewed by the UI's reviewer, presented as everybody's — the
 * original defect with a second language on top. The `label` on each field IS chrome and IS
 * localised; the tablet reads `tablet.procedure.field.<key>` and never `f.label`.
 *
 * The `i18n-exempt` markers below are what tools/i18n-tests.js section D honours. They name
 * a REGION and a REASON, they are visible where the exemption applies rather than in a list
 * somewhere else, and the suite counts them and prints them every run — so an exemption is a
 * thing somebody has to defend rather than a thing that can be slipped in.
 */
/* i18n-exempt:content — the draught's procedure card, standing in for an unauthored one.
 * Content prose with a designer's reviewer; localised with the package, not with the engine. */
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
/* i18n-exempt:end */

/**
 * The planner an anomaly authors, or the draught's as a documented fallback.
 *
 * `containment.planner` is `{ target[], state[], trigger[], transfer[], maintained[], aborts[] }`.
 * A package may author any subset; anything it leaves out falls back, and `usesFallback`
 * says which fields did so, so the suite can report a package that has not been written yet
 * rather than letting the draught's vocabulary pass as everybody's.
 */
function plannerFor(anomalyDef) {
  const p = (anomalyDef && anomalyDef.containment && anomalyDef.containment.planner) || {};
  const pick = (key, fallback) => (Array.isArray(p[key]) && p[key].length ? p[key] : fallback);
  const usesFallback = [];
  const fields = PROCEDURE_FIELDS.map((f) => {
    const options = pick(f.key, f.options);
    if (options === f.options) usesFallback.push(f.key);
    return { ...f, options };
  });
  const maintained = pick('maintained', MAINTAINED);
  if (maintained === MAINTAINED) usesFallback.push('maintained');
  const aborts = pick('aborts', ABORTS);
  if (aborts === ABORTS) usesFallback.push('aborts');
  return { fields, maintained, aborts, usesFallback };
}

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
    this.callsign = msg('panels.squad.defaultCallsign');
    this.net = null;
  }

  get isOpen() { return this.open !== null; }

  hide() { this.open = null; this.node.style.display = 'none'; this.onResume(); }

  /**
   * The conditions on THIS floor, read from the world rather than typed out.
   *
   * ⚠ THIS WAS THREE HARD-CODED SENTENCES ABOUT THE COLD STORE, on a panel five incidents
   * across three buildings now share. A squad deploying to a condemned block was told where
   * the cold store's office breaker is, and one deploying to a forest reserve was told the
   * same thing. The ambient line was worse than wrong: it read `CONFIG.heat.ambientC`, the
   * CONSTANT, so §14.4's weather could move the real ambient three degrees and this went on
   * printing 6C — the one number on the card a squad plans their fence around.
   *
   * ⚠ AND `circuit${n === 1 ? '' : 's'}` WAS ENGLISH GRAMMAR WRITTEN IN JAVASCRIPT. Two forms
   * is English's rule; Polish has three. Each of these is a plural GROUP, and which form
   * comes out is Intl.PluralRules' decision rather than a comparison's.
   */
  _conditions(g) {
    const out = [];
    const circuits = [...g.site.circuits.values()];
    if (circuits.length) {
      const dead = circuits.filter((c) => !c.on).length;
      const names = circuits.map((c) => escapeHtml(c.switchLabel || c.displayName)).join('; ');
      out.push(dead === circuits.length
        ? plural('panels.conditions.circuitsAllDead', circuits.length, { names })
        : plural('panels.conditions.circuitsSomeDead', circuits.length, { dead, names }));
    }
    const amb = g.heat.ambientC.toFixed(1);
    const w = g.content.weather;
    if (w && w.ambientDeltaC) {
      out.push(msg(w.ambientDeltaC > 0 ? 'panels.conditions.ambientUp' : 'panels.conditions.ambientDown',
        { celsius: amb, weather: escapeHtml(w.label.toLowerCase()), delta: Math.abs(w.ambientDeltaC) }));
    } else {
      out.push(msg('panels.conditions.ambient', { celsius: amb }));
    }
    const doors = g.site.doors.length;
    if (doors) {
      const shut = g.site.doors.filter((d) => !d.open).length;
      out.push(plural('panels.conditions.doors', doors, { shut }));
    }
    return out.map((line) => `<li>${line}</li>`).join('');
  }

  _shell(title, sub, body, footer) {
    this.node.style.display = 'flex';
    this.node.innerHTML = `
      <div class="sheet">
        <header><h1>${title}</h1><p>${sub}</p></header>
        <div class="body">${body}</div>
        <footer>${footer}</footer>
      </div>`;
  }

  /* ── the squad room ──────────────────────────────────────────────────────
   * Before the operation card, because who is coming changes what you bring. GDD §11.4
   * wants friends-only and invite-code lobbies; an invite code over WebRTC is exactly
   * that and needs no account, no server and no lobby list.
   */

  showSquad(net) {
    this.open = 'squad';
    this.net = net;
    this._renderSquad();
  }

  _renderSquad() {
    const net = this.net;
    const g = this.game;
    const roster = g.players.map((p) => `<li class="${p.connected ? '' : 'off'}">
      <b>${escapeHtml(p.name)}</b>
      <span>${p.id === net.localPlayerId ? msg('panels.squad.you')
    : p.connected ? msg('panels.squad.ready') : msg('panels.squad.noRadio')}</span></li>`).join('');

    const hosting = net.role === 'host';
    const joined = net.role === 'client';

    this._shell(msg('panels.squad.title'), msg('panels.squad.sub'), `
      <div class="cols">
        <section>
          <h2>${msg('panels.squad.soloHead')}</h2>
          <p>${msg('panels.squad.soloBody')}</p>
          <button class="go wide" data-solo ${net.online ? 'disabled' : ''}>${msg('panels.squad.soloButton')}</button>

          <h2>${msg('panels.squad.hostHead')}</h2>
          <p>${msg('panels.squad.hostBody')}</p>
          <button class="wide" data-host ${net.online ? 'disabled' : ''}>${msg('panels.squad.hostButton')}</button>
          ${net.code ? `<div class="code">${escapeHtml(net.code)}</div>` : ''}

          <h2>${msg('panels.squad.joinHead')}</h2>
          <div class="joiner">
            <input data-code placeholder="${escapeHtml(msg('panels.squad.codePlaceholder'))}" maxlength="5" ${net.online ? 'disabled' : ''}>
            <button data-join ${net.online ? 'disabled' : ''}>${msg('panels.squad.joinButton')}</button>
          </div>
          <p class="small">${msg('panels.squad.callsignLabel')} <input data-name value="${escapeHtml(this.callsign)}" maxlength="14" class="inline"></p>
        </section>
        <section>
          <h2>${msg('panels.squad.rosterHead')}</h2>
          <ul class="roster">${roster}</ul>
          <p class="small status">${escapeHtml(net.status)}</p>
          <h2>${msg('panels.squad.secondHead')}</h2>
          <ul>
            <li>${msg('panels.squad.secondFence')}</li>
            <li>${msg('panels.squad.secondImager')}</li>
            <li>${msg('panels.squad.secondContact')}</li>
            <li>${msg('panels.squad.secondCase')}</li>
          </ul>
          <p class="small">${msg('panels.squad.joiningOpen')}</p>
        </section>
      </div>`,
    hosting
      ? `<span class="waiting">${msg('panels.squad.hostFooter')}</span><button class="go" data-deploy>${msg('panels.squad.briefButton')}</button>`
      : joined
        ? `<span class="waiting">${msg('panels.squad.joinedFooter')}</span>`
        : `<span class="waiting">${msg('panels.squad.idleFooter')}</span>`);

    const q = (s) => this.node.querySelector(s);
    const nameField = q('[data-name]');
    if (nameField) {
      nameField.onchange = () => {
        this.callsign = nameField.value.trim().slice(0, 14) || msg('panels.squad.defaultCallsign');
      };
    }
    const solo = q('[data-solo]');
    if (solo) solo.onclick = () => { this.open = null; this.node.style.display = 'none'; this.showLoadout(); };
    const hostBtn = q('[data-host]');
    if (hostBtn) hostBtn.onclick = () => { net.hostPeer(); this._renderSquad(); };
    const joinBtn = q('[data-join]');
    if (joinBtn) joinBtn.onclick = () => { net.joinPeer(q('[data-code]').value, this.callsign); this._renderSquad(); };
    const dep = q('[data-deploy]');
    if (dep) dep.onclick = () => { this.open = null; this.node.style.display = 'none'; this.showLoadout(); };
  }

  /* ── phase A + B: the operation card and the wager ───────────────────────── */

  showLoadout() {
    this.open = 'loadout';
    if (this.manifest.size === 0) {
      for (const { itemId, qty } of recommendedManifest(this.game.content)) this.manifest.set(itemId, qty);
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
        <td class="name"><b>${escapeHtml(it.displayName)}</b><span>${escapeHtml(it.summary || '')}</span></td>
        <td class="vol">${it.cargoVolume}</td>
        <td class="qty">
          <button data-dec="${it.id}" ${n ? '' : 'disabled'}>−</button><b>${n}</b><button data-inc="${it.id}">+</button>
        </td></tr>`;
    }).join('');

    /* Coverage warnings describe the GAP and never prescribe the fix (GDD §10.7). */
    const warn = [];
    const have = (id) => (this.manifest.get(id) || 0) > 0;
    const heatUnits = (this.manifest.get('floodlight-tripod') || 0) + (this.manifest.get('portable-heater') || 0);
    if (!have('thermal-imager')) warn.push(msg('panels.card.warnNoThermal'));
    if (!have('reinforced-transit-case')) warn.push(msg('panels.card.warnNoCase'));
    if (heatUnits === 0) warn.push(msg('panels.card.warnNoHeat'));
    else if (heatUnits < 2) warn.push(msg('panels.card.warnOneHeat'));
    if (!have('trauma-kit')) warn.push(msg('panels.card.warnNoMedical'));

    /* The briefing is the INCIDENT's, not the map's — two operations on this floor read
     * completely differently, and that is the point of them sharing it (GDD §15.2). */
    const inc = g.content.incident || {};
    const brief = inc.briefing || {};
    const known = (brief.known || []).map((k) => `<li>${escapeHtml(k.text)} <span class="conf">${
      msg('panels.card.confidence', { word: escapeHtml(k.confidence) })}</span></li>`).join('');
    const others = INCIDENTS.filter((id) => id !== inc.id);

    this._shell(msg('panels.card.title', { site: escapeHtml(g.site.displayName) }),
      msg('panels.card.sub', { incident: escapeHtml(inc.displayName || inc.id || '') }), `
      <div class="cols">
        <section class="brief">
          <h2>${msg('panels.card.incidentHead')}</h2>
          <p><b>${escapeHtml(brief.headline || '')}</b></p>
          <p>${escapeHtml(brief.report || '')}</p>
          <h2>${msg('panels.card.conditionsHead')}</h2>
          <ul>
            ${this._conditions(g)}
            ${known}
          </ul>
          <h2>${msg('panels.card.mandateHead')}</h2>
          <p>${msg('panels.card.mandatePrimary')}</p>
          <p>${msg('panels.card.mandateOptional')}</p>
          <p class="small">${msg('panels.card.reportsIncomplete')}</p>
          ${/* ⚠ NOT WHILE A ROOM IS OPEN. These buttons NAVIGATE, and a squad host's page
              * reload destroys their peer — the room, the roster, every seat. The playtest
              * driver clicked one mid-form and measured the result: "friend status:
              * disconnected". Switching incident is a pre-room decision; with a room open
              * the card says so instead of offering the trapdoor. */
  ''}${others.length && !(this.net && (this.net.code || this.net.peer)) ? `<h2>${msg('panels.card.otherHead')}</h2>
            <p class="small">${msg('panels.card.otherBody')}</p>
            ${others.map((id) => `<button class="wide" data-incident="${id}">${
  msg('panels.card.otherButton', { name: escapeHtml(id.replace(/^cold-storage-/, '')) })}</button>`).join('')}` : ''}
          ${others.length && this.net && (this.net.code || this.net.peer)
    ? `<p class="small">${msg('panels.card.roomPinsIncident')}</p>` : ''}
        </section>
        <section class="kit">
          <h2>${msg('panels.card.manifestHead')}</h2>
          <div class="budget ${used > budget ? 'over' : ''}">
            <div class="bar"><i style="width:${Math.min(100, (used / budget) * 100)}%"></i></div>
            <span>${msg('panels.card.budget', { used, budget })}</span>
          </div>
          <table class="items"><tbody>${rows}</tbody></table>
          ${warn.length ? `<div class="warn"><b>${msg('panels.card.coverageHead')}</b><ul>${
  warn.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : ''}
        </section>
      </div>`,
      `<button class="ghost" data-reset>${msg('panels.card.recommended')}</button>
       <button class="go" data-deploy ${used > budget ? 'disabled' : ''}>${msg('panels.card.deploy')}</button>`);

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
    this.node.querySelectorAll('[data-incident]').forEach((b) => { b.onclick = () => {
      const u = new URL(location.href);
      u.searchParams.set('incident', b.dataset.incident);
      location.href = u.toString();
    }; });
    this.node.querySelector('[data-reset]').onclick = () => {
      this.manifest = new Map(recommendedManifest(this.game.content).map((r) => [r.itemId, r.qty]));
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
    /* ⚠ THE TAB LABEL WAS `id[0].toUpperCase() + id.slice(1)` — English capitalisation
     * performed on an identifier, which is also the wrong WORD in any language whose term
     * for "evidence" is not "evidence". The id stays the id; the label is a message. */
    const nav = tabs.map((id) => `<button data-tab="${id}" class="${id === this.tab ? 'on' : ''}">${
      msg(`tablet.tab.${id}`)}</button>`).join('');
    let body = '';

    if (this.tab === 'briefing') {
      /**
       * ⚠ THIS PRINTED THE COLD STORE'S BRIEFING FOR EVERY INCIDENT.
       *
       * "Establish custody of the anomaly on level 2 and transfer it to the stair head" was
       * spelled into this file, and level 2 is one floor of one of four buildings. A squad
       * deploying to Blackthorn Reserve — a forest, reached by a track, with no level 2 and
       * no stair head — opened the tablet and read that as their mandate. So did a squad on
       * Ashlar's ninth floor, whose case leaves by the east landing.
       *
       * "Two circuits, both dead on arrival" was the same mistake with a number in it. Every
       * map has two circuits and they are called different things on each: office and
       * storage, gallery and landing, yard and ridge. The tablet named none of them and
       * asserted the count.
       *
       * This is the third surface with this defect — the hypothesis board and the procedure
       * planner were the other two — and it is the one a squad reads FIRST. Every incident
       * package already authors a `briefing` with a headline, a report and what is known
       * with a confidence on each; the site knows its own circuits and whether they are
       * live. Nothing here needed to be invented, only read.
       */
      const inc = g.content.incident || {};
      const brief = inc.briefing || {};
      const known = (brief.known || []).map((k) => `<li>${escapeHtml(k.text)}
        <span class="dim">${escapeHtml(k.confidence || '')}</span></li>`).join('');
      const circuits = [...g.site.circuits.values()]
        .map((c) => msg(c.on ? 'tablet.briefing.circuitLive' : 'tablet.briefing.circuitDead',
          { name: escapeHtml(c.displayName) })).join(' · ');
      body = `<div class="pad">
        <h2>${msg('tablet.briefing.mandate')}</h2>
        <p>${escapeHtml(brief.headline || inc.displayName || '')}</p>
        <p class="small">${escapeHtml(brief.report || '')}</p>
        <h2>${msg('tablet.briefing.site')}</h2>
        <p>${escapeHtml(g.site.displayName)} — ${g.site.rooms.map((r) => r.name).join(' · ')}</p>
        <p class="small">${circuits}</p>
        <h2>${msg('tablet.briefing.known')}</h2>
        <ul>${known}<li>${msg('tablet.briefing.ambient', { celsius: g.heat.ambientC.toFixed(1) })}</li></ul>
        <h2>${msg('tablet.briefing.controls')}</h2>
        <div class="keys">
          <div>${msg('tablet.briefing.keysMove')}</div>
          <div>${msg('tablet.briefing.keysVerb')}</div>
          <div>${msg('tablet.briefing.keysUse')}</div>
          <div>${msg('tablet.briefing.keysScreens')}</div>
        </div></div>`;
    }

    if (this.tab === 'evidence') {
      /* `type`, `reliability`, `dimension` and `integrity` are the EVIDENCE RULE's own
       * fields, read from the anomaly package. They are interpolated, never keyed — a
       * vocabulary a content author can extend cannot live in the engine's locale. */
      const rows = g.ledger.entries.map((e) => `
        <li class="ev">
          <div class="head"><b>${msg('tablet.evidence.head', { seq: e.seq, type: escapeHtml(e.type) })}</b>
            <span class="rel ${e.reliability}">${escapeHtml(e.reliability)}</span>
            <span class="when">${msg('tablet.evidence.when', {
    time: GameClock.formatMs(e.simTimeMs), room: escapeHtml(e.room),
  })}</span></div>
          <p>${escapeHtml(e.raw)}</p>
          <div class="prov">${msg('tablet.evidence.provenance', {
    source: escapeHtml(e.source), integrity: escapeHtml(e.integrity), dimension: escapeHtml(e.dimension),
  })}</div>
        </li>`).join('');
      body = `<div class="pad">
        <p class="small">${msg('tablet.evidence.intro')}</p>
        <ul class="evlist">${rows || `<li class="empty">${msg('tablet.evidence.empty')}</li>`}</ul></div>`;
    }

    if (this.tab === 'board') {
      /* ⚠ THE BOARD IS THE LOADED ANOMALY'S BOARD. This read a frozen array in src/ that
       * held seven claims about the graybox draught, so every other incident put the
       * draught's opinions on the tablet — the lodger's board offered "a sustained heat
       * gradient above 40C stops it dead" about a thing that has never been recorded
       * moving, and offered it with support, because two evidence ids happened to be
       * spelled the same in both files.
       *
       * ⚠ AND THE SUPPORT WORD IS AN ID AS WELL AS A LABEL. `supportFor()` returns it, this
       * turns it into a CSS class, and a suite compares against 'strong'. So the slug goes
       * on the element and the message goes in the text. */
      const rows = g.ledger.claims.map((c) => {
        const sup = g.ledger.supportFor(c);
        const st = g.ledger.claimState.get(c.id);
        const slug = sup.word.replace(/ /g, '-');
        const word = msg(`tablet.board.support.${slug}`);
        const support = sup.hits.length
          ? plural('tablet.board.supportWithHits', sup.hits.length, { word })
          : msg('tablet.board.supportOnly', { word });
        return `<li class="claim">
          <div class="txt">${escapeHtml(c.text)}<span class="dim">${escapeHtml(c.dimension)}</span></div>
          <div class="sup ${slug}">${support}</div>
          <div class="btns">
            <button data-claim="${c.id}" data-val="believed" class="${st === 'believed' ? 'on' : ''}">${msg('tablet.board.believe')}</button>
            <button data-claim="${c.id}" data-val="excluded" class="${st === 'excluded' ? 'on' : ''}">${msg('tablet.board.exclude')}</button>
          </div></li>`;
      }).join('');
      body = `<div class="pad">
        <p class="small">${msg('tablet.board.intro')}</p>
        <ul class="claims">${rows}</ul></div>`;
    }

    if (this.tab === 'procedure') {
      /* The field LABEL is chrome and is keyed off `f.key`; the OPTIONS are the anomaly's
       * planner block or the draught's card, and are content. See PROCEDURE_FIELDS. */
      const sel = (f) => `<label>${msg(`tablet.procedure.field.${f.key}`)}
        <select data-field="${f.key}">
          <option value="">${msg('tablet.procedure.unset')}</option>
          ${f.options.map((o) => `<option ${this.plan[f.key] === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
        </select></label>`;
      /* ⚠ THE PLANNER IS THE LOADED ANOMALY'S PLANNER, for the same reason the board is.
       * These were the draught's four fields shown for every incident, so a squad planning
       * the caller — which hunts sound and is stopped by silence — was offered a heat
       * gradient, a chiller and a freight door, and nothing about being quiet. */
      const planner = plannerFor(g.anomaly.def);
      const maint = planner.maintained.map((m, i) => `<label class="chk"><input type="checkbox" data-maint="${i}" ${
        this.plan.maintained.has(m) ? 'checked' : ''}>${escapeHtml(m)}</label>`).join('');
      const abort = `<label>${msg('tablet.procedure.abort')}<select data-abort>${
        planner.aborts.map((a) => `<option ${this.plan.abort === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}</select></label>`;
      const committed = g.mission.procedure;
      body = `<div class="pad plan">
        <p class="small">${msg('tablet.procedure.intro')}</p>
        ${planner.fields.map(sel).join('')}
        <div class="maint"><span>${msg('tablet.procedure.maintained')}</span>${maint}</div>
        ${abort}
        ${committed ? `<div class="card"><b>${msg('tablet.procedure.committed', { time: GameClock.formatMs(committed.committedMs) })}</b>
          <ol>${[committed.target, committed.state, committed.trigger, committed.transfer].filter(Boolean).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ol>
          <div class="ab">${msg('tablet.procedure.abortLine', { condition: escapeHtml(committed.abort) })}</div></div>` : ''}
      </div>`;
    }

    /* ⚠ THE PHASE AND THE PRESSURE STAGE ARE IDS. `PHASE.ARRIVAL` is the literal 'Arrival'
     * and `stageNames[0]` is 'Latent'; both are compared against and carried in a snapshot,
     * and both were also printed here raw — an English word inside an otherwise translated
     * line, which is exactly what the pseudolocale showed on the HUD. */
    /* ⚠ AND THE PHASE IS THE HOST'S TOO. `mission.phase` is written by `applySnapshot`, so
     * `msg('phase.' + phase)` resolves to its own key for anything the table does not carry
     * and lands in `<p>${sub}</p>` unescaped — the same shape as the debrief's grade, on the
     * screen the squad has open most often. */
    this._shell(msg('tablet.shell.title'), msg('tablet.shell.sub', {
      phase: escapeHtml(msg(`phase.${g.mission.phase}`)),
      time: GameClock.formatMs(g.clock.simTimeMs),
      stage: escapeHtml(msg(`pressure.${g.mission.stageName}`)),
    }),
    `<nav class="tabs">${nav}</nav>${body}`,
    this.tab === 'procedure'
      ? `<button class="ghost" data-close>${msg('tablet.shell.close')}</button><button class="go" data-commit>${msg('tablet.shell.commit')}</button>`
      : `<button class="ghost" data-close>${msg('tablet.shell.close')}</button>`);

    this.node.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => this.showTablet(b.dataset.tab));
    this.node.querySelector('[data-close]').onclick = () => this.hide();
    this.node.querySelectorAll('[data-claim]').forEach((b) => b.onclick = () => {
      const cur = g.ledger.claimState.get(b.dataset.claim);
      g.setClaim(b.dataset.claim, cur === b.dataset.val ? null : b.dataset.val);
      this._renderTablet();
    });
    this.node.querySelectorAll('[data-field]').forEach((s) => s.onchange = () => { this.plan[s.dataset.field] = s.value; });
    this.node.querySelectorAll('[data-maint]').forEach((c) => c.onchange = () => {
      const m = plannerFor(g.anomaly.def).maintained[Number(c.dataset.maint)];
      if (c.checked) this.plan.maintained.add(m); else this.plan.maintained.delete(m);
    });
    const ab = this.node.querySelector('[data-abort]');
    if (ab) ab.onchange = () => { this.plan.abort = ab.value; };
    const commit = this.node.querySelector('[data-commit]');
    if (commit) {
      commit.onclick = () => {
        g.commitProcedure({ ...this.plan, maintained: Array.from(this.plan.maintained) });
        this.hide();
      };
    }
  }

  /* ── the cargo manifest, in the field ────────────────────────────────────── */

  showCache() {
    this.open = 'cache';
    this._renderCache();
  }

  _renderCache() {
    const g = this.game;
    /* ⚠ `itemsById.get(itemId).displayName` WITH NO GUARD, ON A MAP THE HOST FILLS.
     * `game.cache` is replaced wholesale by `applySnapshot`, so one key naming an item this
     * build does not have threw here and the manifest screen would not open again for the
     * rest of the operation. The wire layer drops unknown ids; this stops caring. */
    const rows = Array.from(g.cache, ([itemId, n]) => {
      const it = g.itemsById.get(itemId);
      if (!it) return '';
      return `<tr class="${n ? '' : 'gone'}">
        <td class="name"><b>${escapeHtml(it.displayName)}</b><span>${escapeHtml(it.summary || '')}</span></td>
        <td class="vol">${it.bulk}</td><td class="qty">${n}</td>
        <td><button data-take="${escapeHtml(itemId)}" ${n ? '' : 'disabled'}>${msg('panels.cache.take')}</button></td></tr>`;
    }).join('');
    const held = g.player.heldItemId;
    const heldItem = held ? g.itemsById.get(held) : null;
    this._shell(msg('panels.cache.title'), msg('panels.cache.sub'),
      `<div class="pad"><table class="items"><tbody>${rows}</tbody></table>
       <p class="small">${msg('panels.cache.slots')}</p></div>`,
      `${heldItem ? `<button class="ghost" data-return>${
        msg('panels.cache.returnItem', { name: escapeHtml(heldItem.displayName) })}</button>` : ''
      }<button class="go" data-close>${msg('panels.cache.close')}</button>`);

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

  /**
   * ⚠ THE WHOLE DEBRIEF IS THE HOST'S OBJECT AND THIS SCREEN PRINTED IT.
   *
   * On a client `game.result` is written by `applySnapshot` from the `rs` field, verbatim
   * until this milestone. Three of the four things drawn below went into `innerHTML` with
   * no escaping — `d.name`, `d.word`, and `msg('grade.' + result.overall)`, which is the
   * worst of them: `t()` returns the KEY when it does not recognise it, so an `overall` of
   * `<img src=x onerror=…>` came back out of the message table unchanged and went straight
   * into an `<h1>` on every machine in the squad. `d.why` was escaped, which is what made
   * the other three look deliberate.
   *
   * `sanitiseResult` in protocol.js now rebuilds the object from a whitelist before it ever
   * reaches a Game, and everything here is escaped. Both, for the reason the escaper's own
   * note gives: the wire layer cannot know this is `innerHTML`, and this cannot know the
   * object came from a stranger — a solo player's `result` comes from `mission.grade`.
   */
  showDebrief(result) {
    this.open = 'debrief';
    const g = this.game;
    const rows = Array.isArray(result.dims) ? result.dims : [];
    const dims = rows.map((d) => `<li><b>${escapeHtml(d.name)}</b><span class="w">${
      escapeHtml(d.word)}</span><p>${escapeHtml(d.why)}</p></li>`).join('');
    const rules = g.ledger.claims.map((c) => {
      const s = g.ledger.claimState.get(c.id);
      const mark = s === null ? msg('debrief.screen.unmarked') : (s === 'believed') === c.truth ? '✓' : '✕';
      return `<li class="${mark === '✓' ? 'ok' : mark === '✕' ? 'bad' : 'un'}"><span>${mark}</span>${escapeHtml(c.text)}
        <em>${c.truth ? msg('debrief.screen.markedTrue') : msg('debrief.screen.markedFalse')}</em></li>`;
    }).join('');
    /* The state names and the trigger id are the anomaly package's own vocabulary. */
    const trans = g.anomaly.transitions.map((tr) => `<li><b>${GameClock.formatMs(tr.simTimeMs)}</b> ${
      msg('debrief.screen.transition', { from: escapeHtml(tr.from), to: escapeHtml(tr.to) })} <em>${
      msg('debrief.screen.trigger', { trigger: escapeHtml(tr.triggerId) })}</em><p>${escapeHtml(tr.telegraph)}</p></li>`).join('');

    /* ⚠ `result.overall` IS AN ID. base.js maps it onto a CSS pill and a saved profile has a
     * whole history written in it, so the value stays English and the label sits beside it. */
    this._shell(msg('debrief.screen.title', { grade: escapeHtml(msg(`grade.${result.overall}`)) }),
      result.failReason ? escapeHtml(result.failReason) : msg('debrief.screen.closed'),
      `<div class="cols">
        <section><h2>${msg('debrief.screen.assessment')}</h2><ul class="dims">${dims}</ul></section>
        <section>
          <h2>${msg('debrief.screen.transitions')}</h2>
          <ul class="trans">${trans || `<li class="empty">${msg('debrief.screen.noTransitions')}</li>`}</ul>
          <h2>${msg('debrief.screen.rules')}</h2>
          <ul class="rules">${rules}</ul>
        </section>
      </div>`,
      `<button class="go" data-again>${msg('debrief.screen.again')}</button>`);
    this.node.querySelector('[data-again]').onclick = () => window.location.reload();
  }
}


export { PROCEDURE_FIELDS, MAINTAINED, ABORTS, plannerFor };
