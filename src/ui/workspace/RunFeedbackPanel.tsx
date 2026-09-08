// Ticket 67 (B07, docs/specs/run-feedback-review.md): plain, durable
// Task/Run commentary. One shared, self-contained component for both the
// admin (RunWorkspace.tsx) and collaborator (CollaboratorWorkspace.tsx)
// surfaces — the same shape SessionChat.tsx already established for shared
// Session chat: it fetches, polls, and posts on its own, so a caller only
// ever passes the Run id, rather than each surface owning a parallel copy
// of the fetch/poll/composer state machine.
//
// Never a review/approval decision, never routed to a runtime — see
// docs/specs/run-feedback-review.md's "Scope and constraints carried over
// from #37". Shown for every Run status, including every terminal failure,
// since commentary never assumes a live process.
import { useEffect, useRef, useState } from 'react';
import type { RunFeedbackEntry } from '../../types.js';
import { listRunFeedback, postRunFeedback } from '../collaboratorRuns.js';

/** A comment composer, deliberately parallel to SessionChat's own ChatComposer — retains the draft on a failed post, the same guarantee the collaborator request form already gives. */
function RunFeedbackComposer({ onSubmit }: { onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(value);
      setText('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="mobile-request-composer run-feedback-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea aria-label="Add feedback" onChange={(event) => setText(event.target.value)} placeholder="Add a comment…" rows={2} value={text} />
      <button className="button button-primary" disabled={!text.trim() || sending} type="submit">{sending ? 'Posting…' : 'Post'}</button>
      {/* The post itself failed to reach the server — never a claim about whether the Run received it, since a comment is never routed to a runtime at all (B07). */}
      {error && <p className="run-feedback-error" role="alert">Not sent — {error}</p>}
    </form>
  );
}

/**
 * `headingLevel` lets each surface keep a correct heading hierarchy —
 * RunWorkspace's own sections are h2s, while CollaboratorWorkspace's Run
 * conversation nests everything but the objective itself under h3 — without
 * forking the component the way the pre-refactor two copies did.
 */
export function RunFeedbackPanel({ runId, headingLevel = 'h2' }: { runId: string; headingLevel?: 'h2' | 'h3' }) {
  const [feedback, setFeedback] = useState<RunFeedbackEntry[]>([]);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  useEffect(() => {
    setFeedback([]);
    let disposed = false;
    const tick = () => listRunFeedback(runId)
      .then((next) => { if (!disposed && runIdRef.current === runId) setFeedback(next); })
      .catch(() => undefined);
    void tick();
    const interval = setInterval(() => void tick(), 5000);
    return () => { disposed = true; clearInterval(interval); };
  }, [runId]);

  const submit = async (text: string) => {
    const entry = await postRunFeedback(runId, text);
    setFeedback((current) => [...current, entry]);
  };

  const Heading = headingLevel;
  return (
    <section aria-label="Feedback" className="run-feedback">
      <Heading>Feedback</Heading>
      {feedback.length === 0
        ? <p className="run-feedback-empty">No comments yet.</p>
        : (
          <ul className="run-feedback-list">
            {feedback.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.displayName}</strong>
                <time dateTime={entry.postedAt}>{new Date(entry.postedAt).toLocaleString()}</time>
                <p>{entry.text}</p>
              </li>
            ))}
          </ul>
        )}
      <RunFeedbackComposer onSubmit={submit} />
    </section>
  );
}
