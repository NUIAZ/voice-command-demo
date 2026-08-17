/**
 * @file SupportView.tsx
 * @description Honest documentation of what the Web Speech API actually does in each
 * browser, what it needs, and where the audio goes.
 *
 * This page exists because the single most common failure mode of a Web Speech demo is
 * a user opening it in the wrong browser and concluding the code is broken. The second
 * most common is not realising that "built into the browser" does not mean "processed on
 * your device".
 */

import type { SpeechSupport } from '../services/speech';

interface Props {
    support: SpeechSupport;
}

interface BrowserRow {
    browser: string;
    recognition: string;
    recognitionTone: 'ok' | 'warn' | 'bad';
    synthesis: string;
    synthesisTone: 'ok' | 'warn' | 'bad';
    notes: string;
}

/**
 * The matrix. Deliberately describes *behaviour* rather than version numbers: the
 * implementations shift, but the shape of the support story has been stable for years —
 * Chromium implements recognition behind the `webkit` prefix and sends audio to a
 * server, WebKit implements it with an on-device or server model depending on the OS,
 * and Gecko does not implement it at all.
 */
const BROWSERS: BrowserRow[] = [
    {
        browser: 'Chrome (desktop & Android)',
        recognition: 'Yes — as webkitSpeechRecognition',
        recognitionTone: 'ok',
        synthesis: 'Yes',
        synthesisTone: 'ok',
        notes:
            'The reference implementation. Recognition is performed by a Google speech service, not on your device, so it needs a working internet connection. Chrome also ends a "continuous" session after several seconds of silence — this demo restarts it automatically.',
    },
    {
        browser: 'Edge (Chromium)',
        recognition: 'Yes — as webkitSpeechRecognition',
        recognitionTone: 'ok',
        synthesis: 'Yes',
        synthesisTone: 'ok',
        notes:
            'Behaves like Chrome. Recognition is routed through Microsoft speech services. Edge ships a large set of high-quality neural voices for synthesis; some are downloaded on first use, so the voice list can grow a few seconds after page load.',
    },
    {
        browser: 'Safari (macOS & iOS)',
        recognition: 'Partial — as webkitSpeechRecognition',
        recognitionTone: 'warn',
        synthesis: 'Yes',
        synthesisTone: 'ok',
        notes:
            'Present, but stricter: recognition must be started from a user gesture, and on iOS it is tied to the system dictation setting — if dictation is disabled in Settings, it fails. Safari also populates the synthesis voice list synchronously and may never fire voiceschanged, and it can drop an utterance without firing onend, which is why this demo runs a watchdog timer.',
    },
    {
        browser: 'Firefox',
        recognition: 'No',
        recognitionTone: 'bad',
        synthesis: 'Yes',
        synthesisTone: 'ok',
        notes:
            'SpeechRecognition is not exposed to web content. There has been a preference behind which a partial implementation lived for years, but it is not on by default and cannot be relied on. Speech synthesis works normally. Use the "Try it" buttons on the Commands page — they run the identical handlers.',
    },
    {
        browser: 'Samsung Internet / other Chromium forks',
        recognition: 'Usually',
        recognitionTone: 'warn',
        synthesis: 'Yes',
        synthesisTone: 'ok',
        notes:
            'Inherits the Chromium implementation, but the backing speech service and the available voices vary by vendor and by device. Feature-detect; never assume.',
    },
];

/**
 * Explains what this browser can and cannot do, and why.
 *
 * The banner at the top is driven by `support`, which is *feature-detected* at runtime;
 * the table below it is hand-maintained prose about the engines' known behaviour. Keeping
 * the two visibly separate is deliberate — the detected result is always authoritative for
 * the browser actually running the page, and the table is background that will age.
 */
export default function SupportView({ support }: Props) {
    return (
        <>
            <section className="panel" aria-labelledby="support-heading">
                <h2 id="support-heading">Browser support</h2>

                <div
                    className={`notice ${support.recognition ? 'notice--info' : 'notice--warn'}`}
                    role="status"
                >
                    <p style={{ marginBottom: 0 }}>
                        <strong>In this browser, right now:</strong> speech recognition is{' '}
                        {support.recognition ? 'available' : 'not available'}; speech synthesis is{' '}
                        {support.synthesis ? 'available' : 'not available'}; this page{' '}
                        {support.secureContext ? 'is' : 'is NOT'} a secure context.
                        {!support.secureContext && (
                            <>
                                {' '}
                                Recognition will be refused until the page is served over HTTPS or from{' '}
                                <code>localhost</code>.
                            </>
                        )}
                    </p>
                </div>

                <div className="table-wrap">
                    <table className="support-table">
                        <caption className="sr-only">
                            Web Speech API support by browser, covering speech recognition, speech
                            synthesis, and behavioural notes.
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">Browser</th>
                                <th scope="col">Recognition (speech in)</th>
                                <th scope="col">Synthesis (speech out)</th>
                                <th scope="col">Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            {BROWSERS.map((row) => (
                                <tr key={row.browser}>
                                    <th scope="row">{row.browser}</th>
                                    <td>
                                        <span className={`pill pill--${row.recognitionTone}`}>{row.recognition}</span>
                                    </td>
                                    <td>
                                        <span className={`pill pill--${row.synthesisTone}`}>{row.synthesis}</span>
                                    </td>
                                    <td style={{ minWidth: '320px' }}>{row.notes}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="panel" aria-labelledby="requirements-heading">
                <h3 id="requirements-heading">What it needs to work</h3>
                <dl className="definition-list">
                    <dt>A secure context</dt>
                    <dd>
                        HTTPS, or <code>http://localhost</code>. Microphone access — and therefore
                        recognition — is refused on a plain <code>http://</code> origin. A page deployed
                        to GitHub Pages is served over HTTPS, so this is only a problem when testing
                        against a LAN address.
                    </dd>

                    <dt>Microphone permission</dt>
                    <dd>
                        The browser asks once per origin. Granting it is remembered; denying it is
                        <em> also</em> remembered, and the browser will not ask again — the user has to
                        change it from the padlock or camera icon in the address bar and reload. That
                        one-way door is why this demo pre-flights the permission and shows a specific
                        recovery message instead of a generic error.
                    </dd>

                    <dt>A network connection, in Chromium browsers</dt>
                    <dd>
                        See the privacy note below. Offline, recognition fails with a{' '}
                        <code>network</code> error. Speech synthesis, by contrast, is local in every
                        browser tested and works offline.
                    </dd>

                    <dt>A user gesture, in Safari</dt>
                    <dd>
                        Recognition must begin from a click or tap. Starting it on page load is
                        silently refused. The microphone button in this demo satisfies that
                        requirement everywhere.
                    </dd>
                </dl>
            </section>

            <section className="panel" aria-labelledby="privacy-heading">
                <h3 id="privacy-heading">Where your voice actually goes</h3>
                <p>
                    &ldquo;Built into the browser&rdquo; is not the same as &ldquo;processed on your
                    device&rdquo;, and the API gives you no way to tell the difference from JavaScript.
                </p>
                <ul>
                    <li>
                        <strong>Chrome and Edge</strong> stream captured audio to their vendor&rsquo;s
                        speech service and return the transcript. That is why recognition fails offline
                        and why the first result takes a moment to arrive.
                    </li>
                    <li>
                        <strong>Safari</strong> uses the platform speech framework, which may run
                        on-device or on Apple&rsquo;s servers depending on the OS version, the language,
                        and whether the relevant model has been downloaded.
                    </li>
                    <li>
                        <strong>This page</strong> has no backend of its own. It never transmits
                        anything, and the only thing it stores is your chosen voice, rate, pitch and
                        mute preference in <code>localStorage</code>. The transcript and command history
                        live in memory and disappear when you close the tab.
                    </li>
                </ul>
                <p>
                    If you are building something where the audio itself is sensitive, feature-detection
                    is not enough — you need a recogniser you control, running where you can point at
                    it. The Web Speech API cannot give you that guarantee.
                </p>
            </section>

            <section className="panel" aria-labelledby="a11y-heading">
                <h3 id="a11y-heading">Accessibility notes</h3>
                <p>
                    <strong>Voice control is itself an assistive technology.</strong> For someone with a
                    motor impairment, RSI, a temporary injury, or their hands full, speaking to an
                    interface may be the only practical way to use it — which makes it all the more
                    important that adding voice does not degrade anything else. Adding a voice mode that
                    can only be reached with a mouse, or that steals focus, or that animates
                    continuously, makes an app less accessible overall even though the new feature is an
                    accessibility feature.
                </p>
                <p>It also has real limits that a demo should be honest about:</p>
                <ul>
                    <li>
                        Recognition accuracy is measurably worse for non-native accents, for regional
                        dialects, and for people with dysarthria, aphasia, or a stammer — the exact
                        groups most likely to benefit. Voice must always be an addition to a pointer and
                        keyboard interface, never a replacement for one.
                    </li>
                    <li>
                        It is unusable in shared, quiet, or noisy environments, and it broadcasts what
                        you are doing to everyone nearby.
                    </li>
                    <li>
                        It conflicts with screen readers, which are already using the audio channel;
                        that is part of why every response here is rendered as text in an{' '}
                        <code>aria-live</code> region as well as spoken, and why mute is a first-class
                        control rather than an afterthought.
                    </li>
                </ul>
                <p>What this demo does about all of that:</p>
                <ul>
                    <li>Every command has a keyboard- and pointer-operable equivalent on the Commands page, plus a text input in the voice panel.</li>
                    <li>The live transcript and every response are in <code>aria-live</code> regions, so screen-reader users receive them as text.</li>
                    <li>All animation is disabled under <code>prefers-reduced-motion</code>.</li>
                    <li>Focus is never stolen; a skip link is the first focusable element; focus indicators are visible and high contrast.</li>
                    <li>State is never conveyed by colour alone — status pills carry text, and the battery bar is paired with its number.</li>
                    <li>Semantic landmarks throughout: <code>header</code>, <code>nav</code>, <code>main</code>, <code>aside</code>, <code>footer</code>.</li>
                </ul>
            </section>
        </>
    );
}
