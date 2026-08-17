/**
 * @file vite.config.ts
 * @description Build + test configuration.
 *
 * WHY `base: './'`:
 * The app is deployed to GitHub Pages under a *project* path
 * (https://<user>.github.io/voice-command-demo/), not at the domain root.
 * A relative base makes the emitted asset URLs work from any sub-path without
 * having to bake the repository name into the build, so the same `dist/` also
 * works when opened from a local static server or a different Pages repo name.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    base: './',
    build: {
        // Source maps make the "how does this work" story inspectable in devtools,
        // which matters for a demo whose whole point is showing the technique.
        sourcemap: true,
        outDir: 'dist',
    },
    test: {
        // jsdom gives us `window`, `localStorage` and DOM events. It does NOT give us
        // SpeechRecognition or speechSynthesis — that is deliberate: the tests stub
        // those explicitly so we can prove the graceful-degradation paths and so the
        // suite never needs a real microphone or an audio device.
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./vitest.setup.ts'],
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
});
