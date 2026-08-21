/* Every sentence the game says to a player, in one place, keyed rather than written.
 *
 * GDD §23 Milestone 5 asks for an "accessibility and localization pass". The accessibility
 * half is done and enforced by the suite. This is the other half, and it starts from an
 * honest position: **the build is monolingual and every string is spelled into the file
 * that prints it**, across eighteen source files.
 *
 * ── THE RULE, stated once ─────────────────────────────────────────────────────
 *
 * **A key names a MESSAGE, never a fragment.** `t('hud.noise.walking')` is a message;
 * `t('hud.noise.') + gait` is a sentence assembled at runtime, and sentence assembly is
 * what breaks in every language that is not English — word order moves, adjectives agree,
 * plurals are not two-valued, and "N of M" is not a template everywhere. Interpolation is
 * allowed and concatenation is not: a message may carry `{count}` and decide for itself
 * where that goes.
 *
 * This is the same argument `sim/senses.js` makes about content: a JSON key may name a
 * QUANTITY and never an OPERATOR. Here a key names a WHOLE THING SAID and never a piece of
 * one. Both rules exist because the alternative composes at the wrong layer.
 *
 * ── WHY A PSEUDOLOCALE, AND WHY IT IS THE POINT ───────────────────────────────
 *
 * An extraction pass is never finished, and the way you find out is not by reading the
 * diff. `pseudo` renders every message with its vowels accented and padded to 130% of its
 * length, so anything still hard-coded stands out on screen as the only unaccented text —
 * and any layout that only fits English breaks visibly rather than at translation time.
 * It needs no translator and it is checkable headlessly, which is why the suite uses it.
 *
 * ── FALLBACK ──────────────────────────────────────────────────────────────────
 *
 * A missing key returns the key itself, loudly, rather than an empty string. §18.1 does not
 * allow the UI to misrepresent, and a blank label misrepresents "there is nothing here".
 * The suite fails the build on any key that resolves to itself in the default locale.
 */

/** Tags the build knows about. `pseudo` is generated, not authored. */
export const LOCALES = Object.freeze(['en-GB', 'en-US', 'pseudo']);
export const DEFAULT_LOCALE = 'en-GB';

/* ── the store ───────────────────────────────────────────────────────────────── */

let _messages = Object.create(null);
let _locale = DEFAULT_LOCALE;
let _fallback = Object.create(null);
/** Keys asked for and not found, in ask order. The suite reads this; so can a translator. */
const _missing = new Set();
/** Keys actually asked for at runtime. Lets the suite find messages nothing uses. */
const _used = new Set();

/**
 * Flatten a nested message document into dotted keys.
 *
 * Locale files nest because a flat file of four hundred dotted keys is unreadable and
 * unreviewable, and review is the whole point of putting the prose in one place.
 */
export function flatten(doc, prefix = '', out = Object.create(null)) {
  for (const k of Object.keys(doc)) {
    if (k.startsWith('_')) continue;            // _note fields are for the reader
    const v = doc[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

/**
 * ⚠ THE PSEUDOLOCALE MUST NOT TOUCH A PLACEHOLDER. `{count}` accented is `{cöûnt}`, which
 * resolves to nothing and prints the literal braces — so the pass would report a bug it
 * had just introduced. Split on the placeholders, transform only the prose between them.
 */
const VOWELS = { a: 'á', e: 'é', i: 'î', o: 'ö', u: 'û', A: 'Á', E: 'É', I: 'Î', O: 'Ö', U: 'Û' };
export function pseudo(text) {
  const parts = String(text).split(/(\{[a-zA-Z0-9_]+\})/g);
  const body = parts.map((p) => (p.startsWith('{') && p.endsWith('}')
    ? p
    : p.replace(/[aeiouAEIOU]/g, (c) => VOWELS[c] || c))).join('');
  /* 30% padding, which is the figure localisation guides use for English to German and is
   * the one that actually breaks a fixed-width HUD row. Padded with a run of the same
   * bracket so it reads as instrumentation rather than as a word. */
  const pad = Math.max(1, Math.round(body.replace(/\{[^}]*\}/g, '').length * 0.3));
  return `⟦${body}${'·'.repeat(pad)}⟧`;
}

/** Install a message table. `doc` may be nested; it is flattened here. */
export function setMessages(doc, locale = DEFAULT_LOCALE) {
  _messages = flatten(doc || {});
  _locale = locale;
  if (locale === DEFAULT_LOCALE) _fallback = _messages;
  _missing.clear();
}

/** Install the fallback separately — used when a partial locale sits over en-GB. */
export function setFallback(doc) { _fallback = flatten(doc || {}); }

export function locale() { return _locale; }
export function missingKeys() { return [..._missing]; }
export function usedKeys() { return [..._used]; }
/**
 * Every key that CAN resolve, which is the union of this locale and the fallback.
 *
 * ⚠ THIS RETURNED ONLY THE CURRENT LOCALE'S OWN KEYS, and under a partial locale that is a
 * lie: `en-US` carries eight messages and the game has a hundred and sixty-four, because the
 * rest fall through. A caller asking "what can I say" got "eight".
 */
export function knownKeys() {
  return [...new Set([...Object.keys(_fallback), ...Object.keys(_messages)])];
}

/** Keys this locale carries ITSELF, which is what a translator's progress bar wants. */
export function ownKeys() { return Object.keys(_messages); }
export function resetUsage() { _used.clear(); _missing.clear(); }

/**
 * The one function the rest of the build calls.
 *
 * @param {string} key     dotted message key
 * @param {object} [params] values for `{placeholders}`
 * @returns {string}
 */
export function t(key, params) {
  _used.add(key);
  let s = _messages[key];
  if (s === undefined) s = _fallback[key];
  if (s === undefined) { _missing.add(key); return key; }
  if (_locale === 'pseudo') s = pseudo(s);
  if (!params) return s;
  return String(s).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m));
}

/**
 * Pick one of a message's plural forms.
 *
 * ⚠ ENGLISH HAS TWO FORMS AND THAT IS NOT A LAW. The naive `n === 1 ? 'x' : 'xs'` is
 * written into this codebase in fourteen places and it is wrong in Polish, Russian, Arabic
 * and Welsh before you reach a second language. `Intl.PluralRules` is in every browser this
 * build supports and already knows the answer, so the locale file authors the CATEGORIES it
 * needs — `one`, `other`, and whatever else its language has — and this picks between them.
 */
export function plural(key, count, params) {
  const cat = new Intl.PluralRules(_locale === 'pseudo' ? DEFAULT_LOCALE : _locale).select(count);
  const tryKey = `${key}.${cat}`;
  const has = _messages[tryKey] !== undefined || _fallback[tryKey] !== undefined;
  return t(has ? tryKey : `${key}.other`, { count, ...(params || {}) });
}

/**
 * Load a locale document over http, the same way content is loaded.
 *
 * Relative to THIS module, so the build works at the site root and under
 * /ContainmentDetailWeb/ alike — the discipline `sim/content.js` already keeps.
 */
export async function loadLocale(tag = DEFAULT_LOCALE, path = '../../content/locales') {
  /* eslint-disable-next-line no-use-before-define */
  return _load(tag, path);
}

async function _load(tag = DEFAULT_LOCALE, path = '../../content/locales') {
  /* `pseudo` is generated from the default rather than authored: a pseudolocale file
   * checked into the repo would go stale the first time anybody added a message. */
  const want = tag === 'pseudo' ? DEFAULT_LOCALE : tag;
  const url = new URL(`${path}/${want}.json`, import.meta.url).href;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`locale ${want}: HTTP ${res.status}`);
  const doc = await res.json();
  /* ⚠ THE FALLBACK IS SET BEFORE THE MESSAGES, because `setMessages` overwrites the
   * fallback when the tag IS the default — so doing it the other way round installs the
   * default as fallback and then immediately replaces it with the partial locale, and every
   * message the partial file does not carry resolves to its own key. */
  if (want !== DEFAULT_LOCALE) {
    const base = await fetch(new URL(`${path}/${DEFAULT_LOCALE}.json`, import.meta.url).href, { cache: 'no-store' });
    if (!base.ok) throw new Error(`fallback ${DEFAULT_LOCALE}: HTTP ${base.status}`);
    const baseDoc = await base.json();
    setMessages(doc, tag);
    setFallback(baseDoc);
    if (tag === 'pseudo') _locale = 'pseudo';
    return doc;
  }
  setMessages(doc, tag);
  if (tag === 'pseudo') _locale = 'pseudo';
  return doc;
}

/**
 * ⚠ THE DEFAULT LOCALE LOADS AT MODULE SCOPE, ON PURPOSE.
 *
 * The alternative is a line in `main.js` that every future entry point has to remember, and
 * the failure mode when somebody forgets is a HUD that prints `hud.objective.investigate`
 * at a player. Top-level await makes every importer wait for one small fetch instead, which
 * is a real dependency and a visible one — a module that needs the message table says so by
 * importing this file.
 *
 * A FAILURE HERE IS LOUD AND NOT FATAL. If the fetch fails the game still runs and `t()`
 * returns keys, which looks broken because it IS broken; a silent empty string would look
 * like a design decision. The suite asserts the table loaded, so this cannot ship missing.
 */
/**
 * Which locale to boot in.
 *
 * `?locale=` wins, because a bug report needs to be reproducible and "set your browser to
 * German" is not a reproduction step. Then a stored preference. Then the browser's own
 * languages, in the order it lists them — `navigator.languages` is already a ranked list of
 * what the person reads and there is no reason to ask them again.
 *
 * ⚠ AN UNKNOWN TAG IS NOT AN ERROR AND IS NOT A GUESS. `de-AT` does not silently become
 * `de-DE`: a locale this build does not ship is the default, because a half-matched
 * language is worse than an honest English — you get some of the game in a language you
 * chose and the rest in one you did not, with no way to tell which is which.
 */
export function chooseLocale(search = (typeof location !== 'undefined' ? location.search : ''),
  stored = null,
  languages = (typeof navigator !== 'undefined' ? navigator.languages : null)) {
  const asked = new URLSearchParams(search || '').get('locale');
  if (asked && LOCALES.includes(asked)) return asked;
  if (stored && LOCALES.includes(stored)) return stored;
  for (const l of languages || []) if (LOCALES.includes(l)) return l;
  return DEFAULT_LOCALE;
}

export let bootError = null;
try {
  let stored = null;
  try { stored = localStorage.getItem('cd.locale'); } catch { /* private mode, or no storage */ }
  await _load(chooseLocale(undefined, stored), '../../content/locales');
} catch (e) {
  bootError = e;
  /* eslint-disable-next-line no-console */
  console.error('[i18n] default locale failed to load; the UI will print keys.', e);
}
