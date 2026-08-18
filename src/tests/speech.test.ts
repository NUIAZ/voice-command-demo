/**
 * @file speech.test.ts
 * @description Covers `SpeechService` against hand-written stubs.
 *
 * NO REAL MICROPHONE IS EVER TOUCHED. Every browser surface the service uses
 * (recognition, synthesis, permissions, media devices, storage) is injected through the
 * constructor, which is precisely why the service takes them as options rather than
 * reaching for globals.
 *
 * The behaviours pinned down here are the ones that are impossible to verify by reading
 * the code and expensive to debug in a browser: the feedback guard, the promise that
 * must never hang, the silence-timeout restart, and the permission-denied path.
 */

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VOICE_SETTINGS,
    SpeechService,
    VOICE_SETTINGS_KEY,
    detectSpeechSupport,
    loadVoiceSettings,
    sanitizeVoiceSettings,
    saveVoiceSettings,
} from '../services/speech';
import type { PermissionsLike, SpeechErrorInfo } from '../services/speech';
import type {
    SpeechHostWindow,
    SpeechRecognitionConstructor,
    SpeechRecognitionErrorEventLike,
    SpeechRecognitionEventLike,
    SpeechRecognitionLike,
    SpeechRecognitionResultListLike,
    StorageLike,
} from '../services/speechTypes';

/* ════════════════════════════════════════════════════════════════════════════
   Stubs
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * A recogniser that behaves like the real thing in the ways that matter:
 * `start()` throws `InvalidStateError` when already running, `stop()` fires `onend`
 * asynchronously-ish, and the engine can end its own session (Chrome's silence timeout).
 */
class FakeRecognition implements SpeechRecognitionLike {
    continuous = false;
    interimResults = false;
    lang = '';
    maxAlternatives = 1;

    onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;

    running = false;
    startCalls = 0;
    stopCalls = 0;
    abortCalls = 0;

    start(): void {
        this.startCalls++;
        if (this.running) {
            const error = new Error('recognition has already started');
            error.name = 'InvalidStateError';
            throw error;
        }
        this.running = true;
        this.onstart?.();
    }

    stop(): void {
        this.stopCalls++;
        if (!this.running) return;
        this.running = false;
        this.onend?.();
    }

    abort(): void {
        this.abortCalls++;
        this.running = false;
    }

    /** Chrome ends a "continuous" session on its own silence timeout. */
    endBySilence(): void {
        this.running = false;
        this.onend?.();
    }

    emitFinal(transcript: string): void {
        const alternative = { transcript, confidence: 0.95 };
        const result = Object.assign([alternative], { isFinal: true });
        this.onresult?.({
            resultIndex: 0,
            results: [result] as unknown as SpeechRecognitionResultListLike,
        });
    }

    emitInterim(transcript: string): void {
        const alternative = { transcript, confidence: 0.4 };
        const result = Object.assign([alternative], { isFinal: false });
        this.onresult?.({
            resultIndex: 0,
            results: [result] as unknown as SpeechRecognitionResultListLike,
        });
    }

    emitError(code: string): void {
        this.onerror?.({ error: code });
    }
}

class FakeUtterance {
    rate = 1;
    pitch = 1;
    lang = '';
    voice: SpeechSynthesisVoice | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly text: string) {}
}

class FakeSynthesis {
    spoken: FakeUtterance[] = [];
    cancelCalls = 0;
    pauseCalls = 0;
    resumeCalls = 0;
    /** When false, an utterance never ends on its own; used to test the error path. */
    autoEnd = true;
    voices: SpeechSynthesisVoice[] = [];

    speak(utterance: FakeUtterance): void {
        this.spoken.push(utterance);
        if (this.autoEnd) queueMicrotask(() => utterance.onend?.());
    }
    cancel(): void {
        this.cancelCalls++;
    }
    pause(): void {
        this.pauseCalls++;
    }
    resume(): void {
        this.resumeCalls++;
    }
    getVoices(): SpeechSynthesisVoice[] {
        return this.voices;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
}

/** A voice object with just the fields the service reads. */
function fakeVoice(voiceURI: string, name: string, lang = 'en-US'): SpeechSynthesisVoice {
    return { voiceURI, name, lang, localService: true, default: false } as SpeechSynthesisVoice;
}

interface Harness {
    host: SpeechHostWindow;
    synthesis: FakeSynthesis;
    recognisers: FakeRecognition[];
    /** The recogniser the service actually constructed. */
    recogniser(): FakeRecognition;
}

/** Builds a host object with both halves of the API present. */
function makeHost(options: { withRecognition?: boolean; withSynthesis?: boolean; voices?: SpeechSynthesisVoice[] } = {}): Harness {
    const { withRecognition = true, withSynthesis = true, voices = [] } = options;
    const recognisers: FakeRecognition[] = [];
    const synthesis = new FakeSynthesis();
    synthesis.voices = voices;

    class TrackedRecognition extends FakeRecognition {
        constructor() {
            super();
            recognisers.push(this);
        }
    }

    const host: SpeechHostWindow = {};
    if (withRecognition) {
        host.SpeechRecognition = TrackedRecognition as unknown as SpeechRecognitionConstructor;
    }
    if (withSynthesis) {
        host.speechSynthesis = synthesis as unknown as SpeechSynthesis;
        host.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance;
    }

    return {
        host,
        synthesis,
        recognisers,
        recogniser() {
            const first = recognisers[0];
            if (!first) throw new Error('No recogniser was constructed');
            return first;
        },
    };
}

/** In-memory `Storage`, so persistence tests never depend on jsdom's shared instance. */
function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
    const data = new Map(Object.entries(seed));
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
        removeItem: (key) => {
            data.delete(key);
        },
    };
}

/** Builds a service wired to stubs, with permission probing disabled by default. */
function makeService(
    harness: Harness,
    extra: { storage?: StorageLike | null; permissions?: PermissionsLike | null } = {},
): SpeechService {
    return new SpeechService({
        host: harness.host,
        storage: extra.storage ?? null,
        permissions: extra.permissions ?? null,
        mediaDevices: null,
    });
}

/* ════════════════════════════════════════════════════════════════════════════
   Support detection and graceful degradation
   ════════════════════════════════════════════════════════════════════════════ */

describe('detectSpeechSupport', () => {
    it('reports nothing supported for a missing host', () => {
        expect(detectSpeechSupport(null)).toEqual({
            recognition: false,
            synthesis: false,
            secureContext: false,
        });
    });

    it('reports nothing supported for a host with neither API', () => {
        const support = detectSpeechSupport({});
        expect(support.recognition).toBe(false);
        expect(support.synthesis).toBe(false);
    });

    it('accepts the webkit-prefixed recogniser, which is what actually ships', () => {
        const support = detectSpeechSupport({
            webkitSpeechRecognition: FakeRecognition as unknown as SpeechRecognitionConstructor,
        });
        expect(support.recognition).toBe(true);
    });

    it('flags an insecure context, which is why recognition would be refused', () => {
        const host = { isSecureContext: false } as unknown as SpeechHostWindow;
        expect(detectSpeechSupport(host).secureContext).toBe(false);
    });
});

describe('graceful degradation when the browser has no speech APIs at all', () => {
    it('constructs without throwing and reports itself unsupported', () => {
        const service = new SpeechService({ host: {}, storage: null, permissions: null, mediaDevices: null });
        expect(service.support.recognition).toBe(false);
        expect(service.support.synthesis).toBe(false);
        expect(service.status).toBe('unsupported');
    });

    it('start() resolves false and explains itself instead of throwing', async () => {
        const service = new SpeechService({ host: {}, storage: null, permissions: null, mediaDevices: null });
        const errors: SpeechErrorInfo[] = [];
        service.onError = (info) => errors.push(info);

        await expect(service.start()).resolves.toBe(false);
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('unsupported');
        expect(errors[0].message).toContain('Try it');
    });

    it('speak() resolves immediately rather than hanging on a missing synthesiser', async () => {
        const service = new SpeechService({ host: {}, storage: null, permissions: null, mediaDevices: null });
        await expect(service.speak('anything at all')).resolves.toBeUndefined();
        expect(service.getVoices()).toEqual([]);
    });

    it('stop() and destroy() are safe no-ops', () => {
        const service = new SpeechService({ host: {}, storage: null, permissions: null, mediaDevices: null });
        expect(() => {
            service.stop();
            service.destroy();
            service.cancelSpeech();
        }).not.toThrow();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
   Settings persistence
   ════════════════════════════════════════════════════════════════════════════ */

describe('voice settings persistence', () => {
    it('round-trips through storage', () => {
        const storage = memoryStorage();
        saveVoiceSettings({ voiceUri: 'urn:voice:test', rate: 1.4, pitch: 0.8, muted: true }, storage);
        expect(loadVoiceSettings(storage)).toEqual({
            voiceUri: 'urn:voice:test',
            rate: 1.4,
            pitch: 0.8,
            muted: true,
        });
    });

    it('returns defaults when nothing is stored', () => {
        expect(loadVoiceSettings(memoryStorage())).toEqual(DEFAULT_VOICE_SETTINGS);
    });

    it('returns defaults instead of throwing on corrupt JSON', () => {
        const storage = memoryStorage({ [VOICE_SETTINGS_KEY]: '{not json at all' });
        expect(loadVoiceSettings(storage)).toEqual(DEFAULT_VOICE_SETTINGS);
    });

    it('survives storage being entirely unavailable', () => {
        expect(loadVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
        expect(() => saveVoiceSettings(DEFAULT_VOICE_SETTINGS, null)).not.toThrow();
    });

    it('tolerates a storage implementation that throws on write', () => {
        const hostile: StorageLike = {
            getItem: () => null,
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
            removeItem: () => {},
        };
        expect(() => saveVoiceSettings(DEFAULT_VOICE_SETTINGS, hostile)).not.toThrow();
    });

    it('clamps out-of-range values field by field rather than discarding everything', () => {
        const cleaned = sanitizeVoiceSettings({ voiceUri: 'v', rate: 99, pitch: -4, muted: 'yes' });
        expect(cleaned).toEqual({ voiceUri: 'v', rate: 2, pitch: 0, muted: false });
    });

    it('recovers from a non-object payload', () => {
        expect(sanitizeVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
        expect(sanitizeVoiceSettings('nope')).toEqual(DEFAULT_VOICE_SETTINGS);
    });

    it('persists updates made through the service and reloads them next session', () => {
        const harness = makeHost();
        const storage = memoryStorage();

        const first = makeService(harness, { storage });
        first.updateSettings({ rate: 1.5, muted: true });
        expect(storage.data.get(VOICE_SETTINGS_KEY)).toContain('1.5');

        const second = makeService(makeHost(), { storage });
        expect(second.settings.rate).toBe(1.5);
        expect(second.settings.muted).toBe(true);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
   Synthesis behaviour
   ════════════════════════════════════════════════════════════════════════════ */

describe('speaking', () => {
    it('speaks through the synthesiser with the current rate and pitch', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        service.updateSettings({ rate: 1.25, pitch: 0.75 });

        await service.speak('three vans are offline');

        expect(harness.synthesis.spoken).toHaveLength(1);
        expect(harness.synthesis.spoken[0].text).toBe('three vans are offline');
        expect(harness.synthesis.spoken[0].rate).toBe(1.25);
        expect(harness.synthesis.spoken[0].pitch).toBe(0.75);
    });

    it('MUTE: says nothing aloud but still resolves, so awaiting callers never stall', async () => {
        const harness = makeHost();
        const service = makeService(harness);

        service.updateSettings({ muted: true });
        await expect(service.speak('this must not be spoken')).resolves.toBeUndefined();
        expect(harness.synthesis.spoken).toHaveLength(0);

        // And unmuting takes effect immediately, on the very next utterance; this is
        // the behaviour the reference implementation's stale closure broke.
        service.updateSettings({ muted: false });
        await service.speak('this one should be spoken');
        expect(harness.synthesis.spoken).toHaveLength(1);
    });

    it('muting mid-sentence cancels what is already being said', () => {
        const harness = makeHost();
        const service = makeService(harness);
        harness.synthesis.autoEnd = false;

        void service.speak('a very long sentence that the user has decided they do not want');
        const cancelsBefore = harness.synthesis.cancelCalls;
        service.updateSettings({ muted: true });
        expect(harness.synthesis.cancelCalls).toBeGreaterThan(cancelsBefore);
    });

    it('resolves on onerror as well as onend: a promise that only settles on onend deadlocks', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        harness.synthesis.autoEnd = false;

        const promise = service.speak('this utterance is going to fail');
        harness.synthesis.spoken[0].onerror?.();

        await expect(promise).resolves.toBeUndefined();
    });

    it('ignores empty text without touching the synthesiser', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        await service.speak('   ');
        expect(harness.synthesis.spoken).toHaveLength(0);
    });

    it('applies the persisted voice selection when that voice exists', async () => {
        const voices = [fakeVoice('urn:a', 'Voice A'), fakeVoice('urn:b', 'Voice B')];
        const harness = makeHost({ voices });
        const service = makeService(harness);

        expect(service.getVoices()).toHaveLength(2);
        service.updateSettings({ voiceUri: 'urn:b' });
        await service.speak('testing');

        expect(harness.synthesis.spoken[0].voice?.voiceURI).toBe('urn:b');
    });

    it('falls back to the browser default when the stored voice is gone', async () => {
        const harness = makeHost({ voices: [fakeVoice('urn:a', 'Voice A')] });
        const service = makeService(harness);
        service.updateSettings({ voiceUri: 'urn:vanished' });
        await service.speak('testing');
        expect(harness.synthesis.spoken[0].voice).toBeNull();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
   The feedback guard
   ════════════════════════════════════════════════════════════════════════════ */

describe('feedback loop guard', () => {
    it('stops recognition before speaking and restarts it when the utterance ends', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        const rec = () => harness.recogniser();

        await service.start();
        expect(rec().running).toBe(true);
        expect(service.status).toBe('listening');

        harness.synthesis.autoEnd = false;
        const promise = service.speak('six vans are at or below twenty percent');

        // The microphone must be off BEFORE any audio leaves the speakers, or the app
        // transcribes its own voice and runs it as a command.
        expect(rec().running).toBe(false);
        expect(service.status).toBe('speaking');

        harness.synthesis.spoken[0].onend?.();
        await promise;

        expect(rec().running).toBe(true);
        expect(service.status).toBe('listening');
    });

    it('does not restart recognition after speaking if the user stopped listening', async () => {
        const harness = makeHost();
        const service = makeService(harness);

        await service.start();
        service.stop();
        const startsBefore = harness.recogniser().startCalls;

        await service.speak('goodbye');

        expect(harness.recogniser().startCalls).toBe(startsBefore);
        expect(service.status).toBe('idle');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
   Recognition lifecycle
   ════════════════════════════════════════════════════════════════════════════ */

describe('recognition lifecycle', () => {
    it('configures the recogniser for continuous listening with interim results', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        await service.start();

        expect(harness.recogniser().continuous).toBe(true);
        expect(harness.recogniser().interimResults).toBe(true);
        expect(harness.recogniser().lang).toBe('en-US');
    });

    it('restarts itself after the engine ends the session on a silence timeout', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        await service.start();
        expect(harness.recogniser().startCalls).toBe(1);

        // Chrome does this by itself after a few seconds of quiet. Without the restart,
        // "continuous" listening silently dies and the user is never told.
        harness.recogniser().endBySilence();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(harness.recogniser().startCalls).toBe(2);
        expect(harness.recogniser().running).toBe(true);
        service.destroy();
    });

    it('swallows InvalidStateError when start() is called on an already-running engine', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        await service.start();
        await expect(service.start()).resolves.toBe(true);
        expect(service.status).toBe('listening');
    });

    it('delivers interim and final transcripts separately, lowercased and trimmed', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        const interim: string[] = [];
        const final: string[] = [];
        service.onInterim = (text) => interim.push(text);
        service.onFinal = (text) => final.push(text);

        await service.start();
        harness.recogniser().emitInterim('how many vans');
        harness.recogniser().emitFinal('  How Many Vans Are Charging  ');

        expect(interim).toContain('how many vans');
        expect(final).toEqual(['how many vans are charging']);
    });

    it('aborts the engine on destroy', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        await service.start();
        service.destroy();
        expect(harness.recogniser().abortCalls).toBe(1);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
   Errors and microphone permission
   ════════════════════════════════════════════════════════════════════════════ */

describe('error handling', () => {
    it('swallows the two expected error codes so the UI shows no false alarm', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        const errors: SpeechErrorInfo[] = [];
        service.onError = (info) => errors.push(info);

        await service.start();
        harness.recogniser().emitError('no-speech'); // Just silence.
        harness.recogniser().emitError('aborted'); // Our own stop() call.

        expect(errors).toHaveLength(0);
        expect(service.status).toBe('listening');
        service.destroy();
    });

    it('maps a denied microphone onto its own status with actionable advice', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        const errors: SpeechErrorInfo[] = [];
        service.onError = (info) => errors.push(info);

        await service.start();
        harness.recogniser().emitError('not-allowed');

        expect(service.status).toBe('mic-blocked');
        expect(errors).toHaveLength(1);
        expect(errors[0].recoverable).toBe(true);
        expect(errors[0].message).toContain('address bar');
    });

    it('explains that Chromium recognition is a network service when it cannot be reached', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        const errors: SpeechErrorInfo[] = [];
        service.onError = (info) => errors.push(info);

        await service.start();
        harness.recogniser().emitError('network');

        expect(service.status).toBe('error');
        expect(errors[0].message).toContain('servers');
        service.destroy();
    });

    it('surfaces an unknown engine error rather than silently ignoring it', async () => {
        const harness = makeHost();
        const service = makeService(harness);
        const errors: SpeechErrorInfo[] = [];
        service.onError = (info) => errors.push(info);

        await service.start();
        harness.recogniser().emitError('some-future-error');

        expect(service.status).toBe('error');
        expect(errors[0].code).toBe('some-future-error');
        service.destroy();
    });
});

describe('microphone permission pre-flight', () => {
    it('never starts the engine when permission is already denied', async () => {
        const harness = makeHost();
        const permissions: PermissionsLike = {
            query: async () => ({ state: 'denied' as PermissionState }),
        };
        const service = makeService(harness, { permissions });
        const errors: SpeechErrorInfo[] = [];
        service.onError = (info) => errors.push(info);

        await expect(service.start()).resolves.toBe(false);
        expect(service.status).toBe('mic-blocked');
        expect(harness.recogniser().startCalls).toBe(0);
        expect(errors[0].message).toContain('Allow');
    });

    it('proceeds when permission is already granted', async () => {
        const harness = makeHost();
        const permissions: PermissionsLike = {
            query: async () => ({ state: 'granted' as PermissionState }),
        };
        const service = makeService(harness, { permissions });

        await expect(service.start()).resolves.toBe(true);
        expect(harness.recogniser().running).toBe(true);
        service.destroy();
    });

    it('treats a permissions API that throws as "no information", not as a denial', async () => {
        // Firefox and older Safari throw a TypeError for the 'microphone' name. Treating
        // that as denial would lock out users whose microphone works perfectly well.
        const harness = makeHost();
        const permissions: PermissionsLike = {
            query: () => Promise.reject(new TypeError("'microphone' is not a valid permission name")),
        };
        const service = makeService(harness, { permissions });

        await expect(service.checkMicrophonePermission()).resolves.toBe('unknown');
        await expect(service.start()).resolves.toBe(true);
        service.destroy();
    });

    it('reports "unknown" when there is no permissions API at all', async () => {
        const service = makeService(makeHost(), { permissions: null });
        await expect(service.checkMicrophonePermission()).resolves.toBe('unknown');
    });
});
