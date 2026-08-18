import { describe, expect, it } from 'vitest';
import { renderTextVersion, esc } from '../services/textVersion';
import { VEHICLES, DEPOTS, STATUSES, statusLabel } from '../data';
import { COMMANDS, STOP_PHRASES } from '../services/commands';

/**
 * The text version exists so a browser without script still gets the information the demo
 * is about, and it is generated rather than written so it cannot drift from the app. These
 * tests are the "cannot drift" guarantee: add a vehicle or a command and forget the text
 * page, and the build fails. (It cannot forget: it reads the same arrays. The tests are
 * there for the day someone refactors that away.)
 */
describe('text version', () => {
    const html = renderTextVersion({ generatedOn: '2026-01-01', interactiveUrl: './' });

    it('is a complete HTML document with no script and no stylesheet', () => {
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain('<html lang="en">');
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<link[^>]+stylesheet/i);
        expect(html.trim().endsWith('</html>')).toBe(true);
    });

    it('lists every vehicle as a table row with a row header, and its status as text', () => {
        for (const v of VEHICLES) {
            expect(html).toContain(`<th scope="row">${esc(v.name)}</th>`);
            expect(html).toContain(`<td>${esc(v.id)}</td>`);
            expect(html).toContain(esc(v.telematicsIp));
        }
        for (const s of STATUSES) expect(html).toContain(esc(statusLabel(s.id)));
        // Real header cells, so a screen reader can announce column names.
        expect((html.match(/<th scope="col">/g) ?? []).length).toBeGreaterThanOrEqual(10);
        expect(html).toContain('<caption>');
    });

    it('lists every depot with its town', () => {
        for (const d of DEPOTS) {
            expect(html).toContain(esc(d.name));
            expect(html).toContain(esc(d.town));
        }
    });

    it('lists every command with its title, description and example, grouped', () => {
        for (const c of COMMANDS) {
            expect(html).toContain(`id="command-${esc(c.id)}"`);
            expect(html).toContain(esc(c.title));
            expect(html).toContain(esc(c.description));
            expect(html).toContain(esc(c.example));
        }
        for (const p of STOP_PHRASES) expect(html).toContain(esc(p));
        for (const g of new Set(COMMANDS.map(c => c.group))) expect(html).toContain(`<h3>${esc(g)}</h3>`);
    });

    it('tells a no-script reader how to reach the interactive version and which browsers work', () => {
        expect(html).toContain('href="./"');
        expect(html).toMatch(/JavaScript/);
        expect(html).toMatch(/Chrome or Edge/);
        expect(html).toMatch(/Try it/);
    });

    it('is deterministic for a fixed date', () => {
        expect(renderTextVersion({ generatedOn: '2026-01-01' })).toBe(
            renderTextVersion({ generatedOn: '2026-01-01' }),
        );
        expect(html).toContain('Generated 2026-01-01');
    });
});
