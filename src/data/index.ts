/**
 * @file data/index.ts
 * @description Query layer over the in-memory fleet.
 *
 * WHY a query layer rather than filtering inline in the command handlers: these are the
 * functions a real app would implement as HTTP calls. Keeping them behind a narrow,
 * synchronous interface means the command router in `services/commands.ts` reads exactly
 * as it would against a real backend, and swapping this module for `fetch` calls is a
 * mechanical change rather than a rewrite. It also makes every handler trivially
 * testable without mocking a network.
 */

import { DEPOTS, STATUSES } from './depots';
import { LOW_BATTERY_THRESHOLD, STALE_CHECKIN_MINUTES, VEHICLES } from './vehicles';
import type { Depot, StatusMeta, Vehicle, VehicleStatus } from './types';
import { containsWord } from '../services/speechFormat';

export type { Depot, StatusMeta, Vehicle, VehicleStatus };
export { DEPOTS, STATUSES, VEHICLES, LOW_BATTERY_THRESHOLD, STALE_CHECKIN_MINUTES };
export { depotName, getStatus, statusLabel, getDepot } from './depots';

/** Every vehicle, in fleet order. */
export function allVehicles(): readonly Vehicle[] {
    return VEHICLES;
}

/** Vehicles in a given operational state. */
export function vehiclesByStatus(status: VehicleStatus): Vehicle[] {
    return VEHICLES.filter((v) => v.status === status);
}

/** Vehicles assigned to a given depot. */
export function vehiclesByDepot(depotId: string): Vehicle[] {
    return VEHICLES.filter((v) => v.depotId === depotId);
}

/** Vehicles at or below the low-charge threshold, worst first. */
export function lowBatteryVehicles(threshold = LOW_BATTERY_THRESHOLD): Vehicle[] {
    return VEHICLES.filter((v) => v.batteryPercent <= threshold).sort(
        (a, b) => a.batteryPercent - b.batteryPercent,
    );
}

/**
 * Vehicles whose telematics unit has gone quiet but which are *not* already flagged
 * offline.
 *
 * WHY exclude the offline ones: they are reported separately, and a spoken report that
 * says "3 offline… and also these same 3 haven't checked in" wastes the listener's
 * attention on a distinction they did not ask about.
 */
export function staleCheckInVehicles(thresholdMinutes = STALE_CHECKIN_MINUTES): Vehicle[] {
    return VEHICLES.filter(
        (v) => v.status !== 'offline' && v.lastCheckInMinutes > thresholdMinutes,
    ).sort((a, b) => b.lastCheckInMinutes - a.lastCheckInMinutes);
}

/** Count of vehicles per status, in the display order defined by STATUSES. */
export function statusCounts(): { status: StatusMeta; count: number }[] {
    return STATUSES.map((status) => ({
        status,
        count: VEHICLES.filter((v) => v.status === status.id).length,
    }));
}

/** Total undelivered parcels still on board across the whole fleet. */
export function totalPackagesRemaining(): number {
    return VEHICLES.reduce((sum, v) => sum + v.packagesRemaining, 0);
}

/** Mean battery state of charge across the fleet, as a whole percent. */
export function averageBatteryPercent(): number {
    if (VEHICLES.length === 0) return 0;
    return Math.round(VEHICLES.reduce((s, v) => s + v.batteryPercent, 0) / VEHICLES.length);
}

/**
 * Everything a "how are we doing" answer needs, computed once.
 * Grouping it into one object keeps the summary handler readable and stops it from
 * walking the fleet six times.
 */
export interface FleetSummary {
    total: number;
    onRoute: number;
    idle: number;
    charging: number;
    maintenance: number;
    offline: number;
    lowBattery: number;
    staleCheckIns: number;
    packagesRemaining: number;
    averageBattery: number;
    /** True when nothing at all needs a human. Drives the "all clear" phrasing. */
    allClear: boolean;
}

/**
 * Computes the whole `FleetSummary` in one pass of the query helpers.
 *
 * Every field is derived from `VEHICLES` at call time — there is no memoisation and no
 * cached snapshot, so a test that swaps the dataset sees the change immediately. Cheap
 * enough at 48 rows that caching would cost more in staleness bugs than it saves.
 *
 * Two subtleties worth knowing before reusing the numbers:
 * - `lowBattery` and `offline` OVERLAP. A van can be both flat and unreachable, so the
 *   counts do not sum to `total` and must not be presented as a partition.
 * - `staleCheckIns` deliberately excludes vehicles already marked offline (see
 *   `staleCheckInVehicles`), so it is a count of *additional* vans worth chasing.
 *
 * `allClear` is the only field that is a judgement rather than a measurement: it is true
 * only when offline, maintenance, low-battery and stale counts are all zero. Adding a new
 * category of problem means adding it here too, or the "any problems?" answer will keep
 * saying everything is fine while the UI shows otherwise.
 */
export function fleetSummary(): FleetSummary {
    const offline = vehiclesByStatus('offline').length;
    const maintenance = vehiclesByStatus('maintenance').length;
    const lowBattery = lowBatteryVehicles().length;
    const stale = staleCheckInVehicles().length;
    return {
        total: VEHICLES.length,
        onRoute: vehiclesByStatus('on-route').length,
        idle: vehiclesByStatus('idle').length,
        charging: vehiclesByStatus('charging').length,
        maintenance,
        offline,
        lowBattery,
        staleCheckIns: stale,
        packagesRemaining: totalPackagesRemaining(),
        averageBattery: averageBatteryPercent(),
        allClear: offline === 0 && maintenance === 0 && lowBattery === 0 && stale === 0,
    };
}

/** Exact lookup by asset tag or call sign, case-insensitive. */
export function findVehicle(idOrName: string): Vehicle | undefined {
    const needle = idOrName.trim().toLowerCase();
    return VEHICLES.find(
        (v) => v.id.toLowerCase() === needle || v.name.toLowerCase() === needle,
    );
}

/**
 * Pulls a vehicle out of a spoken utterance.
 *
 * WHY word-boundary matching and not `includes()`: the fleet contains vans called
 * "Tern", "Kite", "Rook" and "Teal". A substring test finds "tern" inside "eastern",
 * "pattern" and "internal", and "kite" inside nothing useful but "teal" inside
 * "stealthy". Word boundaries eliminate an entire class of nonsense matches at
 * effectively zero cost.
 *
 * WHY longest-name-first: "Yellowhammer" contains no other call sign, but if a fleet
 * ever had both "Hawk" and "Nighthawk" the shorter one would win a naive scan. Sorting
 * by descending length makes the most specific match win, which is the behaviour people
 * expect.
 *
 * Asset tags are also matched, but only in their spoken form — a recogniser hears
 * "HC-118" as "hc 118", "h c one one eight" or "age see 118" depending on how it was
 * said, so we normalise the digits out of the tag and look for those.
 */
export function matchVehicleInTranscript(normalizedTranscript: string): Vehicle | undefined {
    const byLongestName = [...VEHICLES].sort((a, b) => b.name.length - a.name.length);
    for (const vehicle of byLongestName) {
        if (containsWord(normalizedTranscript, vehicle.name)) return vehicle;
    }
    // Fall back to the numeric part of the asset tag ("118" out of "HC-118"), which is
    // the part a recogniser transcribes reliably.
    for (const vehicle of VEHICLES) {
        const digits = vehicle.id.replace(/\D/g, '');
        if (digits && containsWord(normalizedTranscript, digits)) return vehicle;
    }
    return undefined;
}

/**
 * Pulls a depot out of a spoken utterance, checking the canonical name first and then
 * the alias list ("north gate", "the lake", "quarry").
 */
export function matchDepotInTranscript(normalizedTranscript: string): Depot | undefined {
    for (const depot of DEPOTS) {
        if (containsWord(normalizedTranscript, depot.name)) return depot;
        if (containsWord(normalizedTranscript, depot.town)) return depot;
        for (const alias of depot.spokenAliases) {
            if (containsWord(normalizedTranscript, alias)) return depot;
        }
    }
    return undefined;
}

/**
 * Pulls a status out of a spoken utterance.
 *
 * Aliases are checked longest-first for the same reason vehicle names are: "on route"
 * must beat a bare "route", and "off line" must not be shadowed by something shorter.
 */
export function matchStatusInTranscript(normalizedTranscript: string): StatusMeta | undefined {
    const candidates: { status: StatusMeta; phrase: string }[] = [];
    for (const status of STATUSES) {
        candidates.push({ status, phrase: status.label });
        for (const alias of status.spokenAliases) candidates.push({ status, phrase: alias });
    }
    candidates.sort((a, b) => b.phrase.length - a.phrase.length);
    for (const candidate of candidates) {
        if (containsWord(normalizedTranscript, candidate.phrase)) return candidate.status;
    }
    return undefined;
}
