import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

export const THEME_PREFERENCES = [
  'system',
  'light',
  'dark',
  'midnight',
  'slate',
  'nord',
  'solar',
  'forest',
  'signature',
] as const;

export type ThemePreference = typeof THEME_PREFERENCES[number];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string; glyph: string }[] = [
  { value: 'system', label: 'System', glyph: '◐' },
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
  { value: 'midnight', label: 'Midnight', glyph: '◒' },
  { value: 'slate', label: 'Slate', glyph: '▦' },
  { value: 'nord', label: 'Nord', glyph: '❄' },
  { value: 'solar', label: 'Solar', glyph: '◑' },
  { value: 'forest', label: 'Forest', glyph: '▲' },
  { value: 'signature', label: 'AgentDeck Signature', glyph: '◆' },
];

export const THEME_STORAGE_KEY = 'agentdeck.theme';
export const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function normalizeThemePreference(value: unknown): ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.includes(value as ThemePreference)
    ? value as ThemePreference
    : 'system';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

export function themeColorScheme(theme: ResolvedTheme): 'light' | 'dark' {
  return theme === 'light' ? 'light' : 'dark';
}

export function readThemePreference(storage: ThemeStorage | undefined): ThemePreference {
  if (!storage) return 'system';
  try {
    return normalizeThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function persistThemePreference(storage: ThemeStorage | undefined, preference: ThemePreference): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme persistence is optional; the active preference still applies for this page.
  }
}

function getThemeStorage(): ThemeStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference(getThemeStorage()));
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia(DARK_MODE_QUERY).matches);
  const resolvedTheme = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia(DARK_MODE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = themeColorScheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    persistThemePreference(getThemeStorage(), preference);
  }, [preference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
