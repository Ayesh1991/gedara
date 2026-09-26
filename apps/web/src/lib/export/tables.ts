// What "export everything" (MASTER_PLAN §5.2 Settings) contains: every household table the signed-in
// person can read, in a stable order. Left out on purpose (a unit test checks nothing else is missed):
//   app_meta          build metadata, not household data
//   sms_device        phone tokens (hashes) — secrets
//   push_subscription browser push endpoints + keys — secrets
//   push_run          the daily job's bookkeeping
// Pure (no Supabase import) so the test can read it.

export interface ExportTable {
  name: string;
  /** Column(s) to page by, so a big table is read completely and in the same order every time. */
  order: string[];
  /** Filter by household_id (household itself filters by id; units include the shared system ones). */
  scope: 'household' | 'id' | 'visible';
}

export const EXPORT_TABLES: ExportTable[] = [
  { name: 'household', order: ['id'], scope: 'id' },
  { name: 'household_member', order: ['user_id'], scope: 'household' },
  { name: 'household_invite', order: ['email'], scope: 'household' },
  { name: 'unit', order: ['id'], scope: 'visible' },
  { name: 'category', order: ['id'], scope: 'household' },
  { name: 'merchant', order: ['id'], scope: 'household' },
  { name: 'account', order: ['id'], scope: 'household' },
  { name: 'money_transaction', order: ['id'], scope: 'household' },
  { name: 'transaction_line', order: ['id'], scope: 'household' },
  { name: 'recurring_rule', order: ['id'], scope: 'household' },
  { name: 'recurring_skip', order: ['id'], scope: 'household' },
  { name: 'meter_reading', order: ['id'], scope: 'household' },
  { name: 'budget', order: ['id'], scope: 'household' },
  { name: 'sms_message', order: ['id'], scope: 'household' },
  { name: 'location', order: ['id'], scope: 'household' },
  { name: 'floor_plan', order: ['id'], scope: 'household' },
  { name: 'label_profile', order: ['id'], scope: 'household' },
  { name: 'product', order: ['id'], scope: 'household' },
  { name: 'product_barcode', order: ['id'], scope: 'household' },
  { name: 'product_unit_conversion', order: ['product_id', 'from_unit_id'], scope: 'household' },
  { name: 'product_alias', order: ['id'], scope: 'household' },
  { name: 'stock_lot', order: ['id'], scope: 'household' },
  { name: 'stock_movement', order: ['id'], scope: 'household' },
  { name: 'stock_op', order: ['op_id'], scope: 'household' },
  { name: 'shopping_list_item', order: ['id'], scope: 'household' },
  { name: 'asset', order: ['id'], scope: 'household' },
  { name: 'tag', order: ['id'], scope: 'household' },
  { name: 'asset_tag', order: ['asset_id', 'tag_id'], scope: 'household' },
  { name: 'category_field', order: ['id'], scope: 'household' },
  { name: 'maintenance_plan', order: ['id'], scope: 'household' },
  { name: 'maintenance_log', order: ['id'], scope: 'household' },
  { name: 'activity', order: ['id'], scope: 'household' },
  { name: 'attachment', order: ['id'], scope: 'household' },
  { name: 'attention_dismissal', order: ['id'], scope: 'household' },
  { name: 'drive_source', order: ['household_id'], scope: 'household' },
  { name: 'scan_file', order: ['id'], scope: 'household' },
  { name: 'export_run', order: ['id'], scope: 'household' },
];

export const EXCLUDED_TABLES = ['app_meta', 'sms_device', 'push_subscription', 'push_run'];

/** One row → CSV-friendly values (objects/arrays as JSON text). */
export function csvRow(row: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)]),
  );
}

/** A safe path inside the zip for a stored file (no "..", no leading slash). */
export function zipPath(storagePath: string): string | null {
  const clean = storagePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return `files/${clean}`;
}
