// Aurora colour themes. The CSS in src/styles/index.css ([data-theme] blocks) is what the app
// paints; this registry drives the picker's previews. theme.test.ts keeps the two in sync.
// Themes only change the aurora light and accents — gold (primary action) and status colours are fixed.

export const THEME_IDS = ['aurora', 'nebula', 'lagoon', 'ember', 'mono'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemeDef {
  id: ThemeId;
  aur: readonly [string, string, string];
  accentA: string;
  accentB: string;
  glow: string;
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  aurora: { id: 'aurora', aur: ['#7c3aed', '#0891b2', '#0d9488'], accentA: '#8b5cf6', accentB: '#22d3ee', glow: '#8b5cf6' },
  nebula: { id: 'nebula', aur: ['#c026d3', '#7c3aed', '#4338ca'], accentA: '#d946ef', accentB: '#818cf8', glow: '#d946ef' },
  lagoon: { id: 'lagoon', aur: ['#0d9488', '#0891b2', '#059669'], accentA: '#2dd4a7', accentB: '#22d3ee', glow: '#2dd4a7' },
  ember: { id: 'ember', aur: ['#d97706', '#e11d48', '#7c3aed'], accentA: '#fb7185', accentB: '#c084fc', glow: '#fb7185' },
  mono: { id: 'mono', aur: ['#334155', '#475569', '#64748b'], accentA: '#cbd5e1', accentB: '#94a3b8', glow: '#94a3b8' },
};

export const DEFAULT_THEME: ThemeId = 'aurora';
