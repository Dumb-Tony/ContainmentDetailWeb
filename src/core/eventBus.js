/* Domain event bus — GDD §21.5.
 *
 * Deliberately NOT an event-sourcing framework (GDD says not to build one for the MVP).
 * It is a subscribe/emit pair plus a BOUNDED recent-event log for the debug overlay and
 * the shift report. Bounded matters: GDD §24.1 forbids unbounded trace logs, and a
 * ten-minute shift with 100 bags emits thousands of events.
 *
 * Rendering and UI listen. They never emit gameplay events and never decide rules.
 */

export const EVENTS = Object.freeze({
  // Milestone 0 has no gameplay events yet; these are declared so the vocabulary is
  // fixed in one place and later milestones cannot invent near-duplicate names.
  SIM_RESET:            'SIM_RESET',
  SIM_PAUSED:           'SIM_PAUSED',
  SIM_RESUMED:          'SIM_RESUMED',
  MODE_CHANGED:         'MODE_CHANGED',
  // Milestone 1.
  BAG_SPAWNED:          'BAG_SPAWNED',
  BAG_LEFT_CONVEYOR:    'BAG_LEFT_CONVEYOR',
  BAG_PICKED_UP:        'BAG_PICKED_UP',
  BAG_RELEASED:         'BAG_RELEASED',
  BAG_THROWN:           'BAG_THROWN',
  BAG_SCANNED:          'BAG_SCANNED',
  // Milestone 2.
  BAG_PLACED_IN_CART:   'BAG_PLACED_IN_CART',
  BAG_TAKEN_FROM_CART:  'BAG_TAKEN_FROM_CART',
  BAG_SPILLED:          'BAG_SPILLED',
  CART_HITCHED:         'CART_HITCHED',
  CART_UNHITCHED:       'CART_UNHITCHED',
  CART_PLACARD_SET:     'CART_PLACARD_SET',
  VEHICLE_ENTERED:      'VEHICLE_ENTERED',
  VEHICLE_EXITED:       'VEHICLE_EXITED',
  // Reserved for their milestones (GDD §21.5). Not emitted yet.
  BAG_ENTERED_HOLD:     'BAG_ENTERED_HOLD',
  BAG_LEFT_HOLD:        'BAG_LEFT_HOLD',
  FLIGHT_STATE_CHANGED: 'FLIGHT_STATE_CHANGED',
  FLIGHT_DEPARTED:      'FLIGHT_DEPARTED',
  BAG_MISROUTED:        'BAG_MISROUTED',
  BAG_MISSED:           'BAG_MISSED',
  SCORE_CHANGED:        'SCORE_CHANGED',
});

export class EventBus {
  constructor({ logSize = 256 } = {}) {
    this._handlers = new Map();   // type -> Set<fn>
    this._any = new Set();
    this.logSize = logSize;
    this.log = [];                // ring, newest last
    this.emitted = 0;
  }

  /** @returns {() => void} unsubscribe */
  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) { set = new Set(); this._handlers.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** @returns {() => void} unsubscribe */
  onAny(fn) { this._any.add(fn); return () => this._any.delete(fn); }

  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload = {}, simTimeMs = 0) {
    const evt = { type, simTimeMs, ...payload };
    this.emitted++;

    this.log.push(evt);
    if (this.log.length > this.logSize) this.log.shift();

    const set = this._handlers.get(type);
    // iterate a copy: a handler may unsubscribe itself mid-dispatch
    if (set) for (const fn of Array.from(set)) fn(evt);
    for (const fn of Array.from(this._any)) fn(evt);
    return evt;
  }

  /** Most recent events, newest first. Debug overlay only. */
  recent(n = 8) { return this.log.slice(-n).reverse(); }

  clearLog() { this.log.length = 0; this.emitted = 0; }

  /** Drop every subscriber. Restart rebuilds systems, so stale closures must not survive. */
  clearHandlers() { this._handlers.clear(); this._any.clear(); }
}
