/**
 * @file CommandsView.tsx
 * @description The command reference.
 *
 * Every command gets its trigger phrases, an example, and a "Try it" button that runs
 * the *identical handler* the microphone would have run.
 *
 * That button is not a convenience feature. It is how this demo stays usable for:
 *   - anyone in Firefox, which has no speech recognition at all;
 *   - anyone without a microphone, or who has denied permission;
 *   - anyone in an open-plan office, a library, or a shared space;
 *   - anyone with a speech difference the recogniser handles badly (recognisers are
 *     measurably worse for non-native accents, dysarthria and stammering), and a voice
 *     interface with no pointer equivalent simply locks those users out;
 *   - anyone who would just rather not talk to their computer.
 *
 * Because it calls `runCommandById`, the same function `processTranscript` dispatches
 * to: there is no parallel click-only code path that can drift out of step with the
 * spoken one.
 */

import { commandsByGroup } from '../services/commands';

interface Props {
    /** Runs a command by id and speaks the result through the live session. */
    onRun: (id: string) => void;
    /** Whether this browser can listen at all; changes the framing of the page. */
    speechSupported: boolean;
}

/**
 * Builds the page from `commandsByGroup()`, so the reference cannot go stale: adding a
 * command to the router adds it here, and the trigger phrases shown are the exact strings
 * the matcher tests against rather than a hand-written paraphrase.
 *
 * `speechSupported` only changes the framing copy; the "Try it" buttons are rendered and
 * usable either way, which is the entire point of the page (see the file header).
 */
export default function CommandsView({ onRun, speechSupported }: Props) {
    const groups = commandsByGroup();

    return (
        <>
            <section className="panel" aria-labelledby="commands-heading">
                <h2 id="commands-heading">Command reference</h2>
                <p>
                    Say any of the trigger phrases below while the microphone is on, or press{' '}
                    <strong>Try it</strong> to run the same handler without speaking. Answers appear in
                    the voice panel and are spoken aloud unless you have muted them.
                </p>
                {!speechSupported && (
                    <div className="notice notice--info">
                        <p>
                            <strong>This browser has no speech recognition.</strong> Every command below
                            still works: press <strong>Try it</strong>, or type a phrase into the box in
                            the voice panel. Spoken answers still work if your browser has speech
                            synthesis, which most do.
                        </p>
                    </div>
                )}

                <h3 style={{ marginTop: '18px' }}>How matching works, and what it does not do</h3>
                <p className="small muted">
                    The transcript is lowercased, stripped of punctuation, and tested against an ordered
                    list of commands. The first command whose trigger phrase appears in the transcript
                    wins; nothing after it is consulted. Vehicle call signs, depot names and state words
                    are matched on word boundaries so that &ldquo;Tern&rdquo; is not found inside
                    &ldquo;eastern&rdquo;.
                </p>
                <p className="small muted">
                    It is <strong>not</strong> fuzzy matching and <strong>not</strong> intent
                    classification. There is no model and no confidence score.
                    &ldquo;vehicals&rdquo; matches nothing. &ldquo;Don&rsquo;t tell me about the offline
                    ones&rdquo; matches the offline command, because negation is invisible to a
                    substring test. In exchange it is fully deterministic, runs in microseconds, needs
                    no network, and when it gets something wrong you can read the source and see
                    exactly why: a fair trade for a small fixed vocabulary, and the wrong one the
                    moment users start speaking freely.
                </p>
            </section>

            {groups.map(
                (group) =>
                    group.commands.length > 0 && (
                        <section
                            key={group.group}
                            className="panel command-group"
                            aria-labelledby={`group-${group.group.replace(/\s+/g, '-')}`}
                        >
                            <h3 id={`group-${group.group.replace(/\s+/g, '-')}`}>{group.group}</h3>
                            <ul className="command-list">
                                {group.commands.map((command) => (
                                    <li key={command.id} className="command-card">
                                        <div className="command-card__head">
                                            <span className="command-card__title">{command.title}</span>
                                            <button
                                                type="button"
                                                className="btn btn--small"
                                                onClick={() => onRun(command.id)}
                                            >
                                                Try it
                                                <span className="sr-only">: run the {command.title} command</span>
                                            </button>
                                        </div>
                                        <p className="small muted" style={{ margin: '3px 0 0' }}>
                                            {command.description}
                                        </p>
                                        <ul className="command-card__triggers" aria-label={`Trigger phrases for ${command.title}`}>
                                            {command.keywords.map((keyword) => (
                                                <li key={keyword}>{keyword}</li>
                                            ))}
                                        </ul>
                                        <p className="command-card__example">
                                            <span className="muted">Example: </span>
                                            <em>&ldquo;{command.example}&rdquo;</em>
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ),
            )}
        </>
    );
}
