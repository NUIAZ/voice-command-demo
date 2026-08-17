/**
 * @file data.test.ts
 * @description Integrity checks on the fictional dataset and its extractors.
 *
 * The dataset is hand-written, so these tests guard against the two ways hand-written
 * data goes wrong: a typo that breaks a lookup (a depot id nothing matches, a duplicate
 * call sign) and a value drifting outside the reserved documentation ranges, which is
 * the one mistake in a public demo that would actually matter.
 */

import { describe, expect, it } from 'vitest';
import {
    DEPOTS,
    LOW_BATTERY_THRESHOLD,
    STATUSES,
    STALE_CHECKIN_MINUTES,
    VEHICLES,
    findVehicle,
    fleetSummary,
    getDepot,
    lowBatteryVehicles,
    matchDepotInTranscript,
    matchStatusInTranscript,
    matchVehicleInTranscript,
    staleCheckInVehicles,
    totalPackagesRemaining,
    vehiclesByDepot,
    vehiclesByStatus,
} from '../data';

describe('dataset integrity', () => {
    it('has a fleet large enough for the answers to be interesting', () => {
        expect(VEHICLES.length).toBe(48);
        expect(DEPOTS.length).toBe(6);
    });

    it('has unique asset tags and unique call signs', () => {
        expect(new Set(VEHICLES.map((v) => v.id)).size).toBe(VEHICLES.length);
        expect(new Set(VEHICLES.map((v) => v.name)).size).toBe(VEHICLES.length);
    });

    it('assigns every van to a depot that exists', () => {
        for (const vehicle of VEHICLES) {
            expect(getDepot(vehicle.depotId), vehicle.id).toBeDefined();
        }
    });

    it('gives every van a status from the closed set', () => {
        const ids = new Set(STATUSES.map((s) => s.id));
        for (const vehicle of VEHICLES) {
            expect(ids.has(vehicle.status), vehicle.id).toBe(true);
        }
    });

    it('uses ONLY reserved documentation and private address ranges', () => {
        // RFC 5737 reserves 203.0.113.0/24 and 198.51.100.0/24 for documentation;
        // RFC 1918 reserves 192.168.0.0/16 for private use. Nothing here can route.
        for (const vehicle of VEHICLES) {
            expect(vehicle.telematicsIp, vehicle.id).toMatch(
                /^(203\.0\.113\.\d{1,3}|198\.51\.100\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/,
            );
        }
    });

    it('keeps every percentage inside 0–100', () => {
        for (const vehicle of VEHICLES) {
            expect(vehicle.batteryPercent).toBeGreaterThanOrEqual(0);
            expect(vehicle.batteryPercent).toBeLessThanOrEqual(100);
            expect(vehicle.cargoPercent).toBeGreaterThanOrEqual(0);
            expect(vehicle.cargoPercent).toBeLessThanOrEqual(100);
        }
    });

    it('places each van on its depot subnet, as a real fleet would', () => {
        const prefixes: Record<string, string> = {
            northgate: '203.0.113.',
            riverside: '203.0.113.',
            eastport: '203.0.113.',
            summit: '198.51.100.',
            lakeview: '198.51.100.',
            quarry: '192.168.40.',
        };
        for (const vehicle of VEHICLES) {
            expect(vehicle.telematicsIp.startsWith(prefixes[vehicle.depotId]), vehicle.id).toBe(true);
        }
    });
});

describe('derived queries', () => {
    it('splits the fleet across the five states with the totals the demo quotes', () => {
        expect(vehiclesByStatus('on-route')).toHaveLength(26);
        expect(vehiclesByStatus('charging')).toHaveLength(7);
        expect(vehiclesByStatus('idle')).toHaveLength(8);
        expect(vehiclesByStatus('maintenance')).toHaveLength(4);
        expect(vehiclesByStatus('offline')).toHaveLength(3);
    });

    it('adds up to the whole fleet', () => {
        const summary = fleetSummary();
        expect(summary.onRoute + summary.charging + summary.idle + summary.maintenance + summary.offline).toBe(
            summary.total,
        );
    });

    it('totals the parcels still on board', () => {
        expect(totalPackagesRemaining()).toBe(626);
    });

    it('orders low-charge vans worst first', () => {
        const low = lowBatteryVehicles();
        expect(low.length).toBe(6);
        expect(low[0].name).toBe('Oriole');
        for (let i = 1; i < low.length; i++) {
            expect(low[i].batteryPercent).toBeGreaterThanOrEqual(low[i - 1].batteryPercent);
            expect(low[i].batteryPercent).toBeLessThanOrEqual(LOW_BATTERY_THRESHOLD);
        }
    });

    it('excludes offline vans from the stale check-in list to avoid double-reporting', () => {
        const stale = staleCheckInVehicles();
        expect(stale.map((v) => v.name)).toEqual(['Merlin', 'Chaffinch']);
        for (const vehicle of stale) {
            expect(vehicle.status).not.toBe('offline');
            expect(vehicle.lastCheckInMinutes).toBeGreaterThan(STALE_CHECKIN_MINUTES);
        }
    });

    it('groups vans by depot', () => {
        expect(vehiclesByDepot('riverside')).toHaveLength(8);
        expect(vehiclesByDepot('quarry')).toHaveLength(6);
        expect(vehiclesByDepot('nowhere')).toHaveLength(0);
    });

    it('finds a van by asset tag or call sign, case-insensitively', () => {
        expect(findVehicle('HC-101')?.name).toBe('Kestrel');
        expect(findVehicle('kestrel')?.id).toBe('HC-101');
        expect(findVehicle('nobody')).toBeUndefined();
    });
});

describe('transcript extractors', () => {
    it('pulls a call sign out of an utterance on word boundaries', () => {
        expect(matchVehicleInTranscript('tell me about kingfisher')?.id).toBe('HC-140');
        expect(matchVehicleInTranscript('the eastern depot')).toBeUndefined();
        expect(matchVehicleInTranscript('a stealthy plan')).toBeUndefined();
    });

    it('falls back to the digits of an asset tag', () => {
        expect(matchVehicleInTranscript('details for 144')?.name).toBe('Ouzel');
    });

    it('pulls a depot out of an utterance by name, town, or alias', () => {
        expect(matchDepotInTranscript('how is northgate')?.id).toBe('northgate');
        expect(matchDepotInTranscript('anything in cranmoor')?.id).toBe('riverside');
        expect(matchDepotInTranscript('at the old quarry')?.id).toBe('quarry');
        expect(matchDepotInTranscript('ask the driver')).toBeUndefined();
    });

    it('accepts the variant spellings a recogniser actually produces for a state', () => {
        expect(matchStatusInTranscript('which vans are en route')?.id).toBe('on-route');
        expect(matchStatusInTranscript('which vans are on root')?.id).toBe('on-route');
        expect(matchStatusInTranscript('anything plugged in')?.id).toBe('charging');
        expect(matchStatusInTranscript('who is parked')?.id).toBe('idle');
        expect(matchStatusInTranscript('anything in the shop')?.id).toBe('maintenance');
        expect(matchStatusInTranscript('what is off line')?.id).toBe('offline');
        expect(matchStatusInTranscript('give me a summary')).toBeUndefined();
    });
});
