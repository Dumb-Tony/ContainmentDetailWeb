/* Regional Site 19 — the between-mission base (GDD §13), as a screen.
 *
 * ⚠ IT IS A SCREEN, NOT A BUILDING. §13.1: the base must be compact enough that preparing
 * for a mission takes minutes and not a commute. A walkable lobby would spend the player's
 * attention on corridors, and every one of the five rooms in §26.2 is one page of reading
 * and one decision. Tabs are the whole navigation model.
 *
 * NO RULE LIVES HERE. Every number, price, gate and refusal comes out of
 * src/sim/progression.js; this file asks and prints the answer. That is what lets the
 * suite drive the entire campaign with no DOM — and it is why a refusal is rendered as
 * the string the model returned rather than re-derived into a nicer sentence, which is how
 * a panel and a model start disagreeing about what is affordable.
 *
 * The markup deliberately reuses ui/panels.js classes so the existing stylesheet covers
 * it: `.sheet`, `.cols`, `h2`, `.small`, `table.items`, `.budget`, `.warn`, `nav.tabs`,
 * `ul.dims`, `ul.evlist`, `ul.roster`, `.plan` for select controls. ⚠ The debrief history
 * borrows the EVIDENCE RELIABILITY palette (`.rel.confirmed` / `.probable` / `.disputed`)
 * to colour the overall word. That is a deliberate borrow, not a mistake: the two scales
 * mean different things and happen to want the same green-amber-red, and reusing it costs
 * no new CSS. If the reliability colours are ever restyled, look here.
 */

import { escapeHtml } from './hud.js';
import {
  DEPARTMENTS, RESOURCES, CLEARANCE_TIERS, UPGRADES, TREATMENTS,
  STANDING_FLOOR, STANDING_CEILING, standingTier, clearanceTier,
} from '../sim/progression.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/** grade() words on the §6.4 ladder, mapped onto the reliability palette. See the header. */
const OVERALL_PILL = {
  Exemplary: 'confirmed', Controlled: 'confirmed',
  Costly: 'probable', Compromised: 'disputed', Failed: 'disputed',
};

const money = (n) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n))}`;
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n))}`;

export class BaseScreen {
  /**
   * @param {HTMLElement} root  where the panel div is appended, exactly as Panels does
   * @param {object} opts
   *   progression  a Progression instance (src/sim/progression.js)
   *   site         the content/site.json document (defaults to progression.site)
   *   items        the content items.json document, for the armory counter
   *   onDeploy     called with the chosen operation when the squad commits
   *   onClose      called when the screen closes, for pointer lock and the clock
   */
  constructor(root, { progression, site = null, items = null, onDeploy, onClose } = {}) {
    this.progression = progression;
    this.site = site || (progression && progression.site) || { rooms: [], operations: [] };
    this.items = items;
    this.onDeploy = onDeploy || (() => {});
    this.onClose = onClose || (() => {});
    this.node = el('div', 'cd-panel', root);
    this.node.style.display = 'none';
    this.open = null;
    this.tab = 'operations';
    /** Which board card the player has picked. Defaults to the first authorised. */
    this.selectedOp = null;
    /* One line, from the model, shown until the next thing the player does. Refusals are
     * addressed to the person who just clicked and nothing else needs to hear them. */
    this.notice = null;
  }

  get isOpen() { return this.open !== null; }

  show(tab = this.tab) {
    this.open = 'base';
    const room = (this.site.rooms || []).find((r) => r.id === tab);
    /* A tab the player's clearance does not cover cannot be the landing tab — including
     * after a save that was made at a higher clearance and then reset. */
    this.tab = room && this.progression.roomOpen(room) ? tab : 'operations';
    this._render();
  }

  hide() {
    if (!this.open) return;
    this.open = null;
    this.node.style.display = 'none';
    this.onClose();
  }

  /** Re-read the model and repaint. Called after every purchase, fit and treatment. */
  refresh() { if (this.open) this._render(); }

  _shell(title, sub, body, footer) {
    this.node.style.display = 'flex';
    this.node.innerHTML = `
      <div class="sheet">
        <header><h1>${title}</h1><p>${sub}</p></header>
        <div class="body">${body}</div>
        <footer>${footer}</footer>
      </div>`;
  }

  /* ── the shell ───────────────────────────────────────────────────────────── */

  _render() {
    const pr = this.progression;
    const p = pr.profile;
    const rooms = this.site.rooms || [];
    const tier = clearanceTier(pr.clearance);

    const nav = rooms.map((r) => {
      const openRoom = pr.roomOpen(r);
      const need = clearanceTier(r.clearanceRequired || 0).name;
      return `<button data-room="${r.id}" class="${r.id === this.tab ? 'on' : ''}"
        ${openRoom ? '' : `disabled title="Requires ${escapeHtml(need)}"`}>${escapeHtml(r.name.split(' ')[0])}</button>`;
    }).join('');

    const room = rooms.find((r) => r.id === this.tab) || rooms[0] || null;
    let body = '<div class="pad"><p class="empty">The site file names no rooms.</p></div>';
    if (room) {
      if (this.tab === 'operations') body = this._operations(room);
      else if (this.tab === 'logistics') body = this._logistics(room);
      else if (this.tab === 'archive') body = this._archive(room);
      else if (this.tab === 'research') body = this._research(room);
      else if (this.tab === 'containment') body = this._containment(room);
      else body = this._genericRoom(room);
    }

    const op = this._authorisedOperation();
    const footer = this.tab === 'operations' && op
      ? `<span class="waiting">${escapeHtml(this.site.condition === 'underfunded'
          ? 'Everything you take is everything you have.' : '')}</span>
         <button class="ghost" data-close>Close</button>
         <button class="go" data-deploy>Take the operation</button>`
      : `<button class="go" data-close>Close</button>`;

    this._shell(escapeHtml(this.site.displayName || 'Foundation site'),
      `${escapeHtml(tier.name)} · ${p.operationsCompleted} operation${p.operationsCompleted === 1 ? '' : 's'} closed · ${escapeHtml(this.site.standing || '')}`,
      `${this._ledger()}<nav class="tabs">${nav}</nav>${this._notice()}
       <div class="pad"><h2>${escapeHtml(room ? room.name : 'Site')}</h2>
         <p class="small">${escapeHtml(room ? room.purpose : '')}</p></div>${body}`,
      footer);

    this._bind();
  }

  _notice() {
    if (!this.notice) return '';
    return `<div class="pad"><div class="warn"><b>Counter</b><ul><li>${escapeHtml(this.notice)}</li></ul></div></div>`;
  }

  /** The four §12.2 resources, across the top, on every tab. */
  _ledger() {
    const pr = this.progression;
    const p = pr.profile;
    const tier = clearanceTier(pr.clearance);
    const next = CLEARANCE_TIERS.find((t) => t.level === pr.clearance + 1);
    const desc = (id) => escapeHtml((RESOURCES.find((r) => r.id === id) || {}).what || '');
    return `<div class="ledgerbar">
      <div class="fig" title="${desc('requisition')}"><b>${money(p.requisition)}</b><span>requisition</span></div>
      <div class="fig" title="${desc('research')}"><b>${money(p.research)}</b><span>research data</span></div>
      <div class="fig" title="${desc('clearance')}"><b>${escapeHtml(tier.name)}</b><span>clearance${next ? ` · next at ${this._clearanceNeed(next)}` : ''}</span></div>
      <div class="fig"><b>${p.containment.length}</b><span>in custody</span></div>
    </div>`;
  }

  _clearanceNeed(t) {
    const r = t.requires || {};
    const bits = [];
    if (r.operations !== undefined) bits.push(`${r.operations} operations`);
    if (r.custodies !== undefined) bits.push(`${r.custodies} custodies`);
    if (r.research !== undefined) bits.push(`${r.research} research earned`);
    return escapeHtml(bits.join(', '));
  }

  /* ── operations room (§13.2) ─────────────────────────────────────────────── */

  _operations(room) {
    const pr = this.progression;
    const op = this._authorisedOperation();
    const status = this.site.regionalStatus || {};
    const handicap = pr.squadHandicap();
    const effects = pr.effects();
    const budget = this.items ? this.items.cargoVolumeBudget : null;
    const adjusted = budget === null ? null : budget + effects.cargoVolumeBudget + handicap.cargoVolume;

    const list = this._authorisedOperations();
    const board = list.length
      ? list.map((o) => `
      <div class="card-op ${o.id === (op && op.id) ? 'chosen' : ''}" data-op="${escapeHtml(o.id)}">
        <b>${escapeHtml(o.name)}</b>
        <p>${escapeHtml(o.mandate)}</p>
        <p class="small">${escapeHtml(o.difficulty || 'Field')} · ${escapeHtml(o.distance || '')}</p>
        <ul>${(o.conditions || []).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        <p class="small">Optional: ${(o.optional || []).map((x) => escapeHtml(x)).join(' · ')}</p>
      </div>`).join('')
      : '<p class="empty">No operation is authorised at your clearance.</p>';

    const known = op ? pr.insightsFor(op.anomalyId).filter((i) => i.unlocked) : [];
    const knownHtml = known.length
      ? `<h2>What the archive already knows</h2><ul>${known.map((i) => `<li>${escapeHtml(i.text)}</li>`).join('')}</ul>`
      : `<h2>What the archive already knows</h2><p class="small">Nothing yet. The first squad down works it out in the dark.</p>`;

    const roster = pr.fieldable().map((o) => {
      const c = pr.conditionOf(o.id);
      return `<li class="${c ? 'off' : ''}"><b>${escapeHtml(o.name)}</b>
        <span>${c ? `${escapeHtml(c.name)} · ${c.operationsRemaining} op${c.operationsRemaining === 1 ? '' : 's'}` : 'fit'}</span></li>`;
    }).join('');

    const warns = [];
    if (handicap.cargoVolume < 0) warns.push(`Injuries on the roster reduce what the squad can carry by ${Math.abs(handicap.cargoVolume)} volume.`);
    if (handicap.stabiliseFactor > 1) warns.push(`Field stabilisation will take ${Math.round((handicap.stabiliseFactor - 1) * 100)}% longer with the current roster.`);
    if (pr.profile.containment.length >= pr.cells().length) warns.push('Every holding position in the corridor is occupied. A new capture has nowhere to go.');

    return `<div class="cols">
      <section>
        <h2>Mission board</h2>
        ${board}
        <p class="small">${list.length > 1
          ? 'The same floor twice. Everything you learned about the building still applies; nothing you learned about the anomaly does.'
          : 'One operation. The board carries what exists and nothing else.'}</p>
        ${knownHtml}
      </section>
      <section>
        <h2>Regional picture</h2>
        <ul>
          <li>${escapeHtml(status.weather || '—')}</li>
          <li>${escapeHtml(status.region || '—')}</li>
          <li>${escapeHtml(status.readiness || '—')}</li>
        </ul>
        <h2>Readiness</h2>
        <ul class="roster">${roster}</ul>
        ${adjusted === null ? '' : `<div class="budget"><div class="bar"><i style="width:${Math.min(100, (adjusted / Math.max(1, budget + 4)) * 100)}%"></i></div>
          <span>${adjusted} cargo volume</span></div>
          <p class="small">Standard manifest is ${budget}. ${effects.cargoVolumeBudget ? `The vehicle bay adds ${effects.cargoVolumeBudget}. ` : ''}${handicap.cargoVolume ? `Injuries cost ${Math.abs(handicap.cargoVolume)}.` : ''}</p>`}
        ${warns.length ? `<div class="warn"><b>Before you go</b><ul>${warns.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : ''}
        <h2>Department standing</h2>
        ${this._standing()}
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  /** §12.3 as a readable picture: what each department wants, and what it charges you. */
  _standing() {
    const pr = this.progression;
    return `<ul class="dims">${DEPARTMENTS.map((d) => {
      const v = pr.standing(d.id);
      const t = standingTier(v);
      const pct = ((v - STANDING_FLOOR) / (STANDING_CEILING - STANDING_FLOOR)) * 100;
      return `<li><b>${escapeHtml(d.name)}</b><span class="w">${escapeHtml(t.name)} · ${signed(v)}</span>
        <div class="budget"><div class="bar"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>
          <span>×${t.priceMultiplier.toFixed(2)}</span></div>
        <p>Values ${escapeHtml(d.values.toLowerCase())}. Watches ${escapeHtml(d.watches.toLowerCase())}.</p></li>`;
    }).join('')}</ul>
    <p class="small">Standing changes what a department charges. It never closes a counter — GDD §12.3.</p>`;
  }

  /* ── armory and logistics counter (§13.2) ────────────────────────────────── */

  _logistics(room) {
    const pr = this.progression;
    const itemList = (this.items && this.items.items) || [];
    const families = itemList.filter((it) => UPGRADES.some((u) => u.family === it.id));

    /* The fit control. One select per family, because §12.4 sidegrades are a CHOICE and a
     * select is the only control that says "one of these" without needing a paragraph. */
    const fits = families.map((it) => {
      const owned = UPGRADES.filter((u) => u.family === it.id && pr.owns(u.id));
      const cur = pr.fittedFor(it.id) || '';
      const issued = pr.itemAsIssued(it);
      return `<label>${escapeHtml(it.displayName)}
        <select data-fit="${it.id}">
          <option value="" ${cur === '' ? 'selected' : ''}>Standard ${escapeHtml(it.displayName.toLowerCase())}</option>
          ${owned.map((u) => `<option value="${u.id}" ${cur === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
        </select>
        <span class="issued">${this._issuedLine(it, issued)}</span></label>`;
    }).join('');

    const rows = UPGRADES.map((u) => {
      const owned = pr.owns(u.id);
      const price = pr.priceOf(u);
      const afford = pr.profile.requisition >= price && pr.profile.research >= (u.costResearch || 0);
      const dept = DEPARTMENTS.find((d) => d.id === u.department);
      return `<tr class="${owned ? 'taken' : afford ? '' : 'gone'}">
        <td class="name"><b>${escapeHtml(u.name)}</b>
          <span>${escapeHtml(u.blurb)}</span>
          <span>${u.gains.map((g) => `<em class="gain">+${escapeHtml(g)}</em>`).join(' ')}
                ${u.losses.map((l) => `<em class="loss">−${escapeHtml(l)}</em>`).join(' ')}</span>
          <span>${escapeHtml(dept ? dept.name : '')} · ${escapeHtml(standingTier(pr.standing(u.department)).name.toLowerCase())} rate</span></td>
        <td class="vol">${price}${u.costResearch ? `<br>${u.costResearch}R` : ''}</td>
        <td class="qty">${owned
          ? '<b>held</b>'
          : `<button data-buy="${u.id}" ${afford ? '' : 'disabled'}>Order</button>`}</td>
      </tr>`;
    }).join('');

    const lost = this._lastLoss();

    return `<div class="cols">
      <section class="plan">
        <h2>Fitted equipment</h2>
        <p class="small">One variant per family. The standard tool is always on the list, because
           GDD §10.1 does not allow a new tier to make the old one irrelevant.</p>
        ${fits || '<p class="empty">No equipment file loaded.</p>'}
      </section>
      <section>
        <h2>Requisition</h2>
        <table class="items"><tbody>${rows}</tbody></table>
        <p class="small">Price is the department's rate at your current standing. Research-data
           costs do not move with standing — analysis is analysis.</p>
        <h2>Recovery</h2>
        ${lost}
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  /** What the fitted variant actually does to the issued item, in the item's own units. */
  _issuedLine(base, issued) {
    const bits = [];
    const cmp = (field, label, unit = '') => {
      if (base[field] === undefined && issued[field] === undefined) return;
      if (base[field] === issued[field]) return;
      const from = base[field] === undefined ? '—' : `${base[field]}${unit}`;
      const to = issued[field] === undefined ? '—' : `${issued[field]}${unit}`;
      bits.push(`${label} ${from} → ${to}`);
    };
    cmp('cargoVolume', 'volume');
    cmp('bulk', 'slot');
    cmp('batteryMinutes', 'battery', ' min');
    cmp('heatOutputCelsius', 'output', 'C');
    cmp('heatFalloffMetres', 'falloff', 'm');
    cmp('feedRadiusMetres', 'feed', 'm');
    cmp('barrierWidthMetres', 'width', 'm');
    return bits.length ? escapeHtml(bits.join(' · ')) : 'as issued';
  }

  _lastLoss() {
    const h = this.progression.profile.history;
    const last = h[h.length - 1];
    if (!last) return '<p class="small">Nothing has come back yet, because nothing has gone out.</p>';
    const dim = (last.dims || []).find((d) => /stewardship/i.test(d.name));
    return `<p class="small">Operation ${last.operation}: equipment stewardship read
      <b>${escapeHtml(dim ? dim.word : 'unrecorded')}</b>. Anything left on the floor was reordered out of
      that operation's requisition.</p>`;
  }

  /* ── archive terminal (§13.2) ────────────────────────────────────────────── */

  _archive(room) {
    const pr = this.progression;
    const hist = pr.profile.history.slice().reverse();
    const rows = hist.map((h) => {
      const pill = OVERALL_PILL[h.overall] || 'unreliable';
      const dims = (h.dims || []).map((d) => `${d.name}: ${d.word}`).join(' · ');
      return `<li class="ev">
        <div class="head"><b>Operation ${h.operation}</b>
          <span class="rel ${pill}">${escapeHtml(h.overall)}</span>
          <span class="when">${h.minutes ? `${Number(h.minutes).toFixed(1)} min` : '—'} · ${escapeHtml(h.mapId || 'unrecorded')}</span></div>
        <p>${escapeHtml(h.failReason || 'Operation closed.')}</p>
        <div class="prov">requisition ${signed(h.requisition)} · research ${signed(h.research)} · ${escapeHtml(dims)}</div>
      </li>`;
    }).join('');

    const files = (this.site.dossiers || []).map((d) => {
      const k = pr.knowledgeFor(d.anomalyId);
      const ins = pr.insightsFor(d.anomalyId);
      return `<li><b>${escapeHtml(d.designation)}</b><span class="w">${k.operations} operation${k.operations === 1 ? '' : 's'}</span>
        <p>${escapeHtml(d.classFraming)}</p>
        <p>${escapeHtml(d.operationalCost)}</p>
        <p>${ins.filter((i) => i.unlocked).length} of ${ins.length} case notes filed.</p></li>`;
    }).join('');

    return `<div class="cols">
      <section>
        <h2>Mission history</h2>
        <ul class="evlist">${rows || '<li class="empty">No operation has closed yet.</li>'}</ul>
      </section>
      <section>
        <h2>Case files</h2>
        <ul class="dims">${files || '<li class="empty">Nothing filed.</li>'}</ul>
        <h2>Attribution</h2>
        <p class="small">Designations are provisional until a licensing record exists — GDD §25.3.
           Nothing in this build prints a number it has not earned the right to print.</p>
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  /* ── research station and the isolation bench (§13.2, §12.5) ─────────────── */

  _research(room) {
    const pr = this.progression;
    const dossiers = this.site.dossiers || [];

    const knowledge = dossiers.map((d) => {
      const k = pr.knowledgeFor(d.anomalyId);
      const ins = pr.insightsFor(d.anomalyId);
      return `<h2>${escapeHtml(d.designation)}</h2>
        <p class="small">${k.rulesRead} rule${k.rulesRead === 1 ? '' : 's'} read correctly across ${k.operations} operation${k.operations === 1 ? '' : 's'};
           ${k.rulesMisread} misread, at no cost.</p>
        <ul class="dims">${ins.map((i) => `<li class="${i.unlocked ? '' : 'locked'}">
          <b>${i.unlocked ? 'Filed' : 'Not yet'}</b><span class="w">${escapeHtml(this._insightNeed(i))}</span>
          <p>${i.unlocked ? escapeHtml(i.text) : escapeHtml(i.grants || 'A case note the squad has not earned yet.')}</p></li>`).join('')}</ul>`;
    }).join('');

    const bench = pr.fieldable().map((o) => {
      const c = pr.conditionOf(o.id);
      if (!c) return `<li><b>${escapeHtml(o.name)}</b><span class="w">Fit</span><p>${o.operations} operation${o.operations === 1 ? '' : 's'} on file.</p></li>`;
      const buttons = TREATMENTS.map((t) => {
        const price = Math.round(t.costRequisition * (1 + pr.effects().treatmentCostPct / 100));
        return `<button data-treat="${o.id}" data-treatment="${t.id}">${escapeHtml(t.name)}${price ? ` · ${price}` : ''}</button>`;
      }).join(' ');
      return `<li><b>${escapeHtml(o.name)}</b><span class="w">${escapeHtml(c.name)} · ${c.operationsRemaining} op${c.operationsRemaining === 1 ? '' : 's'} left</span>
        <p>${escapeHtml(c.note)}</p><p>${buttons}</p></li>`;
    }).join('');

    return `<div class="cols">
      <section>
        <h2>Research data</h2>
        <p class="small">${money(pr.profile.research)} available · ${money(pr.profile.researchTotalEarned)} earned in total.
           Clearance reads the total earned, so spending never costs you a milestone.</p>
        ${knowledge || '<p class="empty">No case file open.</p>'}
      </section>
      <section>
        <h2>Isolation bench</h2>
        <p class="small">${pr.treatmentCapacity()} bed${pr.treatmentCapacity() === 1 ? '' : 's'}.
           Treatment is never required: an untreated operative deploys with the effect and it
           expires on its own after the stated number of operations. GDD §12.5 — you can always
           field a character, and nothing here waits on a real clock.</p>
        <ul class="dims">${bench}</ul>
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  _insightNeed(i) {
    const r = i.requires || {};
    const bits = [];
    if (r.rules !== undefined) bits.push(`${r.rules} rules`);
    if (r.operations !== undefined) bits.push(`${r.operations} operations`);
    if (r.research !== undefined) bits.push(`${r.research} research`);
    return bits.join(' · ');
  }

  /* ── containment observation corridor (§13.2) ────────────────────────────── */

  _containment(room) {
    const pr = this.progression;
    const wing = this.site.containmentWing || { cells: [] };
    const byCell = new Map(pr.profile.containment.map((c) => [c.cellId, c]));

    const cells = pr.cells().map((cell) => {
      const held = byCell.get(cell.id);
      if (!held) {
        return `<li class="vacant"><b>${escapeHtml(cell.label || cell.id)}</b><span>vacant</span>
          <div class="hist">${escapeHtml(cell.holding)}</div></li>`;
      }
      const hist = held.history.map((h) => `<div>${escapeHtml(h)}</div>`).join('');
      return `<li><b>${escapeHtml(held.designation)}</b><span>${escapeHtml(cell.label || cell.id)}</span>
        <div class="hist">${escapeHtml(cell.holding)}${hist}</div></li>`;
    }).join('');

    const maint = pr.profile.containment.flatMap((c) => c.maintenance.map((m) => `<li>${escapeHtml(m)}</li>`)).join('');

    return `<div class="cols">
      <section>
        <h2>Holding positions</h2>
        <ul class="cells">${cells || '<li class="empty">The corridor has no cells on file.</li>'}</ul>
      </section>
      <section>
        <h2>How this corridor is written</h2>
        <p>${escapeHtml(wing.framing || '')}</p>
        <h2>Maintenance record</h2>
        <ul>${maint || '<li class="empty">Nothing is due. Nothing is held.</li>'}</ul>
        <p class="small">Checks fall due every ${Math.max(1, (wing.maintenanceIntervalOperations || 3) + pr.effects().maintenanceIntervalOperations)} operations.
           They are a record, not a chore: nothing here becomes mandatory and nothing here destroys progress.</p>
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  _genericRoom(room) {
    return `<div class="pad"><ul>${(room.allows || []).map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul></div>${this._siteUpgrades(room)}`;
  }

  /* ── §13.3 base growth, shown in the room it changes ─────────────────────── */

  _siteUpgrades(room) {
    const pr = this.progression;
    const list = (room && room.upgrades) || [];
    if (!list.length) return '';
    const rows = list.map((u) => {
      const owned = pr.profile.siteUpgrades.includes(u.id);
      const price = pr.priceOf(u);
      const gated = (u.clearanceRequired || 0) > pr.clearance;
      const blocked = u.requiresUpgrade && !pr.profile.siteUpgrades.includes(u.requiresUpgrade);
      const afford = pr.profile.requisition >= price && pr.profile.research >= (u.costResearch || 0);
      const why = gated ? `Requires ${clearanceTier(u.clearanceRequired).name}`
        : blocked ? 'Depends on work that has not been done'
          : afford ? '' : 'Requisition short';
      return `<tr class="${owned ? 'taken' : afford && !gated && !blocked ? '' : 'gone'}">
        <td class="name"><b>${escapeHtml(u.name)}</b><span>${escapeHtml(u.blurb)}</span>
          <span>${escapeHtml(owned ? u.visible : why)}</span></td>
        <td class="vol">${price}${u.costResearch ? `<br>${u.costResearch}R` : ''}</td>
        <td class="qty">${owned ? '<b>built</b>'
          : `<button data-site-buy="${u.id}" ${afford && !gated && !blocked ? '' : 'disabled'}>Build</button>`}</td>
      </tr>`;
    }).join('');
    return `<div class="pad"><h2>What this room could be</h2>
      <table class="items"><tbody>${rows}</tbody></table>
      <p class="small">The site began underfunded and every one of these is visible from the first
         day — GDD §13.3. Growth changes what the room can do; it never moves where things are.</p></div>`;
  }

  /* ── binding ─────────────────────────────────────────────────────────────── */

  /**
   * Everything the squad's clearance authorises. ⚠ This returned the FIRST match, which was
   * right while the site had one operation and silently wrong the moment it had two — the
   * second incident on the cold-storage floor simply never appeared on the board. A board
   * that shows one of the two available operations is worse than a board that shows none,
   * because nobody goes looking for what it did not mention.
   */
  _authorisedOperations() {
    const pr = this.progression;
    return (this.site.operations || []).filter((o) => (o.clearanceRequired || 0) <= pr.clearance);
  }

  /** The one the player has selected, defaulting to the first authorised. */
  _authorisedOperation() {
    const list = this._authorisedOperations();
    return list.find((o) => o.id === this.selectedOp) || list[0] || null;
  }

  _bind() {
    const q = (s) => this.node.querySelector(s);
    const all = (s) => this.node.querySelectorAll(s);

    all('[data-room]').forEach((b) => b.onclick = () => { this.notice = null; this.show(b.dataset.room); });

    const close = q('[data-close]');
    if (close) close.onclick = () => this.hide();

    all('[data-op]').forEach((n) => {
      n.onclick = () => { this.selectedOp = n.dataset.op; this.refresh(); };
    });
    const dep = q('[data-deploy]');
    if (dep) dep.onclick = () => {
      const op = this._authorisedOperation();
      if (!op) return;
      this.open = null;
      this.node.style.display = 'none';
      this.onDeploy(op);
    };

    all('[data-buy]').forEach((b) => b.onclick = () => {
      this.notice = this.progression.buyUpgrade(b.dataset.buy);
      this._render();
    });
    all('[data-site-buy]').forEach((b) => b.onclick = () => {
      this.notice = this.progression.buySiteUpgrade(b.dataset.siteBuy);
      this._render();
    });
    all('[data-fit]').forEach((s) => s.onchange = () => {
      this.notice = this.progression.fitUpgrade(s.dataset.fit, s.value || null);
      this._render();
    });
    all('[data-treat]').forEach((b) => b.onclick = () => {
      this.notice = this.progression.treat(b.dataset.treat, b.dataset.treatment);
      this._render();
    });
  }
}
