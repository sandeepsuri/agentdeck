import { describe, expect, it } from 'vitest';
import {
  normalizeThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './theme.js';

function storageWith(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => key === THEME_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => { if (key === THEME_STORAGE_KEY) value = next; },
    value: () => value,
  };
}

describe('theme preferences', () => {
  it('accepts supported preferences and normalizes invalid values to system', () => {
    expect(normalizeThemePreference('system')).toBe('system');
    expect(normalizeThemePreference('light')).toBe('light');
    expect(normalizeThemePreference('dark')).toBe('dark');
    expect(normalizeThemePreference('sepia')).toBe('system');
    expect(normalizeThemePreference(null)).toBe('system');
  });

  it('uses the OS preference only while system mode is selected', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('reads, persists, and recovers from invalid stored values', () => {
    const storage = storageWith('dark');
    expect(readThemePreference(storage)).toBe('dark');
    persistThemePreference(storage, 'light');
    expect(storage.value()).toBe('light');
    expect(readThemePreference(storageWith('invalid'))).toBe('system');
  });

  it('falls back safely when storage access throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: (_key: string, _value: string) => { throw new Error('blocked'); },
    };
    expect(readThemePreference(broken)).toBe('system');
    expect(() => persistThemePreference(broken, 'dark' satisfies ThemePreference)).not.toThrow();
  });
});
