/**
 * @file speechFormat.ts
 * @description Small, pure helpers for turning data into strings that a text-to-speech
 * engine says *intelligibly*.
 *
 * This module exists because "correct text" and "text that sounds right when spoken"
 * are different problems, and mixing the two into the command handlers makes both
 * untestable. Everything here is pure and framework-free.
 *
 * The techniques are borrowed from a production voice-control feature (see README
 * "Credits"): reading dotted quads as "dot", pluralising response strings, and never
 * reciting zeros were all things that only became obvious once real people listened to
 * the output.
 */

/**
 * Reads a dotted-quad IP address the way a person would say it.
 *
 * WHY: every TTS engine tested reads `203.0.113.5` as either "two hundred three point
 * zero point one hundred thirteen point five" or — worse — as a decimal number
 * ("two hundred three point zero one one three five"). Neither is transcribable back
 * into an address by a listener. Spelling the separator as the word "dot" produces
 * "203 dot 0 dot 113 dot 5", which is exactly how a person reads an address aloud.
 *
 * The engine still reads each octet as a number ("two hundred three"), which is what
 * people expect; the fix is only about the separator.
 */
export function speakIp(ip: string): string {
    return ip.replace(/\./g, ' dot ');
}

/**
 * Reads an identifier containing letters + digits so the letters are not swallowed.
 *
 * WHY: "HC-118" is read by several engines as "hick one hundred eighteen" — the engine
 * treats a short uppercase run as a pronounceable word. Splitting the letters apart
 * and replacing the hyphen with a space forces letter-by-letter reading:
 * "H C 118".
 */
export function speakId(id: string): string {
    return id
        .replace(/-/g, ' ')
        .replace(/[A-Z]{2,}/g, (run) => run.split('').join(' '))
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Classic count + noun pluraliser: `plural(1, 'vehicle')` → `"1 vehicle"`,
 * `plural(3, 'vehicle')` → `"3 vehicles"`.
 *
 * WHY it matters more for speech than for text: on screen "1 vehicles" is a typo you
 * skim past. Spoken aloud it is jarring enough that listeners stop following the
 * sentence and start noticing the machine. Irregular plurals take the explicit
 * `pluralForm` argument.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
    const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
    return `${count} ${word}`;
}

/** The bare noun without the count, for sentences that phrase the number differently. */
export function pluralWord(count: number, singular: string, pluralForm?: string): string {
    return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** Subject-verb agreement helper: `is` / `are`. Spoken output notices this too. */
export function isAre(count: number): string {
    return count === 1 ? 'is' : 'are';
}

/**
 * Joins a list the way a person speaks it: `"a, b, and c"`.
 *
 * WHY not `Array.join(', ')`: a comma-only list read aloud has no audible end — the
 * listener cannot tell whether the sentence finished or the engine was cut off. The
 * final "and" is the audible terminator.
 */
export function speakList(items: readonly string[], conjunction = 'and'): string {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0]!;
    if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

/**
 * Drops zero-valued entries from a "here is what is wrong" list.
 *
 * WHY: reciting "0 offline, 0 in maintenance, 0 low battery" takes eight seconds to
 * communicate nothing. Reporting only non-zero items and falling back to a single
 * "all clear" sentence is both faster and much easier to act on — this is the single
 * biggest quality-of-life difference between a voice status report that people keep
 * using and one they turn off.
 */
export function nonZeroParts(parts: readonly { count: number; text: string }[]): string[] {
    return parts.filter((p) => p.count > 0).map((p) => p.text);
}

/**
 * Rounds a number for speech. TTS reads `82.6666666` digit-soup style; nobody needs
 * more than whole percent for a spoken figure.
 */
export function speakPercent(value: number): string {
    return `${Math.round(value)} percent`;
}

/**
 * Reads a distance with a spoken unit rather than an abbreviation.
 *
 * WHY: "km" is read as "kay em" by some engines and "kilometres" by others. Spelling
 * the unit removes the coin flip. Large numbers are also grouped down to thousands
 * ("12 thousand 400") because engines read six-digit numbers as an unbroken digit run.
 */
export function speakDistanceKm(km: number): string {
    const rounded = Math.round(km);
    if (rounded < 1000) return `${rounded} kilometres`;
    const thousands = Math.floor(rounded / 1000);
    const remainder = rounded % 1000;
    if (remainder === 0) return `${thousands} thousand kilometres`;
    return `${thousands} thousand ${remainder} kilometres`;
}

/**
 * Reads a duration in minutes as the largest sensible unit.
 * "97 minutes" is harder to hold in your head than "1 hour 37 minutes".
 */
export function speakMinutes(minutes: number): string {
    if (minutes < 60) return plural(minutes, 'minute');
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (rest === 0) return plural(hours, 'hour');
    return `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

/**
 * Normalises a raw transcript for matching.
 *
 * WHY each step:
 * - lowercase: recognisers capitalise sentence starts and proper nouns inconsistently.
 * - strip punctuation: Chrome inserts commas, periods and apostrophes based on prosody,
 *   so "what's wrong" can arrive as "What's wrong." or "Whats wrong" from the same
 *   utterance. Removing punctuation entirely makes keyword matching deterministic —
 *   but note we replace apostrophes with *nothing* and other punctuation with a
 *   *space*, so "what's" → "whats" while "stop, listen" → "stop listen".
 * - collapse whitespace: interim results often arrive with doubled spaces.
 */
export function normalizeTranscript(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Whole-word containment test against an already-normalised transcript.
 *
 * WHY this exists alongside the router's substring matching: substring matching is
 * fine for command *phrases* ("how many", "go to") but dangerous for short data
 * values. The fleet contains a vehicle called "Tern"; a substring test would match it
 * inside "eastern", "pattern" and "internal". Word-boundary matching is used wherever
 * we pull a *name* out of an utterance.
 */
export function containsWord(normalizedTranscript: string, word: string): boolean {
    const normalizedWord = normalizeTranscript(word);
    if (!normalizedWord) return false;
    return ` ${normalizedTranscript} `.includes(` ${normalizedWord} `);
}
