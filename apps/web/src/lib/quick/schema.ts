// Quick spend (Phase 12): the shapes of the screen's one read and of the copy kept on the phone.
// Pure (zod only), so the logic that uses them is unit-tested without Supabase.
import { z } from 'zod';

const num = z.coerce.number();

export const TileSchema = z.object({
  id: z.string(),
  key: z.string().nullable(),
  label: z.string().nullable(),
  icon: z.string().nullable(),
  kind: z.enum(['expense', 'handover']),
  category_id: z.string().nullable(),
  usual_amount: num.nullable(),
  sort: z.number(),
  hidden: z.boolean(),
});
export type Tile = z.infer<typeof TileSchema>;

export const EntrySchema = z.object({
  op_id: z.string(),
  tile_id: z.string().nullable(),
  kind: z.enum(['expense', 'handover']),
  client_at: z.string(),
  /** The transaction; null once the entry was deleted. */
  id: z.string().nullable(),
  amount: num,
  account_id: z.string().nullable(),
  occurred_on: z.string().nullable(),
  occurred_at: z.string().nullable(),
  notes: z.string().nullable(),
  label: z.string().nullable(),
  category_id: z.string().nullable(),
});
export type Entry = z.infer<typeof EntrySchema>;

export const PrefsSchema = z.object({
  cash_account_id: z.string().nullable(),
  order_mode: z.enum(['learned', 'mine']),
  hand: z.enum(['right', 'left']),
  cash_check: z.boolean(),
  cash_checked_on: z.string().nullable(),
});
export type Prefs = z.infer<typeof PrefsSchema>;

export const StateSchema = z.object({
  prefs: PrefsSchema.nullable(),
  balance: num.nullable(),
  tiles: z.array(TileSchema),
  accounts: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  wallets: z.array(z.object({ user_id: z.string(), account_id: z.string(), name: z.string(), person: z.string().nullable() })),
  entries: z.array(EntrySchema),
  since_check: num,
});
export type QuickState = z.infer<typeof StateSchema>;

export const SnapshotSchema = z.object({
  v: z.literal(1),
  userId: z.string(),
  householdId: z.string(),
  role: z.enum(['owner', 'member', 'viewer']),
  name: z.string().nullable(),
  timezone: z.string(),
  savedAt: z.string(),
  state: StateSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
