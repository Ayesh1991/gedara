// Category field templates ("Electronics" → IMEI, storage …; MASTER_PLAN §3.5 `category_field`).
// A thing shows the fields of its sub-category and of that sub-category's parent. Values live in
// `asset.custom`; they are typed and checked here (rule 6: validate before storing).
import { z } from 'zod';

export const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select', 'url'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface CategoryField {
  id: string;
  category_id: string;
  key: string;
  label: string;
  type: string;
  options: string[] | null;
  sort: number;
}

/** Templates that apply to a category: its parent's first, then its own, each by `sort`. */
export function fieldsFor(
  fields: CategoryField[],
  categoryId: string | null,
  categories: Array<{ id: string; parent_id: string | null }>,
): CategoryField[] {
  if (!categoryId) return [];
  const cat = categories.find((c) => c.id === categoryId);
  const chain = [cat?.parent_id, categoryId].filter((id): id is string => Boolean(id));
  const seen = new Set<string>();
  const out: CategoryField[] = [];
  for (const id of chain) {
    for (const f of fields.filter((x) => x.category_id === id).sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      out.push(f);
    }
  }
  return out;
}

/** A field key from a label: "Power (W)" → "power_w". */
export function fieldKey(label: string): string {
  const k = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(k) ? k : `f_${k}`.slice(0, 40);
}

export type FieldValue = string | number | boolean;
export type FieldError = 'number' | 'date' | 'url' | 'option';

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const URL_RE = /^https?:\/\/\S+$/i;

/**
 * Form values (strings / booleans) → what is stored. Empty values are dropped; keys that aren't
 * templates of this category (e.g. left over from another category) are kept as they were.
 */
export function cleanCustom(
  fields: CategoryField[],
  input: Record<string, string | boolean | undefined>,
  previous: Record<string, unknown> = {},
): { value: Record<string, FieldValue>; errors: Record<string, FieldError> } {
  const known = new Set(fields.map((f) => f.key));
  const value: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(previous)) {
    if (!known.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) value[k] = v;
  }
  const errors: Record<string, FieldError> = {};
  for (const f of fields) {
    const raw = input[f.key];
    if (f.type === 'boolean') {
      if (raw === true) value[f.key] = true;
      continue;
    }
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) continue;
    switch (f.type) {
      case 'number': {
        const n = Number(s.replace(/,/g, ''));
        if (Number.isFinite(n)) value[f.key] = n;
        else errors[f.key] = 'number';
        break;
      }
      case 'date':
        if (DAY.safeParse(s).success) value[f.key] = s;
        else errors[f.key] = 'date';
        break;
      case 'url':
        if (URL_RE.test(s)) value[f.key] = s.slice(0, 500);
        else errors[f.key] = 'url';
        break;
      case 'select':
        if (f.options?.includes(s)) value[f.key] = s;
        else errors[f.key] = 'option';
        break;
      default:
        value[f.key] = s.slice(0, 200);
    }
  }
  return { value, errors };
}

/** Stored value → what the form shows. */
export function formValue(v: unknown): string | boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return '';
}

/** Stored value → display text ("Yes", "2,000", "https://…"). */
export function displayValue(f: Pick<CategoryField, 'type'>, v: unknown, yes: string, locale = 'en-LK'): string {
  if (v === null || v === undefined || v === '') return '';
  if (f.type === 'boolean') return v === true ? yes : '';
  if (f.type === 'number' && typeof v === 'number') return new Intl.NumberFormat(locale).format(v);
  return String(v);
}
