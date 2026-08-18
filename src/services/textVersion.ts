/**
 * textVersion.ts: renders the demo's information as one plain, static HTML page.
 *
 * The voice demo cannot work without JavaScript; speech recognition and speech
 * synthesis are browser APIs that script has to drive. But the *information* the
 * demo answers questions about (the fleet, the depots, and what you can ask) does
 * not need script at all, and a visitor with scripting off, or in a text-only
 * browser, should get it rather than a dead end.
 *
 * So text.html is generated at build time from the same dataset and the same
 * command table the app uses: fleet summary, every vehicle as a real table with
 * header cells, the depots, and the full command vocabulary with an example
 * phrase for each. It cannot drift from the app because it is not maintained
 * separately; a test asserts every vehicle and every command is present.
 *
 * Output rules: semantic HTML only, no script, no stylesheet, no colour as the
 * only signal (status is text). Readable in Lynx, in a screen reader, on paper.
 */

import { VEHICLES, DEPOTS, STATUSES, fleetSummary, statusLabel, depotName } from '../data';
import { COMMANDS, STOP_PHRASES } from './commands';

/** Escape text for HTML. Everything from the dataset goes through this. */
export function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface TextVersionOptions {
  /** ISO date shown in the footer; defaults to today. */
  readonly generatedOn?: string;
  /** Where the interactive app lives, for the "try the full version" link. */
  readonly interactiveUrl?: string;
}

/** Minutes → "1 h 36 min" / "12 min", the way the app phrases it. */
function minutesLabel(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Render the complete text version. Pure: same input, same string. */
export function renderTextVersion(options: TextVersionOptions = {}): string {
  const generatedOn = options.generatedOn ?? new Date().toISOString().slice(0, 10);
  const interactiveUrl = options.interactiveUrl ?? './';
  const summary = fleetSummary();

  const rows = VEHICLES.map(
    v => `<tr>
<th scope="row">${esc(v.name)}</th>
<td>${esc(v.id)}</td>
<td>${esc(statusLabel(v.status))}</td>
<td>${esc(depotName(v.depotId))}</td>
<td>${esc(v.batteryPercent)}%</td>
<td>${esc(v.cargoPercent)}%</td>
<td>${esc(v.packagesRemaining)}</td>
<td>${esc(v.odometerKm.toLocaleString('en-US'))} km</td>
<td>${esc(v.telematicsIp)}</td>
<td>${esc(minutesLabel(v.lastCheckInMinutes))} ago</td>
<td>${v.note ? esc(v.note) : ''}</td>
</tr>`,
  ).join('\n');

  const depots = DEPOTS.map(
    d =>
      `<li><strong>${esc(d.name)}</strong>, ${esc(d.town)}: ${esc(d.chargeBays)} charge bays, subnet ${esc(d.subnet)}. Also answers to: ${d.spokenAliases.map(esc).join(', ') || 'none'}.</li>`,
  ).join('\n');

  const statuses = STATUSES.map(
    s => `<li><strong>${esc(s.label)}</strong>${s.isProblem ? ' (counts as a problem)' : ''}. Also answers to: ${s.spokenAliases.map(esc).join(', ') || 'none'}.</li>`,
  ).join('\n');

  // Group commands the way the Commands page does.
  const groups = new Map<string, typeof COMMANDS[number][]>();
  for (const c of COMMANDS) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  }
  const commands = [...groups.entries()]
    .map(
      ([group, cmds]) => `
<h3>${esc(group)}</h3>
<dl>
${cmds
  .map(
    c => `<dt id="command-${esc(c.id)}"><strong>${esc(c.title)}</strong></dt>
<dd>${esc(c.description)} Say, for example: <q>${esc(c.example)}</q>.</dd>`,
  )
  .join('\n')}
</dl>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Voice Command Demo: text version</title>
<meta name="description" content="Plain-text version of the Voice Command Demo: the fleet data, the depots, and the full command vocabulary, generated from the same source as the interactive app.">
</head>
<body>
<a id="top"></a>
<header>
<h1>Voice Command Demo: text version</h1>
<p>This page is the information behind the Voice Command Demo in plain HTML, with no script and
no stylesheet: the fleet summary, every one of the ${VEHICLES.length} vehicles as a table, the
${DEPOTS.length} depots, and the ${COMMANDS.length} voice commands with an example phrase for each. It is
generated at build time from the same dataset and command table the app uses, so it is always
current.</p>
<p>What it cannot do is listen or talk. Speech recognition and speech synthesis are browser
features that need JavaScript, so if your browser has scripting turned off, or you are using a
text-only browser, you have two options: read on here, or open
<a href="${esc(interactiveUrl)}">the interactive version</a> in a browser with JavaScript
enabled. For speech <em>recognition</em> that means Chrome or Edge (Safari with a user gesture);
Firefox has speech synthesis but no recognition, and there every command still works from its
<strong>Try it</strong> button and the text box, using the same handler the microphone would.
Everything is fictional and nothing leaves your machine except, in Chromium browsers, the audio
the browser sends to its own speech service.</p>
</header>
<nav aria-labelledby="toc-heading">
<h2 id="toc-heading">Contents</h2>
<ol>
<li><a href="#summary">Fleet summary</a></li>
<li><a href="#vehicles">Vehicles</a></li>
<li><a href="#depots">Depots</a></li>
<li><a href="#statuses">Statuses</a></li>
<li><a href="#commands">Voice commands</a></li>
</ol>
</nav>
<main>
<section id="summary">
<h2>Fleet summary</h2>
<dl>
<dt>Vans in fleet</dt><dd>${esc(summary.total)}</dd>
<dt>On route</dt><dd>${esc(summary.onRoute)}</dd>
<dt>Idle</dt><dd>${esc(summary.idle)}</dd>
<dt>Charging</dt><dd>${esc(summary.charging)}</dd>
<dt>In maintenance</dt><dd>${esc(summary.maintenance)}</dd>
<dt>Offline</dt><dd>${esc(summary.offline)}</dd>
<dt>At or below the low-battery threshold</dt><dd>${esc(summary.lowBattery)}</dd>
<dt>Stale check-ins</dt><dd>${esc(summary.staleCheckIns)}</dd>
<dt>Parcels still on board</dt><dd>${esc(summary.packagesRemaining)}</dd>
<dt>Average battery</dt><dd>${esc(summary.averageBattery)}%</dd>
</dl>
<p>${summary.allClear ? 'All clear: nothing needs attention.' : 'Some vans need attention; see the Status column below.'}</p>
</section>
<section id="vehicles">
<h2>Vehicles</h2>
<table>
<caption>All ${VEHICLES.length} vans: call sign, asset id, status, depot, charge, load, parcels, odometer, telematics address, last check-in</caption>
<thead>
<tr>
<th scope="col">Call sign</th><th scope="col">Asset</th><th scope="col">Status</th><th scope="col">Depot</th>
<th scope="col">Charge</th><th scope="col">Load</th><th scope="col">Parcels</th><th scope="col">Odometer</th>
<th scope="col">Telematics</th><th scope="col">Last check-in</th><th scope="col">Note</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
<p><a href="#top">Back to top</a></p>
</section>
<section id="depots">
<h2>Depots</h2>
<ul>
${depots}
</ul>
</section>
<section id="statuses">
<h2>Statuses</h2>
<ul>
${statuses}
</ul>
</section>
<section id="commands">
<h2>Voice commands</h2>
<p>In the interactive app every one of these can be spoken, clicked (<strong>Try it</strong>) or
typed. To stop the app talking, say any of: ${STOP_PHRASES.map(p => `<q>${esc(p)}</q>`).join(', ')}.</p>
${commands}
<p><a href="#top">Back to top</a></p>
</section>
</main>
<footer>
<p>Generated ${esc(generatedOn)} from the app's dataset and command table. Source and interactive
app: <a href="https://github.com/NUIAZ/voice-command-demo">github.com/NUIAZ/voice-command-demo</a>.
Every name, depot, vehicle and address is fictional. MIT licensed.</p>
</footer>
</body>
</html>
`;
}
