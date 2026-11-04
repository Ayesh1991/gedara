// Ask Gedara, part 1: the plan (Phase 10). The AI only turns a question into ≤ 3 calls from a fixed list of
// read-only database functions (migration 100); it never sees any data. Two shapes:
//   * ModelPlan — what the model must return (strict JSON schema + Zod; every field present, null when unused);
//   * AskPlan   — what the browser runs: the tool name and the exact SQL arguments, checked again by Zod.
// toPlan() turns one into the other and refuses a call whose arguments don't fit its tool or the bounds
// (dates 2020-01-01 … today + 400 days and ≤ 3 years apart, ≤ 10 rows, `about` ≤ 60 characters).
import { z } from 'zod';

export const ASK_TOOLS = [
  'ask_spend',
  'ask_transactions',
  'ask_due',
  'ask_instalments',
  'ask_find',
  'ask_pantry',
  'ask_balances',
  'ask_budget',
  'ask_warranty',
] as const;
export type AskTool = (typeof ASK_TOOLS)[number];

export const REFUSALS = ['write', 'house', 'private', 'other'] as const;
export type Refusal = (typeof REFUSALS)[number];

export const GROUPS = ['category', 'shop', 'month', 'account', 'product'] as const;
export const VIEWS = ['runout', 'expiring', 'below_min'] as const;
export const SPEND_KINDS = ['category', 'sub', 'product', 'shop', 'words', 'all'] as const;

export const MAX_CALLS = 3;
const FIRST_DAY = '2020-01-01';

// ── What the model returns ─────────────────────────────────────────────────────
const nullable = (t: Record<string, unknown>) => ({ ...t, type: [t.type as string, 'null'] });

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['calls', 'refusal'],
  properties: {
    refusal: { type: ['string', 'null'], enum: [...REFUSALS, null] },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'about', 'from', 'to', 'group', 'view', 'within_days', 'month', 'limit'],
        properties: {
          tool: { type: 'string', enum: [...ASK_TOOLS] },
          about: nullable({ type: 'string' }),
          from: nullable({ type: 'string' }),
          to: nullable({ type: 'string' }),
          group: { type: ['string', 'null'], enum: [...GROUPS, null] },
          view: { type: ['string', 'null'], enum: [...VIEWS, null] },
          within_days: nullable({ type: 'integer' }),
          month: nullable({ type: 'string' }),
          limit: nullable({ type: 'integer' }),
        },
      },
    },
  },
} as const;

const ModelCall = z
  .object({
    tool: z.enum(ASK_TOOLS),
    about: z.string().nullable(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    group: z.enum(GROUPS).nullable(),
    view: z.enum(VIEWS).nullable(),
    within_days: z.number().int().nullable(),
    month: z.string().nullable(),
    limit: z.number().int().nullable(),
  })
  .strict();
export const ModelPlan = z.object({ calls: z.array(ModelCall).max(MAX_CALLS), refusal: z.enum(REFUSALS).nullable() }).strict();
export type ModelPlan = z.infer<typeof ModelPlan>;

// ── What the browser runs ──────────────────────────────────────────────────────
/** Letters (any script), digits, spaces and a little punctuation; never markup, quotes or URLs. */
export const About = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{M}\p{N} &'’.\-/()]+$/u)
  .refine((s) => !/https?|www\.|:\/\//i.test(s));
const Day = z.iso.date();
const Uuid = z.uuid();

const SpendArgs = z
  .object({
    p_about: About.nullable(),
    p_from: Day.nullable(),
    p_to: Day.nullable(),
    p_group: z.enum(GROUPS).nullable(),
    p_kind: z.enum(SPEND_KINDS).nullable().optional(),
    p_id: Uuid.nullable().optional(),
  })
  .strict();

export const AskCall = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('ask_spend'), args: SpendArgs }).strict(),
  z
    .object({
      tool: z.literal('ask_transactions'),
      args: z
        .object({
          p_about: About.nullable(),
          p_from: Day.nullable(),
          p_to: Day.nullable(),
          p_limit: z.number().int().min(1).max(10),
          p_kind: z.enum(SPEND_KINDS).nullable().optional(),
          p_id: Uuid.nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ tool: z.literal('ask_due'), args: z.object({ p_from: Day.nullable(), p_to: Day.nullable() }).strict() }).strict(),
  z.object({ tool: z.literal('ask_instalments'), args: z.object({ p_about: About.nullable() }).strict() }).strict(),
  z.object({ tool: z.literal('ask_find'), args: z.object({ p_about: About }).strict() }).strict(),
  z
    .object({
      tool: z.literal('ask_pantry'),
      args: z.object({ p_view: z.enum(VIEWS), p_within_days: z.number().int().min(1).max(60) }).strict(),
    })
    .strict(),
  z.object({ tool: z.literal('ask_balances'), args: z.object({ p_about: About.nullable() }).strict() }).strict(),
  z.object({ tool: z.literal('ask_budget'), args: z.object({ p_month: Day.nullable() }).strict() }).strict(),
  z
    .object({ tool: z.literal('ask_warranty'), args: z.object({ p_within_days: z.number().int().min(1).max(400) }).strict() })
    .strict(),
]);
export type AskCall = z.infer<typeof AskCall>;

export const AskPlan = z.object({ calls: z.array(AskCall).max(MAX_CALLS), refusal: z.enum(REFUSALS).nullable() }).strict();
export type AskPlan = z.infer<typeof AskPlan>;

// ── Model plan → runnable plan ─────────────────────────────────────────────────
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** A range the database will accept, or null. Missing ends are left to the database's defaults. */
function range(from: string | null, to: string | null, today: string): { p_from: string | null; p_to: string | null } | null {
  for (const d of [from, to]) {
    if (d === null) continue;
    if (!Day.safeParse(d).success || d < FIRST_DAY || d > addDays(today, 400)) return null;
  }
  if (from && to && (from > to || daysBetween(from, to) > 1096)) return null;
  return { p_from: from, p_to: to };
}

function about(text: string | null, required: boolean): string | null | undefined {
  if (text === null || text.trim() === '') return required ? undefined : null;
  const r = About.safeParse(text);
  return r.success ? r.data : undefined;
}

/** One model call → one runnable call; null when it doesn't fit (the whole plan is then refused). */
function toCall(c: z.infer<typeof ModelCall>, today: string): AskCall | null {
  switch (c.tool) {
    case 'ask_spend':
    case 'ask_transactions': {
      const a = about(c.about, false);
      const r = range(c.from, c.to, today);
      if (a === undefined || !r) return null;
      if (c.tool === 'ask_spend') return { tool: c.tool, args: { p_about: a, ...r, p_group: c.group } };
      const limit = c.limit ?? 5;
      if (limit < 1 || limit > 10) return null;
      return { tool: c.tool, args: { p_about: a, ...r, p_limit: limit } };
    }
    case 'ask_due': {
      const r = range(c.from, c.to, today);
      return r ? { tool: c.tool, args: r } : null;
    }
    case 'ask_instalments':
    case 'ask_balances': {
      const a = about(c.about, false);
      return a === undefined ? null : { tool: c.tool, args: { p_about: a } };
    }
    case 'ask_find': {
      const a = about(c.about, true);
      return a ? { tool: c.tool, args: { p_about: a } } : null;
    }
    case 'ask_pantry': {
      const within = c.within_days ?? 7;
      if (!c.view || within < 1 || within > 60) return null;
      return { tool: c.tool, args: { p_view: c.view, p_within_days: within } };
    }
    case 'ask_budget': {
      if (c.month === null) return { tool: c.tool, args: { p_month: null } };
      if (!/^\d{4}-\d{2}$/.test(c.month)) return null;
      const r = range(`${c.month}-01`, `${c.month}-01`, today);
      return r ? { tool: c.tool, args: { p_month: `${c.month}-01` } } : null;
    }
    case 'ask_warranty': {
      const within = c.within_days ?? 60;
      if (within < 1 || within > 400) return null;
      return { tool: c.tool, args: { p_within_days: within } };
    }
  }
}

/** The model's JSON text → a runnable plan, or null when anything doesn't fit (try the next model). */
export function toPlan(text: string, today: string): AskPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const m = ModelPlan.safeParse(raw);
  if (!m.success) return null;
  if (m.data.refusal) return { calls: [], refusal: m.data.refusal };
  if (m.data.calls.length === 0) return { calls: [], refusal: 'other' };
  const calls: AskCall[] = [];
  for (const c of m.data.calls) {
    const call = toCall(c, today);
    if (!call) return null;
    calls.push(call);
  }
  const plan = AskPlan.safeParse({ calls, refusal: null });
  return plan.success ? plan.data : null;
}
