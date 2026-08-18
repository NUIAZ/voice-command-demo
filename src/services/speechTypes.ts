/**
 * @file speechTypes.ts
 * @description Hand-written structural types for the Web Speech API's *recognition*
 * half.
 *
 * WHY THIS FILE EXISTS AT ALL:
 * `SpeechSynthesis` / `SpeechSynthesisUtterance` (the text-to-speech half) have been
 * in `lib.dom.d.ts` for years, so we use the built-in types for those. `SpeechRecognition`
 * is a different story: it is still a *draft* spec, it ships in Chromium and WebKit
 * behind the `webkit` prefix, and its presence in `lib.dom.d.ts` has come and gone
 * between TypeScript releases. Depending on the ambient DOM lib for it means the build
 * breaks (or silently changes shape) when TypeScript is upgraded.
 *
 * So we declare our own *structural* interfaces with distinct `...Like` names. Distinct
 * names matter: re-declaring `SpeechRecognition` in a global scope would collide with
 * the ambient declaration on TypeScript versions that ship one. Because TypeScript is
 * structurally typed, a real `webkitSpeechRecognition` instance satisfies
 * `SpeechRecognitionLike` without any cast, and the whole codebase stays free of `any`.
 */

/** One candidate transcription of a chunk of speech, with the engine's confidence. */
export interface SpeechRecognitionAlternativeLike {
    readonly transcript: string;
    readonly confidence: number;
}

/**
 * One recognised chunk. Indexable because the engine may return several alternatives
 * ranked by confidence; index 0 is always the best guess.
 *
 * `isFinal` is the important bit: while you are still talking the engine emits
 * *interim* results that can and do change wording as more audio arrives. Only a final
 * result should ever be routed to a command handler.
 */
export interface SpeechRecognitionResultLike {
    readonly isFinal: boolean;
    readonly length: number;
    readonly [index: number]: SpeechRecognitionAlternativeLike;
}

/** The growing list of results for the current recognition session. */
export interface SpeechRecognitionResultListLike {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
}

/**
 * A `result` event.
 *
 * `resultIndex` is the index of the first result that changed since the last event;
 * iterating from 0 every time would re-deliver transcripts you already handled, which
 * is a classic source of duplicated commands.
 */
export interface SpeechRecognitionEventLike {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultListLike;
}

/**
 * The subset of recognition error codes we care about. Kept as a union of literals
 * plus `string` so an unknown future code from a browser still type-checks instead of
 * crashing the build.
 *
 * - `no-speech`: silence timeout. Routine; the engine simply heard nothing.
 * - `aborted`: we (or a page navigation) called `stop()`/`abort()`. Routine.
 * - `not-allowed`: the user denied microphone access, or the page is not a secure
 *                   context. This is the one that deserves real UI.
 * - `service-not-allowed`: the platform (not the user) blocked the speech service,
 *                   e.g. enterprise policy or an OS-level microphone lockout.
 * - `audio-capture`: no usable input device at all (unplugged headset, no mic).
 * - `network`: Chrome's recogniser is cloud-backed; this is the offline case.
 */
export type SpeechRecognitionErrorCode =
    | 'no-speech'
    | 'aborted'
    | 'audio-capture'
    | 'network'
    | 'not-allowed'
    | 'service-not-allowed'
    | 'bad-grammar'
    | 'language-not-supported'
    | (string & {});

/** An `error` event from the recogniser. */
export interface SpeechRecognitionErrorEventLike {
    readonly error: SpeechRecognitionErrorCode;
    readonly message?: string;
}

/** The recogniser object itself: only the members this project actually touches. */
export interface SpeechRecognitionLike {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    maxAlternatives?: number;

    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;

    start(): void;
    stop(): void;
    abort(): void;
}

/** Constructor shape for either `SpeechRecognition` or `webkitSpeechRecognition`. */
export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/**
 * The bits of `window` we probe for. Everything is optional because the entire point
 * of the demo is behaving well when they are missing.
 *
 * Typing the *host* rather than casting the global is what keeps `any` out of
 * `speech.ts`: `detectSpeechSupport(window)` narrows a real `Window` down to this
 * structural view, and tests can pass a plain object literal instead.
 */
export interface SpeechHostWindow {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
}

/**
 * Minimal `Storage` view. Used so settings persistence can be unit-tested against an
 * in-memory map, and so a browser with `localStorage` disabled (Safari private mode
 * historically *threw* on write) degrades to defaults instead of throwing on boot.
 */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
