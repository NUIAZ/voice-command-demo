/**
 * @file types.ts
 * @description Types for the demo's fictional dataset.
 *
 * The dataset is entirely invented: Harborline Courier Co. is not a real company,
 * the depots are not real places, and every address is drawn from the documentation
 * ranges reserved by RFC 5737 (203.0.113.0/24, 198.51.100.0/24) or the private range
 * of RFC 1918 (192.168.0.0/16). None of it can ever route anywhere.
 *
 * WHY invent data at all: a voice demo is only convincing when the spoken answers are
 * *specific*. "Three vehicles need attention: Osprey, Dunlin and Rook" lands in a way
 * that "your query returned 3 rows" never does, and specificity is only possible with
 * a dataset rich enough to have real structure.
 */

/**
 * Operational state of a vehicle. Deliberately a small closed set: voice commands work
 * far better over a handful of well-separated words than over free text, because the
 * recogniser is choosing between a few dozen plausible transcriptions and a distinctive
 * vocabulary makes its job easier.
 */
export type VehicleStatus = 'on-route' | 'idle' | 'charging' | 'maintenance' | 'offline';

/** Human/spoken label for each status, plus the phrases a person might say for it. */
export interface StatusMeta {
    id: VehicleStatus;
    /** Shown in the UI and spoken back in responses. */
    label: string;
    /**
     * Phrases that should resolve to this status when heard. Includes the recogniser's
     * common mis-hearings, e.g. "on route" reliably comes back as "on route",
     * "en route" or "onroute" depending on accent, and all three must work.
     */
    spokenAliases: string[];
    /** Whether a vehicle in this state counts as a problem in the "any problems" report. */
    isProblem: boolean;
    /** CSS accent token used by the UI. */
    tone: 'ok' | 'info' | 'warn' | 'bad';
}

/** A depot the fleet operates out of. All place names are fictional. */
export interface Depot {
    id: string;
    /** Display + spoken name, e.g. "Northgate". */
    name: string;
    /** Fictional town the depot sits in. */
    town: string;
    /**
     * Extra words a person might say for this depot. Kept separate from `name` so the
     * matcher can accept "the north gate depot" as well as "northgate".
     */
    spokenAliases: string[];
    /** Documentation-range subnet the depot's telematics units sit on. */
    subnet: string;
    /** Number of charging bays: gives the depot report something to say. */
    chargeBays: number;
}

/**
 * One delivery van.
 *
 * `name` is a short, phonetically distinct call sign (bird names). WHY birds: the whole
 * fleet needed 48 one- or two-syllable words that a speech recogniser will not confuse
 * with each other or with a command keyword. Bird names happen to be a large, familiar,
 * well-separated vocabulary; real fleets pick their call signs the same way, and for
 * the same reason.
 */
export interface Vehicle {
    /** Asset tag, e.g. "HC-118". */
    id: string;
    /** Spoken call sign, e.g. "Kestrel". Unique across the fleet. */
    name: string;
    status: VehicleStatus;
    /** `Depot.id` this vehicle is assigned to. */
    depotId: string;
    /** Traction battery state of charge, 0–100. */
    batteryPercent: number;
    /** How full the cargo bay is, 0–100. */
    cargoPercent: number;
    /** Parcels still on board and undelivered. */
    packagesRemaining: number;
    /** Lifetime distance. */
    odometerKm: number;
    /** Telematics unit address: RFC 5737 / RFC 1918 documentation ranges only. */
    telematicsIp: string;
    /** Minutes since the telematics unit last reported in. */
    lastCheckInMinutes: number;
    /** Optional free-text note; spoken as part of the vehicle detail answer. */
    note?: string;
}
