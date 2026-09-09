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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewDecision, RunFeedbackEntry } from '../../types.js';
import { getRunReviewState, listRunFeedback, postRunFeedback } from '../collaboratorRuns.js';
import type { RunReviewState } from '../../work-engine/run-review.js';

/**
 * `loading` only while there has never been a successful fetch for the
 * current Run; `ready` once one has landed (regardless of what a later
 * background refresh does); `error` when the most recent fetch failed.
 * Feedback/review each track their own status — one failing must never
 * blank or misreport the other (docs/specs/run-feedback-review.md).
 */
type LoadStatus = 'loading' | 'ready' | 'error';

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
  const [feedbackStatus, setFeedbackStatus] = useState<LoadStatus>('loading');
  const [review, setReview] = useState<RunReviewState | null>(null);
  const [reviewStatus, setReviewStatus] = useState<LoadStatus>('loading');
  // Read inside async continuations (fetch results, a post's own follow-up
  // review refresh) to drop a stale Run's response rather than applying it
  // to whatever Run is now on screen — this is the only guard against a
  // slow request from Run A landing on Run B after the user switches.
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const refreshFeedback = useCallback(() => listRunFeedback(runId)
    .then((next) => {
      if (runIdRef.current !== runId) return;
      setFeedback(next);
      setFeedbackStatus('ready');
    })
    .catch(() => {
      if (runIdRef.current !== runId) return;
      setFeedbackStatus('error');
    }), [runId]);

  const refreshReview = useCallback(() => getRunReviewState(runId)
    .then((next) => {
      if (runIdRef.current !== runId) return;
      setReview(next);
      setReviewStatus('ready');
    })
    .catch(() => {
      if (runIdRef.current !== runId) return;
      setReviewStatus('error');
    }), [runId]);

  useEffect(() => {
    setFeedback([]);
    setFeedbackStatus('loading');
    setReview(null);
    setReviewStatus('loading');
    let disposed = false;
    const tick = () => { if (!disposed) { void refreshFeedback(); void refreshReview(); } };
    tick();
    const interval = setInterval(tick, 5000);
    return () => { disposed = true; clearInterval(interval); };
  }, [runId, refreshFeedback, refreshReview]);

  /**
   * Posting and refreshing the review badge are deliberately two separate
   * failure domains. A post that reaches the server but is followed by a
   * failed review-state refresh is still a successful post — the comment
   * is saved and the draft clears; only the badge refresh is left stale,
   * with its own error/retry affordance below, never surfaced as "Not
   * sent" on the composer.
   */
  const submit = async (text: string, reviewDecision?: ReviewDecision) => {
    const entry = await postRunFeedback(runId, text, { reviewDecision });
    if (runIdRef.current !== runId) return;
    setFeedback((current) => [...current, entry]);
    setFeedbackStatus('ready');
    await refreshReview();
  };

  const Heading = headingLevel;
  const badgeText = review ? reviewBadgeText(review) : null;
  return (
    <section aria-label="Feedback" className="run-feedback">
      <Heading>Feedback</Heading>
      {badgeText && (
        <p className={`run-review-badge run-review-badge-${review!.state}`}>
          {badgeText}
          {reviewStatus === 'error' && ' (may be out of date)'}
        </p>
      )}
      {!review && reviewStatus === 'error' && (
        <p className="run-review-load-error" role="alert">
          Couldn’t load review status.{' '}
          <button className="button" onClick={() => void refreshReview()} type="button">Retry</button>
        </p>
      )}
      {feedback.length > 0 && (
        <>
          {feedbackStatus === 'error' && (
            <p className="run-feedback-refresh-error" role="status">
              Feedback may be out of date.{' '}
              <button className="button" onClick={() => void refreshFeedback()} type="button">Retry</button>
            </p>
          )}
          <ul className="run-feedback-list">
            {feedback.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.displayName}</strong>
                <time dateTime={entry.postedAt}>{new Date(entry.postedAt).toLocaleString()}</time>
                <p>{entry.text}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      {feedback.length === 0 && feedbackStatus === 'loading' && <p className="run-feedback-loading">Loading feedback…</p>}
      {feedback.length === 0 && feedbackStatus === 'error' && (
        <p className="run-feedback-load-error" role="alert">
          Couldn’t load feedback.{' '}
          <button className="button" onClick={() => void refreshFeedback()} type="button">Retry</button>
        </p>
      )}
      {feedback.length === 0 && feedbackStatus === 'ready' && <p className="run-feedback-empty">No comments yet.</p>}
      {/* Keyed by runId: a fresh composer per Run, so an in-progress draft
          or a stale "Not sent" error from the previous Run never shows up
          against the next one — see docs/specs/run-feedback-review.md. */}
      <RunFeedbackComposer key={runId} onSubmit={submit} />
    </section>
  );
}
