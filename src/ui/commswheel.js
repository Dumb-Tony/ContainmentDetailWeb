/* The comms wheel, and what an incoming call looks like — GDD §11.3, §18.2, §19.
 *
 * Three surfaces, one file, because they are one conversation:
 *
 *   the WHEEL     hold a key, flick, release. Ten phrases from src/sim/comms.js, laid out
 *                 clockwise from twelve in the order that file authors them.
 *   the FEED      one caption line per incoming call, rendered by audio.js's own
 *                 `formatCaption` from a row shaped exactly like one of its CAPTIONS.
 *   the MARKERS   where the call is, in the world, projected into HUD space.
 *
 * NO RULE LIVES HERE. Whether a call is allowed, how long it lasts and what it means are
 * all decided by the host through `sim/comms.js`; this file asks and prints the answer,
 * the same contract ui/base.js keeps with progression.js. The one thing it decides on its
 * own is the local pre-check before sending — see `_send`.
 *
 * ── WHY A RADIAL AND NOT A MENU (GDD §19.2) ──────────────────────────────────
 *
 * §19.2 lists "reading small or rapidly changing text" as a thing no required rule may
 * depend on. A list of ten phrases is read every single time. A radial is read for the
 * first few operations and after that it is a DIRECTION — up-left is "it is here" the way
 * W is forward — and a direction survives a dark room, a shaking camera and a player who
 * is busy. The digit keys select the same ten sectors directly for anyone who would rather
 * not flick, and releasing the key without moving past the dead zone sends nothing at all,
 * because an accidental key press must never put a word on five other people's screens.
 *
 * ── COLOUR IS THE BAND, THE GLYPH IS THE IDENTITY (§18.5, §19.2) ─────────────
 *
 * §18.5's interaction language has five signal colours and comms.js has six kinds, which
 * is the useful accident that forces the right design: colour carries the URGENCY BAND
 * (red — somebody is about to be hurt; cyan — information; amber — tasking; green —
 * bodies) and the glyph carries which of the six it is. So a player who cannot separate
 * the hues loses a grouping and never loses a message, and a player who can gets to triage
 * the feed at a glance without reading it. Both channels are always on: unlike §18.5's
 * world outlines, a marker across a dark floor has no third channel to fall back on, so
 * the glyph does NOT follow `vision.shapes`.
 */

import {
  PHRASES, PING_KINDS, ANCHORS, COMMS_CAPTIONS, MARK_RANGE_M,
  phraseOf, kindOf, captionOf, ageFraction, bearingWord, canMark,
} from '../sim/comms.js';
import { formatCaption } from '../audio/audio.js';
import { escapeHtml } from './hud.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/** Which of §18.5's five signal colours each kind borrows. See the file header. */
export const KIND_VARS = Object.freeze({
  danger: '--red', help: '--red',
  evidence: '--cyan', watch: '--cyan',
  objective: '--amber',
  move: '--green',
});

/** Phrase ids in wheel order. Authoring order in comms.js IS this order. */
export const WHEEL_ORDER = Object.freeze(Object.keys(PHRASES));

/* How far from the centre the flick has to travel before it counts as a choice, as a
 * fraction of the wheel's radius. Generous: the cost of a missed selection is a wasted
 * key press, and the cost of an accidental one is a false callout during a procedure. */
export const DEAD_ZONE = 0.34;

/**
 * PURE. Which sector an offset from the centre picks, or null for "cancel".
 *
 * Index 0 sits at twelve o'clock and they run clockwise, which is what `atan2(dx, -dy)`
 * gives directly — screen y grows downward, so the negation is what makes "up" zero and
 * not the thing that inverts the whole wheel.
 *
 * @param {number} radius  the wheel's radius in the same units as dx/dy
 */
export function sectorAt(dx, dy, n, radius, deadZone = DEAD_ZONE) {
  if (!(n > 0)) return null;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r < radius * deadZone) return null;
  const a = Math.atan2(dx, -dy);
  const step = (Math.PI * 2) / n;
  const i = Math.round(((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / step);
  return i % n;
}

/** PURE. Where sector `i` of `n` sits, as a fraction of the wheel's half-width from the
 *  centre. Percentages rather than pixels so the whole wheel scales with `--cd-ui-scale`
 *  without this file ever reading a computed style. */
export function sectorPos(i, n, spread = 0.38) {
  const a = (Math.PI * 2 * i) / n;
  return { left: 50 + spread * 100 * Math.sin(a), top: 50 - spread * 100 * Math.cos(a) };
}

/* ── projection ───────────────────────────────────────────────────────────────
 *
 * Twelve lines of arithmetic rather than an import of THREE. The renderer's camera is a
 * plain perspective camera with `rotation.order = 'YXZ'`, so its basis is exactly the
 * convention the simulation already uses — forward is (-sin yaw · cos pitch, sin pitch,
 * -cos yaw · cos pitch) — and inverting it by hand keeps ui/ out of the engine's module
 * graph, which is the same line renderer.js draws in the other direction.
 */

/**
 * PURE. World point to HUD pixels.
 * @returns {{left, top, depth}} depth is metres in front of the lens; <= 0 is behind it.
 */
export function projectPoint(cam, viewW, viewH, x, y, z) {
  const psi = cam.yaw, theta = cam.pitch;
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
  const cy = Math.cos(psi), sy = Math.sin(psi);
  const x1 = dx * cy - dz * sy;
  const z1 = dx * sy + dz * cy;
  const ct = Math.cos(theta), st = Math.sin(theta);
  const y2 = dy * ct + z1 * st;
  const z2 = -dy * st + z1 * ct;
  const depth = -z2;
  const tan = Math.tan((cam.fovDeg * Math.PI) / 180 / 2);
  const aspect = viewW / Math.max(1, viewH);
  const safe = Math.max(0.001, Math.abs(depth));
  return {
    left: ((x1 / safe / (tan * aspect)) * 0.5 + 0.5) * viewW,
    top: (0.5 - (y2 / safe / tan) * 0.5) * viewH,
    depth,
  };
}

/** The projector the wheel wants, built from a live Renderer. One argument at the wiring
 *  site, and the arithmetic above stays testable without a canvas. */
export function screenProjector(renderer) {
  return (x, y, z) => projectPoint({
    x: renderer.camera.position.x, y: renderer.camera.position.y, z: renderer.camera.position.z,
    yaw: renderer.camera.rotation.y, pitch: renderer.camera.rotation.x,
    fovDeg: renderer.camera.fov,
  }, renderer.viewW || 1, renderer.viewH || 1, x, y, z);
}

/**
 * PURE. Where the crosshair meets the floor, clamped to marking range.
 *
 * ⚠ MEASURED IN HORIZONTAL METRES, not along the ray. comms.js's range test is `dist` on
 * the floor plane like everything else in this game, and a limit clamped along the ray is
 * a different, shorter limit that gets shorter the further you look down — the sort of
 * disagreement that shows up as "sometimes it will not let me mark the far end of the
 * aisle" and never as a stack trace.
 *
 * Looking level or upward never meets the floor at all, so the point runs out to the limit
 * instead of to infinity. Whatever that lands behind is refused by the line-of-sight test,
 * on the host, rather than fudged here.
 */
export function aimPoint(player, rangeM = MARK_RANGE_M) {
  const eye = typeof player.eyeHeight === 'function' ? player.eyeHeight() : 1.62;
  const down = Math.tan(-player.pitch);
  const h = down > 0.02 ? Math.min(rangeM, eye / down) : rangeM;
  return { x: player.x - Math.sin(player.yaw) * h, z: player.z - Math.cos(player.yaw) * h };
}

/* ── the wheel ────────────────────────────────────────────────────────────── */

export class CommsWheel {
  /**
   * @param {HTMLElement} root  where the nodes go — `#hud`, alongside Hud's own children
   * @param {Game} game
   * @param {object} opts
   *   onSend    `(phraseId, {x, z}) => void`. The call site turns this into an ACT on a
   *             client and a direct `game.ping` on the host. This file never picks.
   *   onRefuse  `(why) => void` for the local pre-check. Maps to `game.noticeLocal`.
   *   project   `(x, y, z) => {left, top, depth}`, usually `screenProjector(renderer)`.
   *             Absent, the feed still runs and no markers are drawn.
   *   settings  a Settings instance, for the caption formatting preferences.
   *   maxLines  how many feed lines at once.
   */
  constructor(root, game, { onSend, onRefuse, project = null, settings = null, maxLines = 4 } = {}) {
    this.game = game;
    this.onSend = onSend || (() => {});
    this.onRefuse = onRefuse || (() => {});
    this.project = project;
    this.settings = settings;
    this.maxLines = maxLines;

    this.open = false;
    this.selection = null;      // index into WHEEL_ORDER, or null for cancel
    this.offset = { x: 0, y: 0 };
    /** Pixels of mouse travel that reach the rim. Small enough for a flick of the wrist. */
    this.radius = 150;

    this.node = el('div', 'cd-wheel', root);
    this.node.style.display = 'none';
    this.feed = el('div', 'cd-commsfeed', root);
    this.pins = el('div', 'cd-pings', root);
    this._pinNodes = new Map();   // ping id -> element, so a marker survives a frame
    this._feedSig = '';
    this._wedges = [];
    this._build();

    this._onKey = (e) => this._key(e);
  }

  /* ── the ten wedges, built once ──────────────────────────────────────────── */

  _build() {
    const n = WHEEL_ORDER.length;
    el('div', 'hubline', this.node);
    WHEEL_ORDER.forEach((id, i) => {
      const ph = PHRASES[id];
      const kind = PING_KINDS[ph.kind];
      const cap = COMMS_CAPTIONS[id];
      const pos = sectorPos(i, n);
      const w = el('div', `wedge k-${ph.kind}`, this.node);
      w.style.left = `${pos.left}%`;
      w.style.top = `${pos.top}%`;
      w.style.setProperty('--kind', `var(${KIND_VARS[ph.kind] || '--ink'})`);
      w.dataset.phrase = id;
      /* Glyph, word and key, on every wedge, always. Three channels for the same fact —
       * §18.1's "critical states use redundant color, shape, text". */
      w.innerHTML = `<b class="g">${escapeHtml(kind.glyph)}</b>`
        + `<span class="t">${escapeHtml(cap.text)}</span>`
        + `<em class="n">${(i + 1) % 10}</em>`;
      this._wedges.push(w);
    });
    this.hub = el('div', 'hub', this.node);
    this.hub.textContent = 'release to cancel';
  }

  /* ── opening, aiming, sending ────────────────────────────────────────────── */

  /** The whole input contract, as one call per frame: `wheel.setHeld(input.isDown('comms'))`.
   *  Rising edge opens, falling edge commits. Works unchanged under input.js's toggle mode,
   *  because by then `isDown` is a latch and the edges are the latch's. */
  setHeld(held) {
    if (held && !this.open) this.show();
    else if (!held && this.open) this.hide(true);
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.selection = null;
    this.offset.x = 0; this.offset.y = 0;
    this.node.style.display = 'block';
    window.addEventListener('keydown', this._onKey, true);
    this._paint();
  }

  /** @param {boolean} send commit the selection, or throw it away (Escape, a lost window) */
  hide(send = false) {
    if (!this.open) return;
    this.open = false;
    this.node.style.display = 'none';
    window.removeEventListener('keydown', this._onKey, true);
    const pick = this.selection;
    this.selection = null;
    if (send && pick !== null) this._send(WHEEL_ORDER[pick]);
  }

  get isOpen() { return this.open; }

  /**
   * Mouse travel while the wheel is up. main.js hands the same deltas it would have given
   * `player.look`, and must NOT give them to both — turning the head while choosing a
   * phrase moves the crosshair the phrase is about.
   */
  aim(dx, dy) {
    if (!this.open) return;
    this.offset.x = Math.max(-this.radius, Math.min(this.radius, this.offset.x + dx));
    this.offset.y = Math.max(-this.radius, Math.min(this.radius, this.offset.y + dy));
    const next = sectorAt(this.offset.x, this.offset.y, WHEEL_ORDER.length, this.radius);
    if (next === this.selection) return;
    this.selection = next;
    this._paint();
  }

  /** Direct pick, for the digit keys and for anything that cannot flick a mouse. */
  selectIndex(i) {
    if (!this.open || !(i >= 0 && i < WHEEL_ORDER.length)) return false;
    this.selection = i;
    this._paint();
    return true;
  }

  _key(e) {
    if (!this.open || e.repeat) return;
    if (e.code === 'Escape') { this.hide(false); return; }              // reserved; we only read it
    const digit = /^Digit([0-9])$/.exec(e.code);
    if (digit) {
      const n = Number(digit[1]);
      /* Printed 1..9 then 0, so the tenth wedge is the zero key and not a two-key press. */
      if (this.selectIndex(n === 0 ? 9 : n - 1)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.code === 'Enter' || e.code === 'Space') { this.hide(true); e.preventDefault(); }
  }

  /**
   * The local pre-check, and the only decision this file makes.
   *
   * The host still runs the same test on the same rules (`requestPing`), so a modified
   * client gains nothing by skipping this. What it buys is a refusal the operative reads
   * in the same frame they pressed the key, instead of one that arrives after a round
   * trip — and it keeps a doomed request off the wire, which is where §20.9's rate limit
   * would otherwise be spent on it.
   */
  _send(phraseId) {
    const ph = PHRASES[phraseId];
    if (!ph) return;
    const me = this.game.viewPlayer;
    if (!me) return;
    if (me.alive === false) { this.onRefuse('You are off the net.'); return; }
    if (me.downed && !ph.whileDowned) { this.onRefuse('You are on the floor. Call for help.'); return; }

    const anchor = ANCHORS[ph.anchor];
    let aim = { x: me.x, z: me.z };
    if (anchor.needsSight) {
      aim = aimPoint(me);
      if (!canMark(me, aim.x, aim.z, this.game.site.blockingRects())) {
        this.onRefuse('You cannot see that from here.');
        return;
      }
    }
    this.onSend(phraseId, aim);
  }

  _paint() {
    this._wedges.forEach((w, i) => w.classList.toggle('on', i === this.selection));
    const pick = this.selection === null ? null : WHEEL_ORDER[this.selection];
    this.hub.textContent = pick ? COMMS_CAPTIONS[pick].text : 'release to cancel';
    this.hub.classList.toggle('armed', !!pick);
  }

  /* ── incoming ────────────────────────────────────────────────────────────── */

  /**
   * Once a frame, after the snapshot has landed. Draws the feed and the markers.
   * @param {number} nowMs  simulation time — the same clock the calls expire on, so a
   *   paused game holds what is on screen instead of ageing it out while nobody is playing.
   */
  update(nowMs) {
    const board = this.game.comms;
    if (!board) return;
    const live = board.live(nowMs, (id) => {
      const p = this.game.playerById(id);
      return p ? { x: p.x, z: p.z } : null;
    });
    this._drawFeed(live, nowMs);
    this._drawMarkers(live, nowMs);
  }

  _nameOf(ownerId) {
    const p = this.game.playerById(ownerId);
    return p ? p.name : 'Somebody';
  }

  /**
   * The feed. One line per live call, rendered by audio.js's own formatter from a row of
   * exactly its shape, so a spoken call and a non-speech cue read as the same channel.
   *
   * ⚠ IT IS NOT GOVERNED BY `captions.enabled`. That option turns off the TRANSCRIPT of a
   * sound; these lines are the message itself and this build gives them no audio at all,
   * so honouring the switch here would delete the squad's only comms channel for the
   * player most likely to have turned it off. The two formatting preferences it does read
   * — speaker and direction — are preferences about a line, not about whether there is one.
   */
  _drawFeed(live, nowMs) {
    const me = this.game.viewPlayer;
    const showSpeaker = this.settings ? this.settings.get('captions.speaker') !== false : true;
    const showDirection = this.settings ? this.settings.get('captions.direction') !== false : true;

    const rows = live.map((p) => {
      const cap = captionOf(p);
      const ph = phraseOf(p);
      const placed = ANCHORS[ph.anchor].placed;
      return {
        p, cap,
        priority: cap.priority,
        text: formatCaption(cap, {
          speaker: this._nameOf(p.owner),
          direction: placed && me ? bearingWord(me, p.x, p.z) : null,
          showSpeaker, showDirection,
        }),
      };
    });

    /* Over-full drops the LOWEST priority, not the oldest — the same rule and the same
     * reason as CaptionChannel.active: losing "something to log here" to keep "it is here"
     * is the entire point of the priority column. */
    let show = rows;
    if (rows.length > this.maxLines) {
      const keep = new Set(rows.slice().sort((a, b) => (b.priority - a.priority) || (b.p.atMs - a.p.atMs))
        .slice(0, this.maxLines));
      show = rows.filter((r) => keep.has(r));
    }

    const html = show.map((r) => {
      const kind = kindOf(r.p);
      const fade = ageFraction(r.p, nowMs) > 0.85 ? ' going' : '';
      return `<div class="cline p${r.priority} k-${PHRASES[r.p.phrase].kind}${fade}"`
        + ` style="--kind:var(${KIND_VARS[PHRASES[r.p.phrase].kind] || '--ink'})">`
        + `<b>${escapeHtml(kind.glyph)}</b><span>${escapeHtml(r.text)}</span></div>`;
    }).join('');
    if (html !== this._feedSig) { this._feedSig = html; this.feed.innerHTML = html; }
  }

  /**
   * The markers. One node per live call that has a place, kept across frames and moved,
   * rather than rebuilt — a marker re-created every frame restarts its own fade and never
   * finishes appearing. Same reasoning as `applySnapshot`'s reuse-by-id.
   *
   * A call that is behind the camera or off the edge is CLAMPED to the border with a
   * bearing arrow instead of being dropped. §19.2 again: the squad said where it was, and
   * "you had to be looking the right way to receive that" is exactly the dependency on
   * spatial perception the section forbids.
   */
  _drawMarkers(live, nowMs) {
    if (!this.project) { if (this._pinNodes.size) this._clearMarkers(); return; }
    const me = this.game.viewPlayer;
    const seen = new Set();
    const w = this.pins.clientWidth || window.innerWidth;
    const h = this.pins.clientHeight || window.innerHeight;
    const pad = 46;
    /* ⚠ THE BOTTOM MARGIN IS DEEPER THAN THE OTHERS, and it is not symmetry for its own
     * sake: the feed and the notices live down there, and a clamped marker parked under
     * them is a message the squad sent and nobody received. A marker that is genuinely on
     * screen still projects where it belongs; only the clamp is kept clear. */
    const padBottom = 170;

    for (const p of live) {
      const ph = phraseOf(p);
      if (!ANCHORS[ph.anchor].placed) continue;
      seen.add(p.id);
      let node = this._pinNodes.get(p.id);
      if (!node) {
        const kind = PING_KINDS[ph.kind];
        node = el('div', `cd-ping k-${ph.kind}`, this.pins);
        node.style.setProperty('--kind', `var(${KIND_VARS[ph.kind] || '--ink'})`);
        node.innerHTML = `<b class="g">${escapeHtml(kind.glyph)}</b>`
          + `<span class="t">${escapeHtml(COMMS_CAPTIONS[p.phrase].text)}</span>`
          + `<em class="d"></em><i class="age"></i>`;
        this._pinNodes.set(p.id, node);
      }

      /* Head height, not floor height: a mark drawn at y=0 sits under the geometry it is
       * about, and at twenty metres that is the difference between a marker on the crate
       * and a marker on the floor beyond it. */
      const s = this.project(p.x, 1.5, p.z);
      let left = s.left, top = s.top, edge = false;
      if (s.depth <= 0) {
        /* Behind the lens the projection is mirrored and meaningless, so throw it away and
         * use the bearing instead: park the marker on the rim, on the side it is on, at
         * eye level. Dropping it instead would mean "you had to be facing the right way to
         * receive that", which is the dependency on spatial perception §19.2 forbids. */
        left = bearingWord(me, p.x, p.z) === 'right' ? w - pad : pad;
        top = h / 2;
        edge = true;
      }
      if (left < pad || left > w - pad || top < pad || top > h - padBottom) edge = true;
      node.classList.toggle('edge', edge);
      node.style.left = `${Math.max(pad, Math.min(w - pad, left))}px`;
      node.style.top = `${Math.max(pad, Math.min(h - padBottom, top))}px`;

      const d = me ? Math.hypot(p.x - me.x, p.z - me.z) : 0;
      const dtxt = `${d.toFixed(0)}m`;
      const dn = node.querySelector('.d');
      if (dn.textContent !== dtxt) dn.textContent = dtxt;
      node.style.setProperty('--age', String(1 - ageFraction(p, nowMs)));
    }

    for (const [id, node] of this._pinNodes) {
      if (seen.has(id)) continue;
      node.remove();
      this._pinNodes.delete(id);
    }
  }

  _clearMarkers() {
    for (const node of this._pinNodes.values()) node.remove();
    this._pinNodes.clear();
  }

  /** Tear-down, for a screen that is going away. */
  destroy() {
    this.hide(false);
    this._clearMarkers();
    this.node.remove();
    this.feed.remove();
    this.pins.remove();
  }
}
