// Primary photos for places, products … (MASTER_PLAN §3.7, rule 9): compressed in the browser to
// WebP 1600 px + 320 px thumb, stored at {household}/{entity_type}/{entity_id}/{uuid}.webp in the
// private `household-files` bucket, one `attachment` row with is_primary per entity.
import { queryOptions } from '@tanstack/react-query';
import { compressPhoto } from './images';
import { supabase } from './supabase';

export type PhotoEntity = 'location' | 'product';

export interface EntityPhoto {
  attachmentId: string;
  storagePath: string;
  thumbPath: string | null;
  thumbUrl: string | null;
  fullUrl: string | null;
}

const BUCKET = 'household-files';
const SIGNED_URL_SECONDS = 60 * 60;

/** Primary photo per entity of one type, with signed URLs (the bucket is private). */
export const entityPhotosQuery = (householdId: string, entityType: PhotoEntity, key: readonly unknown[]) =>
  queryOptions({
    queryKey: key,
    queryFn: async (): Promise<Map<string, EntityPhoto>> => {
      const { data, error } = await supabase
        .from('attachment')
        .select('id, entity_id, storage_path, thumb_path')
        .eq('household_id', householdId)
        .eq('entity_type', entityType)
        .eq('is_primary', true);
      if (error) throw error;
      const paths = data.flatMap((a) => [a.storage_path, ...(a.thumb_path ? [a.thumb_path] : [])]);
      const urls = new Map<string, string>();
      if (paths.length) {
        const signed = await supabase.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
        if (signed.error) throw signed.error;
        for (const s of signed.data) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
      }
      return new Map(
        data.map((a) => [
          a.entity_id,
          {
            attachmentId: a.id,
            storagePath: a.storage_path,
            thumbPath: a.thumb_path,
            thumbUrl: urls.get(a.thumb_path ?? a.storage_path) ?? null,
            fullUrl: urls.get(a.storage_path) ?? null,
          },
        ]),
      );
    },
    // Refresh well before the signed URLs expire.
    staleTime: 40 * 60 * 1000,
  });

export async function removeFiles(paths: Array<string | null | undefined>) {
  const list = paths.filter((p): p is string => Boolean(p));
  if (list.length) await supabase.storage.from(BUCKET).remove(list);
}

/** Compress → upload full + thumb → make it the entity's primary photo (replacing any old one). */
export async function setEntityPhoto(
  householdId: string,
  entityType: PhotoEntity,
  entityId: string,
  file: Blob,
  previous?: EntityPhoto | null,
) {
  const photo = await compressPhoto(file);
  const base = `${householdId}/${entityType}/${entityId}/${crypto.randomUUID()}`;
  const fullPath = `${base}.webp`;
  const thumbPath = `${base}.thumb.webp`;
  const upload = (path: string, blob: Blob) =>
    supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' });
  const [full, thumb] = await Promise.all([upload(fullPath, photo.full), upload(thumbPath, photo.thumb)]);
  if (full.error || thumb.error) {
    await removeFiles([fullPath, thumbPath]);
    throw full.error ?? thumb.error;
  }
  if (previous) {
    const { error } = await supabase.from('attachment').delete().eq('id', previous.attachmentId);
    if (error) {
      await removeFiles([fullPath, thumbPath]);
      throw error;
    }
  }
  const { error } = await supabase.from('attachment').insert({
    household_id: householdId,
    entity_type: entityType,
    entity_id: entityId,
    kind: 'photo',
    storage_path: fullPath,
    thumb_path: thumbPath,
    mime: 'image/webp',
    bytes: photo.full.size,
    width: photo.width,
    height: photo.height,
    is_primary: true,
  });
  if (error) {
    await removeFiles([fullPath, thumbPath]);
    throw error;
  }
  if (previous) await removeFiles([previous.storagePath, previous.thumbPath]).catch(() => undefined);
}

export async function removeEntityPhoto(photo: EntityPhoto) {
  const { error } = await supabase.from('attachment').delete().eq('id', photo.attachmentId);
  if (error) throw error;
  await removeFiles([photo.storagePath, photo.thumbPath]).catch(() => undefined);
}
