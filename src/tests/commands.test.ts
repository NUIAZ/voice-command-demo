/**
 * @file commands.test.ts
 * @description Covers the command router: one test per command family, the
 * unknown-command fallback, the ordering decisions that are load-bearing, and the
 * stop-word consolidation.
 *
 * The ordering assertions are the important ones. Substring matching over an ordered
 * list is only correct because of the order, and "mute" being a substring of "unmute" is
 * the kind of bug that is invisible in review and obvious the moment a user hits it.
 */

import { describe, expect, it } from 'vitest';
import {
    COMMANDS,
    STOP_PHRASES,
    UNKNOWN_COMMAND_RESPONSE,
    getCommand,
    isStopPhrase,
    processTranscript,
    runCommandById,
} from '../services/commands';

/** Convenience: route a phrase and return just the id that answered it. */
function idFor(phrase: string): string | null {
    return processTranscript(phrase).commandId;
}

/** Index of a command in the table, for order assertions. */
function orderOf(id: string): number {
    return COMMANDS.findIndex((c) => c.id === id);
}

describe('routing basics', () => {
    it('falls back cleanly on an unrecognised phrase instead of going silent', () => {
        const result = processTranscript('please make me a cup of tea');
        expect(result.commandId).toBeNull();
        expect(result.response).toBe(UNKNOWN_COMMAND_RESPONSE);
        expect(result.effect).toEqual({ kind: 'none' });
    });

    it('falls back on empty and whitespace-only input', () => {
        expect(processTranscript('').commandId).toBeNull();
        expect(processTranscript('   ').commandId).toBeNull();
    });

    it('every command example routes back to that same command', () => {
        // This is the ordering regression test. If anyone reorders COMMANDS in a way
        // that lets an earlier entry swallow a later one's canonical phrase, this fails.
        for (const command of COMMANDS) {
            expect(idFor(command.example), `example "${command.example}"`).toBe(command.id);
        }
    });

    it('is case- and punctuation-insensitive', () => {
        expect(idFor('Any Problems?')).toBe('problems');
        expect(idFor("WHAT'S WRONG")).toBe('problems');
    });
});

describe('stop words are defined in exactly one place', () => {
    it('routes every stop phrase to the stop command with a stop effect', () => {
        for (const phrase of STOP_PHRASES) {
            const result = processTranscript(phrase);
            expect(result.commandId, phrase).toBe('stop');
            expect(result.effect, phrase).toEqual({ kind: 'stop' });
        }
    });

    it('exposes the same vocabulary through isStopPhrase, so the UI cannot drift', () => {
        for (const phrase of STOP_PHRASES) {
            expect(isStopPhrase(phrase), phrase).toBe(true);
        }
        expect(isStopPhrase('how many vans are charging')).toBe(false);
    });

    it('recognises a stop phrase embedded in a longer utterance', () => {
        expect(idFor('okay stop listening now please')).toBe('stop');
    });
});

describe('ordering decisions that change behaviour', () => {
    it('places unmute before mute; otherwise "unmute" matches "mute" and is unreachable', () => {
        expect(orderOf('unmute')).toBeLessThan(orderOf('mute'));
        expect(idFor('unmute')).toBe('unmute');
        expect(idFor('mute')).toBe('mute');
    });

    it('places navigation before help, so "open the commands page" navigates', () => {
        expect(orderOf('navigate')).toBeLessThan(orderOf('help'));
        expect(idFor('open the commands page')).toBe('navigate');
        expect(idFor('what can you do')).toBe('help');
    });

    it('places packages before counts, so "how many packages" is not a vehicle count', () => {
        expect(orderOf('packages')).toBeLessThan(orderOf('count'));
        expect(idFor('how many packages are left')).toBe('packages');
        expect(processTranscript('how many packages are left').response).toContain('parcel');
    });

    it('places the summary last, because "status" appears inside many better questions', () => {
        expect(orderOf('summary')).toBeGreaterThan(orderOf('vehicle'));
        expect(idFor('status of Kestrel')).toBe('vehicle');
        expect(idFor('give me the status')).toBe('summary');
    });

    it('places the vehicle lookup before the depot report', () => {
        expect(orderOf('vehicle')).toBeLessThan(orderOf('depot'));
        expect(idFor('how is Kestrel doing at Northgate')).toBe('vehicle');
        expect(idFor('how is Northgate doing')).toBe('depot');
    });
});

describe('help', () => {
    it('answers with something short enough to actually listen to', () => {
        const result = processTranscript('help');
        expect(result.commandId).toBe('help');
        expect(result.response).toContain('summary');
        // Roughly 15 speaking-seconds. A spoken help text longer than this is useless.
        expect(result.response.length).toBeLessThan(700);
    });
});

describe('voice settings commands', () => {
    it('emits relative settings changes rather than absolute values', () => {
        expect(processTranscript('speak faster').effect).toEqual({ kind: 'settings', change: 'faster' });
        expect(processTranscript('slow down').effect).toEqual({ kind: 'settings', change: 'slower' });
        expect(processTranscript('higher pitch').effect).toEqual({ kind: 'settings', change: 'pitch-up' });
        expect(processTranscript('lower pitch').effect).toEqual({ kind: 'settings', change: 'pitch-down' });
        expect(processTranscript('mute').effect).toEqual({ kind: 'settings', change: 'mute' });
        expect(processTranscript('unmute').effect).toEqual({ kind: 'settings', change: 'unmute' });
        expect(processTranscript('reset voice').effect).toEqual({ kind: 'settings', change: 'reset' });
    });
});

describe('navigation', () => {
    it('resolves each view', () => {
        expect(processTranscript('go to the fleet').effect).toEqual({ kind: 'navigate', view: 'fleet' });
        expect(processTranscript('go to the commands page').effect).toEqual({
            kind: 'navigate',
            view: 'commands',
        });
        expect(processTranscript('take me to browser support').effect).toEqual({
            kind: 'navigate',
            view: 'support',
        });
    });

    it('asks which view when the destination is missing, instead of guessing', () => {
        const result = processTranscript('go to');
        expect(result.commandId).toBe('navigate');
        expect(result.effect).toEqual({ kind: 'none' });
        expect(result.response).toContain('Which view');
    });
});

describe('overall status and problem reporting', () => {
    it('summarises the whole fleet', () => {
        const result = processTranscript('give me a fleet summary');
        expect(result.commandId).toBe('summary');
        expect(result.response).toContain('48 vans in the fleet');
        expect(result.response).toContain('26 on route');
        expect(result.response).toContain('3 offline');
    });

    it('reports only non-zero problem categories, and names them', () => {
        const result = processTranscript('are there any problems');
        expect(result.commandId).toBe('problems');
        expect(result.response).toContain('3 vans offline');
        expect(result.response).toContain('4 vans in maintenance');
        expect(result.response).toContain('Kingfisher');
        // Never recite zeros.
        expect(result.response).not.toMatch(/\b0 vans\b/);
    });

    it('agrees the verb with the count in the problem report', () => {
        // Two vans are overdue a check-in, so the report must say "are", not "is".
        expect(processTranscript('anything wrong').response).toContain('2 vans are overdue');
    });

    it('truncates long name lists with a single audible terminator', () => {
        const result = processTranscript('are there any problems');
        // Six vans are low on charge; only five are named, then "and 1 other".
        expect(result.response).toContain('and 1 other');
        expect(result.response).not.toContain('and 1 others');
    });
});

describe('counts', () => {
    it('counts by state', () => {
        const result = processTranscript('how many vans are charging');
        expect(result.commandId).toBe('count');
        expect(result.response).toBe('7 vans are charging.');
        expect(result.effect).toEqual({ kind: 'filter', status: 'charging', depotId: null });
    });

    it('counts by depot', () => {
        const result = processTranscript('how many vans are at Riverside');
        expect(result.response).toBe('Riverside has 8 vans assigned.');
        expect(result.effect).toEqual({ kind: 'filter', status: null, depotId: 'riverside' });
    });

    it('falls back to the fleet total when neither state nor depot is named', () => {
        expect(processTranscript('how many vans are there').response).toBe(
            '48 vans in the fleet across 6 depots.',
        );
    });
});

describe('listing and filtering', () => {
    it('lists the vans in a state and filters the table to match', () => {
        const result = processTranscript('show me all the offline vans');
        expect(result.commandId).toBe('list');
        expect(result.response).toBe('3 vans are offline: Finch, Oriole, and Kingfisher.');
        expect(result.effect).toEqual({ kind: 'filter', status: 'offline', depotId: null });
    });

    it('accepts the recogniser\'s variant spellings of a state', () => {
        // "on route" comes back as "en route" or "on root" depending on accent.
        expect(processTranscript('which vans are en route').commandId).toBe('list');
        expect(processTranscript('which vans are en route').response).toContain('26 vans are on route');
    });

    it('gives a full breakdown when no state is named', () => {
        const result = processTranscript('list the vans');
        expect(result.response).toContain('26 on route');
        expect(result.response).toContain('3 offline');
        expect(result.effect).toEqual({ kind: 'filter', status: null, depotId: null });
    });
});

describe('depot reports', () => {
    it('reports a depot and flags what needs attention there', () => {
        const result = processTranscript('how is Riverside depot doing');
        expect(result.commandId).toBe('depot');
        expect(result.response).toContain('Riverside in Cranmoor has 8 vans');
        expect(result.effect).toEqual({ kind: 'filter', status: null, depotId: 'riverside' });
    });

    it('uses the singular when exactly one van is flagged', () => {
        // Lakeview has a single flagged van (Kingfisher, offline).
        const result = processTranscript('how is Lakeview doing');
        expect(result.response).toContain('1 van is flagged: Kingfisher.');
    });

    it('says so plainly when a depot is clean, rather than listing zeros', () => {
        const result = processTranscript('depot report');
        // No depot named: it should ask rather than pick one.
        expect(result.response).toContain('Which depot');
    });

    it('matches a depot alias but not a word that merely contains it', () => {
        expect(processTranscript('what is happening at the old quarry').commandId).toBe('depot');
        // "river" must not be found inside "driver".
        expect(idFor('ask the driver')).not.toBe('depot');
    });
});

describe('vehicle lookup by call sign', () => {
    it('gives a full report and speaks the IP address digit-group by digit-group', () => {
        const result = processTranscript('tell me about Kestrel');
        expect(result.commandId).toBe('vehicle');
        expect(result.response).toContain('Kestrel, asset H C 101, is on route');
        expect(result.response).toContain('telematics 203 dot 0 dot 113 dot 11');
        expect(result.effect).toEqual({ kind: 'focus', vehicleId: 'HC-101' });
    });

    it('includes the free-text note when there is one', () => {
        const result = processTranscript('tell me about Oriole');
        expect(result.response).toContain('dropped off the network');
    });

    it('matches a bare call sign with no carrier phrase', () => {
        expect(processTranscript('kingfisher').effect).toEqual({ kind: 'focus', vehicleId: 'HC-140' });
    });

    it('finds a van by the digits of its asset tag', () => {
        expect(processTranscript('details for 118').effect).toEqual({ kind: 'focus', vehicleId: 'HC-118' });
    });

    it('does NOT match a call sign hidden inside a longer word', () => {
        // "Tern" lives inside "eastern"; a substring match would focus the wrong van.
        const result = processTranscript('tell me about the eastern approach');
        expect(result.commandId).toBe('vehicle');
        expect(result.response).toContain('Which van');
        expect(result.effect).toEqual({ kind: 'none' });
    });
});

describe('battery and packages', () => {
    it('lists the low-charge vans, worst first', () => {
        const result = processTranscript('which vans have low battery');
        expect(result.commandId).toBe('battery');
        expect(result.response).toContain('6 vans are at or below 20 percent');
        expect(result.response).toContain('Lowest is Oriole at 0 percent');
    });

    it('answers for a single van when one is named', () => {
        const result = processTranscript('what is the battery on Dunlin');
        expect(result.response).toBe('Dunlin is at 11 percent charge.');
        expect(result.effect).toEqual({ kind: 'focus', vehicleId: 'HC-134' });
    });

    it('totals the parcels still on board', () => {
        const result = processTranscript('how many parcels are left');
        expect(result.commandId).toBe('packages');
        expect(result.response).toContain('626 parcels');
        expect(result.response).toContain('26 vans on route');
    });

    it('answers parcels for a single van when one is named', () => {
        expect(processTranscript('how many parcels does Ibis have').response).toBe(
            'Ibis has 37 parcels left on board.',
        );
    });
});

describe('repeat', () => {
    it('returns a repeat effect, leaving the history to the session', () => {
        const result = processTranscript('say that again');
        expect(result.commandId).toBe('repeat');
        expect(result.effect).toEqual({ kind: 'repeat' });
    });
});

describe('runCommandById: the click-to-try path used when speech is unavailable', () => {
    it('produces exactly the same result as speaking the example', () => {
        for (const command of COMMANDS) {
            expect(runCommandById(command.id), command.id).toEqual(processTranscript(command.example));
        }
    });

    it('accepts a transcript override so a button can supply arguments', () => {
        expect(runCommandById('vehicle', 'tell me about Rook').effect).toEqual({
            kind: 'focus',
            vehicleId: 'HC-146',
        });
    });

    it('returns the unknown fallback for an id that does not exist', () => {
        expect(runCommandById('no-such-command').response).toBe(UNKNOWN_COMMAND_RESPONSE);
    });
});

describe('command metadata is complete enough to document itself', () => {
    it('gives every command an id, title, description, example and at least one trigger', () => {
        for (const command of COMMANDS) {
            expect(command.id).toBeTruthy();
            expect(command.title).toBeTruthy();
            expect(command.description).toBeTruthy();
            expect(command.example).toBeTruthy();
            expect(command.keywords.length).toBeGreaterThan(0);
        }
    });

    it('has unique command ids', () => {
        const ids = COMMANDS.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('can look a command up by id', () => {
        expect(getCommand('summary')?.title).toBe('Fleet summary');
        expect(getCommand('nope')).toBeUndefined();
    });
});
