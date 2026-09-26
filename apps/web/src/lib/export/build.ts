// Settings › Export: one zip with everything this person can read (lib/export/tables), as one JSON
// file plus a CSV per table, and optionally every stored photo / receipt / manual. Built in the
// browser (no server key, RLS applies); streamed to disk where the browser can (desktop Chrome/Edge
// "Save as"), otherwise assembled in memory. The run is logged (rpc_export_done) for the reminder.
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import Papa from 'papaparse';
import type { Json } from '../db.types';
import { supabase } from '../supabase';
import { APP_VERSION } from '../version';
import { EXPORT_TABLES, csvRow, zipPath, type ExportTable } from './tables';

const PAGE = 1000;
const BUCKET = 'household-files';

export interface Progress {
  step: 'tables' | 'files' | 'zip';
  done: number;
  total: number;
}

export interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

async function readTable(t: ExportTable, householdId: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    // Table names come from the fixed list above, never from input.
    let q = supabase.from(t.name as 'account').select('*');
    if (t.scope === 'id') q = q.eq('id', householdId);
    if (t.scope === 'household') q = q.eq('household_id', householdId);
    for (const col of t.order) q = q.order(col as 'id');
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) return rows;
  }
}

export async function buildExport(opts: {
  householdId: string;
  withFiles: boolean;
  sink: Sink;
  onProgress: (p: Progress) => void;
}): Promise<{ bytes: number; counts: Record<string, number> }> {
  const { householdId, withFiles, sink, onProgress } = opts;
  let bytes = 0;
  const pending: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) zipError = err;
    else pending.push(chunk);
  });
  const flush = async () => {
    if (zipError) throw zipError;
    while (pending.length) {
      const c = pending.shift()!;
      bytes += c.length;
      await sink.write(c);
    }
  };
  const addFile = async (name: string, data: Uint8Array, compress: boolean) => {
    const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(f);
    f.push(data, true);
    await flush();
  };

  // Tables
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const [i, t] of EXPORT_TABLES.entries()) {
    onProgress({ step: 'tables', done: i, total: EXPORT_TABLES.length });
    const rows = await readTable(t, householdId);
    tables[t.name] = rows;
    counts[t.name] = rows.length;
    const csv = rows.length ? Papa.unparse(rows.map(csvRow)) : '';
    await addFile(`csv/${t.name}.csv`, strToU8(csv), true);
  }
  const { data: schema } = await supabase.rpc('schema_version');
  const meta = {
    app: 'Gedara',
    app_version: APP_VERSION,
    schema_version: schema ?? null,
    exported_at: new Date().toISOString(),
    household_id: householdId,
    counts,
    note: 'Every table this person can read. Secrets (device tokens, push keys) are not included.',
  };
  await addFile('gedara-export.json', strToU8(JSON.stringify({ meta, tables })), true);
  await addFile('README.txt', strToU8(readme(meta.exported_at)), true);

  // Files (already compressed WebP / PDF: stored, not deflated again)
  let files = 0;
  if (withFiles) {
    const attachments = (tables.attachment ?? []) as Array<{ provider?: string; storage_path?: string }>;
    const list = attachments.filter((a) => a.provider === 'supabase' && a.storage_path);
    for (const [i, a] of list.entries()) {
      onProgress({ step: 'files', done: i, total: list.length });
      const path = zipPath(a.storage_path!);
      if (!path) continue;
      const { data, error } = await supabase.storage.from(BUCKET).download(a.storage_path!);
      if (error || !data) continue; // a missing file must not stop the backup
      await addFile(path, new Uint8Array(await data.arrayBuffer()), false);
      files++;
    }
  }
  counts.files = files;

  onProgress({ step: 'zip', done: 1, total: 1 });
  zip.end();
  await flush();
  await sink.close();

  await supabase.rpc('rpc_export_done', {
    p_household: householdId,
    p_bytes: bytes,
    p_with_files: withFiles,
    p_counts: counts as unknown as Json,
  });
  return { bytes, counts };
}

function readme(at: string): string {
  return [
    `Gedara backup — ${at}`,
    '',
    'gedara-export.json  everything in one file: { meta, tables: { <table>: [rows] } }',
    'csv/<table>.csv      the same rows, one spreadsheet per table (JSON columns as text)',
    'files/…             photos, receipts and manuals, in the same folders as in Gedara',
    '',
    'Amounts are in LKR. Keep this file somewhere safe (your PC, a USB drive, your own Google Drive).',
  ].join('\r\n');
}

/** Where the zip goes: straight to a file the person picks (desktop Chrome/Edge), or a download. */
export async function openSink(name: string): Promise<{ sink: Sink; finish: () => void } | null> {
  const w = window as Window & {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (d: Uint8Array) => Promise<void>; close: () => Promise<void> }> }>;
  };
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Zip', accept: { 'application/zip': ['.zip'] } }] });
      const out = await handle.createWritable();
      return { sink: { write: (c) => out.write(c), close: () => out.close() }, finish: () => undefined };
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return null; // the person cancelled
      // fall through to an in-memory download
    }
  }
  const parts: Uint8Array[] = [];
  return {
    sink: { write: async (c) => void parts.push(c), close: async () => undefined },
    finish: () => {
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}
