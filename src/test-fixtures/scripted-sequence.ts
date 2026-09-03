// Shared by every scripted RunPublisher test double (publication.test.ts,
// engine.publication.test.ts): the one "consume this script in call order,
// repeat the last entry once exhausted" shape both files' observe()
// fakes needed. A thunk entry is invoked lazily, at call time — not up
// front — so a test can assert on state (e.g. the durable intent's own
// row) exactly at the moment a real caller would be mid-execution.
export function createScriptedSequence<T>(script: readonly (T | (() => T))[]): () => T {
  let calls = 0;
  return () => {
    const step = script[Math.min(calls, script.length - 1)]!;
    calls += 1;
    return typeof step === 'function' ? (step as () => T)() : step;
  };
}
