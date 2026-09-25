// Documents for things, bills and services: receipts, warranty cards, manuals, invoices (MASTER_PLAN
// §3.7, §7e). Photos are compressed to WebP like every other photo (rule 9); PDFs are uploaded as
// they are. The type comes from the file's first bytes, never its name (rule 6). Everything stays in
// the private Supabase bucket — the Google Drive overflow is deferred (decision 2026-09-25).
import { queryOptions } from '@tanstack/react-query';
import { FileError, MAX_DOC_BYTES, sniffDocument } from './fileTypes';
import { compressPhoto } from './images';
import { removeFiles } from './photos';
import { supabase } from './supabase';

export const DOC_KINDS = ['receipt', 'warranty', 'manual', 'invoice', 'photo', 'other'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export type DocEntity = 'asset' | 'transaction' | 'maintenance';

const BUCKET = 'household-files';
const SIGNED_URL_SECONDS = 60 * 60;

export { FileError, MAX_DOC_BYTES, formatBytes, sniffDocument } from './fileTypes';

export interface Attachment {
  id: string;
  entity_type: string;
  entity_id: string;
  kind: string;
  title: string | null;
  mime: string | null;
  bytes: number | null;
  storage_path: string;
  thumb_path: string | null;
  is_primary: boolean;
  created_at: string;
  thumbUrl: string | null;
}

const COLUMNS = 'id, entity_type, entity_id, kind, title, mime, bytes, storage_path, thumb_path, is_primary, created_at';

/** Documents of some entities (not their primary photo), newest first, with thumbnail URLs. */
export const attachmentsQuery = (householdId: string, entityType: DocEntity, entityIds: string[], key: readonly unknown[]) =>
  queryOptions({
    queryKey: key,
    enabled: entityIds.length > 0,
    queryFn: async (): Promise<Attachment[]> => {
      const { data, error } = await supabase
        .from('attachment')
        .select(COLUMNS)
        .eq('household_id', householdId)
        .eq('entity_type', entityType)
        .in('entity_id', entityIds)
        .eq('is_primary', false)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const thumbs = data.map((a) => a.thumb_path).filter((p): p is string => Boolean(p));
      const urls = new Map<string, string>();
      if (thumbs.length) {
        const signed = await supabase.storage.from(BUCKET).createSignedUrls(thumbs, SIGNED_URL_SECONDS);
        if (signed.error) throw signed.error;
        for (const s of signed.data) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
      }
      return data.map((a) => ({ ...a, thumbUrl: a.thumb_path ? (urls.get(a.thumb_path) ?? null) : null }));
    },
    staleTime: 40 * 60 * 1000,
  });

/** Upload one document and record it. Returns the new attachment id. */
export async function uploadDocument(
  householdId: string,
  entityType: DocEntity,
  entityId: string,
  file: File,
  kind: DocKind,
): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const type = sniffDocument(head);
  if (!type) throw new FileError('unsupported');
  const base = `${householdId}/${entityType}/${entityId}/${crypto.randomUUID()}`;
  const title = file.name.trim().slice(0, 120) || null;
  const upload = (path: string, blob: Blob, contentType: string) =>
    supabase.storage.from(BUCKET).upload(path, blob, { contentType, upsert: false, cacheControl: '31536000' });

  let row: {
    storage_path: string;
    thumb_path: string | null;
    mime: string;
    bytes: number;
    width?: number;
    height?: number;
  };
  if (type === 'application/pdf') {
    if (file.size > MAX_DOC_BYTES) throw new FileError('tooLarge');
    const path = `${base}.pdf`;
    const res = await upload(path, file, 'application/pdf');
    if (res.error) throw res.error;
    row = { storage_path: path, thumb_path: null, mime: 'application/pdf', bytes: file.size };
  } else {
    const photo = await compressPhoto(file);
    const fullPath = `${base}.webp`;
    const thumbPath = `${base}.thumb.webp`;
    const [full, thumb] = await Promise.all([upload(fullPath, photo.full, 'image/webp'), upload(thumbPath, photo.thumb, 'image/webp')]);
    if (full.error || thumb.error) {
      await removeFiles([fullPath, thumbPath]);
      throw full.error ?? thumb.error;
    }
    row = { storage_path: fullPath, thumb_path: thumbPath, mime: 'image/webp', bytes: photo.full.size, width: photo.width, height: photo.height };
  }

  const { data, error } = await supabase
    .from('attachment')
    .insert({
      household_id: householdId,
      entity_type: entityType,
      entity_id: entityId,
      kind,
      title,
      is_primary: false,
      ...row,
    })
    .select('id')
    .single();
  if (error) {
    await removeFiles([row.storage_path, row.thumb_path]);
    throw error;
  }
  return data.id;
}

export async function setAttachmentKind(id: string, kind: DocKind) {
  const { error } = await supabase.from('attachment').update({ kind }).eq('id', id);
  if (error) throw error;
}

export async function removeAttachment(a: Pick<Attachment, 'id' | 'storage_path' | 'thumb_path'>) {
  const { error } = await supabase.from('attachment').delete().eq('id', a.id);
  if (error) throw error;
  await removeFiles([a.storage_path, a.thumb_path]).catch(() => undefined);
}

/** A fresh short-lived link to the full file (the bucket is private). */
export async function attachmentUrl(a: Pick<Attachment, 'storage_path'>): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(a.storage_path, 10 * 60);
  if (error) throw error;
  return data.signedUrl;
}
