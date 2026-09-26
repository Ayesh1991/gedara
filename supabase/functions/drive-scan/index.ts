// drive-scan — reads the claude.ai "Bill Scanner" Drive folder into the scan inbox (Phase 7).
//
// The claude.ai project saves each scan (bill, warranty card, rating plate) as JSON in a Drive
// folder. This function reads that folder with a Google SERVICE ACCOUNT the owner shared the folder
// with (Viewer, scope drive.readonly: it can only read what was shared with it), validates each new
// or changed file (Zod, shared with the web app: ../_shared/scan/schema.ts) and stores it with
// rpc_scan_files_upsert under the signed-in user's own rights. Nothing reaches the ledger here:
// a person confirms every file in Money › Import.
//
// Caller: the web app (signed-in user's JWT; verify_jwt on). GET = version + "is it configured".
// Secrets: GOOGLE_SA_EMAIL, GOOGLE_SA_KEY (base64 of the key's PEM) — set by scripts/drive-secrets.mjs.
// File contents never appear in logs or replies. Bump FN_VERSION on every deploy.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { z } from 'zod';
import { parseScanText, scannedBillFingerprint } from '../_shared/scan/schema.ts';

const FN_VERSION = 'drive-scan-1';
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES_PER_RUN = 30;
const GOOGLE_DOC = 'application/vnd.google-apps.document';
// What a JSON file from the scanner can arrive as. Everything else in the folder (photos, PDFs) is skipped.
const ACCEPTED = new Set(['application/json', 'text/json', 'text/plain', 'application/octet-stream', GOOGLE_DOC]);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const Body = z.object({ household_id: z.uuid(), force: z.boolean().optional() });

const Begin = z.union([
  z.object({ go: z.literal(true), folder_id: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/), known: z.record(z.string(), z.string()) }),
  z.object({ go: z.literal(false), reason: z.string(), last_sync_at: z.string().optional() }),
]);

const TokenReply = z.object({ access_token: z.string().min(10), expires_in: z.number().int().positive() });
const DriveFile = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
  name: z.string().max(1000),
  mimeType: z.string().max(200),
  modifiedTime: z.iso.datetime({ offset: true }),
  size: z.string().regex(/^\d+$/).optional(),
});
const FileList = z.object({ files: z.array(DriveFile).max(1000) });

// ── Google service-account token (RFC 7523 JWT bearer, RS256 via WebCrypto) ────
let cached: { token: string; until: number } | null = null;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

function googleSecrets(): { email: string; pem: string } | null {
  const email = Deno.env.get('GOOGLE_SA_EMAIL') ?? '';
  const b64 = Deno.env.get('GOOGLE_SA_KEY') ?? '';
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(email) || !b64) return null;
  try {
    const pem = atob(b64);
    return pem.includes('BEGIN PRIVATE KEY') ? { email, pem } : null;
  } catch {
    return null;
  }
}

async function googleToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const sa = googleSecrets();
  if (!sa) throw new Error('not_configured');
  const der = Uint8Array.from(atob(sa.pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(
    JSON.stringify({
      iss: sa.email,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const parsed = TokenReply.safeParse(await res.json().catch(() => null));
  if (!res.ok || !parsed.success) throw new Error('google_auth');
  cached = { token: parsed.data.access_token, until: Date.now() + parsed.data.expires_in * 1000 };
  return cached.token;
}

async function drive(path: string, token: string): Promise<Response> {
  return await fetch(`https://www.googleapis.com/drive/v3/${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Up to 1 MB of the file as text: Google Docs exported as plain text, others downloaded. */
async function readFile(f: z.infer<typeof DriveFile>, token: string): Promise<string> {
  if (f.size && Number(f.size) > MAX_FILE_BYTES) throw new Error('file is larger than 1 MB');
  const res =
    f.mimeType === GOOGLE_DOC
      ? await drive(`files/${f.id}/export?mimeType=text%2Fplain`, token)
      : await drive(`files/${f.id}?alt=media&supportsAllDrives=true`, token);
  if (!res.ok) throw new Error(`Drive said ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error('file is larger than 1 MB');
  return new TextDecoder('utf-8').decode(bytes);
}

type StoredFile = {
  drive_file_id: string;
  name: string;
  mime: string;
  modified_at: string;
  doc_type?: string;
  payload?: unknown;
  bill_fps?: string[];
  parse_error?: string;
};

function toStored(f: z.infer<typeof DriveFile>, content: string): StoredFile {
  const base = { drive_file_id: f.id, name: f.name.slice(0, 300) || 'file', mime: f.mimeType, modified_at: f.modifiedTime };
  const r = parseScanText(content);
  if ('error' in r) {
    const e = r.error;
    const message =
      e.kind === 'shape' ? `document ${e.index + 1}: ${e.message}` : e.kind === 'json' ? `not JSON (${e.message})` : e.kind === 'html' ? 'a web page, not JSON' : 'empty file';
    return { ...base, parse_error: message.slice(0, 500) };
  }
  if (r.kind === 'bill') {
    return { ...base, doc_type: 'bill', payload: r.bills, bill_fps: r.bills.map(scannedBillFingerprint) };
  }
  return { ...base, doc_type: r.kind, payload: r.docs };
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, fn_version: FN_VERSION, configured: googleSecrets() !== null });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return json({ ok: false, error: 'unauthorized' }, 401);

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ ok: false, error: 'invalid' }, 400);
  const householdId = body.data.household_id;

  const begin = await supabase.rpc('rpc_scan_sync_begin', { p_household: householdId, p_force: body.data.force ?? false });
  if (begin.error) return json({ ok: false, error: begin.error.code === '42501' ? 'forbidden' : 'db' }, begin.error.code === '42501' ? 403 : 500);
  const state = Begin.safeParse(begin.data);
  if (!state.success) return json({ ok: false, error: 'db' }, 500);
  if (!state.data.go) return json({ ok: true, skipped: state.data.reason });

  const { folder_id, known } = state.data;
  const report = async (error: string, status: number) => {
    await supabase.rpc('rpc_scan_files_upsert', { p_household: householdId, p_files: [], p_error: error });
    return json({ ok: false, error }, status);
  };

  let token: string;
  try {
    token = await googleToken();
  } catch (e) {
    const code = e instanceof Error && e.message === 'not_configured' ? 'not_configured' : 'google_auth';
    return await report(code, 503);
  }

  const q = encodeURIComponent(`'${folder_id}' in parents and trashed = false`);
  const listRes = await drive(
    `files?q=${q}&orderBy=modifiedTime%20desc&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      `&fields=files(id%2Cname%2CmimeType%2CmodifiedTime%2Csize)`,
    token,
  );
  if (listRes.status === 404 || listRes.status === 403) return await report('folder_not_shared', 502);
  const list = FileList.safeParse(await listRes.json().catch(() => null));
  if (!listRes.ok || !list.success) return await report('drive_list', 502);

  // New or changed files the scanner could have written, oldest first (the order they were scanned).
  const todo = list.data.files
    .filter((f) => ACCEPTED.has(f.mimeType))
    .filter((f) => !known[f.id] || new Date(known[f.id]!).getTime() !== new Date(f.modifiedTime).getTime())
    .reverse();
  const batch = todo.slice(0, MAX_FILES_PER_RUN);

  const stored: StoredFile[] = [];
  for (const f of batch) {
    try {
      stored.push(toStored(f, await readFile(f, token)));
    } catch (e) {
      stored.push({
        drive_file_id: f.id,
        name: f.name.slice(0, 300) || 'file',
        mime: f.mimeType,
        modified_at: f.modifiedTime,
        parse_error: (e instanceof Error ? e.message : 'unreadable').slice(0, 500),
      });
    }
  }

  const up = await supabase.rpc('rpc_scan_files_upsert', { p_household: householdId, p_files: stored, p_error: null });
  if (up.error) {
    console.log(JSON.stringify({ fn: FN_VERSION, error: up.error.code }));
    return json({ ok: false, error: 'db' }, 500);
  }
  return json({ ok: true, checked: list.data.files.length, stored: stored.length, more: todo.length > batch.length });
});
