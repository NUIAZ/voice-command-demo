/**
 * @file App.tsx
 * @description Shell: landmarks, view switching, and the wiring between command effects
 * and application state.
 *
 * There is no router. Three views, no deep links worth preserving, and a hash router
 * would add a dependency plus a whole class of base-path problems on GitHub Pages for
 * no benefit. View state is a `useState` and the nav is a real `<nav>` with buttons that
 * carry `aria-current`.
 */

import { useCallback, useState } from 'react';
import FleetView from './components/FleetView';
import CommandsView from './components/CommandsView';
import SupportView from './components/SupportView';
import VoicePanel from './components/VoicePanel';
import { useVoiceSession } from './hooks/useVoiceSession';
import type { CommandEffect, ViewId } from './services/commands';
import { STATUSES } from './data';
import type { VehicleStatus } from './data/types';

/** Nav definition. Order here is the tab order. */
const VIEWS: { id: ViewId; label: string }[] = [
    { id: 'fleet', label: 'Fleet' },
    { id: 'commands', label: 'Commands' },
    { id: 'support', label: 'Browser support' },
];

/**
 * Narrows the router's `string | null` status back to the `VehicleStatus` union without
 * an unchecked cast. The router deals in plain strings so it never has to import the
 * data layer's types; validating here keeps the app side honestly typed.
 */
function toVehicleStatus(value: string | null): VehicleStatus | null {
    if (value === null) return null;
    const match = STATUSES.find((s) => s.id === value);
    return match ? match.id : null;
}

/**
 * Root component. Holds the four pieces of application state a spoken command can move
 * (current view, status filter, depot filter, focused vehicle) and hands
 * `useVoiceSession` the one callback that mutates them.
 *
 * The filter and focus states are mutually exclusive by construction: applying a filter
 * clears the focused row and vice versa, because "show me the offline vans" and "where is
 * Kestrel" are different questions and answering both at once produces a table that
 * matches neither.
 *
 * Effects arrive as inert data, so this is the only place in the app where a spoken
 * command turns into a state change, which is what makes the voice layer removable and
 * the views ordinary.
 */
export default function App() {
    const [view, setView] = useState<ViewId>('fleet');
    const [statusFilter, setStatusFilter] = useState<VehicleStatus | null>(null);
    const [depotFilter, setDepotFilter] = useState<string | null>(null);
    const [focusedVehicleId, setFocusedVehicleId] = useState<string | null>(null);

    /**
     * Applies the effects a command asked for.
     *
     * Passed to `useVoiceSession` as an inline-ish callback; safe because the hook
     * stores it in a latest-ref rather than in an effect dependency array, so changing
     * it can never tear down the microphone session.
     */
    const handleEffect = useCallback((effect: CommandEffect) => {
        switch (effect.kind) {
            case 'navigate':
                setView(effect.view);
                break;
            case 'filter':
                setStatusFilter(toVehicleStatus(effect.status));
                setDepotFilter(effect.depotId);
                setFocusedVehicleId(null);
                setView('fleet');
                break;
            case 'focus':
                setFocusedVehicleId(effect.vehicleId);
                setStatusFilter(null);
                setDepotFilter(null);
                setView('fleet');
                break;
            case 'stop':
            case 'repeat':
            case 'settings':
            case 'none':
                // Handled inside the session (or intentionally inert here).
                break;
        }
    }, []);

    const session = useVoiceSession({ onEffect: handleEffect });

    return (
        <>
            {/* First focusable element on the page, per WCAG 2.4.1 "Bypass Blocks". */}
            <a className="skip-link" href="#main">
                Skip to main content
            </a>

            <header className="app-header">
                <div className="app-header__top">
                    <h1 className="app-header__title">Voice Command Demo</h1>
                    <p className="app-header__tag">
                        Hands-free control of a web app using only the browser&rsquo;s built-in Web Speech
                        API: no API keys, no backend, no cloud service of our own.
                    </p>
                </div>
                <nav className="app-nav" aria-label="Views">
                    <ul>
                        {VIEWS.map((v) => (
                            <li key={v.id}>
                                <button
                                    type="button"
                                    onClick={() => setView(v.id)}
                                    aria-current={view === v.id ? 'page' : undefined}
                                >
                                    {v.label}
                                </button>
                            </li>
                        ))}
                    </ul>
                </nav>
            </header>

            <div className="app-layout">
                {/*
                  `tabIndex={-1}` so the skip link can move focus here. Without it the
                  browser scrolls to the anchor but leaves focus at the top of the page,
                  and the next Tab press sends a keyboard user straight back into the nav.
                */}
                <main id="main" tabIndex={-1}>
                    {view === 'fleet' && (
                        <FleetView
                            statusFilter={statusFilter}
                            depotFilter={depotFilter}
                            focusedVehicleId={focusedVehicleId}
                            onStatusFilter={setStatusFilter}
                            onDepotFilter={setDepotFilter}
                        />
                    )}
                    {view === 'commands' && (
                        <CommandsView onRun={session.runCommand} speechSupported={session.support.recognition} />
                    )}
                    {view === 'support' && <SupportView support={session.support} />}
                </main>

                {/* The voice panel is a complementary landmark: useful alongside the main
                    content, but not the main content itself. */}
                <aside aria-label="Voice control">
                    <VoicePanel session={session} />
                </aside>
            </div>

            <footer className="app-footer">
                <p>
                    Every name, depot, vehicle and address in this demo is fictional. Addresses come from
                    the documentation ranges reserved by RFC 5737 and the private range of RFC 1918, so
                    none of them route anywhere.
                </p>
                <p>
                    <strong>Privacy:</strong> speech recognition is performed by your browser. In
                    Chrome and Edge that means the audio is sent to the browser vendor&rsquo;s speech
                    service for transcription. This page has no backend and stores nothing beyond your
                    voice preferences in <code>localStorage</code>.
                </p>
            </footer>
        </>
    );
}
