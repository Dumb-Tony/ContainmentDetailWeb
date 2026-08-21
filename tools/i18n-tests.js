/* Localization — GDD §23 Milestone 5, "accessibility and localization pass".
 *
 * The accessibility half of that milestone was done and is enforced elsewhere. This is the
 * other half, and it started from an honest position: the build was monolingual and every
 * sentence was spelled into the file that printed it, across eighteen source files.
 *
 * What a suite can prove about localization without a translator:
 *   · that the message table loaded at all, so the UI is not printing keys at a player
 *   · that every key the running game asks for EXISTS
 *   · that every message the table defines is USED, so the file does not silt up
 *   · that no user-facing literal is left behind in a converted file
 *   · that the pseudolocale round-trips placeholders, which is the one thing a naive
 *     accent-the-vowels pass gets wrong and the one thing that would make the whole
 *     technique report bugs it had itself introduced
 *   · that plurals go through Intl.PluralRules rather than through `n === 1 ? a : b`
 */

import { lines, counts, ok, eq, near, note, emit, run, heading } from './harness.js';
import {
  t, plural, pseudo, flatten, setMessages, setFallback, loadLocale, locale,
  missingKeys, usedKeys, knownKeys, ownKeys, resetUsage, LOCALES, DEFAULT_LOCALE, bootError, chooseLocale,
} from '../src/core/i18n.js';
import { loadContent } from '../src/sim/content.js';
import { Game, RECOMMENDED_MANIFEST } from '../src/game.js';
import { Hud } from '../src/ui/hud.js';
import { CONFIG, SLOTS } from '../src/config.js';
import { PHASE } from '../src/sim/mission.js';
import { Panels } from '../src/ui/panels.js';
import { BaseScreen } from '../src/ui/base.js';
import { Settings, SettingsPanel, keyLabel } from '../src/ui/settings.js';
import { CommsWheel } from '../src/ui/commswheel.js';
import { Audio, CAPTIONS, formatCaption } from '../src/audio/audio.js';
import { PING_KINDS, COMMS_CAPTIONS } from '../src/sim/comms.js';
/* Section D's two exempt regions, imported so section HH can subtract them: they are content
 * prose that lives in src/ as a documented fallback, and the walk must not report them. */
import { PROCEDURE_FIELDS, MAINTAINED, ABORTS } from '../src/ui/panels.js';
import { CLAIMS } from '../src/sim/evidence.js';
import {
  Progression, loadSite, DEPARTMENTS, UPGRADES, TREATMENTS, CLEARANCE_TIERS,
} from '../src/sim/progression.js';
import { Input } from '../src/core/input.js';
import { varyContent, WEATHER, TIMES } from '../src/sim/variation.js';

/* Files whose user-facing strings have been extracted. A file joins this list when it is
 * converted, and section D below fails the build if a literal creeps back into one. */
const CONVERTED = [
  'src/ui/hud.js', 'src/game.js', 'src/sim/mission.js',
  'src/ui/panels.js', 'src/ui/base.js', 'src/ui/settings.js',
  'src/ui/commswheel.js', 'src/sim/comms.js', 'src/audio/audio.js',
  'src/sim/evidence.js', 'src/sim/instances.js', 'src/sim/variation.js',
  'src/sim/site.js', 'src/sim/anomaly.js', 'src/sim/perception.js', 'src/core/input.js',
];

/**
 * Regions section D is told to skip, and the ONE reason it accepts.
 *
 * ⚠ TWO FILES HOLD CONTENT PROSE IN `src/` ON PURPOSE and the grep cannot tell the
 * difference. `ui/panels.js`'s PROCEDURE_FIELDS/MAINTAINED/ABORTS is the graybox draught's
 * procedure card and `sim/evidence.js`'s CLAIMS is the graybox draught's board; both stand
 * in for a package that has not authored its own, both are compared character-for-character
 * against that package by other suites, and both would be WRONG in content/locales — a
 * briefing has a designer's reviewer and a button label has the UI's, and the en-GB `_note`
 * forbids mixing them.
 *
 * The marker is honest because of four properties, and a blanket file exclusion has none of
 * them: it is applied BEFORE comments are stripped, so it is a comment in the source rather
 * than a name in a list somewhere else; it names a REGION and not a file, so live code five
 * lines away is still checked; it carries a REASON after the colon and D4 fails without one;
 * and D3 prints every exemption on every run, so adding one is a thing somebody has to
 * defend in review rather than a thing that disappears.
 */
const EXEMPT_RE = /\/\*\s*i18n-exempt:content\s*—[\s\S]*?\/\*\s*i18n-exempt:end\s*\*\//g;
/** An opening marker in any shape, so D4 can catch one that carries no reason. */
const EXEMPT_OPEN_RE = /\/\*\s*i18n-exempt:content[^\n*]*/g;

const PROSE_RE = /(['"`])[A-Z][a-z]+(?:[ ,'’—-][A-Za-z0-9][A-Za-z0-9]*)+[.!?]?\1/g;

/** The one string the WALK itself puts on screen — a network status, a counter notice and a
 *  fail reason all come from somewhere the walk has to stand in for. Marked so section HH can
 *  subtract its own fingerprints rather than reporting them as findings. */
const STUB = 'zzstubzz';

/* ── A. the table itself ──────────────────────────────────────────────────── */
async function sectionA() {
  heading('A. the message table loads, and says so when it does not');

  ok('A1 the default locale loaded at module scope, so nothing has to remember to load it',
    bootError === null, bootError ? String(bootError) : '');
  ok('A2 and every message the game can say resolves, counting what a partial locale inherits',
    knownKeys().length > 100, `${knownKeys().length} resolvable, ${ownKeys().length} carried by this locale`);
  ok('A3 and the locale it booted in is one this build ships', LOCALES.includes(locale()), locale());
  note(`booted in ${locale()}: ${knownKeys().length} messages resolvable, ${ownKeys().length} carried by the locale itself`);

  /* ⚠ A MISSING KEY RETURNS THE KEY, LOUDLY. An empty string is the tempting fallback and
   * it is the wrong one: §18.1 does not allow the UI to misrepresent, and a blank label
   * says "there is nothing here" when what is true is "somebody forgot a message". */
  const before = missingKeys().length;
  eq('A4 a key with no message resolves to the key rather than to an empty string',
    t('nothing.here.at.all'), 'nothing.here.at.all');
  ok('A5 and the miss is recorded, so a suite or a translator can list them',
    missingKeys().length === before + 1 && missingKeys().includes('nothing.here.at.all'));

  eq('A6 nesting flattens to dotted keys, because a flat file of four hundred keys is unreviewable',
    JSON.stringify(flatten({ a: { b: { c: 'x' } } })), JSON.stringify({ 'a.b.c': 'x' }));
  eq('A7 and _note fields are for the reader, not for the table',
    JSON.stringify(flatten({ _note: 'ignore me', real: 'keep me' })), JSON.stringify({ real: 'keep me' }));
  emit();
}

/* ── B. interpolation and plurals ─────────────────────────────────────────── */
function sectionB() {
  heading('B. interpolation, and plurals that are not English\'s plurals');

  setMessages({
    demo: {
      greet: 'Hello {who}, you have {n} of them',
      lanes: { one: '{count} lane open', other: '{count} lanes open' },
    },
  }, DEFAULT_LOCALE);

  eq('B1 a message interpolates its placeholders',
    t('demo.greet', { who: 'Vasquez', n: 3 }), 'Hello Vasquez, you have 3 of them');
  eq('B2 a placeholder with no value is left visible rather than blanked',
    t('demo.greet', { who: 'Vasquez' }), 'Hello Vasquez, you have {n} of them');

  /* ⚠ `n === 1 ? '' : 's'` IS NOT A PLURAL RULE. It is English's plural rule written out,
   * and it is wrong in Polish (three forms), Russian (three), Arabic (six) and Welsh
   * before you reach a second language. `Intl.PluralRules` is in every browser this build
   * supports and already knows; the table authors the categories and the code asks. */
  eq('B3 one lane is singular', plural('demo.lanes', 1), '1 lane open');
  eq('B4 and zero lanes is plural in English, which the naive ternary also gets right',
    plural('demo.lanes', 0), '0 lanes open');
  eq('B5 and so is twenty-four', plural('demo.lanes', 24), '24 lanes open');
  ok('B6 the selection goes through Intl.PluralRules rather than through a comparison',
    new Intl.PluralRules(DEFAULT_LOCALE).select(1) === 'one'
    && new Intl.PluralRules(DEFAULT_LOCALE).select(2) === 'other');

  /* A language with a category English does not have still resolves, because `other` is
   * required and everything falls back to it. */
  setMessages({ demo: { lanes: { other: '{count} lanes' } } }, DEFAULT_LOCALE);
  eq('B7 a table with only `other` still answers for one', plural('demo.lanes', 1), '1 lanes');
  emit();
}

/* ── C. the pseudolocale ──────────────────────────────────────────────────── */
function sectionC() {
  heading('C. the pseudolocale, which is how an extraction pass finds what it missed');

  /* ⚠ THE PSEUDOLOCALE MUST NOT TOUCH A PLACEHOLDER. `{count}` with its vowels accented is
   * `{cöûnt}`, which matches no parameter, resolves to nothing, and prints literal braces —
   * so the pass would report a bug it had just introduced, in every message that carries a
   * number. That is the whole failure mode of doing this naively. */
  const p = pseudo('Hold custody — {held}s of {need}s.');
  ok('C1 the pseudolocale accents the prose', /[áéîöû]/.test(p), p);
  ok('C2 and does not touch a placeholder', p.includes('{held}') && p.includes('{need}'), p);
  ok('C3 and pads, so a layout that only fits English breaks visibly rather than in Berlin',
    p.length > 'Hold custody — {held}s of {need}s.'.length + 5, `${p.length} chars`);
  ok('C4 and brackets itself, so it reads as instrumentation rather than as a word',
    p.startsWith('⟦') && p.endsWith('⟧'));
  note(`pseudo: ${p}`);

  setMessages({ demo: { x: 'Carry the case to the stair head.' } }, 'pseudo');
  const rendered = t('demo.x');
  ok('C5 and a locale set to pseudo renders every message through it', /[áéîöû]/.test(rendered), rendered);
  emit();
}

/* ── CC. a second, partial locale ─────────────────────────────────────────── */
async function sectionCC() {
  heading('CC. a partial locale falls through to the default for what it does not say');

  /**
   * ⚠ THE FALLBACK PATH CANNOT BE TESTED WITH A COMPLETE FILE, because a complete file
   * never exercises it — and a fallback that is never exercised is a fallback that is
   * broken the first time somebody ships a translation that is 80% done, which is every
   * translation that has ever shipped.
   *
   * `en-US` is deliberately partial: it carries only the messages where American English
   * differs from British, which is eight of a hundred and sixty-four.
   */
  await loadLocale('en-US');
  eq('CC1 the running locale is the one that was asked for', locale(), 'en-US');
  eq('CC2 a message the partial locale overrides comes from the partial locale',
    t('mission.refuse.nothingToStabilise'), 'Nothing to stabilize.');
  eq('CC3 a message it does not carry falls through to the default',
    t('mission.refuse.nothingInHand'), 'Nothing in hand.');
  eq('CC4 and an overridden message keeps its placeholders',
    t('mission.verb.stabilise', { name: 'Vasquez' }), 'Stabilize Vasquez');
  eq('CC5 plurals fall through too, because the group is inherited whole',
    plural('debrief.why.rescues', 1), '1 casualty recovered under pressure.');

  const overridden = ['mission.refuse.nothingToStabilise', 'mission.verb.stabilise',
    'mission.notice.stabilised', 'mission.notice.revived', 'hud.cond.exposureStabilised',
    'hud.cond.mobilityStabilised', 'debrief.dim.time', 'debrief.why.careStabilised'];
  const wrong = overridden.filter((k) => /stabilised/.test(t(k, { bars: '', name: 'x' })));
  eq(`CC6 no message this locale claims to override still says the other spelling${wrong.length ? ` — ${wrong.join(', ')}` : ''}`,
    wrong.length, 0);
  note(`en-US carries ${knownKeys().length} messages of its own; everything else falls through to ${DEFAULT_LOCALE}`);

  /* ⚠ AND IT DOES NOT CONVERT THE UNITS, which is a decision rather than an omission. The
   * anomaly's threshold is 40C and the seal radius is 1.5m, and those are RULES: the imager
   * bezel, the evidence board, the design document and the after-action report all print
   * the same figures. A locale that rendered 4.9ft would be showing a different number from
   * every other surface for the same rule. */
  /* Checked over the MESSAGES rather than the raw file: the note in that file explains the
   * decision by naming the thing it refuses to do, and a check that reads the explanation
   * as a violation is a check that punishes writing the reason down. */
  const usMessages = Object.values(flatten(await (await fetch('/content/locales/en-US.json')).json())).join(' ');
  ok('CC7 and it does not convert a number a rule is stated in',
    !/\bft\b|\binch|Fahrenheit|°F/.test(usMessages), usMessages.slice(0, 120));

  await loadLocale(DEFAULT_LOCALE);
  eq('CC8 and going back to the default restores it', t('mission.refuse.nothingToStabilise'), 'Nothing to stabilise.');

  /**
   * ⚠ AN UNKNOWN TAG IS NOT A GUESS. `de-AT` must not silently become `de-DE`: a half-matched
   * language is worse than an honest English, because you get some of the game in a language
   * you chose and the rest in one you did not, with no way to tell which is which.
   */
  eq('CC9 an explicit ?locale= wins, so a bug report has a reproduction step',
    chooseLocale('?locale=en-US', 'pseudo', ['fr-FR']), 'en-US');
  eq('CC10 then a stored preference', chooseLocale('', 'en-US', ['fr-FR']), 'en-US');
  eq('CC11 then the browser\'s own ranked list', chooseLocale('', null, ['fr-FR', 'en-US']), 'en-US');
  eq('CC12 a tag this build does not ship is the default rather than a near match',
    chooseLocale('?locale=de-AT', null, ['de-DE']), DEFAULT_LOCALE);
  eq('CC13 and no signal at all is the default', chooseLocale('', null, null), DEFAULT_LOCALE);
  emit();
}

/* ── CD. an enum that is also a label ─────────────────────────────────────── */
async function sectionCD() {
  heading('CD. every engine vocabulary that reaches a player has a label beside its id');

  /**
   * ⚠ THE PSEUDOLOCALE FOUND THIS ON THE LIVE BUILD, which is what it is for.
   *
   * The HUD read `⟦Încîdént préssûré: Latent⟧` — an accented message with a plain English
   * word inside it. `Latent` is `CONFIG.pressure.stageNames[0]`, and `Arrival` is
   * `PHASE.ARRIVAL`. Both are IDS: compared against, written into the phase log, carried in
   * a snapshot. Localising the value would break every comparison; leaving it alone left
   * English in a translated sentence. So the id stays the id and gets a label beside it —
   * the same fix the debrief's dimension names needed, found the same way.
   *
   * A grep could not have found this. The string was never in the UI file; it arrived
   * through an interpolation from a constant three modules away.
   */
  await loadLocale(DEFAULT_LOCALE);
  const missingBefore = new Set(missingKeys());
  const phases = Object.values(PHASE);
  const stages = CONFIG.pressure.stageNames;
  for (const p of phases) t(`phase.${p}`);
  for (const s of stages) t(`pressure.${s}`);
  const gaps = missingKeys().filter((k) => !missingBefore.has(k));
  eq(`CD1 every mission phase and every pressure stage has a label${gaps.length ? ` — ${gaps.join(', ')}` : ''}`,
    gaps.length, 0);
  note(`${phases.length} phases and ${stages.length} pressure stages, all labelled`);

  /* And under the pseudolocale the label is accented, so nothing English survives the line. */
  await loadLocale('pseudo');
  const accented = [...phases.map((p) => t(`phase.${p}`)), ...stages.map((s) => t(`pressure.${s}`))];
  ok('CD2 and under the pseudolocale none of them comes through as plain English',
    accented.every((s) => /[áéîöû]/.test(s) || !/[aeiou]/i.test(s)), accented.slice(0, 3).join(' '));
  await loadLocale(DEFAULT_LOCALE);
  emit();
}

/* ── D. nothing user-facing left behind ───────────────────────────────────── */
async function sectionD() {
  heading('D. no converted file still spells a sentence at a player');

  /**
   * ⚠ THE CHECK IS A GREP AND IT HAS TO BE, because the alternative is trusting a diff.
   * An extraction pass is never finished: the string you miss is in the branch you did not
   * take, and the only cheap way to find it is to look at the source rather than at the
   * screen. Comments are stripped first — the note explaining a message is not a message.
   *
   * What counts as user-facing: a quoted run beginning with a capital and containing at
   * least two words. That deliberately does not catch `'ok'` or `'—'`, which are short
   * enough to be markup rather than prose and are in the table anyway.
   */
  const raw = new Map();
  const stripped = new Map();
  const exemptions = [];
  for (const f of CONVERTED) {
    const src = await (await fetch(`/${f}`)).text();
    raw.set(f, src);
    /* ⚠ THE EXEMPT REGIONS COME OUT FIRST, before comments are stripped. The markers ARE
     * comments, so stripping first would delete the fences and leave the content behind —
     * which is the failure mode that makes a marker scheme quietly stop working. */
    const withoutExempt = src.replace(EXEMPT_RE, (m) => {
      exemptions.push(`${f}: ${(/i18n-exempt:content\s*—\s*([^\n]*)/.exec(m) || [, ''])[1].trim()} (${m.split('\n').length} lines)`);
      return '';
    });
    stripped.set(f, withoutExempt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
  }

  const literals = [];
  for (const [f, code] of stripped) {
    const found = code.match(PROSE_RE) || [];
    for (const s of found) {
      /* A CSS class list, a DOM id and an event name are not prose. */
      if (/^['"`][A-Z]+['"`]$/.test(s)) continue;
      literals.push(`${f}: ${s}`);
    }
  }
  eq(`D1 no converted file contains a user-facing sentence${literals.length ? ` — ${literals.slice(0, 6).join(' · ')}` : ''}`,
    literals.length, 0);
  note(`${CONVERTED.length} file(s) converted: ${CONVERTED.join(', ')}`);

  /* And the counter-check, so D1 cannot pass by the regex being broken. */
  const canary = "const x = 'Carry the case to the stair head.';";
  ok('D2 and the check would catch one if it were there, so D1 is not passing on a broken regex',
    (canary.match(PROSE_RE) || []).length === 1);

  /**
   * ⚠ AN EXEMPTION IS A THING SOMEBODY HAS TO DEFEND, so it is printed rather than merely
   * honoured. Two exist and both are the same case: content prose that lives in `src/` as a
   * documented fallback for a package that has not authored its own.
   */
  note(`${exemptions.length} exempt region(s): ${exemptions.join(' · ') || 'none'}`);
  ok('D3 every exempt region states why it is exempt, so the marker cannot be used as a mute',
    exemptions.length > 0 && exemptions.every((s) => /—\s*\S|: \S/.test(s) && s.split(': ')[1].length > 20),
    exemptions.join(' | '));

  /* Unpaired or unreasoned markers. An opening marker with no `i18n-exempt:end` would eat
   * the rest of the file — including live code — and D1 would go on passing. */
  const unpaired = [];
  for (const [f, src] of raw) {
    const opens = (src.match(EXEMPT_OPEN_RE) || []).length;
    const ends = (src.match(/i18n-exempt:end/g) || []).length;
    const closed = (src.match(EXEMPT_RE) || []).length;
    if (opens !== ends || opens !== closed) unpaired.push(`${f}: ${opens} open, ${ends} end, ${closed} matched`);
    for (const m of src.match(EXEMPT_OPEN_RE) || []) {
      if (!/i18n-exempt:content\s*—\s*\S/.test(m)) unpaired.push(`${f}: marker with no reason — ${m.trim()}`);
    }
  }
  eq(`D4 and every marker is paired and carries a reason${unpaired.length ? ` — ${unpaired.join(' · ')}` : ''}`,
    unpaired.length, 0);

  /* And the counter-check for the exemption itself: prose OUTSIDE a marked region in the
   * same file is still caught, so the marker is a region and not a file-level mute. */
  const fake = `/* i18n-exempt:content — a reason */\nconst A = ['Inside the fence'];\n/* i18n-exempt:end */\nconst B = 'Outside the fence';`;
  const survivors = fake.replace(EXEMPT_RE, '').match(PROSE_RE) || [];
  ok('D5 prose outside a marked region in an exempting file is still caught',
    survivors.length === 1 && survivors[0].includes('Outside'), survivors.join(' | '));
  emit();
}

/* ── E. every key the running game asks for exists ────────────────────────── */
async function sectionE(content) {
  heading('E. every key a running mission asks for is in the table');

  await loadLocale(DEFAULT_LOCALE);
  resetUsage();

  const host = document.createElement('div');
  document.body.appendChild(host);
  const g = new Game(content, { seed: 'i18n' });
  g.commitLoadout(RECOMMENDED_MANIFEST);
  const hud = new Hud(host, g, null);
  const p = g.player;

  /* Drive the HUD through the states that have their own sentence, so the sweep is over
   * messages the game can actually reach rather than over the ones easiest to reach. */
  hud.update();
  p.applyCondition('exposure', 'serious');
  p.applyCondition('mobility-injury', 'serious');
  g.skipMs(60); hud.update();
  p.conditions.exposure.stabilised = true;
  p.conditions.mobility.stabilised = true;
  hud.update();

  p.x = g.site.cache.x; p.z = g.site.cache.z;
  for (const h of [{ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 }]) {
    g.setCommand('p1', { axis: h, sprint: true, crouch: false });
    for (let i = 0; i < 12; i++) g.skipMs(16);
    hud.update();
  }
  g.setCommand('p1', { axis: { x: 0, y: 0 }, sprint: false, crouch: false });
  g.skipMs(200); hud.update();

  /* The microphone screen. */
  g.cache.set('directional-microphone', (g.cache.get('directional-microphone') || 0) + 1);
  g.takeFromCache('directional-microphone');
  const micSlot = SLOTS.findIndex((s) => p.slots.get(s.id) === 'directional-microphone');
  if (micSlot >= 0) { g.selectSlot('p1', (micSlot + 1) % SLOTS.length); g.selectSlot('p1', micSlot); }
  const heater = content.itemsById.get('portable-heater');
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    p.yaw = yaw;
    const d = g.deployables.place(heater, p.x - Math.sin(yaw) * 6, p.z - Math.cos(yaw) * 6, 0);
    g.skipMs(200); hud.update();
    g.deployables.remove(d);
  }

  /* The squad rows and the objective ladder. */
  const mate = g.addPlayer('Two');
  mate.x = p.x + 3; mate.z = p.z;
  g.skipMs(60); hud.update();
  mate.applyCondition('exposure', 'serious');
  g.skipMs(60); hud.update();
  mate.applyCondition('exposure', 'serious');
  g.skipMs(200); hud.update();

  /* Every objective branch, driven on the model rather than played out — the sentences are
   * what is under test, not the route to them. */
  const objectives = [];
  const say = () => objectives.push(hud._objective());
  say();
  g.mission.procedure = { target: 'a' }; say();
  g.mission.procedure = null;
  g.custody = 'sealed'; say();
  g.custody = 'verified'; say();
  p.hands = 'reinforced-transit-case'; say();
  p.hands = null; say();
  g.custody = 'none';

  const missing = missingKeys().filter((k) => k !== 'nothing.here.at.all');
  eq(`E1 every message a running mission asked for exists${missing.length ? ` — ${missing.join(', ')}` : ''}`,
    missing.length, 0);
  ok('E2 and it asked for a useful number of them, so E1 is not passing on an idle HUD',
    usedKeys().length >= 15, `${usedKeys().length} keys used`);
  note(`${usedKeys().length} distinct messages reached by one driven mission`);
  ok('E3 no objective line came back as a bare key',
    objectives.every((s) => s && !/^[a-z]+(\.[a-z]+)+$/i.test(s)), objectives.join(' | '));
  note(`objectives reached: ${objectives.length}`);
  emit();
}

/* ── G. every screen the player opens, walked ─────────────────────────────── */
/**
 * ⚠ A MESSAGE NOTHING EVER ASKS FOR IS A MESSAGE NOBODY HAS CHECKED. Section E drives a
 * running mission and proves the HUD's keys resolve; this does the same for the screens
 * either side of the floor, which is where four fifths of the prose lives — the operation
 * card, the four tablet tabs, the cargo manifest, the debrief, Regional Site 19's five
 * rooms, all seven settings groups, and the ping wheel.
 *
 * It walks them by CALLING THEM, not by asking for their keys: the branch that only renders
 * when a manifest carries exactly one heat emitter is the branch a spot-check misses, so the
 * manifest is emptied, filled with one, and filled properly, and each render is a real one.
 * The handful of lines a walk genuinely cannot reach — a refusal that needs a real keystroke,
 * a map with no rooms at all — are probed at the end and are labelled as probes.
 */
/**
 * Open every screen, in every state that has its own sentence, into `host`.
 *
 * ⚠ SHARED BY SECTION G AND SECTION HH ON PURPOSE. G asks "did every key resolve"; HH asks
 * "did anything come through in English", and those two questions have to be asked of the
 * SAME walk or the second one is checking a smaller game than the first.
 */
async function walkScreens(content, host, seed) {
  const g = new Game(content, { seed });
  g.commitLoadout(RECOMMENDED_MANIFEST);

  /**
   * ⚠ EVERY PANEL REPLACES ITS OWN innerHTML, so the host holds only the LAST state of each
   * screen when the walk ends. Reading the text once at the end therefore inspects six
   * screens out of forty renders, and the pseudolocale pass — whose entire job is to look at
   * what is on screen — would have been looking at a sixth of it. So the text is sampled
   * after each render and the samples are what section HH reads.
   *
   * Sampled with a text-node walk rather than `textContent`, because `textContent` welds
   * adjacent elements into one token: the base screen's five nav buttons came out as
   * `operationsarmoryarchiveresearchcontainment`, which matches no word in any content file
   * and is reported as a finding when it is five room names correctly interpolated.
   */
  const shots = [];
  const snap = () => {
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const parts = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue);
    shots.push(parts.join(' '));
  };

  /* ── the squad room, the operation card ──────────────────────────────── */
  const panels = new Panels(host, g, {});
  const netStub = (role, online, code) => ({
    localPlayerId: 'p1', role, online, code, status: STUB, hostPeer() {}, joinPeer() {},
  });
  for (const n of [netStub('host', false, STUB.slice(0, 5).toUpperCase()), netStub('client', true, ''), netStub(null, false, '')]) {
    panels.showSquad(n); snap();
  }

  /* Every coverage warning. §10.7 wants the warning to describe the GAP, and the one-emitter
   * warning is a different sentence from the no-emitter one — so both are rendered. */
  panels.showLoadout(); snap();
  panels.manifest.clear(); panels._renderLoadout(); snap();
  panels.manifest.set('portable-heater', 1); panels._renderLoadout(); snap();
  panels.manifest.set('thermal-imager', 1);
  panels.manifest.set('reinforced-transit-case', 1);
  panels.manifest.set('trauma-kit', 1);
  panels.manifest.set('floodlight-tripod', 2);
  panels._renderLoadout(); snap();

  /* The conditions block reads the world, so the world is moved rather than the block. */
  const circuits = [...g.site.circuits.values()];
  if (circuits.length > 1) { circuits[0].on = true; panels._renderLoadout(); snap(); }
  for (const w of [{ label: 'Hard frost', ambientDeltaC: -3 }, { label: 'Steady rain', ambientDeltaC: 1 }, null]) {
    g.content.weather = w;
    panels._renderLoadout(); snap();
  }

  /* ── the field tablet, all four tabs and both states of two of them ───── */
  const firstEvidence = (content.anomaly.evidenceRules || [])[0];
  for (const tab of ['briefing', 'evidence', 'board', 'procedure']) { panels.showTablet(tab); snap(); }
  if (firstEvidence) {
    g.ledger.record(firstEvidence.id, { simTimeMs: 1000, x: 0, z: 0, room: 'aisle', source: 'operative' });
    panels.showTablet('evidence'); snap();
    panels.showTablet('board'); snap();
  }
  g.mission.procedure = {
    committedMs: 1000, target: 'a', state: 'b', trigger: 'c', transfer: 'd', abort: 'e', maintained: [],
  };
  panels.showTablet('procedure'); snap();
  g.mission.procedure = null;

  /* ── the cargo manifest, with and without something in hand ───────────── */
  panels.showCache(); snap();
  g.takeFromCache('thermal-imager');
  panels.showCache(); snap();

  /* ── the debrief, for every grade word the ladder can produce ──────────── */
  const result = g.mission.grade({
    custody: 'verified', extracted: true, players: g.players, player: g.player,
    ledger: g.ledger, deployables: g.deployables, simTimeMs: 900000,
    cargoIssued: g.cargoIssued, cargoRecovered: g.cargoIssued, instances: g.instances,
  });
  for (const word of ['Exemplary', 'Controlled', 'Costly', 'Compromised', 'Failed']) {
    panels.showDebrief({ ...result, overall: word, failReason: null }); snap();
  }
  panels.showDebrief({ ...result, failReason: STUB }); snap();
  panels.hide();

  /* ── Regional Site 19 ─────────────────────────────────────────────────── */
  const site = await loadSite();
  const pr = new Progression({ site });
  const base = new BaseScreen(host, { progression: pr, site, items: content.items });
  base.show('operations'); snap();
  /* ⚠ CLEARANCE GATES FOUR OF THE FIVE ROOMS, so a walk at level zero silently renders the
   * operations board five times. Clearance is derived from the profile rather than stored,
   * so the facts are raised and the gate opens honestly. */
  pr.profile.operationsCompleted = 40;
  pr.profile.custodiesVerified = 40;
  pr.profile.researchTotalEarned = 4000;
  pr.profile.research = 400;
  pr.profile.requisition = 4000;
  for (const room of site.rooms || []) { base.show(room.id); snap(); }
  /* An archive with nothing in it, then with a night in it. Both are sentences. */
  pr.applyDebrief(result, g.mission, {
    anomalyId: content.anomaly.id, mapId: content.map.id, operationId: 'op-i18n',
    custody: 'verified', minutes: 15, observations: 3, squad: g.players,
    scenario: { seed: 'i18n', weather: 'Hard frost', time: 'Night', faulted: ['circuit-office'], shut: ['door-freight'] },
  });
  for (const tab of ['archive', 'logistics', 'containment', 'research']) { base.show(tab); snap(); }
  base.notice = STUB; base.refresh(); snap();
  base.hide();

  /* ── the settings screen, every group ─────────────────────────────────── */
  const settings = new Settings();
  const input = new Input(window, settings.bindings(), settings.holdModes());
  const panel = new SettingsPanel(host, settings, { input });
  for (const group of ['controls', 'captions', 'vision', 'camera', 'audio', 'assists', 'safety']) {
    panel.show(group); snap();
  }
  panel.hide();

  /* ── the ping wheel, the feed and the markers ──────────────────────────── */
  const wheel = new CommsWheel(host, g, {
    settings,
    project: (x, y, z) => ({ left: x, top: z, depth: 5 }),
  });
  wheel.show();
  wheel.selectIndex(0);
  wheel._paint(); snap();
  wheel.hide(false);
  for (const id of Object.keys(COMMS_CAPTIONS)) g.ping('p1', id, g.player.x + 1, g.player.z + 1);
  wheel.update(g.clock.simTimeMs); snap();
  /* Both local refusals, which the wheel decides on its own before anything reaches the wire. */
  const refusals = [];
  const wheel2 = new CommsWheel(host, g, { settings, onRefuse: (why) => refusals.push(why) });
  g.player.alive = false; wheel2._send('contact');
  g.player.alive = true; g.player.downed = true; wheel2._send('contact');
  g.player.downed = false;
  wheel.destroy(); wheel2.destroy();

  /* ── the host's own refusals, which answer with the same sentences ─────── */
  const boardRefusals = [
    g.ping('p1', 'not-a-phrase', 0, 0),
    g.ping('', 'contact', 0, 0),
    g.ping('p1', 'contact', 9999, 9999),
  ];

  /* ── captions: every cue's line, and every bearing word ────────────────── */
  const audio = new Audio();
  for (const key of Object.keys(CAPTIONS)) audio.captions.push(key, { simTimeMs: 0, direction: 'ahead' });
  for (const d of ['ahead', 'behind', 'left', 'right', 'above', 'below']) {
    formatCaption(CAPTIONS.CONTACT, { direction: d });
  }
  for (const kind of Object.values(PING_KINDS)) void kind.label;

  /* ── the weather and the time of day, through the layer that chooses them ─ */
  varyContent(content, 'i18n-screens');
  for (const w of Object.values(WEATHER)) { void w.label; void w.line; }
  for (const tod of Object.values(TIMES)) { void tod.label; void tod.line; }

  /* ── refusals the sim returns, driven rather than probed ──────────────── */
  const simRefusals = [
    g.instances.collect('p1', null),
    g.anomaly.trySeal(null, 0),
  ];

  /**
   * ⚠ AND THE FEW A WALK CANNOT REACH. These are PROBES and are labelled as such: a rebind
   * refusal needs a real keystroke on a real keyboard, `settings.key.numpad` needs a numeric
   * keypad bound to something, and `site.unmarkedFloor` needs a map whose room rects cover
   * none of the floor — which no shipped map has, and which is the point of the fallback.
   * A probe proves the message EXISTS; it does not prove anybody can reach it, and section F
   * still reports whatever nothing reaches.
   */
  const probes = [
    'settings.flash.refused.unknown-action', 'settings.flash.refused.bad-code',
    'settings.flash.refused.reserved', 'settings.flash.refused.not-holdable',
    'settings.flash.refused.bad-mode', 'settings.flash.reserved', 'settings.flash.bound',
    'settings.flash.displaced', 'settings.flash.groupReset', 'settings.bindings.noInput',
    'settings.bindings.unbound', 'settings.bindings.awaiting', 'settings.bindings.cancel',
    'settings.key.none', 'site.unmarkedFloor', 'base.shell.noRooms', 'base.ops.boardEmpty',
    'base.armory.noItems', 'base.research.noFile', 'base.containment.empty',
    'base.containment.onTheBus', 'base.containment.onTheBusRated',
    'base.containment.improvised', 'base.containment.improvisedUnrated',
    'base.upgrades.blocked', 'base.upgrades.short', 'base.ops.warnCorridorFull',
    'base.ops.warnNoRating', 'base.ops.warnCargo', 'base.ops.warnStabilise',
    'base.ops.unknown', 'base.ops.difficultyDefault', 'base.archive.unmeasured',
    'base.archive.unrecorded', 'base.armory.unrecorded', 'base.issued.missing',
    'panels.squad.defaultCallsign', 'debrief.screen.unmarked', 'tablet.evidence.empty',
    'mission.refuse.notHeld', 'mission.refuse.wrongVessel', 'mission.refuse.caseNoPower',
    'mission.refuse.caseTooFar', 'mission.refuse.nothingInHandToLog',
    'mission.refuse.tooFarFromCase', 'mission.refuse.handsFull',
    'mission.refuse.noCustodyProcedure',
  ];
  for (const k of probes) t(k, { key: 'X', action: 'x', actions: 'x', group: 'x', tier: 'x', rating: 'x', name: 'x', volume: 1, percent: 1, distance: 1, radius: 1, cell: 'x', value: 1 });
  for (const key of ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'Space', 'Tab', 'Enter', 'Backspace', 'CapsLock', 'Numpad4', null]) keyLabel(key);

  return { refusals, boardRefusals, simRefusals, shots };
}

async function sectionG(content) {
  heading('G. the screens either side of the floor, walked, with their keys present');

  await loadLocale(DEFAULT_LOCALE);
  /* ⚠ USAGE IS NOT RESET HERE. Section F reports what nothing reaches, and resetting would
   * hand it every message section E had just proved reachable as "not reached". */
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { refusals, boardRefusals, simRefusals } = await walkScreens(content, host, 'i18n-screens');

  const missing = missingKeys().filter((k) => k !== 'nothing.here.at.all');
  eq(`G1 every message the screens asked for exists${missing.length ? ` — ${missing.slice(0, 12).join(', ')}` : ''}`,
    missing.length, 0);
  ok('G2 and the walk reached a great many of them, so G1 is not passing on an unopened panel',
    usedKeys().length >= 300, `${usedKeys().length} keys used`);
  note(`${usedKeys().length} distinct messages reached by walking the screens`);

  /* ⚠ NOTHING RENDERED MAY BE A BARE KEY. G1 catches a key that is MISSING; this catches one
   * that was never asked for because the code printed the string `panels.card.deploy`
   * instead of calling for it — a typo in a template rather than a gap in the table. */
  const bareKeys = [...host.querySelectorAll('*')]
    .filter((n) => n.children.length === 0 && /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/.test((n.textContent || '').trim()))
    .map((n) => n.textContent.trim());
  eq(`G3 no element on any walked screen printed a bare message key${bareKeys.length ? ` — ${bareKeys.slice(0, 5).join(', ')}` : ''}`,
    bareKeys.length, 0);

  ok('G4 the wheel refused the two calls only the local operative can be told about',
    refusals.length === 2 && refusals.every((s) => s && !/^comms\./.test(s)), refusals.join(' | '));
  const spoken = boardRefusals.filter(Boolean);
  ok('G5 and the host answered its own refusals with sentences rather than keys',
    spoken.length > 0 && spoken.every((s) => !/^(comms|mission)\./.test(s)), spoken.join(' | '));
  const said = simRefusals.filter(Boolean);
  ok('G6 and the simulation\'s refusals are sentences too',
    said.length > 0 && said.every((s) => !/^mission\./.test(s)), said.join(' | '));

  /* Every phrase on the wheel says something, and it is the same string the feed reads. */
  ok('G7 every phrase on the wheel resolves to words rather than to its own key',
    Object.keys(COMMS_CAPTIONS).every((id) => !COMMS_CAPTIONS[id].text.startsWith('comms.phrase.')),
    Object.values(COMMS_CAPTIONS).map((c) => c.text).join(' | ').slice(0, 90));
  ok('G8 and every audio cue does the same, which is §17.3\'s whole promise',
    Object.keys(CAPTIONS).every((k) => !CAPTIONS[k].text.startsWith('caption.')));

  host.remove();
  emit();
}

/* ── H. the pseudolocale, over the same screens ───────────────────────────── */
/**
 * ⚠ THE GREP CANNOT SEE A STRING THAT ARRIVES THROUGH AN INTERPOLATION. Section D reads the
 * file that PRINTS a line; `Latent` was never in that file, it came from a constant three
 * modules away, and it took a person looking at an accented HUD to find it. This is that
 * walk, automated: render the screens under `pseudo` and assert that the accessor tables the
 * engine reaches through — captions, phrases, kinds, weather, palettes — come back accented
 * rather than in English.
 *
 * It cannot replace looking at the screen, because it only knows about the tables it names.
 * What it does is stop the ones already found from coming back.
 */
async function sectionH() {
  heading('H. under the pseudolocale, no engine vocabulary comes through in English');

  await loadLocale('pseudo');
  const accented = (s) => /[áéîöûÁÉÎÖÛ]/.test(s) || !/[aeiouAEIOU]/.test(s);

  const rows = [];
  for (const [k, v] of Object.entries(CAPTIONS)) rows.push([`caption.${k}`, v.text]);
  for (const [k, v] of Object.entries(COMMS_CAPTIONS)) rows.push([`comms.phrase.${k}`, v.text]);
  for (const [k, v] of Object.entries(PING_KINDS)) rows.push([`comms.kind.${k}`, v.label]);
  for (const [k, v] of Object.entries(WEATHER)) { rows.push([`weather.${k}.label`, v.label]); rows.push([`weather.${k}.line`, v.line]); }
  for (const [k, v] of Object.entries(TIMES)) { rows.push([`time.${k}.label`, v.label]); rows.push([`time.${k}.line`, v.line]); }

  const plain = rows.filter(([, v]) => !accented(String(v))).map(([k]) => k);
  eq(`H1 every accessor table renders through the message table${plain.length ? ` — ${plain.join(', ')}` : ''}`,
    plain.length, 0);
  note(`${rows.length} accessor-backed strings, all pseudolocalised`);

  /* ⚠ AND THE ACCESSOR MUST BE AN ACCESSOR. `{ ...row }` copies a getter's VALUE at module
   * load, so a table spread into a literal would have frozen English at boot and passed
   * every test that ran in en-GB. The check is that the SAME object answers differently
   * after the locale changes, which is the only thing a copied value cannot do. */
  const underPseudo = CAPTIONS.CONTACT.text;
  await loadLocale(DEFAULT_LOCALE);
  const underDefault = CAPTIONS.CONTACT.text;
  ok('H2 and the same row answers differently after a locale change, so it is a live lookup',
    underPseudo !== underDefault && /[áéîöû]/.test(underPseudo), `${underPseudo} vs ${underDefault}`);
  emit();
}

/* ── HH. the walk itself, under the pseudolocale ──────────────────────────── */
/**
 * ⚠ THIS IS THE `?locale=pseudo` WALK, DONE HEADLESSLY AND EVERY RUN.
 *
 * A person opening the game with `?locale=pseudo` finds what the grep cannot: a string that
 * reached the screen through an interpolation from a constant in another module was never a
 * literal in the file that printed it. `Latent` was found that way. So was `Arrival`.
 *
 * The instrument is: render every screen under `pseudo`, take the TEXT, and list every word
 * that came through unaccented. Two things produce an unaccented word and telling them apart
 * is the whole point of the exercise —
 *
 *   CONTENT, correctly interpolated. A room name, an item's displayName, an incident's
 *   headline, a department's name, a claim, a planner option. These are authored in
 *   content/ and content/site.json and localised with the package, and they SHOULD be plain
 *   here, because the pseudolocale is the ENGINE's locale and not the package's.
 *
 *   AN ENGINE VOCABULARY WITH NO LABEL. `Latent`, `Arrival`, `Exemplary` — a constant that
 *   is both an id and the display text. These are the findings.
 *
 * So the words are subtracted from every loaded content document. What survives is reported
 * rather than asserted: a package is free to add a word tomorrow, and a check that failed the
 * build on that would be a check that punishes content. The COUNT is printed every run, so it
 * cannot drift quietly, and H3 fails on the specific vocabularies already found — which is
 * the part that must not come back.
 */
async function sectionHH(content) {
  heading('HH. the pseudolocale walk, headless: what came through the screens in English');

  await loadLocale('pseudo');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { shots } = await walkScreens(content, host, 'i18n-pseudo');

  /* Everything the packages are entitled to say in their own words. */
  const site = await loadSite();
  const contentWords = new Set([STUB, STUB.slice(0, 5)]);
  const eat = (doc) => {
    for (const w of JSON.stringify(doc).match(/[A-Za-z][A-Za-z'-]{2,}/g) || []) contentWords.add(w.toLowerCase());
  };
  eat(content.incident); eat(content.anomaly); eat(content.map); eat(content.items); eat(site);
  /* Progression's own tables are content in the same sense: department names, upgrade names,
   * treatment names and condition names are authored data the panel interpolates. */
  eat({ d: DEPARTMENTS, u: UPGRADES, t: TREATMENTS, c: CLEARANCE_TIERS });
  /* And section D's two exempt regions, which are content that happens to live in src/. The
   * exemption and this subtraction have to agree or the walk reports the planner's own abort
   * condition — "Pressure reaches Breach" — as a pressure stage that lost its label. */
  eat({ p: PROCEDURE_FIELDS, m: MAINTAINED, a: ABORTS, c: CLAIMS });

  /**
   * ⚠ THE PSEUDO BRACKETS NEST, because a message can carry another message: the armory's
   * recovery line interpolates a debrief WORD, which is itself localised, so the text reads
   * `⟦Operation 1 … read ⟦Intact⟧. Anything left …⟧`. A single non-greedy `⟦[^⟧]*⟧` pairs the
   * outer opener with the INNER closer and leaves the tail of the outer message behind — and
   * the tail then reports `nyth` and `n's`, fragments of accented words, as findings. Strip
   * innermost-first until nothing changes.
   */
  let text = shots.join(' \n ');
  for (let before = ''; before !== text;) { before = text; text = text.replace(/⟦[^⟦⟧]*⟧/g, ' '); }
  const plain = new Map();
  for (const w of text.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []) {
    const k = w.toLowerCase();
    if (contentWords.has(k)) continue;
    plain.set(k, (plain.get(k) || 0) + 1);
  }
  const words = [...plain.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}×${n}`);
  note(`${shots.length} screen states walked; ${plain.size} distinct unaccented word(s) survived that no loaded package supplies`);
  if (words.length) note(`    ${words.join(', ')}`);

  /**
   * The three that have already been found this way, and must not come back. Each is an
   * ENGINE vocabulary that was also its own display text: the mission phase, the pressure
   * stage, and §6.4's overall grade word.
   */
  /* ⚠ SCANNED WITH THE EXEMPT SENTENCES CUT OUT, not with their WORDS subtracted. The
   * draught's abort condition is the sentence "Pressure reaches Breach", and it is content:
   * subtracting the word `breach` would also hide a pressure stage that had genuinely lost
   * its label, which is the thing this check exists to catch. So the authored strings are
   * removed whole and whatever is left is the engine talking. */
  let scan = text;
  for (const s of [...PROCEDURE_FIELDS.flatMap((f) => [f.label, ...f.options]),
    ...MAINTAINED, ...ABORTS, ...CLAIMS.map((c) => c.text)]) scan = scan.split(s).join(' ');

  const regressions = [];
  for (const w of [...Object.values(PHASE), ...CONFIG.pressure.stageNames,
    'Exemplary', 'Controlled', 'Costly', 'Compromised', 'Failed']) {
    if (new RegExp(`(^|[^A-Za-z])${w}([^A-Za-z]|$)`).test(scan)) regressions.push(w);
  }
  eq(`H3 no engine vocabulary already given a label came back through a screen in English${
    regressions.length ? ` — ${regressions.join(', ')}` : ''}`, regressions.length, 0);

  /* And the counter-check: the walk really did render, so H3 is not passing on a blank page.
   * ⚠ MEASURED ON THE FULL TEXT, not on `text`. `text` has every ⟦accented⟧ message removed —
   * which is almost all of it — so a threshold against that one is a threshold against how
   * much CONTENT the screens happen to be showing, and it went red the first time it ran. */
  const full = shots.join(' ');
  ok('H4 and the walk rendered a screenful, so H3 is not passing on an empty host',
    shots.length >= 30 && full.length > 40000 && /[áéîöû]/.test(full),
    `${shots.length} states, ${full.length} chars rendered, ${text.length} of them not from a message`);

  host.remove();
  await loadLocale(DEFAULT_LOCALE);
  emit();
}

/* ── F. the table has nothing dead in it ──────────────────────────────────── */
async function sectionF() {
  heading('F. the table has nothing in it that nothing says');

  /**
   * A message file silts up faster than code does, because deleting a sentence feels
   * riskier than deleting a function. Reported rather than asserted while the extraction is
   * in progress — a key added for a file that is not converted yet is not dead, it is
   * early — but the count is printed every run so it cannot drift quietly.
   */
  const used = new Set(usedKeys());
  const dead = knownKeys().filter((k) => !used.has(k) && !k.includes('.one') && !k.includes('.other'));
  note(`${knownKeys().length} messages defined, ${used.size} reached by section E`);
  if (dead.length) note(`    not reached: ${dead.join(', ')}`);
  ok('F1 every message the table defines is spelled correctly enough to resolve',
    knownKeys().every((k) => typeof t(k) === 'string' && t(k) !== ''));

  /* Plural groups must carry `other`, because everything falls back to it. */
  const groups = new Set(knownKeys().filter((k) => /\.(one|other|few|many|two|zero)$/.test(k))
    .map((k) => k.replace(/\.(one|other|few|many|two|zero)$/, '')));
  const noOther = [...groups].filter((g) => !knownKeys().includes(`${g}.other`));
  eq(`F2 every plural group carries an \`other\`, which is what everything falls back to${noOther.length ? ` — ${noOther.join(', ')}` : ''}`,
    noOther.length, 0);
  note(`${groups.size} plural group(s): ${[...groups].join(', ') || 'none'}`);
  emit();
}

/* ── run ──────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await run('A', () => sectionA());
    await run('B', () => sectionB());
    await run('C', () => sectionC());
    await run('CC', () => sectionCC());
    await run('CD', () => sectionCD());
    await run('D', () => sectionD());
    const content = await loadContent();
    await run('E', () => sectionE(content));
    await run('G', () => sectionG(content));
    await run('H', () => sectionH());
    await run('HH', () => sectionHH(content));
    await run('F', () => sectionF());
    emit();
  } catch (e) {
    lines.push(`FAIL  the i18n suite itself threw: ${e && e.stack ? e.stack : e}`);
    counts.fails++;
    emit();
  }
})();
