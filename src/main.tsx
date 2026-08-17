/**
 * @file main.tsx
 * @description Application entry point.
 *
 * StrictMode is on deliberately. It double-mounts effects in development, which is
 * exactly the pressure a microphone session should be under: `useVoiceSession` builds
 * its `SpeechService` inside an effect and destroys it in the cleanup, so StrictMode
 * proves the construct/destroy cycle is clean rather than leaving an orphaned recogniser
 * with a live `voiceschanged` listener behind. If voice mode survives StrictMode, it
 * will survive a route change.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
