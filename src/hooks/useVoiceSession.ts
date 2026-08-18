/**
 * @file useVoiceSession.ts
 * @description React binding for `SpeechService` + `commands`.
 *
 * This is the only React-aware part of the voice stack. It owns the conversation
 * history, applies command effects, and keeps the service's callbacks pointed at
 * up-to-date logic.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STALE-CLOSURE BUG THIS FILE EXISTS TO AVOID
 * ─────────────────────────────────────────────────────────────────────────────
 * The reference implementation set up its speech service inside a
 * `useEffect(..., [isOpen])`. The result handler it installed closed over `muted`,
 * `speechRate` and `speechPitch` as they were AT THE MOMENT THE EFFECT RAN. Those
 * variables are captured by value, and the effect never re-ran, so:
 *
 *   - toggling mute mid-session did nothing at all; the handler kept reading the
 *     `muted` value from session start and kept speaking;
 *   - the rate and pitch sliders appeared to work (they wrote to the service object
 *     directly) but the mute check did not, which is a genuinely baffling combination
 *     to debug because "some of the settings work".
 *
 * The naive repair (adding `muted` to the dependency array) is worse: the effect
 * would tear the whole service down and construct a new one on every toggle, which
 * kills the microphone, drops the transcript, and re-triggers the permission flow.
 *
 * The fix used here is two-part:
 *
 *   1. Settings live inside the service, in one mutable object, and `speak()` reads
 *      them at call time. There is no captured copy anywhere.
 *   2. Everything else that the service calls back into goes through a "latest ref":
 *      a ref updated after every render, so the callback installed once at mount
 *      always invokes the CURRENT logic with the CURRENT props. The service is
 *      constructed exactly once and survives every re-render.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    DEFAULT_VOICE_SETTINGS,
    SpeechService,
    detectSpeechSupport,
} from '../services/speech';
import type {
    SpeechErrorInfo,
    SpeechStatus,
    SpeechSupport,
    VoiceSettings,
} from '../services/speech';
import type { SpeechHostWindow } from '../services/speechTypes';
import {
    getCommand,
    processTranscript,
    runCommandById,
} from '../services/commands';
import type { CommandEffect, CommandResult, SettingsChange } from '../services/commands';

/** One line in the on-screen conversation log. */
export interface TranscriptEntry {
    /** Monotonic, so React keys never collide even within the same millisecond. */
    id: number;
    role: 'user' | 'assistant' | 'system';
    text: string;
    at: number;
    /** Which command answered, when one did. Shown as a subtle badge. */
    commandId?: string | null;
}

/** Everything the UI needs from a voice session. */
export interface VoiceSession {
    support: SpeechSupport;
    status: SpeechStatus;
    /** Live partial transcription while the user is mid-sentence. */
    interim: string;
    entries: TranscriptEntry[];
    /** The most recent spoken answer, so "repeat" has something to say. */
    lastResponse: string;
    error: SpeechErrorInfo | null;
    voices: SpeechSynthesisVoice[];
    settings: VoiceSettings;
    listening: boolean;
    start: () => void;
    stop: () => void;
    toggle: () => void;
    updateSettings: (patch: Partial<VoiceSettings>) => void;
    applySettingsChange: (change: SettingsChange) => void;
    /** Runs a command by id without a microphone: the Commands page "Try it" buttons. */
    runCommand: (id: string) => void;
    /** Routes typed text through the identical pipeline as speech. */
    submitText: (text: string) => void;
    clearHistory: () => void;
    previewVoice: () => void;
    /** Clears a `mic-blocked` / `error` state and tries again. */
    retry: () => void;
}

/**
 * The hook's entire configuration surface: one callback, and nothing that could
 * plausibly change mid-session.
 *
 * Everything else a caller might want to configure (voice, rate, pitch, mute) is
 * deliberately NOT here. Those live in the service, are persisted to localStorage, and
 * are changed through `updateSettings`; accepting them as options would reintroduce the
 * captured-value bug described in the file header.
 */
export interface UseVoiceSessionOptions {
    /**
     * Applies the non-speech effects (navigation, filtering, focusing, stopping).
     * Held in a latest-ref, so it may be an inline arrow function without causing the
     * service to be rebuilt.
     */
    onEffect: (effect: CommandEffect) => void;
}

/** How much of the conversation to keep. Old entries are dropped from the top. */
const MAX_ENTRIES = 120;

/** Step sizes for the spoken "faster"/"slower"/"higher"/"lower" commands. */
const RATE_STEP = 0.15;
const PITCH_STEP = 0.2;

/**
 * The voice stack's single entry point: microphone in, spoken answer out, conversation
 * log and controls returned for the UI to render.
 *
 * ── WHAT IT OWNS ────────────────────────────────────────────────────────────────
 * One `SpeechService` instance, held in a ref and constructed exactly once per mount.
 * The conversation log (`entries`, capped at `MAX_ENTRIES` with the oldest dropped from
 * the top), the last spoken answer (so the "repeat" command has something to say), the
 * live interim transcript, the current status and error, and the voice list. It does NOT
 * own the voice settings: those live inside the service and are read at speak time.
 *
 * ── WHAT IT DELIBERATELY DOES NOT OWN ───────────────────────────────────────────
 * Application state. Navigation, filtering and focusing are emitted as `CommandEffect`
 * data and handed to the caller's `onEffect`. The hook applies exactly two effects
 * itself: `settings` (because only it can read the service's current rate/pitch to apply
 * a *relative* change) and `stop`.
 *
 * ── THE LATEST-REF PLUMBING, AND WHY IT IS NOT OPTIONAL ─────────────────────────
 * `SpeechService` is not React-aware: its callbacks are plain property assignments,
 * installed once when the service is built. If those callbacks closed over props and
 * state directly they would freeze at mount, which is exactly the bug documented in the
 * file header: mute stopped working mid-session while the rate slider kept working,
 * because one path read a captured copy and the other wrote to the service object.
 *
 * The repair is that `onEffect` and the final-transcript handler are stored in refs
 * refreshed by an effect with NO dependency array (i.e. after every render), and the
 * service's callbacks dereference those refs instead of capturing anything. Adding
 * dependencies to the construction effect would be the naive alternative and is worse:
 * it tears the service down and rebuilds it, which kills the microphone, drops the
 * transcript, and re-triggers the permission prompt on every mute toggle.
 *
 * ── LIFECYCLE ───────────────────────────────────────────────────────────────────
 * Support is probed synchronously during the first render so the UI can render the right
 * affordances on the very first paint rather than flashing a microphone button at a
 * browser that has none. The service is then constructed in a mount effect (not a
 * `useState` initialiser, so React 19 StrictMode's double-mount produces a clean
 * construct → destroy → construct cycle rather than an orphan holding a live
 * `voiceschanged` listener), and torn down via `service.destroy()` on unmount.
 *
 * Nothing here starts listening on its own. `start()` must be called from a user
 * gesture: browsers gate microphone access on one, and an app that opens the mic on
 * mount is an app people close.
 *
 * ── ONE PIPELINE, THREE ENTRY POINTS ────────────────────────────────────────────
 * Speech (`onFinal`), typed input (`submitText`) and the Commands page's "Try it"
 * buttons (`runCommand`) all funnel through the same `deliver` path, so a clicked
 * command can never behave differently from a spoken one. Within `deliver` the ordering
 * is intentional: effects are applied BEFORE the audio starts, so the screen and the
 * voice agree; `stop` is applied AFTER, so the goodbye is not spoken into a session
 * that has already ended.
 */
export function useVoiceSession({ onEffect }: UseVoiceSessionOptions): VoiceSession {
    // Support is probed synchronously so the UI can render the right affordances on the
    // very first paint, rather than flashing a microphone button at a Firefox user.
    const support = useMemo<SpeechSupport>(
        () =>
            detectSpeechSupport(
                typeof window === 'undefined' ? null : (window as unknown as SpeechHostWindow),
            ),
        [],
    );

    const [status, setStatus] = useState<SpeechStatus>(support.recognition ? 'idle' : 'unsupported');
    const [interim, setInterim] = useState('');
    const [entries, setEntries] = useState<TranscriptEntry[]>([]);
    const [lastResponse, setLastResponse] = useState('');
    const [error, setError] = useState<SpeechErrorInfo | null>(null);
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);

    const serviceRef = useRef<SpeechService | null>(null);
    const entryIdRef = useRef(0);
    const lastResponseRef = useRef('');

    /* ── Latest-ref plumbing ──────────────────────────────────────────────────
       These refs are reassigned after EVERY render. The service's callbacks are
       installed once, at mount, and dereference these, so they always run the newest
       closure without the service ever being rebuilt. This is the whole fix. */
    const onEffectRef = useRef(onEffect);
    const handleFinalRef = useRef<(text: string) => void>(() => {});

    const pushEntry = useCallback(
        (role: TranscriptEntry['role'], text: string, commandId?: string | null) => {
            setEntries((prev) => {
                const next: TranscriptEntry[] = [
                    ...prev,
                    { id: ++entryIdRef.current, role, text, at: Date.now(), commandId },
                ];
                return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
            });
        },
        [],
    );

    /** Applies a relative settings change against whatever the service currently holds. */
    const applySettingsChange = useCallback((change: SettingsChange) => {
        const service = serviceRef.current;
        if (!service) return;
        const current = service.settings;
        let patch: Partial<VoiceSettings>;
        switch (change) {
            case 'faster':
                patch = { rate: Math.min(2, Number((current.rate + RATE_STEP).toFixed(2))) };
                break;
            case 'slower':
                patch = { rate: Math.max(0.5, Number((current.rate - RATE_STEP).toFixed(2))) };
                break;
            case 'pitch-up':
                patch = { pitch: Math.min(2, Number((current.pitch + PITCH_STEP).toFixed(2))) };
                break;
            case 'pitch-down':
                patch = { pitch: Math.max(0, Number((current.pitch - PITCH_STEP).toFixed(2))) };
                break;
            case 'mute':
                patch = { muted: true };
                break;
            case 'unmute':
                patch = { muted: false };
                break;
            case 'reset':
                patch = { ...DEFAULT_VOICE_SETTINGS };
                break;
        }
        setSettings(service.updateSettings(patch));
    }, []);

    /**
     * Shared delivery path for spoken commands, typed commands, and "Try it" clicks.
     * All three go through the identical code so the demo can never drift into having
     * a click-only behaviour that differs from the spoken one.
     */
    const deliver = useCallback(
        async (result: CommandResult, echo: string) => {
            pushEntry('user', echo);

            // `repeat` is resolved here rather than in the router, which is pure and has
            // no memory of previous answers.
            let spoken = result.response;
            if (result.effect.kind === 'repeat' && lastResponseRef.current) {
                spoken = lastResponseRef.current;
            }

            pushEntry('assistant', spoken, result.commandId);
            lastResponseRef.current = spoken;
            setLastResponse(spoken);

            // Effects land before the audio starts so the screen and the voice agree:
            // hearing "3 vans are offline" while the table still shows everything is
            // exactly the sort of mismatch that makes an interface feel unreliable.
            if (result.effect.kind === 'settings') applySettingsChange(result.effect.change);
            else onEffectRef.current(result.effect);

            await serviceRef.current?.speak(spoken);

            // Stop AFTER the confirmation has been spoken; cutting the microphone first
            // would mean the goodbye is spoken into a session that is already gone, and
            // `speak()` would restart listening behind it.
            if (result.effect.kind === 'stop') serviceRef.current?.stop();
        },
        [applySettingsChange, pushEntry],
    );

    const handleFinal = useCallback(
        (text: string) => {
            setInterim('');
            void deliver(processTranscript(text), text);
        },
        [deliver],
    );

    // Refresh the latest-refs after every render. No dependency array on purpose.
    useEffect(() => {
        onEffectRef.current = onEffect;
        handleFinalRef.current = handleFinal;
    });

    /**
     * Construct the service exactly once.
     *
     * Empty dependency array, and every callback it installs goes through a latest-ref,
     * so nothing about a re-render can tear the microphone down. Building it inside the
     * effect (rather than in a `useState` initialiser) also means React 19's StrictMode
     * double-mount gets a clean construct → destroy → construct cycle instead of
     * leaving an orphaned service with a live `voiceschanged` listener.
     */
    useEffect(() => {
        const service = new SpeechService();
        serviceRef.current = service;

        service.onStatusChange = (next) => {
            setStatus(next);
            // Any successful transition out of a failure state clears the banner.
            if (next === 'listening' || next === 'idle') setError(null);
        };
        service.onInterim = setInterim;
        service.onVoicesChanged = (list) => setVoices([...list]);
        service.onError = (info) => {
            setError(info);
            pushEntry('system', info.message);
        };
        service.onFinal = (text) => handleFinalRef.current(text);

        setSettings(service.settings);
        setVoices([...service.getVoices()]);
        setStatus(service.status);

        return () => {
            service.destroy();
            serviceRef.current = null;
        };
    }, [pushEntry]);

    const start = useCallback(() => {
        setError(null);
        void serviceRef.current?.start();
    }, []);

    const stop = useCallback(() => {
        serviceRef.current?.stop();
        setInterim('');
    }, []);

    const listening = status === 'listening' || status === 'starting';

    const toggle = useCallback(() => {
        if (serviceRef.current?.isListening) stop();
        else start();
    }, [start, stop]);

    const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
        const service = serviceRef.current;
        if (!service) return;
        setSettings(service.updateSettings(patch));
    }, []);

    const runCommand = useCallback(
        (id: string) => {
            const command = getCommand(id);
            void deliver(runCommandById(id), command ? command.example : id);
        },
        [deliver],
    );

    const submitText = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            void deliver(processTranscript(trimmed), trimmed);
        },
        [deliver],
    );

    const clearHistory = useCallback(() => {
        setEntries([]);
        setLastResponse('');
        lastResponseRef.current = '';
    }, []);

    const previewVoice = useCallback(() => {
        void serviceRef.current?.speak(
            'This is the selected voice, at the current speed and pitch.',
        );
    }, []);

    const retry = useCallback(() => {
        setError(null);
        void serviceRef.current?.requestMicrophoneAccess().then(() => serviceRef.current?.start());
    }, []);

    return {
        support,
        status,
        interim,
        entries,
        lastResponse,
        error,
        voices,
        settings,
        listening,
        start,
        stop,
        toggle,
        updateSettings,
        applySettingsChange,
        runCommand,
        submitText,
        clearHistory,
        previewVoice,
        retry,
    };
}
