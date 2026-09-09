// Ticket 67 (B07, docs/specs/run-feedback-review.md): plain, durable
// Task/Run commentary. One shared, self-contained component for both the
// admin (RunWorkspace.tsx) and collaborator (CollaboratorWorkspace.tsx)
// surfaces — the same shape SessionChat.tsx already established for shared
// Session chat: it fetches, polls, and posts on its own, so a caller only
// ever passes the Run id, rather than each surface owning a parallel copy
// of the fetch/poll/composer state machine.
//
// Never routed to a runtime — see docs/specs/run-feedback-review.md's
// "Scope and constraints carried over from #37". Shown for every Run
// status, including every terminal failure, since commentary never assumes
// a live process. Ticket 71 (B09): a review decision is deliberately built
// on this same comment path (a specially-tagged post, never a second
// write) — see run-review.ts's own header for why.
import { useEffect, useRef, useState } from 'react';
import type { ReviewDecision, RunFeedbackEntry } from '../../types.js';
import { getRunReviewState, listRunFeedback, postRunFeedback } from '../collaboratorRuns.js';
import type { RunReviewState } from '../../work-engine/run-review.js';

/** B09: "Ready to review"/"Reviewed by X"/"Changes requested by X" — nothing rendered while not_applicable, matching the design's own "never a fourth status column" framing. */
function reviewBadgeText(review: RunReviewState): string | null {
  switch (review.state) {
    case 'ready_to_review': return 'Ready to review';
    case 'reviewed': return `Reviewed by ${review.reviewedBy}`;
    case 'changes_requested': return `Changes requested by ${review.reviewedBy}`;
    case 'not_applicable': return null;
  }
}

/**
 * A comment composer, deliberately parallel to SessionChat's own
 * ChatComposer — retains the draft on a failed post, the same guarantee the
 * collaborator request form already gives. Ticket 71 (B09): "Mark
 * reviewed"/"Request changes" post this same composer's text, tagged with
 * a reviewDecision — anyone who can read the Run can act, no new
 * permission axis (docs/specs/run-feedback-review.md).
 */
function RunFeedbackComposer({ onSubmit }: { onSubmit: (text: string, reviewDecision?: ReviewDecision) => Promise<void> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (reviewDecision?: ReviewDecision) => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(value, reviewDecision);
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
      <div className="run-feedback-composer-actions">
        <button className="button button-primary" disabled={!text.trim() || sending} type="submit">{sending ? 'Posting…' : 'Post'}</button>
        <button className="button" disabled={!text.trim() || sending} onClick={() => void submit('changes_requested')} type="button">Request changes</button>
        <button className="button" disabled={!text.trim() || sending} onClick={() => void submit('reviewed')} type="button">Mark reviewed</button>
      </div>
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
  const [review, setReview] = useState<RunReviewState | null>(null);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  useEffect(() => {
    setFeedback([]);
    setReview(null);
    let disposed = false;
    const tick = () => Promise.all([listRunFeedback(runId), getRunReviewState(runId)])
      .then(([nextFeedback, nextReview]) => {
        if (disposed || runIdRef.current !== runId) return;
        setFeedback(nextFeedback);
        setReview(nextReview);
      })
      .catch(() => undefined);
    void tick();
    const interval = setInterval(() => void tick(), 5000);
    return () => { disposed = true; clearInterval(interval); };
  }, [runId]);

  const submit = async (text: string, reviewDecision?: ReviewDecision) => {
    const entry = await postRunFeedback(runId, text, { reviewDecision });
    setFeedback((current) => [...current, entry]);
    setReview(await getRunReviewState(runId));
  };

  const Heading = headingLevel;
  const badgeText = review ? reviewBadgeText(review) : null;
  return (
    <section aria-label="Feedback" className="run-feedback">
      <Heading>Feedback</Heading>
      {badgeText && <p className={`run-review-badge run-review-badge-${review!.state}`}>{badgeText}</p>}
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
