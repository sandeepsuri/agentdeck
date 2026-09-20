import { describe, expect, it } from 'vitest';
import { isInspectorRelevant, parseInitialNavigation } from './navigation.js';

describe('parseInitialNavigation', () => {
  it('accepts a session and known workspace view', () => {
    expect(parseInitialNavigation('?session=managed-1&view=work')).toEqual({
      sessionId: 'managed-1',
      view: 'work',
    });
  });

  it('ignores empty sessions and unknown views', () => {
    expect(parseInitialNavigation('?session=%20&view=admin')).toEqual({});
  });

  it('accepts a Run deep-link (ticket 07: the native companion\'s openRun)', () => {
    expect(parseInitialNavigation('?run=run-1&view=work')).toEqual({
      runId: 'run-1',
      view: 'work',
    });
  });

  it('maps retired destinations onto the four-destination IA so existing companion links keep working', () => {
    expect(parseInitialNavigation('?session=s&view=terminal')).toEqual({ sessionId: 's', view: 'work' });
    expect(parseInitialNavigation('?run=r&view=operations')).toEqual({ runId: 'r', view: 'work' });
    for (const legacy of ['tasks', 'grid', 'history', 'signals']) {
      expect(parseInitialNavigation(`?view=${legacy}`)).toEqual({ view: 'work' });
    }
    expect(parseInitialNavigation('?view=overview')).toEqual({ view: 'home' });
    expect(parseInitialNavigation('?view=changes')).toEqual({ view: 'review' });
    expect(parseInitialNavigation('?view=usage')).toEqual({ view: 'usage' });
  });
});

describe('isInspectorRelevant', () => {
  it('only shows a Session inspector beside an opened Session in Work', () => {
    expect(isInspectorRelevant('work', true)).toBe(true);
    for (const view of ['home', 'review', 'usage'] as const) {
      expect(isInspectorRelevant(view, true)).toBe(false);
    }
    expect(isInspectorRelevant('work', false)).toBe(false);
  });
});
