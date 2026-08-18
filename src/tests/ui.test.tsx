/**
 * @file ui.test.tsx
 * @description End-to-end-ish smoke tests over the real React tree in jsdom.
 *
 * jsdom has NO SpeechRecognition and NO speechSynthesis, which makes it an unusually
 * good test environment for this app: it is exactly the Firefox-shaped browser the
 * no-speech fallbacks exist for. If the tree renders and the click-to-try path works
 * here, it works for every user who cannot or will not use a microphone.
 *
 * Rendered with plain `react-dom/client` rather than a testing library; the assertions
 * are simple enough not to need one, and a demo repository should not carry a dependency
 * it barely uses.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { VEHICLES } from '../data';

// React needs this flag to accept `act()` outside a testing library.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<App />);
    });
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
});

/** Finds the first element matching `selector` whose text content is exactly `text`. */
function byText<T extends Element>(selector: string, text: string): T {
    const match = Array.from(container.querySelectorAll(selector)).find(
        (el) => el.textContent?.trim().startsWith(text),
    );
    if (!match) throw new Error(`No ${selector} found with text starting "${text}"`);
    return match as T;
}

async function click(element: Element): Promise<void> {
    await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

describe('application shell', () => {
    it('renders without throwing in a browser that has no speech APIs at all', () => {
        expect(container.textContent).toContain('Voice Command Demo');
    });

    it('provides the semantic landmarks and a skip link as the first focusable element', () => {
        expect(container.querySelector('header')).not.toBeNull();
        expect(container.querySelector('nav[aria-label="Views"]')).not.toBeNull();
        expect(container.querySelector('main#main')).not.toBeNull();
        expect(container.querySelector('aside[aria-label="Voice control"]')).not.toBeNull();
        expect(container.querySelector('footer')).not.toBeNull();

        const skip = container.querySelector('a.skip-link');
        expect(skip?.getAttribute('href')).toBe('#main');
        // `main` must be focusable, or the skip link scrolls without moving focus.
        expect(container.querySelector('main')?.getAttribute('tabindex')).toBe('-1');
    });

    it('renders the whole fleet in the table', () => {
        const rows = container.querySelectorAll('tbody tr');
        expect(rows.length).toBe(VEHICLES.length);
    });

    it('exposes the live transcript and the response as separate aria-live regions', () => {
        expect(container.querySelector('[aria-label="Live transcript"][aria-live="polite"]')).not.toBeNull();
        // The response region is role="status", an implicit polite live region, and atomic
        // so a partial sentence is never announced out of order.
        const response = container.querySelector('[aria-label="Latest response"]');
        expect(response?.getAttribute('role')).toBe('status');
        expect(response?.getAttribute('aria-atomic')).toBe('true');
    });

    it('disables the microphone button and explains why when recognition is unavailable', () => {
        const mic = container.querySelector<HTMLButtonElement>('button.mic-button');
        expect(mic?.disabled).toBe(true);
        expect(container.textContent).toContain('does not implement speech recognition');
    });
});

describe('click-to-try: the no-microphone path', () => {
    it('runs a command from the Commands page and shows the spoken answer as text', async () => {
        await click(byText('button', 'Commands'));
        expect(container.textContent).toContain('Command reference');

        // Every command card carries the same "Try it" affordance; the first one in the
        // Fleet group is the exception report.
        const tryButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
            b.textContent?.startsWith('Try it'),
        );
        expect(tryButtons.length).toBeGreaterThan(10);

        await click(tryButtons[0]);

        // The answer is rendered as text whether or not anything was spoken aloud, and
        // the utterance that produced it is echoed into the history.
        expect(container.textContent).toContain('3 vans offline: Finch, Oriole, and Kingfisher');
        expect(container.textContent).toContain('are there any problems');
        expect(container.textContent).toContain('Command history');
    });

    it('applies a command effect: a filter command narrows the table and navigates back to it', async () => {
        await click(byText('button', 'Commands'));
        const listCard = Array.from(container.querySelectorAll('li.command-card')).find((li) =>
            li.textContent?.includes('List by state'),
        );
        expect(listCard).toBeDefined();

        const tryIt = listCard!.querySelector('button');
        await click(tryIt!);

        // "show me all the offline vans" → filter to offline → three rows, on the fleet view.
        const rows = container.querySelectorAll('tbody tr');
        expect(rows.length).toBe(3);
        expect(container.textContent).toContain('3 vans are offline');
    });

    it('focuses a single vehicle row when asked about one van', async () => {
        await click(byText('button', 'Commands'));
        const vehicleCard = Array.from(container.querySelectorAll('li.command-card')).find((li) =>
            li.textContent?.includes('Vehicle detail'),
        );
        await click(vehicleCard!.querySelector('button')!);

        const focused = container.querySelector('tr.is-focused');
        expect(focused?.textContent).toContain('Kestrel');
        expect(container.textContent).toContain('203 dot 0 dot 113 dot 11');
    });
});

describe('pointer-driven filtering still works independently of voice', () => {
    it('filters the table from the status chips', async () => {
        await click(byText('button', 'Charging'));
        expect(container.querySelectorAll('tbody tr').length).toBe(7);

        await click(byText('button', 'All states'));
        expect(container.querySelectorAll('tbody tr').length).toBe(VEHICLES.length);
    });
});

describe('browser support view', () => {
    it('reports what this environment can actually do', async () => {
        await click(byText('button', 'Browser support'));
        expect(container.textContent).toContain('speech recognition is not available');
        expect(container.textContent).toContain('Voice control is itself an assistive technology');
    });
});
