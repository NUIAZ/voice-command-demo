/**
 * @file vehicles.ts
 * @description The fictional fleet: 48 electric delivery vans belonging to
 * Harborline Courier Co., an invented company operating out of six invented depots.
 *
 * Nothing here is real. Every address is inside a documentation range that can never
 * route on the public internet:
 *   - 203.0.113.0/24  and 198.51.100.0/24  — reserved for documentation by RFC 5737
 *   - 192.168.0.0/16                        — private use, RFC 1918
 *
 * WHY the data is written out longhand instead of generated in a loop: the whole point
 * of the dataset is that the spoken answers are *interesting*. Randomly generated rows
 * produce uniform, forgettable answers ("about half of everything is fine"); hand-picked
 * rows let the demo have an actual story — Oriole dropped off the network mid-fault,
 * Ouzel is waiting on a battery module, six vans are running low on charge. Every
 * number below was chosen so that some command has something worth saying about it.
 *
 * Rows are grouped by depot so that each vehicle's telematics address falls inside its
 * depot's subnet, exactly as it would in a real fleet.
 */

import type { Vehicle } from './types';

/** Battery percentage at or below which a vehicle is reported as "low charge". */
export const LOW_BATTERY_THRESHOLD = 20;

/**
 * Minutes without a telematics check-in before a vehicle is treated as "stale".
 *
 * WHY 45: the fictional units report every 5 minutes, so 45 minutes is nine missed
 * reports — comfortably past "a tunnel" and into "somebody should call the driver".
 */
export const STALE_CHECKIN_MINUTES = 45;

/**
 * The whole fleet: 48 rows, and the only source of truth behind every spoken answer.
 *
 * INVARIANTS THE REST OF THE APP RELIES ON
 * - Asset tags run `HC-101`..`HC-148` with no gaps. `matchVehicleInTranscript` falls
 *   back to the digits alone ("118"), so two vehicles sharing a numeric suffix would
 *   make that lookup ambiguous.
 * - Call signs are unique and are single words. The transcript matcher tests them with
 *   word boundaries, longest-first; a two-word call sign would never match a recogniser
 *   that hyphenates or joins it.
 * - `status` is one of the five `VehicleStatus` values. `statusCounts()` walks `STATUSES`
 *   and would silently report zero for anything spelled differently here.
 * - `telematicsIp` sits inside its depot's /26, and every address is RFC 5737
 *   (203.0.113.0/24, 198.51.100.0/24) or RFC 1918 (192.168.40.0/24). Nothing here routes.
 * - `batteryPercent` and `cargoPercent` are whole percentages 0–100. Nine rows carry a
 *   `note`; the rest omit the field rather than setting it empty, because the detail
 *   answer tests for presence.
 *
 * CURRENT SHAPE, WHICH IS TUNED RATHER THAN INCIDENTAL — 26 on-route, 8 idle,
 * 7 charging, 4 maintenance, 3 offline; 6 at or below the 20% low-charge line; 2 stale
 * check-ins (Merlin at 73 min, Chaffinch at 62 — both deliberately *not* offline, so
 * `staleCheckInVehicles` has something to return that the offline report does not
 * already cover). Depot counts are uneven on purpose (10/8/9/7/8/6) so a per-depot
 * answer is not the same sentence six times.
 *
 * Editing a row is editing the demo script: drop the offline vans and "any problems?"
 * answers "all clear", which is the one response nobody wants to hear a demo give.
 */
export const VEHICLES: readonly Vehicle[] = [
    // ── Northgate (Bellhaven) — 203.0.113.0/26 ────────────────────────────────
    { id: 'HC-101', name: 'Kestrel', status: 'on-route', depotId: 'northgate', batteryPercent: 68, cargoPercent: 41, packagesRemaining: 23, odometerKm: 41280, telematicsIp: '203.0.113.11', lastCheckInMinutes: 2 },
    { id: 'HC-102', name: 'Heron', status: 'on-route', depotId: 'northgate', batteryPercent: 54, cargoPercent: 33, packagesRemaining: 17, odometerKm: 38210, telematicsIp: '203.0.113.12', lastCheckInMinutes: 1 },
    { id: 'HC-103', name: 'Osprey', status: 'maintenance', depotId: 'northgate', batteryPercent: 22, cargoPercent: 0, packagesRemaining: 0, odometerKm: 96540, telematicsIp: '203.0.113.13', lastCheckInMinutes: 14, note: 'Rear axle bearing replacement. Due back Thursday.' },
    { id: 'HC-104', name: 'Falcon', status: 'charging', depotId: 'northgate', batteryPercent: 46, cargoPercent: 0, packagesRemaining: 0, odometerKm: 51120, telematicsIp: '203.0.113.14', lastCheckInMinutes: 3 },
    { id: 'HC-105', name: 'Magpie', status: 'on-route', depotId: 'northgate', batteryPercent: 81, cargoPercent: 62, packagesRemaining: 34, odometerKm: 22870, telematicsIp: '203.0.113.15', lastCheckInMinutes: 1 },
    { id: 'HC-106', name: 'Raven', status: 'idle', depotId: 'northgate', batteryPercent: 93, cargoPercent: 0, packagesRemaining: 0, odometerKm: 33940, telematicsIp: '203.0.113.16', lastCheckInMinutes: 6 },
    { id: 'HC-107', name: 'Finch', status: 'offline', depotId: 'northgate', batteryPercent: 12, cargoPercent: 55, packagesRemaining: 19, odometerKm: 47760, telematicsIp: '203.0.113.17', lastCheckInMinutes: 128, note: 'Telematics unit stopped reporting near the Bellhaven tunnel.' },
    { id: 'HC-108', name: 'Swift', status: 'on-route', depotId: 'northgate', batteryPercent: 37, cargoPercent: 28, packagesRemaining: 12, odometerKm: 60310, telematicsIp: '203.0.113.18', lastCheckInMinutes: 2 },
    { id: 'HC-109', name: 'Lark', status: 'on-route', depotId: 'northgate', batteryPercent: 72, cargoPercent: 47, packagesRemaining: 26, odometerKm: 15490, telematicsIp: '203.0.113.19', lastCheckInMinutes: 1 },
    { id: 'HC-110', name: 'Wren', status: 'charging', depotId: 'northgate', batteryPercent: 29, cargoPercent: 0, packagesRemaining: 0, odometerKm: 28650, telematicsIp: '203.0.113.20', lastCheckInMinutes: 4 },

    // ── Riverside (Cranmoor) — 203.0.113.64/26 ────────────────────────────────
    { id: 'HC-111', name: 'Robin', status: 'on-route', depotId: 'riverside', batteryPercent: 63, cargoPercent: 51, packagesRemaining: 29, odometerKm: 44120, telematicsIp: '203.0.113.70', lastCheckInMinutes: 2 },
    { id: 'HC-112', name: 'Sparrow', status: 'idle', depotId: 'riverside', batteryPercent: 88, cargoPercent: 12, packagesRemaining: 5, odometerKm: 39870, telematicsIp: '203.0.113.71', lastCheckInMinutes: 9 },
    { id: 'HC-113', name: 'Puffin', status: 'on-route', depotId: 'riverside', batteryPercent: 18, cargoPercent: 34, packagesRemaining: 14, odometerKm: 52330, telematicsIp: '203.0.113.72', lastCheckInMinutes: 1 },
    { id: 'HC-114', name: 'Curlew', status: 'on-route', depotId: 'riverside', batteryPercent: 76, cargoPercent: 58, packagesRemaining: 31, odometerKm: 19240, telematicsIp: '203.0.113.73', lastCheckInMinutes: 3 },
    { id: 'HC-115', name: 'Plover', status: 'maintenance', depotId: 'riverside', batteryPercent: 40, cargoPercent: 0, packagesRemaining: 0, odometerKm: 88410, telematicsIp: '203.0.113.74', lastCheckInMinutes: 22, note: 'Scheduled brake service.' },
    { id: 'HC-116', name: 'Tern', status: 'charging', depotId: 'riverside', batteryPercent: 51, cargoPercent: 0, packagesRemaining: 0, odometerKm: 30980, telematicsIp: '203.0.113.75', lastCheckInMinutes: 5 },
    { id: 'HC-117', name: 'Egret', status: 'on-route', depotId: 'riverside', batteryPercent: 58, cargoPercent: 44, packagesRemaining: 21, odometerKm: 46700, telematicsIp: '203.0.113.76', lastCheckInMinutes: 2 },
    { id: 'HC-118', name: 'Ibis', status: 'on-route', depotId: 'riverside', batteryPercent: 84, cargoPercent: 66, packagesRemaining: 37, odometerKm: 11530, telematicsIp: '203.0.113.77', lastCheckInMinutes: 1 },

    // ── Eastport (Thornbury) — 203.0.113.128/26 ───────────────────────────────
    { id: 'HC-119', name: 'Kite', status: 'on-route', depotId: 'eastport', batteryPercent: 69, cargoPercent: 39, packagesRemaining: 18, odometerKm: 35420, telematicsIp: '203.0.113.140', lastCheckInMinutes: 2 },
    { id: 'HC-120', name: 'Merlin', status: 'idle', depotId: 'eastport', batteryPercent: 95, cargoPercent: 0, packagesRemaining: 0, odometerKm: 27810, telematicsIp: '203.0.113.141', lastCheckInMinutes: 73, note: 'Parked since the morning wave; unit reporting intermittently.' },
    { id: 'HC-121', name: 'Nightjar', status: 'on-route', depotId: 'eastport', batteryPercent: 44, cargoPercent: 53, packagesRemaining: 24, odometerKm: 58090, telematicsIp: '203.0.113.142', lastCheckInMinutes: 1 },
    { id: 'HC-122', name: 'Oriole', status: 'offline', depotId: 'eastport', batteryPercent: 0, cargoPercent: 21, packagesRemaining: 8, odometerKm: 71260, telematicsIp: '203.0.113.143', lastCheckInMinutes: 213, note: 'Reported a charging fault, then dropped off the network entirely.' },
    { id: 'HC-123', name: 'Petrel', status: 'on-route', depotId: 'eastport', batteryPercent: 66, cargoPercent: 48, packagesRemaining: 22, odometerKm: 23150, telematicsIp: '203.0.113.144', lastCheckInMinutes: 3 },
    { id: 'HC-124', name: 'Quail', status: 'charging', depotId: 'eastport', batteryPercent: 33, cargoPercent: 0, packagesRemaining: 0, odometerKm: 42680, telematicsIp: '203.0.113.145', lastCheckInMinutes: 6 },
    { id: 'HC-125', name: 'Redwing', status: 'on-route', depotId: 'eastport', batteryPercent: 15, cargoPercent: 29, packagesRemaining: 11, odometerKm: 49930, telematicsIp: '203.0.113.146', lastCheckInMinutes: 2 },
    { id: 'HC-126', name: 'Shrike', status: 'on-route', depotId: 'eastport', batteryPercent: 79, cargoPercent: 57, packagesRemaining: 30, odometerKm: 17840, telematicsIp: '203.0.113.147', lastCheckInMinutes: 1 },
    { id: 'HC-127', name: 'Teal', status: 'idle', depotId: 'eastport', batteryPercent: 90, cargoPercent: 0, packagesRemaining: 0, odometerKm: 36510, telematicsIp: '203.0.113.148', lastCheckInMinutes: 8 },

    // ── Summit Park (Westmarch) — 198.51.100.0/26 ─────────────────────────────
    { id: 'HC-128', name: 'Vireo', status: 'on-route', depotId: 'summit', batteryPercent: 61, cargoPercent: 43, packagesRemaining: 20, odometerKm: 40270, telematicsIp: '198.51.100.10', lastCheckInMinutes: 2 },
    { id: 'HC-129', name: 'Warbler', status: 'maintenance', depotId: 'summit', batteryPercent: 55, cargoPercent: 0, packagesRemaining: 0, odometerKm: 64380, telematicsIp: '198.51.100.11', lastCheckInMinutes: 31, note: 'Cargo door actuator on order.' },
    { id: 'HC-130', name: 'Yellowhammer', status: 'on-route', depotId: 'summit', batteryPercent: 73, cargoPercent: 60, packagesRemaining: 33, odometerKm: 12960, telematicsIp: '198.51.100.12', lastCheckInMinutes: 1 },
    { id: 'HC-131', name: 'Avocet', status: 'charging', depotId: 'summit', batteryPercent: 24, cargoPercent: 0, packagesRemaining: 0, odometerKm: 55740, telematicsIp: '198.51.100.13', lastCheckInMinutes: 4 },
    { id: 'HC-132', name: 'Bittern', status: 'on-route', depotId: 'summit', batteryPercent: 49, cargoPercent: 36, packagesRemaining: 16, odometerKm: 31420, telematicsIp: '198.51.100.14', lastCheckInMinutes: 3 },
    { id: 'HC-133', name: 'Chaffinch', status: 'idle', depotId: 'summit', batteryPercent: 86, cargoPercent: 0, packagesRemaining: 0, odometerKm: 25680, telematicsIp: '198.51.100.15', lastCheckInMinutes: 62, note: 'Sitting on the apron; last check-in over an hour ago.' },
    { id: 'HC-134', name: 'Dunlin', status: 'on-route', depotId: 'summit', batteryPercent: 11, cargoPercent: 25, packagesRemaining: 9, odometerKm: 67150, telematicsIp: '198.51.100.16', lastCheckInMinutes: 2 },

    // ── Lakeview (Aldergate) — 198.51.100.64/26 ───────────────────────────────
    { id: 'HC-135', name: 'Eider', status: 'on-route', depotId: 'lakeview', batteryPercent: 70, cargoPercent: 49, packagesRemaining: 25, odometerKm: 20430, telematicsIp: '198.51.100.70', lastCheckInMinutes: 1 },
    { id: 'HC-136', name: 'Fulmar', status: 'idle', depotId: 'lakeview', batteryPercent: 91, cargoPercent: 0, packagesRemaining: 0, odometerKm: 34760, telematicsIp: '198.51.100.71', lastCheckInMinutes: 7 },
    { id: 'HC-137', name: 'Gannet', status: 'on-route', depotId: 'lakeview', batteryPercent: 57, cargoPercent: 41, packagesRemaining: 19, odometerKm: 45890, telematicsIp: '198.51.100.72', lastCheckInMinutes: 2 },
    { id: 'HC-138', name: 'Hobby', status: 'charging', depotId: 'lakeview', batteryPercent: 38, cargoPercent: 0, packagesRemaining: 0, odometerKm: 29310, telematicsIp: '198.51.100.73', lastCheckInMinutes: 5 },
    { id: 'HC-139', name: 'Jackdaw', status: 'on-route', depotId: 'lakeview', batteryPercent: 82, cargoPercent: 63, packagesRemaining: 35, odometerKm: 14270, telematicsIp: '198.51.100.74', lastCheckInMinutes: 1 },
    { id: 'HC-140', name: 'Kingfisher', status: 'offline', depotId: 'lakeview', batteryPercent: 47, cargoPercent: 18, packagesRemaining: 7, odometerKm: 53640, telematicsIp: '198.51.100.75', lastCheckInMinutes: 96, note: 'Last seen leaving the Aldergate yard. No position fix since.' },
    { id: 'HC-141', name: 'Linnet', status: 'on-route', depotId: 'lakeview', batteryPercent: 64, cargoPercent: 46, packagesRemaining: 23, odometerKm: 38050, telematicsIp: '198.51.100.76', lastCheckInMinutes: 3 },
    { id: 'HC-142', name: 'Moorhen', status: 'idle', depotId: 'lakeview', batteryPercent: 89, cargoPercent: 0, packagesRemaining: 0, odometerKm: 26940, telematicsIp: '198.51.100.77', lastCheckInMinutes: 10 },

    // ── Old Quarry (Portvale) — 192.168.40.0/26 ───────────────────────────────
    { id: 'HC-143', name: 'Nuthatch', status: 'on-route', depotId: 'quarry', batteryPercent: 52, cargoPercent: 38, packagesRemaining: 17, odometerKm: 43810, telematicsIp: '192.168.40.10', lastCheckInMinutes: 2 },
    { id: 'HC-144', name: 'Ouzel', status: 'maintenance', depotId: 'quarry', batteryPercent: 30, cargoPercent: 0, packagesRemaining: 0, odometerKm: 79520, telematicsIp: '192.168.40.11', lastCheckInMinutes: 40, note: 'Awaiting a replacement traction battery module.' },
    { id: 'HC-145', name: 'Pintail', status: 'on-route', depotId: 'quarry', batteryPercent: 75, cargoPercent: 55, packagesRemaining: 28, odometerKm: 18690, telematicsIp: '192.168.40.12', lastCheckInMinutes: 1 },
    { id: 'HC-146', name: 'Rook', status: 'charging', depotId: 'quarry', batteryPercent: 41, cargoPercent: 0, packagesRemaining: 0, odometerKm: 32170, telematicsIp: '192.168.40.13', lastCheckInMinutes: 6 },
    { id: 'HC-147', name: 'Siskin', status: 'on-route', depotId: 'quarry', batteryPercent: 19, cargoPercent: 31, packagesRemaining: 13, odometerKm: 56420, telematicsIp: '192.168.40.14', lastCheckInMinutes: 4 },
    { id: 'HC-148', name: 'Turnstone', status: 'idle', depotId: 'quarry', batteryPercent: 87, cargoPercent: 0, packagesRemaining: 0, odometerKm: 24580, telematicsIp: '192.168.40.15', lastCheckInMinutes: 12 },
];
