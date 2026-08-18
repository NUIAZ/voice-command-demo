// scripts/screenshots.mjs: captures docs/*.png from the live site (or a local
// URL) for the README and social posts. Playwright is not a dependency here;
// point PLAYWRIGHT_DIR at any project that has it, and BROWSER_CHANNEL=msedge
// or chrome to use an installed browser:
//   PLAYWRIGHT_DIR=../x/node_modules/playwright BROWSER_CHANNEL=msedge node scripts/screenshots.mjs
//   SITE_URL=http://localhost:5173/ node scripts/screenshots.mjs   (default: the Pages URL)
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

const pw = process.env.PLAYWRIGHT_DIR
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_DIR, 'index.mjs')).href
  : 'playwright';
const { chromium } = await import(pw);

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'docs');
mkdirSync(out, { recursive: true });
const site = process.env.SITE_URL || 'https://nuiaz.github.io/voice-command-demo/';

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });

async function shoot(name, { scheme = 'light', width = 1200, height = 800, path = '', prepare, clip, clipHeight } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
  await page.goto(site + path, { waitUntil: 'networkidle' });
  if (prepare) await prepare(page);
  await page.waitForTimeout(300);
  if (clip && clipHeight) {
    // Social tile: only the top `clipHeight` px of the element. Clip coordinates
    // for a fullPage screenshot are page-relative, so add the scroll offset.
    const box = await page.locator(clip).first().evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    });
    await page.screenshot({
      path: resolve(out, name), fullPage: true,
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(clipHeight, box.height) },
    });
  } else if (clip) {
    await page.locator(clip).first().screenshot({ path: resolve(out, name) });
  } else await page.screenshot({ path: resolve(out, name) });
  console.log('wrote', name);
  await page.close();
}

// Hero: the fleet page with the Voice control panel, light and dark.
await shoot('screenshot.png', { width: 1400, height: 820 });
await shoot('screenshot-dark.png', { scheme: 'dark', width: 1400, height: 820 });
// Social tile: the voice panel plus command history, on its own.
const panel = 'aside[aria-label="Voice control"]';
await shoot('hero.png', { clip: panel, clipHeight: 520 });
await shoot('hero-dark.png', { scheme: 'dark', clip: panel, clipHeight: 520 });
// The panel after asking a question through the text box (same handler as the mic).
const ask = async page => {
  await page.getByPlaceholder(/Type a command/i).fill('are there any problems');
  await page.getByRole('button', { name: 'Run' }).click();
  await page.waitForTimeout(900);
};
await shoot('hero-answered.png', { prepare: ask, clip: panel, clipHeight: 640 });
await shoot('hero-answered-dark.png', { scheme: 'dark', prepare: ask, clip: panel, clipHeight: 640 });
// The Commands page (no router; click the nav tab): every command has a Try it button.
await shoot('commands.png', {
  width: 1400, height: 900,
  prepare: async page => { await page.getByRole('link', { name: 'Commands' }).or(page.getByRole('button', { name: 'Commands' })).first().click(); await page.waitForTimeout(400); },
});
// The text version, as a plain document.
await shoot('text-version.png', { path: 'text.html', width: 1000, height: 800 });

await browser.close();
