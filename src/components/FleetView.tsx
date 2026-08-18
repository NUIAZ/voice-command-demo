/**
 * @file FleetView.tsx
 * @description The main demo view: the fictional fleet as KPI tiles, filter chips, and
 * a table.
 *
 * This is the "application" the voice interface is controlling. It matters that it is a
 * real, ordinary UI (filters and a table that work perfectly well with a mouse) because
 * the point being demonstrated is voice control *of an app*, not a voice app. Every
 * spoken command has a visible counterpart here, and both drive the same state.
 */

import { useEffect, useRef } from 'react';
import {
    DEPOTS,
    LOW_BATTERY_THRESHOLD,
    STALE_CHECKIN_MINUTES,
    STATUSES,
    VEHICLES,
    depotName,
    fleetSummary,
    getStatus,
} from '../data';
import type { Vehicle, VehicleStatus } from '../data/types';
import { speakMinutes } from '../services/speechFormat';

interface Props {
    statusFilter: VehicleStatus | null;
    depotFilter: string | null;
    /** Asset id of the row the voice interface just described, if any. */
    focusedVehicleId: string | null;
    onStatusFilter: (status: VehicleStatus | null) => void;
    onDepotFilter: (depotId: string | null) => void;
}

/** Tone for the battery bar. Colour is always paired with the numeric label beside it. */
function batteryTone(percent: number): 'ok' | 'warn' | 'bad' {
    if (percent <= LOW_BATTERY_THRESHOLD) return 'bad';
    if (percent <= 40) return 'warn';
    return 'ok';
}

/**
 * Fully controlled: it derives everything from `VEHICLES` on each render and owns no
 * state, so a filter set by voice and one set by clicking a chip are literally the same
 * code path. That is the property the demo is trying to show, and it only holds while
 * this component stays stateless.
 *
 * `statusFilter` and `depotFilter` combine with AND (both null means the whole fleet).
 * `focusedVehicleId` is separate: it scrolls the matching row into view and marks it, and
 * the parent guarantees it is never set at the same time as a filter.
 */
export default function FleetView({
    statusFilter,
    depotFilter,
    focusedVehicleId,
    onStatusFilter,
    onDepotFilter,
}: Props) {
    const summary = fleetSummary();
    const focusedRowRef = useRef<HTMLTableRowElement | null>(null);

    const visible: Vehicle[] = VEHICLES.filter(
        (v) =>
            (statusFilter === null || v.status === statusFilter) &&
            (depotFilter === null || v.depotId === depotFilter),
    );

    /**
     * Scroll the row the assistant just talked about into view.
     *
     * `behavior` is chosen from the user's motion preference rather than hard-coded to
     * 'smooth': an unexpected smooth scroll is a motion trigger, and the media query is
     * the user telling us so.
     */
    useEffect(() => {
        if (!focusedVehicleId || !focusedRowRef.current) return;
        // Feature-detected: `scrollIntoView` is not implemented by every DOM environment
        // (jsdom, notably), and scrolling is a nicety; it must never be able to throw
        // from an effect and take the whole tree down with it.
        if (typeof focusedRowRef.current.scrollIntoView !== 'function') return;
        const reduceMotion =
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        focusedRowRef.current.scrollIntoView({
            behavior: reduceMotion ? 'auto' : 'smooth',
            block: 'center',
        });
    }, [focusedVehicleId]);

    const filterDescription = [
        statusFilter ? getStatus(statusFilter).label.toLowerCase() : null,
        depotFilter ? `at ${depotName(depotFilter)}` : null,
    ]
        .filter(Boolean)
        .join(' ');

    return (
        <>
            <section className="panel" aria-labelledby="fleet-heading">
                <div className="panel__head">
                    <h2 id="fleet-heading">Harborline Courier Co.: fleet status</h2>
                    <span className="muted small">Fictional data. Nothing here is real.</span>
                </div>

                <ul className="kpis">
                    <li className="kpi">
                        <div className="kpi__value">{summary.total}</div>
                        <div className="kpi__label">vans in fleet</div>
                    </li>
                    <li className="kpi">
                        <div className="kpi__value">{summary.onRoute}</div>
                        <div className="kpi__label">on route</div>
                    </li>
                    <li className="kpi">
                        <div className="kpi__value">{summary.charging}</div>
                        <div className="kpi__label">charging</div>
                    </li>
                    <li className="kpi">
                        <div className="kpi__value">{summary.offline + summary.maintenance}</div>
                        <div className="kpi__label">offline or in maintenance</div>
                    </li>
                    <li className="kpi">
                        <div className="kpi__value">{summary.lowBattery}</div>
                        <div className="kpi__label">at or below {LOW_BATTERY_THRESHOLD}% charge</div>
                    </li>
                    <li className="kpi">
                        <div className="kpi__value">{summary.packagesRemaining}</div>
                        <div className="kpi__label">parcels still on board</div>
                    </li>
                </ul>

                <p className="small muted" style={{ marginTop: '12px', marginBottom: 0 }}>
                    Try saying <strong>&ldquo;are there any problems&rdquo;</strong>,{' '}
                    <strong>&ldquo;how many vans are charging&rdquo;</strong>, or{' '}
                    <strong>&ldquo;tell me about Kingfisher&rdquo;</strong>. A van is flagged when it is
                    offline, in maintenance, at or below {LOW_BATTERY_THRESHOLD}% charge, or has not
                    checked in for over {STALE_CHECKIN_MINUTES} minutes.
                </p>
            </section>

            <section className="panel" aria-labelledby="filter-heading">
                <h3 id="filter-heading">Filters</h3>

                <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
                    <legend className="small muted" style={{ padding: 0, marginBottom: '5px' }}>
                        State
                    </legend>
                    <div className="chips">
                        <button
                            type="button"
                            className="chip"
                            aria-pressed={statusFilter === null}
                            onClick={() => onStatusFilter(null)}
                        >
                            All states
                        </button>
                        {STATUSES.map((s) => (
                            <button
                                key={s.id}
                                type="button"
                                className="chip"
                                aria-pressed={statusFilter === s.id}
                                onClick={() => onStatusFilter(statusFilter === s.id ? null : s.id)}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                </fieldset>

                <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="small muted" style={{ padding: 0, marginBottom: '5px' }}>
                        Depot
                    </legend>
                    <div className="chips">
                        <button
                            type="button"
                            className="chip"
                            aria-pressed={depotFilter === null}
                            onClick={() => onDepotFilter(null)}
                        >
                            All depots
                        </button>
                        {DEPOTS.map((d) => (
                            <button
                                key={d.id}
                                type="button"
                                className="chip"
                                aria-pressed={depotFilter === d.id}
                                onClick={() => onDepotFilter(depotFilter === d.id ? null : d.id)}
                            >
                                {d.name}
                            </button>
                        ))}
                    </div>
                </fieldset>
            </section>

            <section className="panel" aria-labelledby="table-heading">
                <div className="panel__head">
                    <h3 id="table-heading">Vehicles</h3>
                    {/*
                      Announced when the voice interface changes the filter, so a screen
                      reader user hears the table changed without having to go looking.
                    */}
                    <p className="small muted" role="status" style={{ margin: 0 }}>
                        Showing {visible.length} of {VEHICLES.length}
                        {filterDescription ? `: ${filterDescription}` : ''}
                    </p>
                </div>

                <div className="table-wrap">
                    <table>
                        <caption className="sr-only">
                            Fleet vehicles with operational state, depot, charge, load, parcels
                            remaining, odometer, telematics address and last check-in.
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">Call sign</th>
                                <th scope="col">Asset</th>
                                <th scope="col">State</th>
                                <th scope="col">Depot</th>
                                <th scope="col">Charge</th>
                                <th scope="col" className="num">
                                    Load
                                </th>
                                <th scope="col" className="num">
                                    Parcels
                                </th>
                                <th scope="col" className="num">
                                    Odometer
                                </th>
                                <th scope="col">Telematics</th>
                                <th scope="col">Last check-in</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((v) => {
                                const isFocused = v.id === focusedVehicleId;
                                const tone = getStatus(v.status).tone;
                                return (
                                    <tr
                                        key={v.id}
                                        ref={isFocused ? focusedRowRef : undefined}
                                        className={isFocused ? 'is-focused' : undefined}
                                    >
                                        <th scope="row" style={{ fontWeight: 650 }}>
                                            {v.name}
                                            {isFocused && <span className="sr-only"> (currently described)</span>}
                                        </th>
                                        <td className="mono">{v.id}</td>
                                        <td>
                                            <span className={`pill pill--${tone}`}>{getStatus(v.status).label}</span>
                                        </td>
                                        <td>{depotName(v.depotId)}</td>
                                        <td>
                                            <span className="meter" aria-hidden="true">
                                                <span
                                                    className={`meter__fill meter__fill--${batteryTone(v.batteryPercent)}`}
                                                    style={{ width: `${v.batteryPercent}%` }}
                                                />
                                            </span>
                                            {v.batteryPercent}%
                                        </td>
                                        <td className="num">{v.cargoPercent}%</td>
                                        <td className="num">{v.packagesRemaining}</td>
                                        <td className="num">{v.odometerKm.toLocaleString('en-GB')} km</td>
                                        <td className="mono">{v.telematicsIp}</td>
                                        <td>{speakMinutes(v.lastCheckInMinutes)} ago</td>
                                    </tr>
                                );
                            })}
                            {visible.length === 0 && (
                                <tr>
                                    <td colSpan={10} className="muted">
                                        No vans match this filter.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
        </>
    );
}
