/**
 * @file depots.ts
 * @description The six fictional depots Harborline Courier Co. operates from, plus the
 * status vocabulary. All towns and addresses are invented; subnets are RFC 5737 /
 * RFC 1918 documentation ranges.
 */

import type { Depot, StatusMeta, VehicleStatus } from './types';

/**
 * Depot list.
 *
 * Note the deliberate phonetic spread — Northgate / Riverside / Eastport / Summit /
 * Lakeview / Old Quarry share no leading syllables. Depot names are matched against
 * the transcript, and a recogniser that has to choose between "Marbury" and "Marlbury"
 * will get it wrong roughly half the time. Distinct first syllables are the single
 * cheapest accuracy improvement available to a voice interface.
 */
export const DEPOTS: readonly Depot[] = [
    {
        id: 'northgate',
        name: 'Northgate',
        town: 'Bellhaven',
        spokenAliases: ['north gate', 'north'],
        subnet: '203.0.113.0/26',
        chargeBays: 12,
    },
    {
        id: 'riverside',
        name: 'Riverside',
        town: 'Cranmoor',
        spokenAliases: ['river side', 'river'],
        subnet: '203.0.113.64/26',
        chargeBays: 8,
    },
    {
        id: 'eastport',
        name: 'Eastport',
        town: 'Thornbury',
        spokenAliases: ['east port', 'the port'],
        subnet: '203.0.113.128/26',
        chargeBays: 10,
    },
    {
        id: 'summit',
        name: 'Summit Park',
        town: 'Westmarch',
        spokenAliases: ['summit', 'the park'],
        subnet: '198.51.100.0/26',
        chargeBays: 6,
    },
    {
        id: 'lakeview',
        name: 'Lakeview',
        town: 'Aldergate',
        spokenAliases: ['lake view', 'the lake'],
        subnet: '198.51.100.64/26',
        chargeBays: 9,
    },
    {
        id: 'quarry',
        name: 'Old Quarry',
        town: 'Portvale',
        spokenAliases: ['quarry', 'the old quarry'],
        subnet: '192.168.40.0/26',
        chargeBays: 4,
    },
];

/**
 * Status vocabulary.
 *
 * `spokenAliases` carries the variants a recogniser actually produces. "On route" is
 * the worst offender: depending on accent and on whether the engine is in its
 * British or American model, the same utterance comes back as "on route", "en route",
 * "on root" or "onroute". Listing the variants is cheaper and far more reliable than
 * trying to be clever with fuzzy matching.
 */
export const STATUSES: readonly StatusMeta[] = [
    {
        id: 'on-route',
        label: 'On route',
        spokenAliases: ['on route', 'en route', 'on root', 'onroute', 'delivering', 'out delivering'],
        isProblem: false,
        tone: 'ok',
    },
    {
        id: 'charging',
        label: 'Charging',
        spokenAliases: ['charging', 'on charge', 'plugged in'],
        isProblem: false,
        tone: 'info',
    },
    {
        id: 'idle',
        label: 'Idle',
        spokenAliases: ['idle', 'parked', 'standing by', 'waiting'],
        isProblem: false,
        tone: 'info',
    },
    {
        id: 'maintenance',
        label: 'In maintenance',
        spokenAliases: ['maintenance', 'in the shop', 'being serviced', 'servicing'],
        isProblem: true,
        tone: 'warn',
    },
    {
        id: 'offline',
        label: 'Offline',
        spokenAliases: ['offline', 'off line', 'not reporting', 'unreachable', 'dark'],
        isProblem: true,
        tone: 'bad',
    },
];

/** Lookup helper — depot record by id. Returns undefined for unknown ids. */
export function getDepot(id: string): Depot | undefined {
    return DEPOTS.find((d) => d.id === id);
}

/** Display/spoken depot name, falling back to the raw id so answers never say "undefined". */
export function depotName(id: string): string {
    return getDepot(id)?.name ?? id;
}

/** Lookup helper — status metadata by id. */
export function getStatus(id: VehicleStatus): StatusMeta {
    // Non-null: STATUSES covers every member of the VehicleStatus union by construction,
    // and the compiler enforces that because each entry's `id` is typed VehicleStatus.
    return STATUSES.find((s) => s.id === id)!;
}

/** Display/spoken label for a status id. */
export function statusLabel(id: VehicleStatus): string {
    return getStatus(id).label;
}
