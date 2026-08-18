/**
 * @file commands.ts
 * @description The command router: spoken phrase in, spoken answer (plus an optional
 * side effect) out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW MATCHING WORKS, AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The transcript is normalised (lowercased, punctuation stripped, whitespace collapsed)
 * and then tested against an ORDERED list of commands. The first command that matches
 * wins and no other command is consulted. Most commands match by testing whether any of
 * their keyword phrases appears as a SUBSTRING of the transcript; a few override that
 * with a custom `matches` function when substring testing would be dangerous.
 *
 * This is deliberately simple, and it is worth being honest about what that costs:
 *
 *   ✗ It is NOT fuzzy. "vehicals" or "how meny" match nothing. There is no edit-distance
 *     fallback, no phonetic matching, no spelling correction.
 *   ✗ It is NOT intent classification. There is no model, no embedding, no confidence
 *     score. "I'd rather not hear about the offline ones" matches the offline command,
 *     because the word "offline" is in it. Negation is invisible to a substring test.
 *   ✗ It has NO slot filling beyond the small extractors in `src/data/index.ts`. It
 *     cannot handle "compare Northgate and Riverside"; it will find one depot and
 *     ignore the other.
 *   ✗ ORDER IS LOAD-BEARING. "mute" is a substring of "unmute", so if the mute command
 *     came first, unmuting would be impossible. Every ordering decision below is
 *     commented for exactly this reason, and the order is asserted in the test suite so
 *     that a future edit that reshuffles the list fails loudly.
 *
 *   ✓ In exchange: it is fully deterministic, it runs in microseconds, every branch is
 *     unit-testable: it needs no network and no model, and (the important one for a
 *     voice interface) when it gets something wrong you can read the code and see
 *     exactly why. That is a genuinely reasonable trade for a fixed, small vocabulary.
 *     It stops being reasonable the moment the vocabulary grows past a few dozen phrases
 *     or users start speaking freely, at which point you want real intent recognition.
 *
 * The whole module is pure and synchronous: same transcript in, same result out, no I/O.
 * That is what lets the Commands page offer a "Try it" button that runs the identical
 * handler with no microphone involved.
 */

import {
    DEPOTS,
    LOW_BATTERY_THRESHOLD,
    STALE_CHECKIN_MINUTES,
    STATUSES,
    depotName,
    fleetSummary,
    lowBatteryVehicles,
    matchDepotInTranscript,
    matchStatusInTranscript,
    matchVehicleInTranscript,
    staleCheckInVehicles,
    statusLabel,
    totalPackagesRemaining,
    vehiclesByDepot,
    vehiclesByStatus,
} from '../data';
import type { Vehicle } from '../data/types';
import {
    isAre,
    normalizeTranscript,
    plural,
    pluralWord,
    speakDistanceKm,
    speakId,
    speakIp,
    speakList,
    speakMinutes,
    speakPercent,
} from './speechFormat';

/* ════════════════════════════════════════════════════════════════════════════
   Result and effect types
   ════════════════════════════════════════════════════════════════════════════ */

/** The three demo views the voice interface can move between. */
export type ViewId = 'fleet' | 'commands' | 'support';

/**
 * A relative change to the speech settings.
 *
 * WHY relative rather than absolute: this module is pure and does not know the current
 * rate or pitch. "Speak faster" means "faster than whatever you are doing now", so the
 * router emits the *intent* and the session applies it against live state. It also keeps
 * the router free of any dependency on the speech service.
 */
export type SettingsChange =
    | 'faster'
    | 'slower'
    | 'pitch-up'
    | 'pitch-down'
    | 'mute'
    | 'unmute'
    | 'reset';

/**
 * Something the host application should do in addition to speaking the response.
 *
 * Effects are declarative data, not callbacks, so a handler can be executed in a test
 * (or from a button on the Commands page) without any of the side effects actually
 * happening.
 */
export type CommandEffect =
    | { kind: 'none' }
    /** End the voice session. */
    | { kind: 'stop' }
    /** Speak the previous response again. */
    | { kind: 'repeat' }
    | { kind: 'navigate'; view: ViewId }
    | { kind: 'settings'; change: SettingsChange }
    /** Show the fleet view filtered to a status and/or depot. */
    | { kind: 'filter'; status: string | null; depotId: string | null }
    /** Show the fleet view scrolled to and highlighting one vehicle. */
    | { kind: 'focus'; vehicleId: string };

/**
 * What one turn of the conversation produces. Every handler returns exactly one of
 * these, and so does the unknown-command fallback; the router has no failure channel
 * and never throws, because a voice interface that goes silent is worse than one that
 * says something unhelpful.
 *
 * The split between `response` and `effect` is what keeps the module pure: the text is
 * the whole answer, and the effect is inert data describing what the host app should do
 * alongside speaking it. Nothing here touches the DOM, the speech service or React, so
 * a test can assert both halves without a microphone.
 */
export interface CommandResult {
    /** Text spoken aloud and shown on screen. Never empty. */
    response: string;
    /** What the host app should do as well as speaking. */
    effect: CommandEffect;
    /** Id of the command that matched, or `null` for the unknown-command fallback. */
    commandId: string | null;
}

/** A routable command. */
export interface CommandDefinition {
    /** Stable id, used by tests and by the Commands page's "Try it" buttons. */
    id: string;
    /** Short title for the Commands page. */
    title: string;
    /** One-line explanation of what it does. */
    description: string;
    /** Grouping for the Commands page. */
    group: 'Session' | 'Fleet' | 'Lookup' | 'Voice settings' | 'Navigation';
    /**
     * Trigger phrases, matched as substrings of the normalised transcript unless
     * `matches` is provided. Also displayed on the Commands page, so they double as
     * user-facing documentation; keep them things a person would actually say.
     */
    keywords: string[];
    /** A complete phrase a user could say. Also what the "Try it" button runs. */
    example: string;
    /**
     * Optional matcher that replaces substring keyword testing.
     *
     * Used where substring matching would be actively wrong. The fleet contains vans
     * called "Tern", "Kite" and "Teal": as substrings those appear inside "eastern",
     * "pattern" and "stealthy", so any command keyed on a vehicle name matches with
     * WORD BOUNDARIES instead. `keywords` is still populated for display.
     */
    matches?: (normalized: string) => boolean;
    /** Produces the answer. Pure: takes the normalised transcript, returns a result. */
    handler: (normalized: string) => CommandResult;
}

/* ════════════════════════════════════════════════════════════════════════════
   Stop words: ONE definition, used everywhere
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * The phrases that end a voice session.
 *
 * SINGLE SOURCE OF TRUTH. The reference implementation this demo is generalised from
 * had the stop-word list in two places, once in the command table and once inline in
 * the React overlay's result handler, which had already drifted: the overlay knew
 * about "close" and the command table did not, so "close" ended the session without
 * ever producing a spoken confirmation. Both call sites now use this array (and the
 * `isStopPhrase` helper below), so drift is impossible.
 */
export const STOP_PHRASES: readonly string[] = [
    'stop listening',
    'stop voice',
    'voice off',
    'never mind',
    'nevermind',
    'shut up',
    'be quiet',
    'exit voice',
    'close voice',
    'cancel',
    'quiet',
    'stop',
];

/**
 * Whether an utterance asks to end the session.
 *
 * Exported so the UI can short-circuit (for instance to stop the microphone before the
 * confirmation finishes speaking) without ever re-declaring the vocabulary.
 */
export function isStopPhrase(text: string): boolean {
    const normalized = normalizeTranscript(text);
    return STOP_PHRASES.some((phrase) => normalized.includes(phrase));
}

/* ════════════════════════════════════════════════════════════════════════════
   Small response builders
   ════════════════════════════════════════════════════════════════════════════ */

/** Convenience constructor so handlers stay one expression each. */
function reply(
    commandId: string,
    response: string,
    effect: CommandEffect = { kind: 'none' },
): CommandResult {
    return { commandId, response, effect };
}

/**
 * Reads out a set of vehicles by call sign, capping the list.
 *
 * WHY a cap: a spoken list of 26 names takes 40 seconds and nobody retains past the
 * fourth. Naming a handful and counting the rest carries the same information in a
 * form a listener can actually hold.
 */
function nameList(vehicles: readonly Vehicle[], max = 5): string {
    const names = vehicles.slice(0, max).map((v) => v.name);
    const remaining = vehicles.length - names.length;
    // When the list is truncated the "and N others" IS the audible terminator, so the
    // names themselves are joined with plain commas; running `speakList` here would
    // produce "A, B, and C, and 3 others", which sounds like a mistake.
    if (remaining > 0) return `${names.join(', ')}, and ${plural(remaining, 'other')}`;
    return speakList(names);
}

/** Views a navigation command can reach, with the words that select them. */
const VIEW_PHRASES: { view: ViewId; phrases: string[] }[] = [
    // Checked in order. 'browser support' before 'fleet' so a phrase containing both
    // resolves to the more specific one.
    { view: 'support', phrases: ['browser support', 'compatibility', 'support page', 'browsers', 'support'] },
    { view: 'commands', phrases: ['commands page', 'command reference', 'command list', 'commands', 'vocabulary'] },
    { view: 'fleet', phrases: ['fleet', 'vehicles', 'dashboard', 'home page', 'main page', 'the list', 'home'] },
];

function resolveView(normalized: string): ViewId | null {
    for (const entry of VIEW_PHRASES) {
        if (entry.phrases.some((p) => normalized.includes(p))) return entry.view;
    }
    return null;
}

/* ════════════════════════════════════════════════════════════════════════════
   THE COMMAND TABLE: ORDER IS PART OF THE BEHAVIOUR
   ════════════════════════════════════════════════════════════════════════════

   Reading order is matching order. The comment above each entry says why it sits where
   it does. `src/tests/commands.test.ts` asserts the relative order of the entries whose
   position actually changes behaviour, so this cannot silently rot.
   ═══════════════════════════════════════════════════════════════════════════ */

export const COMMANDS: readonly CommandDefinition[] = [
    // ── 0. STOP ──────────────────────────────────────────────────────────────
    // First, unconditionally. If the user is trying to make it stop talking, nothing
    // else should be able to intercept that. It is the one command that must never be
    // shadowed by a data value.
    {
        id: 'stop',
        title: 'Stop listening',
        description: 'Ends the voice session and switches the microphone off.',
        group: 'Session',
        keywords: [...STOP_PHRASES],
        example: 'stop listening',
        handler: () => reply('stop', 'Voice control off. Press the microphone button to start again.', { kind: 'stop' }),
    },

    // ── 1. NAVIGATION ────────────────────────────────────────────────────────
    // BEFORE `help`, because "open the commands page" contains the word "commands",
    // which is one of help's triggers. Navigation phrases are prefix-shaped ("go to",
    // "open the") so they are specific enough to lead.
    // Note "show the" is deliberately NOT a trigger: "show the offline vehicles" is a
    // filter request, not a navigation request.
    {
        id: 'navigate',
        title: 'Change view',
        description: 'Moves between the Fleet, Commands and Browser support views.',
        group: 'Navigation',
        keywords: ['go to', 'navigate to', 'take me to', 'switch to', 'open the', 'commands page', 'support page', 'browser support'],
        example: 'go to the commands page',
        handler: (t) => {
            const view = resolveView(t);
            if (!view) {
                return reply(
                    'navigate',
                    'Which view? You can say fleet, commands, or browser support.',
                );
            }
            const label = view === 'fleet' ? 'the fleet' : view === 'commands' ? 'the commands reference' : 'browser support';
            return reply('navigate', `Opening ${label}.`, { kind: 'navigate', view });
        },
    },

    // ── 2. HELP ──────────────────────────────────────────────────────────────
    // Early, so a lost user always gets out. Kept to roughly fifteen seconds of speech:
    // a spoken help text longer than that is not help, it is a hostage situation.
    {
        id: 'help',
        title: 'Help',
        description: 'Reads a short summary of what you can ask for.',
        group: 'Session',
        keywords: ['help', 'what can you do', 'what can i say', 'what can i ask', 'commands', 'command list'],
        example: 'what can you do',
        handler: () =>
            reply(
                'help',
                'You can ask for a fleet summary, ask if there are any problems, or ask how many vehicles are ' +
                    'charging, idle, on route, in maintenance, or offline. Ask about a depot by name. Northgate, ' +
                    'Riverside, Eastport, Summit Park, Lakeview, or Old Quarry. Ask about a single van by its call ' +
                    'sign, like Kestrel or Dunlin. You can also say speak faster, speak slower, mute, or stop ' +
                    'listening. Say open the commands page to see the full list on screen.',
            ),
    },

    // ── 3. UNMUTE, then 4. MUTE ──────────────────────────────────────────────
    // THE CANONICAL ORDERING TRAP: "mute" is a substring of "unmute". With mute first,
    // "unmute" matches mute and the user can never turn the voice back on, and because
    // the response is spoken, a muted assistant cannot even tell them what went wrong.
    // The longer, more specific phrase must always be tested first.
    {
        id: 'unmute',
        title: 'Unmute',
        description: 'Turns spoken responses back on.',
        group: 'Voice settings',
        keywords: ['unmute', 'un mute', 'sound on', 'start talking', 'speak again'],
        example: 'unmute',
        handler: () => reply('unmute', 'Speaking out loud again.', { kind: 'settings', change: 'unmute' }),
    },
    {
        id: 'mute',
        title: 'Mute',
        description: 'Keeps answering on screen but stops speaking aloud.',
        group: 'Voice settings',
        keywords: ['mute', 'sound off', 'stop talking', 'silence'],
        example: 'mute',
        handler: () =>
            reply('mute', 'Muted. Answers will still appear on screen.', { kind: 'settings', change: 'mute' }),
    },

    // ── 5–8. RATE AND PITCH ──────────────────────────────────────────────────
    // Before any data command, because "slower" and "faster" are short words that could
    // otherwise be swallowed by a broader keyword later in the table.
    {
        id: 'speak-faster',
        title: 'Speak faster',
        description: 'Increases the speech rate by 0.1.',
        group: 'Voice settings',
        keywords: ['speak faster', 'talk faster', 'speed up', 'faster'],
        example: 'speak faster',
        handler: () => reply('speak-faster', 'Speaking faster.', { kind: 'settings', change: 'faster' }),
    },
    {
        id: 'speak-slower',
        title: 'Speak slower',
        description: 'Decreases the speech rate by 0.1.',
        group: 'Voice settings',
        keywords: ['speak slower', 'talk slower', 'slow down', 'slower'],
        example: 'slow down',
        handler: () => reply('speak-slower', 'Speaking more slowly.', { kind: 'settings', change: 'slower' }),
    },
    {
        id: 'pitch-up',
        title: 'Raise pitch',
        description: 'Raises the synthesised voice pitch.',
        group: 'Voice settings',
        keywords: ['higher pitch', 'raise the pitch', 'higher voice'],
        example: 'higher pitch',
        handler: () => reply('pitch-up', 'Raising the pitch.', { kind: 'settings', change: 'pitch-up' }),
    },
    {
        id: 'pitch-down',
        title: 'Lower pitch',
        description: 'Lowers the synthesised voice pitch.',
        group: 'Voice settings',
        keywords: ['lower pitch', 'deeper voice', 'lower voice'],
        example: 'lower pitch',
        handler: () => reply('pitch-down', 'Lowering the pitch.', { kind: 'settings', change: 'pitch-down' }),
    },
    {
        id: 'reset-voice',
        title: 'Reset voice settings',
        description: 'Restores the default voice, rate and pitch.',
        group: 'Voice settings',
        keywords: ['reset the voice', 'reset voice', 'default voice', 'normal voice'],
        example: 'reset voice',
        handler: () => reply('reset-voice', 'Voice settings reset to default.', { kind: 'settings', change: 'reset' }),
    },

    // ── 9. ANY PROBLEMS ──────────────────────────────────────────────────────
    // Ahead of every other data command. This is the question people actually ask, and
    // it must not be intercepted by a narrower one just because the utterance happened
    // to contain the word "battery".
    {
        id: 'problems',
        title: 'Any problems',
        description:
            'Combined exception report: offline vans, vans in maintenance, low charge, and stale telematics check-ins.',
        group: 'Fleet',
        keywords: ['any problems', 'anything wrong', 'whats wrong', 'what is wrong', 'any issues', 'problems', 'exceptions', 'trouble'],
        example: 'are there any problems',
        handler: () => {
            const offline = vehiclesByStatus('offline');
            const maintenance = vehiclesByStatus('maintenance');
            const low = lowBatteryVehicles();
            const stale = staleCheckInVehicles();

            // Only non-zero categories are spoken. Reciting "zero offline, zero in
            // maintenance, zero low battery" takes eight seconds to say nothing at all,
            // and it trains people to stop listening to the answer.
            const parts: string[] = [];
            if (offline.length > 0) {
                parts.push(`${plural(offline.length, 'van')} offline: ${nameList(offline)}`);
            }
            if (maintenance.length > 0) {
                parts.push(`${plural(maintenance.length, 'van')} in maintenance: ${nameList(maintenance)}`);
            }
            if (low.length > 0) {
                parts.push(
                    `${plural(low.length, 'van')} at or below ${LOW_BATTERY_THRESHOLD} percent charge: ${nameList(low)}`,
                );
            }
            if (stale.length > 0) {
                parts.push(
                    `${plural(stale.length, 'van')} ${isAre(stale.length)} overdue a telematics check-in: ${nameList(stale)}`,
                );
            }

            if (parts.length === 0) {
                return reply('problems', 'All clear. Nothing in the fleet needs attention right now.');
            }
            return reply(
                'problems',
                `${plural(parts.length, 'thing')} to look at. ${parts.join('. ')}.`,
                // Clear any table filter rather than picking one category: the answer
                // spans several, and filtering to just one of them would contradict what
                // was just said aloud.
                { kind: 'filter', status: null, depotId: null },
            );
        },
    },

    // ── 10. BATTERY / CHARGE ─────────────────────────────────────────────────
    // Before the generic count and list commands so "which vans have low battery" is not
    // answered with a status breakdown. If a call sign is present the handler answers
    // for that van instead: a small, deliberate exception to "one command, one answer",
    // because "what's the battery on Dunlin" is an obvious thing to say and routing it
    // to a fleet-wide report would feel broken.
    {
        id: 'battery',
        title: 'Battery / charge',
        description: `Vans at or below ${LOW_BATTERY_THRESHOLD}% charge, or one van's charge if you name it.`,
        group: 'Fleet',
        keywords: ['low battery', 'low charge', 'battery', 'state of charge', 'charge level'],
        example: 'which vans have low battery',
        handler: (t) => {
            const vehicle = matchVehicleInTranscript(t);
            if (vehicle) {
                return reply(
                    'battery',
                    `${vehicle.name} is at ${speakPercent(vehicle.batteryPercent)} charge.`,
                    { kind: 'focus', vehicleId: vehicle.id },
                );
            }
            const low = lowBatteryVehicles();
            if (low.length === 0) {
                return reply('battery', `No vans are below ${LOW_BATTERY_THRESHOLD} percent charge.`);
            }
            const worst = low[0];
            return reply(
                'battery',
                `${plural(low.length, 'van')} ${isAre(low.length)} at or below ${LOW_BATTERY_THRESHOLD} percent: ` +
                    `${nameList(low)}. Lowest is ${worst.name} at ${speakPercent(worst.batteryPercent)}.`,
                { kind: 'filter', status: null, depotId: null },
            );
        },
    },

    // ── 11. PACKAGES ─────────────────────────────────────────────────────────
    // Before `count`, because "how many packages are left" contains "how many" and would
    // otherwise be answered with a vehicle count: a wrong answer to a well-formed
    // question, which is the worst kind of voice-interface failure.
    {
        id: 'packages',
        title: 'Packages remaining',
        description: 'Undelivered parcels still on board, fleet-wide or for one van.',
        group: 'Fleet',
        keywords: ['packages', 'parcels', 'deliveries', 'undelivered', 'drops left'],
        example: 'how many packages are left',
        handler: (t) => {
            const vehicle = matchVehicleInTranscript(t);
            if (vehicle) {
                return reply(
                    'packages',
                    `${vehicle.name} has ${plural(vehicle.packagesRemaining, 'parcel')} left on board.`,
                    { kind: 'focus', vehicleId: vehicle.id },
                );
            }
            const total = totalPackagesRemaining();
            const carrying = vehiclesByStatus('on-route').length;
            return reply(
                'packages',
                `${plural(total, 'parcel')} still on board across the fleet, carried by ` +
                    `${plural(carrying, 'van')} on route.`,
            );
        },
    },

    // ── 12. COUNTS ───────────────────────────────────────────────────────────
    // Handles "how many X", pulling a status or depot out of the utterance. Falls back to
    // the fleet total when neither is present.
    {
        id: 'count',
        title: 'Counts',
        description: 'How many vans in total, in a given state, or at a given depot.',
        group: 'Fleet',
        keywords: ['how many', 'how much', 'number of', 'count of', 'total number'],
        example: 'how many vans are charging',
        handler: (t) => {
            const status = matchStatusInTranscript(t);
            if (status) {
                const count = vehiclesByStatus(status.id).length;
                return reply(
                    'count',
                    `${plural(count, 'van')} ${isAre(count)} ${status.label.toLowerCase()}.`,
                    { kind: 'filter', status: status.id, depotId: null },
                );
            }
            const depot = matchDepotInTranscript(t);
            if (depot) {
                const count = vehiclesByDepot(depot.id).length;
                return reply(
                    'count',
                    `${depot.name} has ${plural(count, 'van')} assigned.`,
                    { kind: 'filter', status: null, depotId: depot.id },
                );
            }
            const summary = fleetSummary();
            return reply(
                'count',
                `${plural(summary.total, 'van')} in the fleet across ${plural(DEPOTS.length, 'depot')}.`,
            );
        },
    },

    // ── 13. VEHICLE DETAIL ───────────────────────────────────────────────────
    // Before the depot and list commands so "how is Kestrel doing at Northgate" answers
    // about Kestrel rather than about Northgate.
    // Matching is overridden: call signs must be matched on WORD BOUNDARIES, because a
    // substring test finds "Tern" inside "eastern" and "Teal" inside "stealthy".
    {
        id: 'vehicle',
        title: 'Vehicle detail',
        description: 'Full report on one van: state, depot, charge, load, telematics address.',
        group: 'Lookup',
        keywords: ['tell me about', 'details for', 'status of', 'information on', 'how is', '<any call sign, e.g. Kestrel>'],
        example: 'tell me about Kestrel',
        matches: (t) =>
            ['tell me about', 'details for', 'information on'].some((p) => t.includes(p)) ||
            matchVehicleInTranscript(t) !== undefined,
        handler: (t) => {
            const vehicle = matchVehicleInTranscript(t);
            if (!vehicle) {
                return reply(
                    'vehicle',
                    'Which van? Say a call sign, for example Kestrel, Dunlin, or Kingfisher.',
                );
            }
            const bits: string[] = [
                `${vehicle.name}, asset ${speakId(vehicle.id)}, is ${statusLabel(vehicle.status).toLowerCase()}`,
                `assigned to ${depotName(vehicle.depotId)}`,
                `charge ${speakPercent(vehicle.batteryPercent)}`,
            ];
            if (vehicle.packagesRemaining > 0) {
                bits.push(`${plural(vehicle.packagesRemaining, 'parcel')} still on board`);
            }
            bits.push(`odometer ${speakDistanceKm(vehicle.odometerKm)}`);
            // IP read as "203 dot 0 dot 113 dot 11"; every engine tested reads a raw
            // dotted quad as a decimal number, which is impossible to write back down.
            bits.push(`telematics ${speakIp(vehicle.telematicsIp)}`);
            bits.push(`last check-in ${speakMinutes(vehicle.lastCheckInMinutes)} ago`);
            const detail = `${bits.join(', ')}.`;
            const note = vehicle.note ? ` ${vehicle.note}` : '';
            return reply('vehicle', detail + note, { kind: 'focus', vehicleId: vehicle.id });
        },
    },

    // ── 14. DEPOT ────────────────────────────────────────────────────────────
    // Before the status list, because "which vans are at Riverside" contains "which
    // vans", one of the list command's triggers.
    // Word-boundary matching again: the alias "river" would otherwise match "driver".
    {
        id: 'depot',
        title: 'Depot report',
        description: 'Fleet breakdown for one depot, including anything needing attention there.',
        group: 'Lookup',
        keywords: ['depot', 'depots', 'yard', 'Northgate', 'Riverside', 'Eastport', 'Summit Park', 'Lakeview', 'Old Quarry'],
        example: 'how is Riverside depot doing',
        matches: (t) =>
            ['depot', 'depots', 'yard'].some((p) => t.includes(p)) ||
            matchDepotInTranscript(t) !== undefined,
        handler: (t) => {
            const depot = matchDepotInTranscript(t);
            if (!depot) {
                const names = DEPOTS.map((d) => d.name);
                return reply('depot', `Which depot? You can say ${speakList(names, 'or')}.`);
            }
            const fleet = vehiclesByDepot(depot.id);
            const onRoute = fleet.filter((v) => v.status === 'on-route').length;
            const charging = fleet.filter((v) => v.status === 'charging').length;
            const attention = fleet.filter(
                (v) =>
                    v.status === 'offline' ||
                    v.status === 'maintenance' ||
                    v.batteryPercent <= LOW_BATTERY_THRESHOLD,
            );
            const head =
                `${depot.name} in ${depot.town} has ${plural(fleet.length, 'van')}: ` +
                `${onRoute} on route, ${charging} charging, across ${plural(depot.chargeBays, 'charge bay')}.`;
            const tail =
                attention.length === 0
                    ? ' Nothing there needs attention.'
                    : ` ${plural(attention.length, 'van')} ${isAre(attention.length)} flagged: ${nameList(attention)}.`;
            return reply('depot', head + tail, { kind: 'filter', status: null, depotId: depot.id });
        },
    },

    // ── 15. LIST BY STATUS ───────────────────────────────────────────────────
    // Triggers on the status words themselves plus generic list phrasing. Placed after
    // the more specific lookups so it acts as the catch-all for "show me the X ones".
    {
        id: 'list',
        title: 'List by state',
        description: 'Names the vans in one operational state, and filters the table to match.',
        group: 'Fleet',
        keywords: ['list', 'show me all', 'show all', 'which vans', 'which vehicles', 'on route', 'idle', 'charging', 'in maintenance', 'offline'],
        example: 'show me all the offline vans',
        matches: (t) =>
            ['list', 'show me all', 'show all', 'which vans', 'which vehicles', 'who is'].some((p) => t.includes(p)) ||
            matchStatusInTranscript(t) !== undefined,
        handler: (t) => {
            const status = matchStatusInTranscript(t);
            if (!status) {
                // No state named: give the breakdown, which is what "list the vans"
                // most plausibly means.
                const counts = STATUSES.map(
                    (s) => `${vehiclesByStatus(s.id).length} ${s.label.toLowerCase()}`,
                );
                return reply(
                    'list',
                    `Across ${plural(fleetSummary().total, 'van')}: ${speakList(counts)}.`,
                    { kind: 'filter', status: null, depotId: null },
                );
            }
            const matchingVehicles = vehiclesByStatus(status.id);
            if (matchingVehicles.length === 0) {
                return reply('list', `No vans are ${status.label.toLowerCase()} right now.`, {
                    kind: 'filter',
                    status: status.id,
                    depotId: null,
                });
            }
            return reply(
                'list',
                `${plural(matchingVehicles.length, 'van')} ${isAre(matchingVehicles.length)} ` +
                    `${status.label.toLowerCase()}: ${nameList(matchingVehicles, 6)}.`,
                { kind: 'filter', status: status.id, depotId: null },
            );
        },
    },

    // ── 16. SUMMARY ──────────────────────────────────────────────────────────
    // Late on purpose: "status" is a substring of a great many useful sentences
    // ("status of Kestrel", "charging status at Riverside"), so it must not lead.
    {
        id: 'summary',
        title: 'Fleet summary',
        description: 'The headline numbers: how many vans, where they are, and overall charge.',
        group: 'Fleet',
        keywords: ['summary', 'overview', 'status', 'how are we doing', 'fleet report', 'situation'],
        example: 'give me a fleet summary',
        handler: () => {
            const s = fleetSummary();
            const head =
                `${plural(s.total, 'van')} in the fleet. ${s.onRoute} on route, ${s.charging} charging, ` +
                `${s.idle} idle, ${s.maintenance} in maintenance, ${s.offline} offline.`;
            const body =
                ` Average charge ${speakPercent(s.averageBattery)}, ` +
                `${plural(s.packagesRemaining, 'parcel')} still to deliver.`;
            const tail = s.allClear
                ? ' Nothing needs attention.'
                : ` ${plural(s.offline + s.maintenance + s.lowBattery + s.staleCheckIns, 'item')} ` +
                  `${isAre(s.offline + s.maintenance + s.lowBattery + s.staleCheckIns)} flagged; say "any problems" for the detail.`;
            return reply('summary', head + body + tail);
        },
    },

    // ── 17. REPEAT ───────────────────────────────────────────────────────────
    // Last: "again" is a short word that appears inside plenty of longer requests, so it
    // only gets to match once nothing more specific has.
    {
        id: 'repeat',
        title: 'Repeat',
        description: 'Says the previous answer again.',
        group: 'Session',
        keywords: ['say that again', 'repeat that', 'repeat', 'again', 'what was that'],
        example: 'say that again',
        // The router is pure and holds no history, so it returns the "nothing yet" text
        // and a `repeat` effect. A session that HAS a previous answer substitutes it;
        // one that does not speaks this. Keeping the history in the session rather than
        // in the router is what lets every handler stay a pure function.
        handler: () => reply('repeat', 'There is nothing to repeat yet.', { kind: 'repeat' }),
    },
];

/* ════════════════════════════════════════════════════════════════════════════
   Routing
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Keyword phrases are normalised once, at module load, using the same function applied
 * to incoming transcripts. Doing it here rather than trusting the literals means a
 * keyword written as "what's wrong" still matches, instead of silently never matching
 * because the transcript had the apostrophe stripped and the keyword did not. That exact
 * mismatch is easy to introduce and impossible to spot by reading.
 *
 * The "<any call sign...>" placeholder in the vehicle command's keyword list normalises
 * to harmless text and is never used for matching, because that command supplies its own
 * `matches`.
 */
const NORMALIZED_KEYWORDS: ReadonlyMap<string, string[]> = new Map(
    COMMANDS.map((command) => [command.id, command.keywords.map(normalizeTranscript).filter(Boolean)]),
);

/** Spoken when nothing matched. Names the escape hatches rather than just apologising. */
export const UNKNOWN_COMMAND_RESPONSE =
    "I didn't catch a command in that. Say help for a summary, or open the commands page to see everything I understand.";

/** Tests one command against an already-normalised transcript. */
function commandMatches(command: CommandDefinition, normalized: string): boolean {
    if (command.matches) return command.matches(normalized);
    const keywords = NORMALIZED_KEYWORDS.get(command.id) ?? [];
    return keywords.some((keyword) => normalized.includes(keyword));
}

/**
 * Routes a raw transcript to a command.
 *
 * First match in `COMMANDS` order wins; nothing after it is consulted. Returns the
 * unknown-command fallback rather than throwing, because a voice interface that goes
 * silent on an unrecognised phrase is indistinguishable from one that has crashed.
 */
export function processTranscript(raw: string): CommandResult {
    const normalized = normalizeTranscript(raw);
    if (!normalized) {
        return { commandId: null, response: UNKNOWN_COMMAND_RESPONSE, effect: { kind: 'none' } };
    }
    for (const command of COMMANDS) {
        if (commandMatches(command, normalized)) return command.handler(normalized);
    }
    return { commandId: null, response: UNKNOWN_COMMAND_RESPONSE, effect: { kind: 'none' } };
}

/** Looks a command up by id. */
export function getCommand(id: string): CommandDefinition | undefined {
    return COMMANDS.find((c) => c.id === id);
}

/**
 * Runs a command directly, bypassing matching entirely.
 *
 * This is what the Commands page's "Try it" buttons call. It matters for more than
 * convenience: it is the whole accessibility story for anyone using Firefox (no
 * recognition support at all), anyone without a microphone, anyone in a shared or noisy
 * space, and anyone who cannot or would rather not speak. The demo has to be fully
 * usable by pointer and keyboard, and running the *identical* handler, rather than a
 * parallel click-only code path, is what guarantees the two stay in step.
 */
export function runCommandById(id: string, transcriptOverride?: string): CommandResult {
    const command = getCommand(id);
    if (!command) {
        return { commandId: null, response: UNKNOWN_COMMAND_RESPONSE, effect: { kind: 'none' } };
    }
    return command.handler(normalizeTranscript(transcriptOverride ?? command.example));
}

/** Commands grouped for display on the reference page, preserving table order. */
export function commandsByGroup(): { group: CommandDefinition['group']; commands: CommandDefinition[] }[] {
    const groups: CommandDefinition['group'][] = ['Fleet', 'Lookup', 'Navigation', 'Voice settings', 'Session'];
    return groups.map((group) => ({
        group,
        commands: COMMANDS.filter((c) => c.group === group),
    }));
}

/** Constants the UI wants to display alongside the fleet, kept in one place. */
export const THRESHOLDS = {
    lowBatteryPercent: LOW_BATTERY_THRESHOLD,
    staleCheckInMinutes: STALE_CHECKIN_MINUTES,
} as const;

/** Re-exported so consumers do not need to reach into the data layer for labels. */
export { pluralWord };
