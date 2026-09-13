import { describe, expect, it } from 'vitest';
import {
  INSPECTOR_COLLAPSED_STORAGE_KEY,
  WORK_LAYOUT_STORAGE_KEY,
  persistInspectorCollapsed,
  persistWorkLayout,
  readInspectorCollapsed,
  readWorkLayout,
} from './preferences.js';

function storageWith(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => key === INSPECTOR_COLLAPSED_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => { if (key === INSPECTOR_COLLAPSED_STORAGE_KEY) value = next; },
    value: () => value,
  };
}

describe('inspector preference', () => {
  it('defaults open and reads only the explicit collapsed value', () => {
    expect(readInspectorCollapsed(undefined)).toBe(false);
    expect(readInspectorCollapsed(storageWith())).toBe(false);
    expect(readInspectorCollapsed(storageWith('false'))).toBe(false);
    expect(readInspectorCollapsed(storageWith('invalid'))).toBe(false);
    expect(readInspectorCollapsed(storageWith('true'))).toBe(true);
  });

  it('persists both open and collapsed states', () => {
    const storage = storageWith();
    persistInspectorCollapsed(storage, true);
    expect(storage.value()).toBe('true');
    persistInspectorCollapsed(storage, false);
    expect(storage.value()).toBe('false');
  });

  it('falls back safely when storage access throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: (_key: string, _value: string) => { throw new Error('blocked'); },
    };
    expect(readInspectorCollapsed(broken)).toBe(false);
    expect(() => persistInspectorCollapsed(broken, true)).not.toThrow();
  });
});

describe('work layout preference', () => {
  function layoutStorage(initial: string | null = null) {
    let value = initial;
    return {
      getItem: (key: string) => key === WORK_LAYOUT_STORAGE_KEY ? value : null,
      setItem: (key: string, next: string) => { if (key === WORK_LAYOUT_STORAGE_KEY) value = next; },
      value: () => value,
    };
  }

  it('defaults to the list and reads only a known layout', () => {
    expect(readWorkLayout(undefined)).toBe('list');
    expect(readWorkLayout(layoutStorage('grid'))).toBe('grid');
    expect(readWorkLayout(layoutStorage('tiles'))).toBe('list');
  });

  it('persists the chosen layout and tolerates blocked storage', () => {
    const storage = layoutStorage();
    persistWorkLayout(storage, 'grid');
    expect(storage.value()).toBe('grid');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readWorkLayout(broken)).toBe('list');
    expect(() => persistWorkLayout(broken, 'grid')).not.toThrow();
  });
});
