import { describe, expect, it } from 'vitest';
import { parseInitialNavigation } from './navigation.js';

describe('parseInitialNavigation', () => {
  it('accepts a session and known workspace view', () => {
    expect(parseInitialNavigation('?session=managed-1&view=terminal')).toEqual({
      sessionId: 'managed-1',
      view: 'terminal',
    });
  });

  it('ignores empty sessions and unknown views', () => {
    expect(parseInitialNavigation('?session=%20&view=admin')).toEqual({});
  });
});
