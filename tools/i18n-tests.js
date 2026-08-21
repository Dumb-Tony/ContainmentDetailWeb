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

/* Files whose user-facing strings have been extracted. A file joins this list when it is
 * converted, and section D below fails the build if a literal creeps back into one. */
const CONVERTED = ['src/ui/hud.js', 'src/game.js', 'src/sim/mission.js'];

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
  const stripped = new Map();
  for (const f of CONVERTED) {
    const src = await (await fetch(`/${f}`)).text();
    stripped.set(f, src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
  }

  const literals = [];
  for (const [f, code] of stripped) {
    const found = code.match(/(['"`])[A-Z][a-z]+(?:[ ,'’—-][A-Za-z0-9][A-Za-z0-9]*)+[.!?]?\1/g) || [];
    for (const s of found) {
      /* A CSS class list, a DOM id and an event name are not prose. */
      if (/^['"`][A-Z]+['"`]$/.test(s)) continue;
      literals.push(`${f}: ${s}`);
    }
  }
  eq(`D1 no converted file contains a user-facing sentence${literals.length ? ` — ${literals.slice(0, 6).join(' · ')}` : ''}`,
    literals.length, 0);
  note(`${CONVERTED.length} file(s) converted so far: ${CONVERTED.join(', ')}`);

  /* And the counter-check, so D1 cannot pass by the regex being broken. */
  const canary = "const x = 'Carry the case to the stair head.';";
  ok('D2 and the check would catch one if it were there, so D1 is not passing on a broken regex',
    (canary.match(/(['"`])[A-Z][a-z]+(?:[ ,'’—-][A-Za-z0-9][A-Za-z0-9]*)+[.!?]?\1/g) || []).length === 1);
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
    await run('F', () => sectionF());
    emit();
  } catch (e) {
    lines.push(`FAIL  the i18n suite itself threw: ${e && e.stack ? e.stack : e}`);
    counts.fails++;
    emit();
  }
})();
