/**
 * @file speech.ts
 * @description A framework-free wrapper around the two halves of the Web Speech API:
 * `SpeechRecognition` (speech in) and `speechSynthesis` (speech out).
 *
 * There is no React in this file on purpose. Everything here is a plain class with
 * callback properties, so it can be dropped into any app, or none at all, and so the
 * awkward parts of the browser API can be unit-tested against stubs instead of a
 * microphone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HARD PARTS, AND WHY THE CODE LOOKS LIKE THIS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. THE FEEDBACK LOOP. If the recogniser is live while the synthesiser is talking,
 *    the app hears its own voice, transcribes it, and runs it as a command. On a laptop
 *    with open speakers this happens *every single time*. The fix is to stop recognition
 *    before speaking and restart it from `utterance.onend`. This is the single most
 *    important thing in this file.
 *
 * 2. SPEAK() MUST NEVER HANG. Callers `await` it, so the promise has to settle on
 *    `onend` AND on `onerror`. Both. A promise that only resolves on `onend` deadlocks
 *    the whole voice session the first time the engine errors, and engines error for
 *    mundane reasons like the tab losing audio focus.
 *
 * 3. "CONTINUOUS" IS NOT CONTINUOUS. Chrome ends a recognition session on its own
 *    silence timeout (roughly 5–8 seconds of quiet) even with `continuous = true`. If
 *    you do not restart from `onend`, hands-free mode silently dies about ten seconds
 *    after the user stops talking, and they get no indication of it.
 *
 * 4. start()/stop() THROW. Calling `start()` on an already-started recogniser throws
 *    `InvalidStateError`, and the state you think it is in and the state it is actually
 *    in drift apart constantly because the engine also stops itself. Every call is
 *    wrapped.
 *
 * 5. `no-speech` AND `aborted` ARE NOT ERRORS. They are the two most common events the
 *    error channel emits: "you went quiet" and "you called stop()". Surfacing them as
 *    failures means the UI shows an error banner during completely normal use.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BUGS FIXED HERE THAT THE REFERENCE IMPLEMENTATION HAD
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FIX A: MICROPHONE PERMISSION WAS NEVER PRE-FLIGHTED. The original just called
 *   `recognition.start()` and let a denied microphone surface as a generic "error"
 *   status, which is indistinguishable from a network failure and gives the user
 *   nothing to act on. We now query `navigator.permissions` where it is supported,
 *   optionally prompt through `getUserMedia` (which produces the browser's own,
 *   familiar permission dialog), and map the `not-allowed` / `service-not-allowed`
 *   recognition errors onto a dedicated `mic-blocked` status that the UI can explain.
 *
 * FIX B: CANCEL/SPEAK RACE. The original called `synthesis.cancel()` at the top of
 *   `speak()`. Cancelling fires the *previous* utterance's `onend`/`onerror`, whose
 *   handler then restarts recognition in the middle of the new utterance. The app
 *   promptly hears itself. Every utterance now carries a monotonically increasing id
 *   and only the newest one is allowed to change state or restart recognition.
 *
 * FIX C: NO WATCHDOG. Safari (and Chrome when a tab is backgrounded) can drop an
 *   utterance without firing either `onend` or `onerror`. The awaited promise then
 *   never settles and the session wedges. A timeout scaled to the text length settles
 *   it and restores listening.
 *
 * FIX D: CHROME TRUNCATES LONG UTTERANCES. Chrome's synthesiser stops speaking after
 *   roughly 15 seconds. The long-standing workaround is a `pause()`/`resume()` heartbeat
 *   while a long utterance is in flight; see `startSynthesisHeartbeat`.
 *
 * FIX E: UNBOUNDED RESTART LOOP. The original's `onend` handler restarted recognition
 *   unconditionally. If the engine cannot start (revoked microphone, no input device,
 *   offline), `start()` throws or immediately errors, which fires `onend` again, which
 *   restarts... a tight spin that pins a core and floods the console. Restarts are now
 *   counted, backed off, and given up on.
 *
 * FIX F: VOICES WERE FILTERED TO ENGLISH ONLY. That silently hides every voice a
 *   non-English user has installed. We return them all and let the UI sort.
 */

import type {
    SpeechHostWindow,
    SpeechRecognitionConstructor,
    SpeechRecognitionErrorEventLike,
    SpeechRecognitionEventLike,
    SpeechRecognitionLike,
    StorageLike,
} from './speechTypes';

/* ════════════════════════════════════════════════════════════════════════════
   Status model
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * The full status union for a voice session. Documented member by member because the
 * UI keys every affordance off this value and an ambiguous status leads directly to a
 * confusing interface.
 *
 * - `unsupported`: this browser has no SpeechRecognition at all (Firefox today).
 *                    Listening will never work; the click-to-run command list still does.
 * - `idle`: supported, not currently listening. The resting state.
 * - `starting`: `start()` has been called and we are waiting on the permission
 *                    prompt and/or the engine's `onstart`. Distinct from `listening`
 *                    because the microphone is NOT yet live and saying something now
 *                    will be missed.
 * - `listening`: the engine is live and audio is being transcribed.
 * - `speaking`: the synthesiser is talking. Recognition is deliberately suspended
 *                    for the duration (see "the feedback loop" above).
 * - `mic-blocked`: permission denied by the user or by platform policy. Recoverable
 *                    only through browser UI, so this gets its own explanatory panel.
 * - `error`: anything else, no capture device, recogniser offline, unknown
 *                    engine error. `lastError` carries the detail.
 */
export type SpeechStatus =
    | 'unsupported'
    | 'idle'
    | 'starting'
    | 'listening'
    | 'speaking'
    | 'mic-blocked'
    | 'error';

/** Result of a microphone permission probe. `unknown` means "the browser won't say". */
export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/** What the browser can actually do, probed once at construction. */
export interface SpeechSupport {
    /** `SpeechRecognition` or `webkitSpeechRecognition` exists. */
    recognition: boolean;
    /** `speechSynthesis` and `SpeechSynthesisUtterance` both exist. */
    synthesis: boolean;
    /**
     * Whether the page is a secure context. Recognition is gated on HTTPS (or
     * `localhost`) in every browser that implements it; worth surfacing separately
     * because "it works on my machine but not on the deployed http:// page" is
     * otherwise a baffling failure.
     */
    secureContext: boolean;
}

/** User-tunable speech-synthesis preferences, persisted between visits. */
export interface VoiceSettings {
    /**
     * `SpeechSynthesisVoice.voiceURI` of the chosen voice, or null for the browser
     * default. We store the URI rather than the object because voices are host objects
     * that cannot be serialised, and rather than the display name because names are not
     * unique across platforms.
     */
    voiceUri: string | null;
    /** 0.5–2. Playback rate multiplier. */
    rate: number;
    /** 0–2. Vocal pitch multiplier. */
    pitch: number;
    /** When true, responses are shown as text but never spoken aloud. */
    muted: boolean;
}

/**
 * Neutral starting point: the browser's own default voice, unmodified speed and pitch,
 * audible.
 *
 * `rate` is a multiplier of the voice's natural speed and `pitch` a multiplier of its
 * natural pitch; both are 1 here, i.e. "whatever this voice does normally". The spec's
 * legal ranges are rate 0.1–10 and pitch 0–2, but this app clamps rate to **0.5–2** and
 * pitch to **0–2** in `sanitizeVoiceSettings`, because outside that band the output stops
 * being intelligible and, worse, engines disagree about it; several clamp silently to
 * their own supported range, so a stored `rate: 6` would read back as 6 and play as
 * something else entirely. Keep the clamp and this object in step.
 *
 * Spread it rather than assigning it (`{ ...DEFAULT_VOICE_SETTINGS }`): it is a plain
 * mutable object, and `updateSettings` writes to the live settings object.
 *
 * Also the reset target for the spoken "reset voice settings" command, so changing a
 * value here changes what that command restores.
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
    voiceUri: null,
    rate: 1,
    pitch: 1,
    muted: false,
};

/** localStorage key. Versioned so a future settings-shape change can't poison old data. */
export const VOICE_SETTINGS_KEY = 'voice-command-demo.settings.v1';

/** Clamp helper: keeps a persisted or user-supplied value inside the API's legal range. */
function clamp(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

/**
 * Coerces anything that came out of storage (or off the wire) into a valid
 * `VoiceSettings`. Every field is validated independently so one bad value does not
 * discard the user's other preferences.
 */
export function sanitizeVoiceSettings(input: unknown): VoiceSettings {
    if (typeof input !== 'object' || input === null) return { ...DEFAULT_VOICE_SETTINGS };
    const raw = input as Record<string, unknown>;
    return {
        voiceUri: typeof raw.voiceUri === 'string' && raw.voiceUri.length > 0 ? raw.voiceUri : null,
        rate: clamp(typeof raw.rate === 'number' ? raw.rate : Number.NaN, 0.5, 2, 1),
        pitch: clamp(typeof raw.pitch === 'number' ? raw.pitch : Number.NaN, 0, 2, 1),
        muted: raw.muted === true,
    };
}

/**
 * Reads persisted settings.
 *
 * Wrapped in try/catch for two separate reasons: the stored JSON may be corrupt (a
 * half-written value, or a user poking at devtools), and `localStorage` access itself
 * throws in some privacy configurations: historically Safari private browsing threw
 * a QuotaExceededError on *write*, and several browsers throw on *read* when storage
 * is blocked by a cookie policy. Neither should be able to stop the app from starting.
 */
export function loadVoiceSettings(storage?: StorageLike | null): VoiceSettings {
    if (!storage) return { ...DEFAULT_VOICE_SETTINGS };
    try {
        const raw = storage.getItem(VOICE_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_VOICE_SETTINGS };
        return sanitizeVoiceSettings(JSON.parse(raw) as unknown);
    } catch {
        return { ...DEFAULT_VOICE_SETTINGS };
    }
}

/** Persists settings, silently tolerating storage being unavailable or full. */
export function saveVoiceSettings(settings: VoiceSettings, storage?: StorageLike | null): void {
    if (!storage) return;
    try {
        storage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        /* Storage blocked or full: preferences simply won't survive a reload. */
    }
}

/* ════════════════════════════════════════════════════════════════════════════
   Support detection
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Probes a window-like object for Web Speech support.
 *
 * Takes the host as an argument rather than reaching for the global so the function is
 * pure and testable: a test can pass `{}` to assert the unsupported path without having
 * to delete properties off the real `window` and put them back.
 */
export function detectSpeechSupport(host?: SpeechHostWindow | null): SpeechSupport {
    if (!host) return { recognition: false, synthesis: false, secureContext: false };
    const recognitionCtor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
    const synthesis = typeof host.speechSynthesis === 'object' && host.speechSynthesis !== null
        && typeof host.SpeechSynthesisUtterance === 'function';
    // `isSecureContext` is on WindowOrWorkerGlobalScope; read it defensively because our
    // structural host type does not require it and tests pass plain objects.
    const secure = (host as unknown as { isSecureContext?: boolean }).isSecureContext;
    return {
        recognition: typeof recognitionCtor === 'function',
        synthesis,
        secureContext: secure !== false,
    };
}

/* ════════════════════════════════════════════════════════════════════════════
   Injectable browser surfaces
   ════════════════════════════════════════════════════════════════════════════ */

/** Minimal view of `navigator.permissions`. */
export interface PermissionsLike {
    query(descriptor: { name: string }): Promise<{ state: PermissionState }>;
}

/** Minimal view of `navigator.mediaDevices`, enough to prompt for and release a mic. */
export interface MediaDevicesLike {
    getUserMedia(constraints: { audio: boolean }): Promise<{ getTracks(): { stop(): void }[] }>;
}

/** Everything the service needs from the outside world. All optional, all injectable. */
export interface SpeechServiceOptions {
    /** Defaults to the global `window` when one exists. */
    host?: SpeechHostWindow | null;
    /** Defaults to `window.localStorage`. Pass `null` to disable persistence. */
    storage?: StorageLike | null;
    /** Defaults to `navigator.permissions`. Pass `null` to skip the permission probe. */
    permissions?: PermissionsLike | null;
    /** Defaults to `navigator.mediaDevices`. Used only for the explicit prompt. */
    mediaDevices?: MediaDevicesLike | null;
    /** BCP-47 tag for both recognition and synthesis. Defaults to `en-US`. */
    lang?: string;
    /** Seed settings, overriding whatever is in storage. */
    settings?: Partial<VoiceSettings>;
}

/** Detail attached to the `onError` callback. */
export interface SpeechErrorInfo {
    /** Raw engine error code, or a synthetic one for failures we detect ourselves. */
    code: string;
    /** Plain-English text safe to show a user. */
    message: string;
    /** Whether the user can fix this themselves through browser UI. */
    recoverable: boolean;
}

/* ════════════════════════════════════════════════════════════════════════════
   The service
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Wraps continuous speech recognition and speech synthesis into something an
 * application can use without knowing any of the above.
 *
 * Callbacks rather than events because there is exactly one consumer, and a plain
 * property assignment is easier to reason about (and to replace on re-render) than an
 * emitter whose listeners have to be unsubscribed.
 */
export class SpeechService {
    readonly support: SpeechSupport;

    private readonly host: SpeechHostWindow | null;
    private readonly storage: StorageLike | null;
    private readonly permissions: PermissionsLike | null;
    private readonly mediaDevices: MediaDevicesLike | null;
    private readonly lang: string;

    private recognition: SpeechRecognitionLike | null = null;
    private currentStatus: SpeechStatus;
    private voiceSettings: VoiceSettings;
    private cachedVoices: SpeechSynthesisVoice[] = [];

    /**
     * The user's *intent*. Distinct from whether the engine is currently running,
     * because the engine stops itself constantly (silence timeouts) and we restart it.
     * Every restart decision reads this flag, never the engine's own state.
     */
    private wantsToListen = false;

    /** True between `synthesis.speak()` and the utterance settling. Suppresses restarts. */
    private isSpeaking = false;

    /**
     * FIX B: monotonic id for utterances. `synthesis.cancel()` fires the previous
     * utterance's terminal events, so a stale handler must be able to recognise that it
     * is stale and do nothing.
     */
    private utteranceSeq = 0;

    /** FIX E: consecutive restart attempts without a successful `onstart`/`onresult`. */
    private restartAttempts = 0;

    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private voicesListener: (() => void) | null = null;
    private destroyed = false;

    /** Fired whenever `status` changes. */
    onStatusChange: (status: SpeechStatus) => void = () => {};
    /** Fired with the running partial transcription while the user is still speaking. */
    onInterim: (text: string) => void = () => {};
    /** Fired once per finalised utterance, already lowercased and trimmed. */
    onFinal: (text: string) => void = () => {};
    /** Fired when the voice list becomes available or changes. */
    onVoicesChanged: (voices: SpeechSynthesisVoice[]) => void = () => {};
    /** Fired for errors worth telling the user about. Routine ones never reach here. */
    onError: (info: SpeechErrorInfo) => void = () => {};

    constructor(options: SpeechServiceOptions = {}) {
        const globalWindow: SpeechHostWindow | null =
            typeof window === 'undefined' ? null : (window as unknown as SpeechHostWindow);

        this.host = options.host !== undefined ? options.host : globalWindow;
        this.lang = options.lang ?? 'en-US';
        this.support = detectSpeechSupport(this.host);

        // Storage: default to localStorage but tolerate it throwing on access (some
        // privacy modes make even *reading* the property throw a SecurityError).
        if (options.storage !== undefined) {
            this.storage = options.storage;
        } else {
            let resolved: StorageLike | null = null;
            try {
                resolved = typeof localStorage === 'undefined' ? null : localStorage;
            } catch {
                resolved = null;
            }
            this.storage = resolved;
        }

        this.permissions = options.permissions !== undefined
            ? options.permissions
            : readNavigatorPermissions();
        this.mediaDevices = options.mediaDevices !== undefined
            ? options.mediaDevices
            : readNavigatorMediaDevices();

        this.voiceSettings = {
            ...loadVoiceSettings(this.storage),
            ...(options.settings ?? {}),
        };

        this.currentStatus = this.support.recognition ? 'idle' : 'unsupported';

        if (this.support.recognition) this.createRecognition();
        if (this.support.synthesis) this.attachVoiceListener();
    }

    /* ── Public state ─────────────────────────────────────────────────────── */

    get status(): SpeechStatus {
        return this.currentStatus;
    }

    get isListening(): boolean {
        return this.currentStatus === 'listening' || this.currentStatus === 'starting';
    }

    get settings(): Readonly<VoiceSettings> {
        return this.voiceSettings;
    }

    /**
     * Merges a settings patch, persists it, and applies it to anything in flight.
     *
     * NOTE ON THE STALE-CLOSURE BUG THIS PREVENTS (fixed on the React side too, in
     * `useVoiceSession.ts`): settings live here, in one mutable object owned by the
     * service, and `speak()` reads them at call time. There is no snapshot taken at
     * subscription time, so flipping mute or dragging the rate slider affects the very
     * next utterance, including one that is already queued.
     */
    updateSettings(patch: Partial<VoiceSettings>): VoiceSettings {
        this.voiceSettings = sanitizeVoiceSettings({ ...this.voiceSettings, ...patch });
        saveVoiceSettings(this.voiceSettings, this.storage);
        // Muting mid-sentence should shut the current sentence up immediately;
        // waiting for it to finish is exactly what the user just asked you not to do.
        if (this.voiceSettings.muted) this.cancelSpeech();
        return this.voiceSettings;
    }

    /* ── Microphone permission (FIX A) ────────────────────────────────────── */

    /**
     * Non-intrusive permission probe. Returns `unknown` rather than guessing when the
     * browser cannot answer.
     *
     * `navigator.permissions.query({ name: 'microphone' })` is supported in Chromium
     * but *throws a TypeError* in Firefox and older Safari because `'microphone'` is not
     * in their enum of permission names, so the whole thing lives in a try/catch and a
     * throw is treated as "no information", not as a denial. Treating it as a denial
     * would block Safari users who actually have a working microphone.
     */
    async checkMicrophonePermission(): Promise<MicPermission> {
        if (!this.permissions) return 'unknown';
        try {
            const result = await this.permissions.query({ name: 'microphone' });
            if (result.state === 'granted' || result.state === 'denied' || result.state === 'prompt') {
                return result.state;
            }
            return 'unknown';
        } catch {
            return 'unknown';
        }
    }

    /**
     * Explicitly asks for the microphone via `getUserMedia`, then releases it again.
     *
     * WHY do this instead of letting `recognition.start()` trigger the prompt: the
     * recognition prompt is fired from inside the engine and, if the user dismisses or
     * denies it, all you get back is an `error` event with `not-allowed`. Going through
     * `getUserMedia` gives a real rejected promise with a distinguishable
     * `NotAllowedError` / `NotFoundError`, which is the difference between telling the
     * user "you denied the microphone, here is how to undo that" and "something went
     * wrong".
     *
     * The tracks are stopped immediately: we only wanted the permission grant, and
     * leaving the stream open lights the browser's recording indicator for no reason.
     */
    async requestMicrophoneAccess(): Promise<MicPermission> {
        if (!this.mediaDevices) return this.checkMicrophonePermission();
        try {
            const stream = await this.mediaDevices.getUserMedia({ audio: true });
            for (const track of stream.getTracks()) {
                try {
                    track.stop();
                } catch {
                    /* Track already ended. */
                }
            }
            return 'granted';
        } catch (err: unknown) {
            const name = err instanceof Error ? err.name : '';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                this.setStatus('mic-blocked');
                this.onError({
                    code: 'not-allowed',
                    message:
                        'Microphone access is blocked for this page. Open the padlock or camera icon in the address bar, allow the microphone, then reload.',
                    recoverable: true,
                });
                return 'denied';
            }
            if (name === 'NotFoundError' || name === 'OverconstrainedError') {
                this.setStatus('error');
                this.onError({
                    code: 'audio-capture',
                    message: 'No microphone was found. Connect an input device and try again.',
                    recoverable: true,
                });
                return 'denied';
            }
            return 'unknown';
        }
    }

    /* ── Recognition ──────────────────────────────────────────────────────── */

    /**
     * Starts (or resumes) continuous listening.
     *
     * Async because of the permission pre-flight; the caller gets a boolean that
     * actually means "the microphone is coming up", instead of the reference's
     * synchronous `true` that only meant "the call didn't throw".
     */
    async start(): Promise<boolean> {
        if (this.destroyed) return false;
        if (!this.recognition) {
            this.setStatus('unsupported');
            this.onError({
                code: 'unsupported',
                message:
                    'This browser has no speech recognition. Try Chrome or Edge, or use the "Try it" buttons on the Commands page, which run the same handlers without a microphone.',
                recoverable: false,
            });
            return false;
        }

        // A page served over plain http:// (other than localhost) will have recognition
        // refused by the browser with an unhelpful error. Say so up front.
        if (!this.support.secureContext) {
            this.setStatus('error');
            this.onError({
                code: 'insecure-context',
                message:
                    'Speech recognition requires a secure context. Serve this page over HTTPS, or run it from localhost.',
                recoverable: false,
            });
            return false;
        }

        this.setStatus('starting');

        // FIX A: find out about a denied microphone *before* starting the engine, so the
        // UI can show a fix-it panel rather than a generic error.
        const permission = await this.checkMicrophonePermission();
        if (permission === 'denied') {
            this.setStatus('mic-blocked');
            this.onError({
                code: 'not-allowed',
                message:
                    'Microphone access is blocked for this page. Click the padlock (or camera) icon in the address bar, set Microphone to Allow, then reload.',
                recoverable: true,
            });
            return false;
        }
        if (permission === 'prompt') {
            // Surface the browser's own dialog through getUserMedia, where a refusal
            // comes back as a distinguishable error rather than a bare event.
            const granted = await this.requestMicrophoneAccess();
            if (granted === 'denied') return false;
        }

        if (this.destroyed) return false;

        this.wantsToListen = true;
        this.restartAttempts = 0;
        const started = this.tryStartRecognition();
        if (started) this.setStatus('listening');
        return started;
    }

    /** Stops listening and cancels any pending restart. Safe to call at any time. */
    stop(): void {
        this.wantsToListen = false;
        this.clearRestartTimer();
        // Wrapped: `stop()` on a recogniser that is not running throws InvalidStateError
        // in some builds and is a silent no-op in others. We cannot know which state it
        // is in, because it stops itself.
        try {
            this.recognition?.stop();
        } catch {
            /* Not running. */
        }
        if (this.currentStatus !== 'mic-blocked' && this.currentStatus !== 'unsupported') {
            this.setStatus('idle');
        }
    }

    /* ── Synthesis ────────────────────────────────────────────────────────── */

    /**
     * Speaks `text`, suspending recognition for the duration.
     *
     * Resolves when the utterance ends, errors out, or trips the watchdog; never
     * hangs. Resolves immediately (without speaking) when muted or when the browser has
     * no synthesiser, so callers can `await` unconditionally.
     */
    speak(text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) return Promise.resolve();

        // Muted is checked here, at speak time, from the live settings object. Reading a
        // snapshot captured when the session started is the stale-closure bug that made
        // the reference's mute toggle do nothing mid-session.
        if (this.voiceSettings.muted) return Promise.resolve();

        const synthesis = this.host?.speechSynthesis;
        const UtteranceCtor = this.host?.SpeechSynthesisUtterance;
        if (!synthesis || !UtteranceCtor) return Promise.resolve();

        return new Promise<void>((resolve) => {
            const id = ++this.utteranceSeq;

            // Cancel anything in flight. FIX B: this synchronously fires the previous
            // utterance's terminal handler, which is why every handler below first
            // checks `id !== this.utteranceSeq` and bails if it has been superseded.
            try {
                synthesis.cancel();
            } catch {
                /* Nothing queued. */
            }

            const utterance = new UtteranceCtor(trimmed);
            utterance.rate = this.voiceSettings.rate;
            utterance.pitch = this.voiceSettings.pitch;
            utterance.lang = this.lang;
            const voice = this.resolveVoice(synthesis);
            if (voice) utterance.voice = voice;

            // ── THE FEEDBACK GUARD ──
            // Stop the recogniser before any audio comes out of the speakers. Without
            // this the app transcribes its own voice and executes it as a command.
            // `wantsToListen` is left TRUE on purpose: it records the user's intent, and
            // `finishUtterance` uses it to decide whether to resume.
            this.isSpeaking = true;
            this.clearRestartTimer();
            try {
                this.recognition?.stop();
            } catch {
                /* Not running. */
            }

            this.setStatus('speaking');

            const finish = (): void => {
                if (id !== this.utteranceSeq) return; // Superseded: a newer utterance owns the state.
                this.clearWatchdog();
                this.stopSynthesisHeartbeat();
                this.isSpeaking = false;
                // Resume listening only if the user never asked us to stop.
                if (this.wantsToListen && !this.destroyed) {
                    this.restartAttempts = 0;
                    if (this.tryStartRecognition()) this.setStatus('listening');
                } else if (!this.destroyed) {
                    this.setStatus('idle');
                }
                resolve();
            };

            // Both terminal events settle the promise. `onerror` is not optional here:
            // an engine error with only an `onend` handler deadlocks every awaiting
            // caller, which in practice means the voice session stops responding
            // entirely and the user has no idea why.
            utterance.onend = finish;
            utterance.onerror = finish;

            // FIX C: some engines drop an utterance without firing either terminal
            // event: Safari does it when the tab loses audio focus, Chrome when the tab
            // is backgrounded mid-sentence. Budget generously (speech runs ~12 chars a
            // second at rate 1) and divide by the rate, because a 2x rate finishes in
            // half the time and a 0.5x rate takes twice as long.
            const estimatedMs = (2000 + trimmed.length * 90) / Math.max(0.5, this.voiceSettings.rate);
            this.watchdogTimer = setTimeout(finish, Math.min(60000, estimatedMs));

            try {
                synthesis.speak(utterance);
            } catch {
                finish();
                return;
            }

            // FIX D: Chrome silently stops after ~15s of continuous speech. Only armed
            // for text long enough to hit the limit, so short answers never create a
            // timer at all.
            if (trimmed.length > 180) this.startSynthesisHeartbeat(synthesis);
        });
    }

    /** Immediately silences the synthesiser without touching the listening state. */
    cancelSpeech(): void {
        this.stopSynthesisHeartbeat();
        try {
            this.host?.speechSynthesis?.cancel();
        } catch {
            /* Nothing queued. */
        }
    }

    /**
     * All installed voices.
     *
     * FIX F: the reference filtered this to `lang.startsWith('en')`, which hides every
     * voice a non-English user has installed and makes the picker look broken. Return
     * everything; the UI groups them.
     */
    getVoices(): SpeechSynthesisVoice[] {
        return this.cachedVoices;
    }

    /** Stops everything and detaches listeners. Idempotent. */
    destroy(): void {
        this.destroyed = true;
        this.wantsToListen = false;
        this.clearRestartTimer();
        this.clearWatchdog();
        this.stopSynthesisHeartbeat();
        this.detachVoiceListener();
        try {
            this.recognition?.abort();
        } catch {
            /* Not running. */
        }
        this.cancelSpeech();
    }

    /* ── Internals ────────────────────────────────────────────────────────── */

    private setStatus(status: SpeechStatus): void {
        if (this.currentStatus === status) return;
        this.currentStatus = status;
        this.onStatusChange(status);
    }

    /**
     * Wraps `recognition.start()`.
     *
     * `InvalidStateError` on an already-started recogniser is genuinely unavoidable:
     * there is no property that tells you whether it is running, the engine starts and
     * stops itself, and by the time your `onend` handler runs the engine may already
     * have been restarted by another code path. Swallowing it is the documented
     * workaround, not laziness, but we distinguish "already started" (fine) from a
     * real failure so FIX E's restart counter does not misfire.
     */
    private tryStartRecognition(): boolean {
        if (!this.recognition) return false;
        try {
            this.recognition.start();
            return true;
        } catch (err: unknown) {
            const name = err instanceof Error ? err.name : '';
            if (name === 'InvalidStateError') return true; // Already listening: success.
            return false;
        }
    }

    private createRecognition(): void {
        const ctor: SpeechRecognitionConstructor | undefined =
            this.host?.SpeechRecognition ?? this.host?.webkitSpeechRecognition;
        if (!ctor) return;

        const rec = new ctor();
        rec.continuous = true;
        rec.interimResults = true; // Needed for the live transcript display.
        rec.lang = this.lang;
        // One alternative is enough: we keyword-match, so a lower-confidence variant of
        // the same phrase almost never routes differently, and asking for more costs
        // latency on the cloud recognisers.
        rec.maxAlternatives = 1;

        rec.onstart = () => {
            // Proof the engine really came up; reset the restart budget (FIX E).
            this.restartAttempts = 0;
        };

        rec.onresult = (event: SpeechRecognitionEventLike) => {
            let final = '';
            let interim = '';
            // Start at `resultIndex`, not 0. Iterating the whole list re-delivers
            // transcripts that were already dispatched, which shows up as commands
            // firing two and three times.
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (!result) continue;
                const alternative = result[0];
                if (!alternative) continue;
                if (result.isFinal) final += alternative.transcript;
                else interim += alternative.transcript;
            }
            if (interim) this.onInterim(interim);
            if (final) {
                this.restartAttempts = 0; // The engine is clearly working.
                this.onInterim('');
                this.onFinal(final.trim().toLowerCase());
            }
        };

        rec.onerror = (event: SpeechRecognitionErrorEventLike) => {
            switch (event.error) {
                case 'no-speech':
                case 'aborted':
                    // Routine. `no-speech` is the silence timeout and `aborted` is our
                    // own `stop()`. Surfacing either as an error puts a red banner on
                    // screen during completely normal use.
                    return;
                case 'not-allowed':
                case 'service-not-allowed':
                    // FIX A: a denied microphone gets its own status and its own advice,
                    // rather than the reference's undifferentiated 'error'.
                    this.wantsToListen = false;
                    this.setStatus('mic-blocked');
                    this.onError({
                        code: event.error,
                        message:
                            event.error === 'not-allowed'
                                ? 'Microphone access was denied. Click the padlock (or camera) icon in the address bar, set Microphone to Allow, then reload the page.'
                                : 'Speech recognition is blocked by this device or browser policy. Check your operating system microphone privacy settings.',
                        recoverable: true,
                    });
                    return;
                case 'audio-capture':
                    this.wantsToListen = false;
                    this.setStatus('error');
                    this.onError({
                        code: event.error,
                        message: 'No microphone was detected. Connect an input device and start listening again.',
                        recoverable: true,
                    });
                    return;
                case 'network':
                    // Worth its own message: Chrome's recogniser is a network service,
                    // which surprises people who assume "built-in API" means "offline".
                    this.setStatus('error');
                    this.onError({
                        code: event.error,
                        message:
                            'The speech recognition service could not be reached. In Chrome, recognition is performed on the vendor\'s servers and needs a working connection.',
                        recoverable: true,
                    });
                    return;
                default:
                    this.setStatus('error');
                    this.onError({
                        code: String(event.error),
                        message: `Speech recognition error: ${String(event.error)}.`,
                        recoverable: false,
                    });
            }
        };

        rec.onend = () => {
            // "continuous" is a suggestion. Chrome ends the session after its own
            // silence timeout, so without this restart hands-free mode quietly dies
            // about ten seconds after the last thing anybody said.
            //
            // Three guards:
            //  - not while speaking: the feedback guard stopped it deliberately, and
            //    `finishUtterance` owns restarting it.
            //  - not if the user stopped: `wantsToListen` is the source of truth.
            //  - FIX E: not forever. If the engine cannot come up (revoked permission,
            //    unplugged microphone, offline recogniser), start() fails or errors
            //    immediately, which fires onend again: an unbounded spin. Back off and
            //    give up after a bounded number of tries.
            if (this.destroyed || this.isSpeaking || !this.wantsToListen) return;

            if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
                this.wantsToListen = false;
                this.setStatus('error');
                this.onError({
                    code: 'restart-failed',
                    message:
                        'Speech recognition kept stopping and could not be restarted. Check the microphone, then start listening again.',
                    recoverable: true,
                });
                return;
            }

            const attempt = this.restartAttempts++;
            // Linear backoff: instant for the first retry (the common silence-timeout
            // case, where any delay is perceptible as "it stopped hearing me"), then
            // progressively slower for the pathological case.
            const delay = attempt === 0 ? 0 : Math.min(2000, attempt * 250);
            this.clearRestartTimer();
            this.restartTimer = setTimeout(() => {
                this.restartTimer = null;
                if (this.destroyed || !this.wantsToListen || this.isSpeaking) return;
                if (!this.tryStartRecognition()) {
                    // Failed synchronously; onend will not fire again, so nudge the loop.
                    this.setStatus('error');
                }
            }, delay);
        };

        this.recognition = rec;
    }

    /** Resolves the persisted `voiceUri` to a live voice object, if it still exists. */
    private resolveVoice(synthesis: SpeechSynthesis): SpeechSynthesisVoice | null {
        if (!this.voiceSettings.voiceUri) return null;
        const voices = this.cachedVoices.length > 0 ? this.cachedVoices : synthesis.getVoices();
        return voices.find((v) => v.voiceURI === this.voiceSettings.voiceUri) ?? null;
    }

    /**
     * Chrome populates `getVoices()` asynchronously and returns an empty array on the
     * first call after page load; Safari populates it synchronously and may never fire
     * `voiceschanged` at all. Handling only one of those behaviours gives you either an
     * empty voice picker (Chrome) or one that never appears (Safari), so we do both:
     * read immediately, subscribe to the event, and schedule one delayed re-read as a
     * belt-and-braces fallback for the case where the event fired before we subscribed.
     */
    private attachVoiceListener(): void {
        const synthesis = this.host?.speechSynthesis;
        if (!synthesis) return;

        const refresh = (): void => {
            try {
                this.cachedVoices = synthesis.getVoices();
            } catch {
                this.cachedVoices = [];
            }
            if (this.cachedVoices.length > 0) this.onVoicesChanged(this.cachedVoices);
        };

        refresh();

        if (typeof synthesis.addEventListener === 'function') {
            this.voicesListener = refresh;
            synthesis.addEventListener('voiceschanged', refresh);
        }

        // Only schedule the fallback re-read when the first read came back empty;
        // otherwise every construction leaves a stray timer behind for no benefit.
        if (this.cachedVoices.length === 0 && typeof setTimeout === 'function') {
            setTimeout(refresh, 300);
        }
    }

    private detachVoiceListener(): void {
        const synthesis = this.host?.speechSynthesis;
        if (synthesis && this.voicesListener && typeof synthesis.removeEventListener === 'function') {
            synthesis.removeEventListener('voiceschanged', this.voicesListener);
        }
        this.voicesListener = null;
    }

    /**
     * FIX D. Chrome's synthesiser stops mid-sentence after roughly 15 seconds. The
     * long-standing workaround (a `pause()` immediately followed by `resume()`) resets
     * its internal timer without an audible gap. Harmless on engines that do not have
     * the bug.
     */
    private startSynthesisHeartbeat(synthesis: SpeechSynthesis): void {
        this.stopSynthesisHeartbeat();
        if (typeof setInterval !== 'function') return;
        this.heartbeatTimer = setInterval(() => {
            if (!this.isSpeaking) {
                this.stopSynthesisHeartbeat();
                return;
            }
            try {
                synthesis.pause();
                synthesis.resume();
            } catch {
                this.stopSynthesisHeartbeat();
            }
        }, 10000);
    }

    private stopSynthesisHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private clearRestartTimer(): void {
        if (this.restartTimer !== null) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }

    private clearWatchdog(): void {
        if (this.watchdogTimer !== null) {
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }
}

/** How many times we will try to bring the recogniser back up before giving up (FIX E). */
const MAX_RESTART_ATTEMPTS = 8;

/** Reads `navigator.permissions` defensively; the property itself can be absent. */
function readNavigatorPermissions(): PermissionsLike | null {
    try {
        if (typeof navigator === 'undefined') return null;
        // `as unknown as` rather than an intersection: TypeScript's built-in
        // `Permissions.query` is typed against the `PermissionName` enum, which does not
        // include 'microphone' even though every Chromium browser accepts it.
        const nav = navigator as unknown as { permissions?: PermissionsLike };
        return nav.permissions ?? null;
    } catch {
        return null;
    }
}

/** Reads `navigator.mediaDevices` defensively; absent on insecure origins. */
function readNavigatorMediaDevices(): MediaDevicesLike | null {
    try {
        if (typeof navigator === 'undefined') return null;
        const nav = navigator as unknown as { mediaDevices?: MediaDevicesLike };
        return nav.mediaDevices ?? null;
    } catch {
        return null;
    }
}
