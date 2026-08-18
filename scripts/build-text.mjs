// scripts/build-text.mjs: writes public/text.html from src/services/textVersion.ts.
//
// Runs before `vite build` (see package.json "build"), so the generated page is
// copied into dist/ with the rest of public/ and published by the Pages
// workflow. It is also run before `vite dev` so http://localhost:5173/text.html
// works locally. The file is gitignored: it is an artefact of the source, not a
// source itself, and committing it would only invite drift.
//
// The generator is TypeScript that imports the dataset and command table (which
// pull in app modules), so it is loaded through Vite's own SSR module loader
// rather than a separate TS runner. That keeps the dependency list unchanged.
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { renderTextVersion } = await server.ssrLoadModule('/src/services/textVersion.ts');
  const html = renderTextVersion({ interactiveUrl: './' });
  mkdirSync(resolve(root, 'public'), { recursive: true });
  const out = resolve(root, 'public', 'text.html');
  writeFileSync(out, html, 'utf8');
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
} finally {
  await server.close();
}
