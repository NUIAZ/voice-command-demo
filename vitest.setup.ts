/**
 * @file vitest.setup.ts
 * @description Global test setup.
 *
 * Deliberately almost empty. In particular it does NOT polyfill `SpeechRecognition` or
 * `speechSynthesis` globally: every speech test injects its own stub through
 * `SpeechService`'s options, so the tests exercise the real support-detection and
 * graceful-degradation code paths instead of routing around them. A global polyfill
 * would make the "this browser cannot listen" branch untestable, which is the branch
 * most likely to be wrong in production.
 */

import { beforeEach } from 'vitest';

beforeEach(() => {
    // jsdom gives each test file a shared localStorage. Clearing it between tests keeps
    // the settings-persistence assertions independent of execution order.
    try {
        localStorage.clear();
    } catch {
        /* Storage unavailable — the tests that care inject their own. */
    }
});
