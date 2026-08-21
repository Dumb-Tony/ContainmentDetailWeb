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
 *
 * ── WHAT IS KEYED AND WHAT IS INTERPOLATED (GDD §23 Milestone 5) ──────────────
 *
 * The furniture is keyed; everything the model or the site file says is interpolated.
 * Department names, upgrade names and blurbs, cell labels, room names and purposes, dossier
 * designations, condition names, treatment names, and every refusal progression.js composed
 * are all read out of content/site.json or the progression tables — a site that shipped with
 * different rooms would need no line of content/locales.
 *
 * ⚠ THE IMPORT IS `msg`. Four functions here bind a local `t` — a standing tier, a clearance
 * tier, a treatment, an upgrade — and a shadowed translator fails as "t is not a function"
 * at the moment the screen is drawn.
 *
 * ⚠ AND `operation${n === 1 ? '' : 's'}` APPEARED EIGHT TIMES IN THIS FILE. That is English's
 * plural rule written out; Polish has three forms and Arabic six. Every one is now a plural
 * GROUP selected by Intl.PluralRules.
 */

import { escapeHtml } from './hud.js';
import { t as msg, plural } from '../core/i18n.js';
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

/**
 * The label for an overall grade. ⚠ THE VALUE IS AN ID: `grade()` returns it, OVERALL_PILL
 * keys a CSS class off it, and a saved profile has years of operations recorded in it. So
 * the id stays English in the data and the label comes from the table — the same split
 * `phase` and `pressure` make, found the same way.
 */
const gradeLabel = (word) => (word ? msg(`grade.${word}`) : '');

/** The label a fitted-equipment row prints for one changed field, in the item's own unit. */
const issuedValue = (field, value) => (value === undefined
  ? msg('base.issued.missing')
  : msg(`base.issued.unit.${field}`, { value }));

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
      const why = escapeHtml(msg('base.shell.requiresTier', { tier: need }));
      return `<button data-room="${r.id}" class="${r.id === this.tab ? 'on' : ''}"
        ${openRoom ? '' : `disabled title="${why}"`}>${escapeHtml(r.name.split(' ')[0])}</button>`;
    }).join('');

    const room = rooms.find((r) => r.id === this.tab) || rooms[0] || null;
    let body = `<div class="pad"><p class="empty">${msg('base.shell.noRooms')}</p></div>`;
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
      ? `<span class="waiting">${this.site.condition === 'underfunded' ? msg('base.shell.underfunded') : ''}</span>
         <button class="ghost" data-close>${msg('base.shell.close')}</button>
         <button class="go" data-deploy>${msg('base.shell.takeOperation')}</button>`
      : `<button class="go" data-close>${msg('base.shell.close')}</button>`;

    this._shell(escapeHtml(this.site.displayName || msg('base.shell.fallbackName')),
      msg('base.shell.sub', {
        tier: escapeHtml(tier.name),
        operations: plural('base.shell.operationsClosed', p.operationsCompleted),
        standing: escapeHtml(this.site.standing || ''),
      }),
      `${this._ledger()}<nav class="tabs">${nav}</nav>${this._notice()}
       <div class="pad"><h2>${escapeHtml(room ? room.name : this.site.displayName || '')}</h2>
         <p class="small">${escapeHtml(room ? room.purpose : '')}</p></div>${body}`,
      footer);

    this._bind();
  }

  _notice() {
    if (!this.notice) return '';
    return `<div class="pad"><div class="warn"><b>${msg('base.shell.counter')}</b><ul><li>${escapeHtml(this.notice)}</li></ul></div></div>`;
  }

  /** The four §12.2 resources, across the top, on every tab. */
  _ledger() {
    const pr = this.progression;
    const p = pr.profile;
    const tier = clearanceTier(pr.clearance);
    const next = CLEARANCE_TIERS.find((c) => c.level === pr.clearance + 1);
    const desc = (id) => escapeHtml((RESOURCES.find((r) => r.id === id) || {}).what || '');
    return `<div class="ledgerbar">
      <div class="fig" title="${desc('requisition')}"><b>${money(p.requisition)}</b><span>${msg('base.ledger.requisition')}</span></div>
      <div class="fig" title="${desc('research')}"><b>${money(p.research)}</b><span>${msg('base.ledger.research')}</span></div>
      <div class="fig" title="${desc('clearance')}"><b>${escapeHtml(tier.name)}</b><span>${
  next ? msg('base.ledger.clearanceNext', { need: this._clearanceNeed(next) }) : msg('base.ledger.clearance')}</span></div>
      <div class="fig"><b>${p.containment.length}</b><span>${msg('base.ledger.inCustody')}</span></div>
    </div>`;
  }

  _clearanceNeed(tier) {
    const r = tier.requires || {};
    const bits = [];
    if (r.operations !== undefined) bits.push(plural('base.ledger.needOperations', r.operations));
    if (r.custodies !== undefined) bits.push(plural('base.ledger.needCustodies', r.custodies));
    if (r.research !== undefined) bits.push(plural('base.ledger.needResearch', r.research));
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

    /* Every operation the site has, authorised or not, and the locked ones say why —
     * the same shape the upgrade list uses. Filtering them out of the render was the
     * obvious reading of "clearance gates operations" and it is the wrong one: §18.1
     * forbids the UI misrepresenting what is available, and a board that silently omits
     * the third contract tells the squad the region has two. A named lock is information;
     * an absence is a lie the player cannot even notice. */
    const all = this.site.operations || [];
    const board = all.length
      ? all.map((o) => {
        const gated = (o.clearanceRequired || 0) > pr.clearance;
        return `
      <div class="card-op ${gated ? 'gated' : ''} ${o.id === (op && op.id) ? 'chosen' : ''}"
           ${gated ? '' : `data-op="${escapeHtml(o.id)}"`}>
        <b>${escapeHtml(o.name)}</b>
        <p>${escapeHtml(o.mandate)}</p>
        <p class="small">${msg('base.ops.opMeta', {
    difficulty: escapeHtml(o.difficulty || msg('base.ops.difficultyDefault')),
    distance: escapeHtml(o.distance || ''),
  })}</p>
        <ul>${(o.conditions || []).map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        <p class="small">${msg('base.ops.optional', { list: (o.optional || []).map((x) => escapeHtml(x)).join(' · ') })}</p>
        ${gated ? `<p class="small lock">${msg('base.ops.locked', { tier: escapeHtml(clearanceTier(o.clearanceRequired).name) })}</p>` : ''}
      </div>`;
      }).join('')
      : `<p class="empty">${msg('base.ops.boardEmpty')}</p>`;

    const known = op ? pr.insightsFor(op.anomalyId).filter((i) => i.unlocked) : [];
    const knownHtml = `<h2>${msg('base.ops.archiveHead')}</h2>${known.length
      ? `<ul>${known.map((i) => `<li>${escapeHtml(i.text)}</li>`).join('')}</ul>`
      : `<p class="small">${msg('base.ops.archiveEmpty')}</p>`}`;

    const roster = pr.fieldable().map((o) => {
      const c = pr.conditionOf(o.id);
      return `<li class="${c ? 'off' : ''}"><b>${escapeHtml(o.name)}</b>
        <span>${c ? msg('base.ops.unfit', {
    condition: escapeHtml(c.name),
    operations: plural('base.ops.opsRemaining', c.operationsRemaining),
  }) : msg('base.ops.fit')}</span></li>`;
    }).join('');

    const warns = [];
    if (handicap.cargoVolume < 0) warns.push(msg('base.ops.warnCargo', { volume: Math.abs(handicap.cargoVolume) }));
    if (handicap.stabiliseFactor > 1) {
      warns.push(msg('base.ops.warnStabilise', { percent: Math.round((handicap.stabiliseFactor - 1) * 100) }));
    }
    /* Occupancy is one warning and RATING is a different one. The corridor can have a cell
     * free and still have nothing the selected operation's anomaly is rated for, which is
     * the case the requisition upgrade exists to solve — so say which of the two it is
     * rather than reporting "full" when it is not, or silence when it may as well be. */
    const cellsNow = pr.cells();
    const takenNow = new Set(pr.profile.containment.map((c) => c.cellId));
    const freeNow = cellsNow.filter((c) => !takenNow.has(c.id));
    if (!freeNow.length) {
      warns.push(msg('base.ops.warnCorridorFull'));
    } else if (op) {
      const d = pr.dossierFor(op.anomalyId);
      const need = d && d.cellRequirement;
      if (need && !freeNow.some((c) => !c.capability || c.capability === need)) {
        warns.push(msg('base.ops.warnNoRating', { rating: escapeHtml(need) }));
      }
    }

    /* Three whole sentences, printed one after another. Not a template with holes in it —
     * the vehicle bay line and the injury line each stand alone or do not appear. */
    const budgetNote = [msg('base.ops.standardManifest', { volume: budget })];
    if (effects.cargoVolumeBudget) budgetNote.push(msg('base.ops.bayAdds', { volume: effects.cargoVolumeBudget }));
    if (handicap.cargoVolume) budgetNote.push(msg('base.ops.injuriesCost', { volume: Math.abs(handicap.cargoVolume) }));

    return `<div class="cols">
      <section>
        <h2>${msg('base.ops.boardHead')}</h2>
        ${board}
        <p class="small">${this._boardLine(all)}</p>
        ${knownHtml}
      </section>
      <section>
        <h2>${msg('base.ops.regionalHead')}</h2>
        <ul>
          <li>${escapeHtml(status.weather || msg('base.ops.unknown'))}</li>
          <li>${escapeHtml(status.region || msg('base.ops.unknown'))}</li>
          <li>${escapeHtml(status.readiness || msg('base.ops.unknown'))}</li>
        </ul>
        <h2>${msg('base.ops.readinessHead')}</h2>
        <ul class="roster">${roster}</ul>
        ${adjusted === null ? '' : `<div class="budget"><div class="bar"><i style="width:${Math.min(100, (adjusted / Math.max(1, budget + 4)) * 100)}%"></i></div>
          <span>${msg('base.ops.cargoVolume', { volume: adjusted })}</span></div>
          <p class="small">${budgetNote.map((s) => `<span>${s}</span>`).join(' ')}</p>`}
        ${warns.length ? `<div class="warn"><b>${msg('base.ops.beforeYouGo')}</b><ul>${
    warns.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : ''}
        <h2>${msg('base.ops.standingHead')}</h2>
        ${this._standing()}
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  /** §12.3 as a readable picture: what each department wants, and what it charges you. */
  _standing() {
    const pr = this.progression;
    return `<ul class="dims">${DEPARTMENTS.map((d) => {
      const v = pr.standing(d.id);
      const tier = standingTier(v);
      const pct = ((v - STANDING_FLOOR) / (STANDING_CEILING - STANDING_FLOOR)) * 100;
      return `<li><b>${escapeHtml(d.name)}</b><span class="w">${msg('base.standing.value', {
        tier: escapeHtml(tier.name), amount: signed(v),
      })}</span>
        <div class="budget"><div class="bar"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>
          <span>${msg('base.standing.multiplier', { multiplier: tier.priceMultiplier.toFixed(2) })}</span></div>
        <p>${msg('base.standing.watches', {
        values: escapeHtml(d.values.toLowerCase()), watches: escapeHtml(d.watches.toLowerCase()),
      })}</p></li>`;
    }).join('')}</ul>
    <p class="small">${msg('base.standing.note')}</p>`;
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
          <option value="" ${cur === '' ? 'selected' : ''}>${
  msg('base.armory.standardVariant', { item: escapeHtml(it.displayName.toLowerCase()) })}</option>
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
          <span>${escapeHtml(dept ? dept.name : '')} · ${msg('base.armory.rate', {
    tier: escapeHtml(standingTier(pr.standing(u.department)).name.toLowerCase()),
  })}</span></td>
        <td class="vol">${price}${u.costResearch ? `<br>${msg('base.armory.researchCost', { count: u.costResearch })}` : ''}</td>
        <td class="qty">${owned
    ? `<b>${msg('base.armory.held')}</b>`
    : `<button data-buy="${u.id}" ${afford ? '' : 'disabled'}>${msg('base.armory.order')}</button>`}</td>
      </tr>`;
    }).join('');

    const lost = this._lastLoss();

    return `<div class="cols">
      <section class="plan">
        <h2>${msg('base.armory.fittedHead')}</h2>
        <p class="small">${msg('base.armory.fittedNote')}</p>
        ${fits || `<p class="empty">${msg('base.armory.noItems')}</p>`}
      </section>
      <section>
        <h2>${msg('base.armory.requisitionHead')}</h2>
        <table class="items"><tbody>${rows}</tbody></table>
        <p class="small">${msg('base.armory.priceNote')}</p>
        <h2>${msg('base.armory.recoveryHead')}</h2>
        ${lost}
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  /**
   * What the fitted variant actually does to the issued item, in the item's own units.
   *
   * ⚠ THE ROW IS ONE MESSAGE AND THE LABEL IS ANOTHER, rather than `label + ' ' + from`. A
   * translator moves "battery 20 min → 34 min" as a line; handed "battery" on its own they
   * have to guess where it goes, and in a language that puts the measure first it goes
   * somewhere else.
   */
  _issuedLine(base, issued) {
    const bits = [];
    const cmp = (field) => {
      if (base[field] === undefined && issued[field] === undefined) return;
      if (base[field] === issued[field]) return;
      bits.push(msg('base.issued.change', {
        label: msg(`base.issued.label.${field}`),
        from: issuedValue(field, base[field]),
        to: issuedValue(field, issued[field]),
      }));
    };
    cmp('cargoVolume');
    cmp('bulk');
    cmp('batteryMinutes');
    cmp('heatOutputCelsius');
    cmp('heatFalloffMetres');
    cmp('feedRadiusMetres');
    cmp('barrierWidthMetres');
    return bits.length ? escapeHtml(bits.join(' · ')) : msg('base.issued.asIssued');
  }

  _lastLoss() {
    const h = this.progression.profile.history;
    const last = h[h.length - 1];
    if (!last) return `<p class="small">${msg('base.armory.nothingBack')}</p>`;
    const dim = (last.dims || []).find((d) => /stewardship/i.test(d.name));
    return `<p class="small">${msg('base.armory.lastLoss', {
      operation: last.operation,
      word: escapeHtml(dim ? dim.word : msg('base.armory.unrecorded')),
    })}</p>`;
  }

  /* ── archive terminal (§13.2) ────────────────────────────────────────────── */

  /**
   * Which night an archived operation was (GDD §14.4).
   *
   * ⚠ §13 keeps a history so that it can be COMPARED, and two rows reading "the cold store,
   * Costly" describe a hard frost with the freight door jammed and a still night with
   * everything open. A squad reading their own record would conclude the floor is simply
   * like that — the one thing controlled variation exists to stop them believing. An
   * operation recorded before variation existed has no scenario and prints nothing rather
   * than pretending.
   */
  _nightLine(h) {
    const s = h.scenario;
    if (!s) return '';
    const bits = [];
    if (s.weather) bits.push(escapeHtml(s.weather));
    if (s.time) bits.push(escapeHtml(s.time.toLowerCase()));
    for (const id of s.shut || []) {
      bits.push(msg('base.archive.jammed', { name: escapeHtml(id.replace(/^door-/, '').replace(/-/g, ' ')) }));
    }
    for (const id of s.faulted || []) {
      bits.push(msg('base.archive.faulted', { name: escapeHtml(id.replace(/^circuit-/, '')) }));
    }
    if (!bits.length) return '';
    return `<p class="small night">${bits.join(' · ')}</p>`;
  }

  _archive(room) {
    const pr = this.progression;
    const hist = pr.profile.history.slice().reverse();
    const rows = hist.map((h) => {
      const pill = OVERALL_PILL[h.overall] || 'unreliable';
      const dims = (h.dims || []).map((d) => msg('base.archive.dim', { name: d.name, word: d.word })).join(' · ');
      return `<li class="ev">
        <div class="head"><b>${msg('base.archive.operation', { operation: h.operation })}</b>
          <span class="rel ${pill}">${escapeHtml(gradeLabel(h.overall))}</span>
          <span class="when">${msg('base.archive.when', {
    minutes: h.minutes ? msg('base.archive.minutes', { minutes: Number(h.minutes).toFixed(1) }) : msg('base.archive.unmeasured'),
    map: escapeHtml(h.mapId || msg('base.archive.unrecorded')),
  })}</span></div>
        <p>${escapeHtml(h.failReason || msg('base.archive.closed'))}</p>
        ${this._nightLine(h)}
        <div class="prov">${msg('base.archive.provenance', {
    requisition: signed(h.requisition), research: signed(h.research), dims: escapeHtml(dims),
  })}</div>
      </li>`;
    }).join('');

    const files = (this.site.dossiers || []).map((d) => {
      const k = pr.knowledgeFor(d.anomalyId);
      const ins = pr.insightsFor(d.anomalyId);
      return `<li><b>${escapeHtml(d.designation)}</b><span class="w">${plural('base.archive.operations', k.operations)}</span>
        <p>${escapeHtml(d.classFraming)}</p>
        <p>${escapeHtml(d.operationalCost)}</p>
        <p>${msg('base.archive.caseNotes', { filed: ins.filter((i) => i.unlocked).length, total: ins.length })}</p></li>`;
    }).join('');

    return `<div class="cols">
      <section>
        <h2>${msg('base.archive.historyHead')}</h2>
        <ul class="evlist">${rows || `<li class="empty">${msg('base.archive.historyEmpty')}</li>`}</ul>
      </section>
      <section>
        <h2>${msg('base.archive.filesHead')}</h2>
        <ul class="dims">${files || `<li class="empty">${msg('base.archive.filesEmpty')}</li>`}</ul>
        <h2>${msg('base.archive.attributionHead')}</h2>
        <p class="small">${msg('base.archive.attribution')}</p>
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
      /* ⚠ TWO COUNTS IN ONE SENTENCE IS A TRAP. `plural()` selects on one number, and
       * "{rules} rules read correctly across {operations} operations" needs two selections
       * at once — so it is three sentences, each with its own plural group, rather than one
       * sentence with English's grammar frozen into it. */
      return `<h2>${escapeHtml(d.designation)}</h2>
        <p class="small"><span>${plural('base.research.rulesRead', k.rulesRead)}</span>
           <span>${plural('base.research.overOperations', k.operations)}</span>
           <span>${plural('base.research.misread', k.rulesMisread)}</span></p>
        <ul class="dims">${ins.map((i) => `<li class="${i.unlocked ? '' : 'locked'}">
          <b>${i.unlocked ? msg('base.research.filed') : msg('base.research.notYet')}</b><span class="w">${escapeHtml(this._insightNeed(i))}</span>
          <p>${i.unlocked ? escapeHtml(i.text) : escapeHtml(i.grants || msg('base.research.insightLocked'))}</p></li>`).join('')}</ul>`;
    }).join('');

    const bench = pr.fieldable().map((o) => {
      const c = pr.conditionOf(o.id);
      if (!c) {
        return `<li><b>${escapeHtml(o.name)}</b><span class="w">${msg('base.bench.fit')}</span>
          <p>${plural('base.bench.onFile', o.operations)}</p></li>`;
      }
      const buttons = TREATMENTS.map((tr) => {
        const price = Math.round(tr.costRequisition * (1 + pr.effects().treatmentCostPct / 100));
        const label = price
          ? msg('base.bench.treat', { name: escapeHtml(tr.name), price })
          : msg('base.bench.treatFree', { name: escapeHtml(tr.name) });
        return `<button data-treat="${o.id}" data-treatment="${tr.id}">${label}</button>`;
      }).join(' ');
      return `<li><b>${escapeHtml(o.name)}</b><span class="w">${msg('base.bench.condition', {
        condition: escapeHtml(c.name),
        remaining: plural('base.bench.remaining', c.operationsRemaining),
      })}</span>
        <p>${escapeHtml(c.note)}</p><p>${buttons}</p></li>`;
    }).join('');

    return `<div class="cols">
      <section>
        <h2>${msg('base.research.dataHead')}</h2>
        <p class="small"><span>${msg('base.research.available', {
    available: money(pr.profile.research), earned: money(pr.profile.researchTotalEarned),
  })}</span> <span>${msg('base.research.clearanceNote')}</span></p>
        ${knowledge || `<p class="empty">${msg('base.research.noFile')}</p>`}
      </section>
      <section>
        <h2>${msg('base.bench.head')}</h2>
        <p class="small"><span>${plural('base.bench.beds', pr.treatmentCapacity())}</span>
           <span>${msg('base.bench.note')}</span></p>
        <ul class="dims">${bench}</ul>
      </section>
    </div>${this._siteUpgrades(room)}`;
  }

  _insightNeed(i) {
    const r = i.requires || {};
    const bits = [];
    if (r.rules !== undefined) bits.push(plural('base.research.needRules', r.rules));
    if (r.operations !== undefined) bits.push(plural('base.ledger.needOperations', r.operations));
    if (r.research !== undefined) bits.push(plural('base.research.needResearch', r.research));
    return bits.join(' · ');
  }

  /* ── containment observation corridor (§13.2) ────────────────────────────── */

  _containment(room) {
    const pr = this.progression;
    const wing = this.site.containmentWing || { cells: [] };
    const byCell = new Map(pr.profile.containment.map((c) => [c.cellId, c]));

    const cells = pr.cells().map((cell) => {
      const held = byCell.get(cell.id);
      const rating = cell.capability ? escapeHtml(cell.capability) : null;
      const label = escapeHtml(cell.label || cell.id);
      if (!held) {
        const where = rating ? msg('base.containment.vacantRated', { rating }) : msg('base.containment.vacant');
        return `<li class="vacant"><b>${label}</b><span>${where}</span>
          <div class="hist">${escapeHtml(cell.holding)}</div></li>`;
      }
      const hist = held.history.map((h) => `<div>${escapeHtml(h)}</div>`).join('');
      const where = held.improvised
        ? (rating ? msg('base.containment.improvised', { cell: label, rating }) : msg('base.containment.improvisedUnrated', { cell: label }))
        : (rating ? msg('base.containment.occupiedRated', { cell: label, rating }) : msg('base.containment.occupied', { cell: label }));
      return `<li${held.improvised ? ' class="improvised"' : ''}><b>${escapeHtml(held.designation)}</b><span>${where}</span>
        <div class="hist">${escapeHtml(cell.holding)}${hist}</div></li>`;
    }).join('');

    /**
     * ⚠ SOMETHING HELD WITH NO CELL WAS INVISIBLE HERE. The list was built by walking the
     * CELLS, so an entry allocated `cellId: null` — which is what happens once the corridor
     * is full — matched no row and simply did not appear. The site held it, the profile
     * recorded it, and the one screen whose job is to say what is in the building showed
     * nothing at all. §18.1 does not allow the UI to misrepresent what is true, and an
     * omission is the most persuasive misrepresentation available.
     */
    const unplaced = pr.profile.containment.filter((c) => !c.cellId).map((held) => {
      const hist = held.history.map((h) => `<div>${escapeHtml(h)}</div>`).join('');
      const line = held.cellRequirement
        ? msg('base.containment.onTheBusRated', { rating: escapeHtml(held.cellRequirement) })
        : msg('base.containment.onTheBus');
      return `<li class="unplaced"><b>${escapeHtml(held.designation)}</b><span>${msg('base.containment.unplaced')}</span>
        <div class="hist">${line}${hist}</div></li>`;
    }).join('');

    const maint = pr.profile.containment.flatMap((c) => c.maintenance.map((m) => `<li>${escapeHtml(m)}</li>`)).join('');
    const every = Math.max(1, (wing.maintenanceIntervalOperations || 3) + pr.effects().maintenanceIntervalOperations);

    return `<div class="cols">
      <section>
        <h2>${msg('base.containment.head')}</h2>
        <ul class="cells">${cells + unplaced || `<li class="empty">${msg('base.containment.empty')}</li>`}</ul>
      </section>
      <section>
        <h2>${msg('base.containment.framingHead')}</h2>
        <p>${escapeHtml(wing.framing || '')}</p>
        <h2>${msg('base.containment.maintenanceHead')}</h2>
        <ul>${maint || `<li class="empty">${msg('base.containment.maintenanceEmpty')}</li>`}</ul>
        <p class="small"><span>${plural('base.containment.interval', every)}</span>
           <span>${msg('base.containment.intervalNote')}</span></p>
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
      const why = gated ? msg('base.upgrades.requires', { tier: escapeHtml(clearanceTier(u.clearanceRequired).name) })
        : blocked ? msg('base.upgrades.blocked')
          : afford ? '' : msg('base.upgrades.short');
      return `<tr class="${owned ? 'taken' : afford && !gated && !blocked ? '' : 'gone'}">
        <td class="name"><b>${escapeHtml(u.name)}</b><span>${escapeHtml(u.blurb)}</span>
          <span>${owned ? escapeHtml(u.visible) : why}</span></td>
        <td class="vol">${price}${u.costResearch ? `<br>${msg('base.armory.researchCost', { count: u.costResearch })}` : ''}</td>
        <td class="qty">${owned ? `<b>${msg('base.upgrades.built')}</b>`
    : `<button data-site-buy="${u.id}" ${afford && !gated && !blocked ? '' : 'disabled'}>${msg('base.upgrades.build')}</button>`}</td>
      </tr>`;
    }).join('');
    return `<div class="pad"><h2>${msg('base.upgrades.head')}</h2>
      <table class="items"><tbody>${rows}</tbody></table>
      <p class="small">${msg('base.upgrades.note')}</p></div>`;
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

  /**
   * What the board is, said once, derived from the board rather than hard-coded. The line
   * used to read "the same floor twice" whenever there was more than one contract, which
   * was true of exactly the two operations that existed when it was written and became a
   * lie the moment a second building arrived.
   */
  _boardLine(ops) {
    if (ops.length < 2) return msg('base.ops.boardOne');
    const floors = new Set(ops.map((o) => o.mapId)).size;
    const things = new Set(ops.map((o) => o.anomalyId)).size;
    if (floors < ops.length && things < ops.length) return msg('base.ops.boardSharedBoth');
    if (floors < ops.length) return msg('base.ops.boardSharedFloor');
    if (things < ops.length) return msg('base.ops.boardSharedAnomaly');
    return msg('base.ops.boardDistinct', { count: ops.length });
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
    if (dep) {
      dep.onclick = () => {
        const op = this._authorisedOperation();
        if (!op) return;
        this.open = null;
        this.node.style.display = 'none';
        this.onDeploy(op);
      };
    }

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
