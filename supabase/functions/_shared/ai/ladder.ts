// AI gateway, part 4: cheap first, a stronger model only when unsure (Phase 9b).
//
//   step 1 (ai1): every item the rules couldn't settle
//   step 2 (ai2): only items still below SURE after step 1 (or contradicting the rules)
//   step 3 (ai3): only items still below SURE after step 2 — a referee
// After each step the votes (the rules' answer counts as one vote) are combined per facet (e.g. a
// line's product and its category are judged separately); the answer is what most votes agree on, and
// its confidence comes from how many agree — not from what a model says about itself (that only
// counts when one model answered). The pattern ("rule+ai1+ai2", "ai1+ai2/split") is stored with
// every suggestion so measured accuracy can be reported per pattern.
//
// Every request goes through assertSafeRequest first; a request that fails it is never sent.
import { assertSafeRequest, UnsafePrompt } from './guard.ts';
import { callModel, type CallResult, type Fetch, type ModelRef, type Provider } from './providers.ts';
import { parseAnswers, TASKS, type AnswerOf, type TaskName } from './tasks.ts';

export const SURE = 0.9;

export interface Facet<A> {
  key: (a: A) => string;
  /** copy this facet's fields from `from` into `to` (when the winning answer differs per facet) */
  take: (to: A, from: A) => A;
}

const same = <A>(to: A) => to;

export const FACETS: { [T in TaskName]: Facet<AnswerOf<T>>[] } = {
  lines: [
    { key: (a) => `${a.destiny}|${a.product ?? '-'}`, take: (to, from) => ({ ...to, destiny: from.destiny, product: from.product }) },
    { key: (a) => a.category, take: (to, from) => ({ ...to, category: from.category }) },
  ],
  sms_category: [{ key: (a) => a.category, take: same }],
  sms_link: [{ key: (a) => a.candidate ?? '-', take: same }],
  thing: [
    { key: (a) => a.category, take: (to, from) => ({ ...to, category: from.category }) },
  ],
};

export interface RuleVote<A> {
  answer: A;
  /** which facets the rules actually decided (a rules' category guess is weak, so often only facet 0) */
  facets: number[];
}

export interface AskItem<A> {
  i: number;
  /** the item as the model sees it (already passed through the guard's text functions) */
  payload: Record<string, unknown>;
  rule?: RuleVote<A>;
}

export interface Vote<A> {
  step: number; // 1, 2, 3
  model: string;
  answer: A;
}

export interface Decision<A> {
  answer: A | null;
  confidence: number;
  pattern: string;
  votes: Vote<A>[];
  blocked: boolean;
}

export interface UsageRow {
  provider: Provider;
  model: string;
  task: TaskName;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ok: boolean;
  error: string | null;
}

export interface Budget {
  /** may this model be called once more (monthly cost cap, daily request cap)? */
  allow(ref: ModelRef): boolean;
  spend(ref: ModelRef, result: CallResult): void;
}

export function combine<T extends TaskName>(task: T, votes: Vote<AnswerOf<T>>[], rule?: RuleVote<AnswerOf<T>>): Omit<Decision<AnswerOf<T>>, 'votes' | 'blocked'> {
  const facets = FACETS[task] as Facet<AnswerOf<T>>[];
  if (!votes.length) {
    return rule ? { answer: rule.answer, confidence: 0.6, pattern: 'rule' } : { answer: null, confidence: 0, pattern: 'none' };
  }
  let answer: AnswerOf<T> | null = null;
  let confidence = 1;
  const parts: string[] = [];
  let split = false;
  facets.forEach((f, fi) => {
    const ruleKey = rule && rule.facets.includes(fi) ? f.key(rule.answer) : null;
    const tally = new Map<string, { n: number; conf: number; from: AnswerOf<T> }>();
    for (const v of votes) {
      const k = f.key(v.answer);
      const t = tally.get(k) ?? { n: 0, conf: 0, from: v.answer };
      t.n += 1;
      t.conf += v.answer.confidence;
      tally.set(k, t);
    }
    if (ruleKey !== null) {
      const t = tally.get(ruleKey) ?? { n: 0, conf: 0, from: rule!.answer };
      t.n += 1;
      t.conf += 0.5;
      tally.set(ruleKey, t);
    }
    const [winKey, win] = [...tally].sort((a, b) => b[1].n - a[1].n || b[1].conf - a[1].conf)[0]!;
    const n = votes.length;
    const agree = votes.filter((v) => f.key(v.answer) === winKey).length;
    const ruleAgrees = ruleKey === null ? null : ruleKey === winKey;
    let c: number;
    if (n === 1) {
      const own = Math.min(votes[0]!.answer.confidence, 0.9);
      c = agree === 0 ? 0.5 : ruleAgrees === true ? Math.max(own, 0.95) : ruleAgrees === false ? Math.min(own, 0.5) : own;
    } else if (agree === n) {
      c = ruleAgrees === false ? 0.85 : ruleAgrees === true ? 0.98 : 0.95;
    } else if (agree * 2 > n) {
      c = 0.75;
      split = true;
    } else {
      c = 0.3;
      split = true;
    }
    confidence = Math.min(confidence, c);
    answer = fi === 0 ? win.from : f.take(answer ?? win.from, win.from);
    if (fi === 0) {
      if (ruleAgrees) parts.push('rule');
      for (const v of votes) if (f.key(v.answer) === winKey) parts.push(`ai${v.step}`);
    }
  });
  return { answer, confidence, pattern: (parts.length ? parts.join('+') : 'ai') + (split ? '/split' : '') };
}

export async function decide<T extends TaskName>(opts: {
  task: T;
  items: AskItem<AnswerOf<T>>[];
  /** what every item of a batch shares (the category list …) */
  shared: Record<string, unknown>;
  steps: ModelRef[];
  keys: Partial<Record<Provider, string>>;
  budget: Budget;
  labelOk: (a: AnswerOf<T>) => boolean;
  fetchImpl?: Fetch;
}): Promise<{ decisions: Map<number, Decision<AnswerOf<T>>>; usage: UsageRow[] }> {
  const { task, items } = opts;
  const spec = TASKS[task];
  const votes = new Map<number, Vote<AnswerOf<T>>[]>(items.map((x) => [x.i, []]));
  const blocked = new Set<number>();
  const usage: UsageRow[] = [];
  const decisions = new Map<number, Decision<AnswerOf<T>>>();
  const settle = (x: AskItem<AnswerOf<T>>) =>
    decisions.set(x.i, { ...combine(task, votes.get(x.i)!, x.rule), votes: votes.get(x.i)!, blocked: blocked.has(x.i) });
  items.forEach(settle);

  for (let s = 0; s < opts.steps.length; s++) {
    const ref = opts.steps[s]!;
    const pending = items.filter((x) => !blocked.has(x.i) && (decisions.get(x.i)!.confidence < SURE || votes.get(x.i)!.length === 0));
    for (let b = 0; b < pending.length; b += spec.batch) {
      const chunk = pending.slice(b, b + spec.batch);
      const user = JSON.stringify({ ...opts.shared, items: chunk.map((x) => ({ i: x.i, ...x.payload })) });
      try {
        assertSafeRequest(user);
      } catch (err) {
        if (!(err instanceof UnsafePrompt)) throw err;
        for (const x of chunk) blocked.add(x.i);
        continue;
      }
      if (!opts.budget.allow(ref)) break;
      const result = await callModel(
        ref,
        { system: spec.system, user, schemaName: task, schema: spec.schema as unknown as Record<string, unknown>, maxOutputTokens: spec.maxOutputTokens },
        opts.keys,
        opts.fetchImpl,
      );
      opts.budget.spend(ref, result);
      usage.push({
        provider: ref.provider, model: ref.model, task, input_tokens: result.inputTokens, output_tokens: result.outputTokens,
        cost_usd: result.costUsd, ok: result.ok, error: result.error,
      });
      const answers = parseAnswers(task, result.text, new Set(chunk.map((x) => x.i)), opts.labelOk);
      for (const [i, a] of answers) votes.get(i)!.push({ step: s + 1, model: `${ref.provider}/${ref.model}`, answer: a });
    }
    items.forEach(settle);
  }
  return { decisions, usage };
}
