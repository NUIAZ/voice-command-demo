/**
 * @file VoicePanel.tsx
 * @description The voice control surface: microphone button, live transcript, spoken
 * response, conversation history, a typed fallback, and the voice settings.
 *
 * ACCESSIBILITY DESIGN NOTES (the reasoning, not just the attributes):
 *
 * - The interim transcript and the assistant's response live in separate `aria-live`
 *   regions. Separate, because they update on completely different cadences: interim
 *   text changes several times a second while you are mid-word, and a screen reader
 *   trying to announce every revision produces unusable noise. The interim region is
 *   `aria-live="polite"` with `aria-atomic="false"` so a reader can coalesce, while the
 *   response region is `role="status"` + `aria-atomic="true"` so the answer is read as
 *   one complete sentence.
 *
 * - The microphone button is a real `<button>` with `aria-pressed`, so its state is
 *   exposed rather than implied by colour. Its accessible name changes with the state.
 *
 * - The status line is also `role="status"`: transitions like "listening → speaking" are
 *   invisible to someone not watching the pulse ring.
 *
 * - The text input is not a lesser fallback. It routes through exactly the same
 *   `processTranscript` pipeline as speech, so anyone who cannot or will not speak gets
 *   the identical feature set.
 */

import { useEffect, useRef, useState } from 'react';
import type { SpeechStatus } from '../services/speech';
import type { VoiceSession } from '../hooks/useVoiceSession';

interface Props {
    session: VoiceSession;
}

/** Human-readable status, plus a hint that tells the user what to do next. */
const STATUS_TEXT: Record<SpeechStatus, { label: string; hint: string }> = {
    unsupported: {
        label: 'Speech recognition unavailable',
        hint: 'This browser cannot listen. Use the Try it buttons or the text box below.',
    },
    idle: { label: 'Not listening', hint: 'Press the microphone to start.' },
    starting: { label: 'Starting…', hint: 'Waiting for the microphone. Do not speak yet.' },
    listening: { label: 'Listening', hint: 'Say a command, or “help” for a summary.' },
    speaking: {
        label: 'Speaking',
        hint: 'The microphone is paused while answering, so it does not hear itself.',
    },
    'mic-blocked': {
        label: 'Microphone blocked',
        hint: 'Allow the microphone from the address bar, then reload.',
    },
    error: { label: 'Something went wrong', hint: 'See the message below, then try again.' },
};

/** Inline SVG so the page has no icon-font or image dependency. */
function MicIcon({ muted }: { muted: boolean }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" strokeLinecap="round" />
            <path d="M12 18v4" strokeLinecap="round" />
            {muted && <path d="M4 3l16 18" strokeLinecap="round" />}
        </svg>
    );
}

/**
 * Renders a `VoiceSession` and nothing else; it holds no session state of its own,
 * only the two bits of local UI state (the typed draft and whether the settings
 * disclosure is open).
 *
 * Every control here has a keyboard- and pointer-reachable equivalent to a spoken
 * command, which is the accessibility floor this demo sets for itself: the text box
 * routes through the same pipeline as speech, and the settings sliders write the same
 * values the "speak faster" / "mute" commands do.
 *
 * The conversation log auto-scrolls to a sentinel `<li>` rather than to a wrapper div;
 * see the note on `logEndRef` for why that element type matters.
 */
export default function VoicePanel({ session }: Props) {
    const [typed, setTyped] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    // Typed as an <li>: the scroll sentinel has to be a valid child of the <ul> it lives
    // in. A stray <div> inside a list is invalid HTML and, more practically, breaks the
    // list semantics that screen readers use to announce "list, 6 items".
    const logEndRef = useRef<HTMLLIElement | null>(null);

    const status = STATUS_TEXT[session.status];
    const canListen = session.support.recognition && session.support.secureContext;

    // Keep the newest log entry in view. `block: 'nearest'` scrolls the log container
    // only: `scrollIntoView` with the default block value yanks the whole page, which
    // is disorienting and, for a sighted keyboard user, loses their place entirely.
    useEffect(() => {
        // Feature-detected for the same reason as the fleet table's scroll: it is a
        // nicety, and an effect that throws unmounts the tree.
        if (typeof logEndRef.current?.scrollIntoView === 'function') {
            logEndRef.current.scrollIntoView({ block: 'nearest' });
        }
    }, [session.entries.length, session.interim]);

    return (
        <div className="voice-panel">
            <section className="panel" aria-labelledby="voice-heading">
                <div className="panel__head">
                    <h2 id="voice-heading">Voice control</h2>
                    <button
                        type="button"
                        className="btn btn--small"
                        aria-expanded={showSettings}
                        aria-controls="voice-settings"
                        onClick={() => setShowSettings((s) => !s)}
                    >
                        {showSettings ? 'Hide settings' : 'Settings'}
                    </button>
                </div>

                {/* ── Blocked microphone gets its own explanatory panel, not a generic
                       error string. This is the whole point of pre-flighting permission:
                       the user is told exactly which control to use to undo it. ── */}
                {session.status === 'mic-blocked' && (
                    <div className="notice notice--bad">
                        <p>
                            <strong>The microphone is blocked for this page.</strong>
                        </p>
                        <p>
                            Click the padlock (or camera) icon at the left of the address bar, set{' '}
                            <strong>Microphone</strong> to <strong>Allow</strong>, then reload. A denied
                            permission is remembered per site, so the browser will not ask again on its
                            own.
                        </p>
                        <p style={{ marginBottom: 0 }}>
                            Everything still works without a microphone; use{' '}
                            <strong>Try it</strong> on the Commands page, or the text box below.
                        </p>
                        <div className="btn-row" style={{ marginTop: '8px' }}>
                            <button type="button" className="btn btn--small" onClick={session.retry}>
                                Try the microphone again
                            </button>
                        </div>
                    </div>
                )}

                {session.error && session.status !== 'mic-blocked' && (
                    <div className="notice notice--warn" role="alert">
                        <p style={{ marginBottom: 0 }}>{session.error.message}</p>
                    </div>
                )}

                {!session.support.recognition && (
                    <div className="notice notice--info">
                        <p style={{ marginBottom: 0 }}>
                            This browser does not implement speech recognition. Firefox, most
                            notably. Use the <strong>Try it</strong> buttons on the Commands page or the
                            text box below; answers are still spoken aloud if speech synthesis is
                            available.
                        </p>
                    </div>
                )}

                {session.support.recognition && !session.support.secureContext && (
                    <div className="notice notice--warn">
                        <p style={{ marginBottom: 0 }}>
                            This page is not a secure context, so the browser will refuse microphone
                            access. Serve it over HTTPS or from <code>localhost</code>.
                        </p>
                    </div>
                )}

                <div className="voice-mic">
                    <button
                        type="button"
                        className={`mic-button${session.listening ? ' is-listening' : ''}`}
                        onClick={session.toggle}
                        disabled={!canListen}
                        aria-pressed={session.listening}
                        aria-describedby="voice-status-line"
                    >
                        <span className="mic-button__pulse" aria-hidden="true" />
                        <MicIcon muted={session.settings.muted} />
                        <span className="sr-only">
                            {session.listening ? 'Stop listening' : 'Start listening'}
                        </span>
                    </button>

                    {/*
                      role="status" (an implicit aria-live="polite") so state changes are
                      announced. Without this, a screen-reader user has no way to know the
                      microphone went live, went quiet, or failed.
                    */}
                    <p className="status-line" id="voice-status-line" role="status">
                        {status.label}
                        <small>{status.hint}</small>
                    </p>
                </div>

                {/* ── LIVE TRANSCRIPT ──────────────────────────────────────────────
                    Interim results are what make a voice UI feel responsive: without
                    them there is a two-second void where the user cannot tell whether
                    they were heard at all. aria-atomic="false" so assistive tech can
                    coalesce the rapid partial updates instead of restarting the
                    announcement on every revision. */}
                <div
                    className="transcript-live"
                    aria-live="polite"
                    aria-atomic="false"
                    aria-label="Live transcript"
                >
                    {session.interim ? (
                        <span className="transcript-live__interim">{session.interim}…</span>
                    ) : (
                        <span className="muted small">
                            {session.listening
                                ? 'Listening. What you say appears here as you speak.'
                                : 'Your words will appear here while you speak.'}
                        </span>
                    )}
                </div>

                {/* The answer, as text, in its own live region. Atomic, because a partial
                    sentence read aloud out of order is worse than no announcement. */}
                <div
                    className="transcript-live"
                    role="status"
                    aria-atomic="true"
                    aria-label="Latest response"
                    style={{ borderStyle: 'solid' }}
                >
                    {session.lastResponse ? (
                        session.lastResponse
                    ) : (
                        <span className="muted small">Answers appear here as text as well as speech.</span>
                    )}
                </div>

                {/* ── TYPED FALLBACK ──────────────────────────────────────────────
                    Same pipeline as speech, no microphone required. */}
                <form
                    className="text-command"
                    onSubmit={(e) => {
                        e.preventDefault();
                        session.submitText(typed);
                        setTyped('');
                    }}
                >
                    <label className="sr-only" htmlFor="typed-command">
                        Type a command instead of speaking
                    </label>
                    <input
                        id="typed-command"
                        type="text"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder="Type a command, e.g. any problems"
                        autoComplete="off"
                    />
                    <button type="submit" className="btn btn--primary" disabled={typed.trim().length === 0}>
                        Run
                    </button>
                </form>

                <div className="btn-row" style={{ marginTop: '10px' }}>
                    <button
                        type="button"
                        className="btn btn--small"
                        aria-pressed={session.settings.muted}
                        onClick={() => session.updateSettings({ muted: !session.settings.muted })}
                    >
                        {session.settings.muted ? 'Unmute answers' : 'Mute answers'}
                    </button>
                    <button
                        type="button"
                        className="btn btn--small"
                        onClick={session.clearHistory}
                        disabled={session.entries.length === 0}
                    >
                        Clear history
                    </button>
                </div>
            </section>

            {showSettings && (
                <section className="panel" id="voice-settings" aria-labelledby="voice-settings-heading">
                    <h3 id="voice-settings-heading">Voice settings</h3>

                    <label className="field">
                        <span>Voice</span>
                        <select
                            value={session.settings.voiceUri ?? ''}
                            onChange={(e) => session.updateSettings({ voiceUri: e.target.value || null })}
                        >
                            <option value="">Browser default</option>
                            {/* Every installed voice, not just the English ones; filtering
                                the list to one language hides the voices a non-English user
                                actually has. */}
                            {session.voices.map((voice) => (
                                <option key={voice.voiceURI} value={voice.voiceURI}>
                                    {voice.name} ({voice.lang}){voice.localService ? '' : ' (network)'}
                                </option>
                            ))}
                        </select>
                        {session.voices.length === 0 && (
                            <span className="small muted">
                                No voices reported yet. Chrome loads them asynchronously; they usually
                                appear a moment after the page does.
                            </span>
                        )}
                    </label>

                    <label className="field">
                        <span>Speed: {session.settings.rate.toFixed(2)}×</span>
                        <input
                            type="range"
                            min="0.5"
                            max="2"
                            step="0.05"
                            value={session.settings.rate}
                            onChange={(e) => session.updateSettings({ rate: Number(e.target.value) })}
                        />
                    </label>

                    <label className="field">
                        <span>Pitch: {session.settings.pitch.toFixed(2)}</span>
                        <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.05"
                            value={session.settings.pitch}
                            onChange={(e) => session.updateSettings({ pitch: Number(e.target.value) })}
                        />
                    </label>

                    <div className="switch-row">
                        <input
                            id="mute-toggle"
                            type="checkbox"
                            checked={session.settings.muted}
                            onChange={(e) => session.updateSettings({ muted: e.target.checked })}
                        />
                        <label htmlFor="mute-toggle">Mute spoken answers (still shown as text)</label>
                    </div>

                    <div className="btn-row">
                        <button
                            type="button"
                            className="btn btn--small"
                            onClick={session.previewVoice}
                            disabled={session.settings.muted}
                        >
                            Test voice
                        </button>
                        <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => session.applySettingsChange('reset')}
                        >
                            Reset to defaults
                        </button>
                    </div>

                    <p className="small muted" style={{ marginTop: '10px', marginBottom: 0 }}>
                        Saved to <code>localStorage</code> and applied to the very next sentence,
                        including one already being spoken.
                    </p>
                </section>
            )}

            <section className="panel" aria-labelledby="history-heading">
                <h3 id="history-heading">Command history</h3>
                {session.entries.length === 0 ? (
                    <p className="small muted" style={{ marginBottom: 0 }}>
                        Nothing yet. Start listening, press a <strong>Try it</strong> button on the
                        Commands page, or type a command above.
                    </p>
                ) : (
                    <ul className="log">
                        {session.entries.map((entry) => (
                            <li key={entry.id} className={`log__entry log__entry--${entry.role}`}>
                                <span className="log__role">
                                    {entry.role === 'user'
                                        ? 'You'
                                        : entry.role === 'assistant'
                                          ? 'Assistant'
                                          : 'System'}
                                    {entry.commandId ? ` · ${entry.commandId}` : ''}
                                </span>
                                {entry.text}
                            </li>
                        ))}
                        <li ref={logEndRef} aria-hidden="true" style={{ height: 0, border: 0, padding: 0 }} />
                    </ul>
                )}
            </section>
        </div>
    );
}
