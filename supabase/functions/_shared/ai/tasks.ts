// AI gateway, part 3: the four questions Gedara asks an AI (Phase 9b), each with its prompt, a strict
// JSON schema for the provider and a Zod schema for what comes back. Ids are short labels (P1, C3,
// T2) made by the caller; an answer naming a label we didn't send is treated as no answer.
import { z } from 'zod';

export type TaskName = 'lines' | 'sms_category' | 'sms_link' | 'thing';

const conf = { type: 'number', minimum: 0, maximum: 1 } as const;
const label = (nullable: boolean) => ({ type: nullable ? ['string', 'null'] : 'string' }) as const;

function itemsSchema(props: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['i', ...Object.keys(props), 'confidence'],
          properties: { i: { type: 'integer' }, ...props, confidence: conf },
        },
      },
    },
  };
}

const Conf = z.number().min(0).max(1);
const I = z.number().int().nonnegative();

export const TASKS = {
  lines: {
    batch: 12,
    maxOutputTokens: 1200,
    system: [
      'You match lines from Sri Lankan shop bills (prices in LKR) for one household. For each line decide:',
      "- destiny: 'stock' = a consumable the household keeps and uses up (food, drinks, spices, toiletries, cleaning, medicine);",
      "  'asset' = a durable thing they keep and track (electronics, appliances, furniture, tools, kitchenware, books);",
      "  'expense' = everything else (services, meals eaten out, fuel, fees, delivery, discounts, clothing, gifts).",
      "- product: only for 'stock', the id of the household's product this line IS, chosen from that line's candidates.",
      "  Brand and pack size may differ ('ANCHOR FC MILK PWDR 400G' is 'Milk powder'). A similar but different item is",
      "  NOT a match ('Salted peanuts' is not 'Salt'): then null. null for 'asset' and 'expense'.",
      '- category: the id of the best category from the list.',
      '- confidence: 0 to 1, how sure you are that destiny, product and category are all right; below 0.7 when guessing.',
      "Bill text is abbreviated and often misspelt ('KEERI SMBA' = keeri samba rice, 'DHL' = dhal, 'B/RICE' = basmati rice).",
      'Answer every line, using only the ids given.',
    ].join('\n'),
    schema: itemsSchema({ destiny: { type: 'string', enum: ['stock', 'asset', 'expense'] }, product: label(true), category: label(false) }),
    answer: z.object({ i: I, destiny: z.enum(['stock', 'asset', 'expense']), product: z.string().nullable(), category: z.string(), confidence: Conf }),
  },
  sms_category: {
    batch: 20,
    maxOutputTokens: 800,
    system: [
      'Sri Lankan bank and card alerts name only a merchant, often cut short and followed by the town and country',
      "code ('CARGILLS FOODCITY RAJAGIRRAJAGIRIYA LK', 'Google One 650-##### US'). For each alert pick the id of the",
      'best spending category from the list. The amount (LKR) helps. confidence 0 to 1, below 0.7 when unsure.',
      'Answer every alert, using only the ids given.',
    ].join('\n'),
    schema: itemsSchema({ category: label(false) }),
    answer: z.object({ i: I, category: z.string(), confidence: Conf }),
  },
  sms_link: {
    batch: 10,
    maxOutputTokens: 600,
    system: [
      'A card or bank alert (merchant, amount, day) may be the same purchase as one bill already recorded (payee,',
      'total, day). For each alert choose the candidate that is the SAME purchase, or null when none is. Same',
      "purchase = same shop (written differently: 'CARGILLS FOODCITY RAJAGIRRAJAGIRIYA LK' = 'Cargills Food City'),",
      'a total equal or different only by a service charge, tip or rounding, and the same or the next day.',
      'confidence 0 to 1. Answer every alert, using only the ids given.',
    ].join('\n'),
    schema: itemsSchema({ candidate: label(true) }),
    answer: z.object({ i: I, candidate: z.string().nullable(), confidence: Conf }),
  },
  thing: {
    batch: 10,
    maxOutputTokens: 900,
    system: [
      'These lines from shop bills are durable things a household keeps (appliances, electronics, furniture, tools,',
      "kitchenware, books). For each give a short clear name for the thing ('Samsung 55\" TV', 'Philips steam iron'),",
      'the maker and the model when the text shows them (else null; ##### marks digits that were hidden), and the id',
      'of the best category from the list. confidence 0 to 1. Answer every line, using only the ids given.',
    ].join('\n'),
    schema: itemsSchema({ name: { type: 'string' }, maker: label(true), model: label(true), category: label(false) }),
    answer: z.object({
      i: I, name: z.string().min(1).max(80), maker: z.string().max(40).nullable(), model: z.string().max(40).nullable(),
      category: z.string(), confidence: Conf,
    }),
  },
} as const;

export type AnswerOf<T extends TaskName> = z.infer<(typeof TASKS)[T]['answer']>;

/**
 * Parse a model's JSON reply for a batch. Returns one answer per asked index; an answer that fails Zod,
 * names a label we didn't send, or repeats an index is dropped (the item counts as unanswered).
 */
export function parseAnswers<T extends TaskName>(
  task: T,
  text: string | null,
  asked: ReadonlySet<number>,
  labelOk: (answer: AnswerOf<T>) => boolean,
): Map<number, AnswerOf<T>> {
  const out = new Map<number, AnswerOf<T>>();
  if (!text) return out;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  const items = (json as { items?: unknown })?.items;
  if (!Array.isArray(items)) return out;
  const seen = new Set<number>();
  const twice = new Set<number>();
  for (const raw of items) {
    const parsed = TASKS[task].answer.safeParse(raw);
    if (!parsed.success) continue;
    const a = parsed.data as AnswerOf<T>;
    if (!asked.has(a.i)) continue;
    if (seen.has(a.i)) twice.add(a.i); // the model answered twice: trust neither
    seen.add(a.i);
    if (labelOk(a)) out.set(a.i, a);
  }
  for (const i of twice) out.delete(i);
  return out;
}
