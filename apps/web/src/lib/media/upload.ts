// Adding music from Gedara (Phase 7h). Each file is checked by its first bytes (rule 6), its tags
// and cover are read, its sha256 is taken, the cover becomes a 320 px WebP (rule 9), then the song
// goes into the private `media-inbox` bucket at the path the database handed out, with progress.
// Two at a time; when 300 MB are already on their way (GDMQF) the queue waits and tries again, so a
// whole album can be dropped at once. The queue lives outside React, so uploads carry on while you
// move around Gedara; any screen can show it (useUploads).
import { EXTENSIONS, type MediaMime } from '@media/protocol';
import { useSyncExternalStore } from 'react';
import { env } from '../env';
import { compressPhoto } from '../images';
import { sha256Hex } from '../scale/espImage';
import { supabase } from '../supabase';
import { readTags, sniffFile, titleFromFileName } from './tags';

export const MAX_SONG_BYTES = 60 * 1024 * 1024;

export type UploadStatus =
  | 'checking'
  | 'unsupported'
  | 'tooLarge'
  | 'duplicate'
  | 'queued'
  | 'waitingRoom' // the speaker is still collecting earlier songs
  | 'uploading'
  | 'sent' // in the inbox; the speaker collects it next
  | 'failed';

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  status: UploadStatus;
  progress: number; // 0–1 while uploading
  title?: string;
  artist?: string;
  trackId?: string;
  error?: string;
}

interface Job extends UploadItem {
  file: File;
  deviceId: string;
  householdId: string;
}

const CONCURRENCY = 2;
const RETRY_FULL_MS = 20_000;
let jobs: Job[] = [];
let snapshot: UploadItem[] = [];
const listeners = new Set<() => void>();
let onSent: ((householdId: string) => void) | null = null;

function emit() {
  snapshot = jobs.map(({ file: _f, deviceId: _d, householdId: _h, ...item }) => item);
  for (const l of listeners) l();
}

function patch(job: Job, p: Partial<UploadItem>) {
  Object.assign(job, p);
  emit();
}

/** Called after each song reaches the inbox (the library refreshes). */
export function onUploadSent(fn: (householdId: string) => void) {
  onSent = fn;
}

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Finished rows (sent, duplicate, unsupported…) leave the list. */
export function clearFinished() {
  jobs = jobs.filter((j) => j.status === 'checking' || j.status === 'queued' || j.status === 'uploading' || j.status === 'waitingRoom');
  emit();
}

export function addFiles(files: Iterable<File>, deviceId: string, householdId: string) {
  for (const file of files) {
    jobs.push({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      size: file.size,
      status: 'checking',
      progress: 0,
      file,
      deviceId,
      householdId,
    });
  }
  emit();
  pump();
}

function pump() {
  const running = jobs.filter((j) => j.status === 'uploading' || (j.status === 'checking' && j.progress < 0)).length;
  let free = CONCURRENCY - running;
  for (const j of jobs) {
    if (free <= 0) break;
    if (j.status === 'checking' && j.progress === 0) {
      j.progress = -1; // claimed
      free--;
      void run(j).finally(() => pump());
    }
  }
}

/** Length in seconds, from the browser's own decoder (null if it can't tell in 5 s). */
function durationOf(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 5000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(audio.duration, 86_399) : null);
    };
    audio.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    audio.src = url;
  });
}

async function coverPath(householdId: string, cover: { data: Uint8Array } | undefined): Promise<string | null> {
  if (!cover) return null;
  try {
    // Songs of one album share one cover file (named by the picture's own sha256).
    const sha = await sha256Hex(cover.data);
    const path = `${householdId}/cover-${sha.slice(0, 32)}.webp`;
    const { thumb } = await compressPhoto(new Blob([cover.data as Uint8Array<ArrayBuffer>]));
    const { error } = await supabase.storage.from('media-art').upload(path, thumb, { contentType: 'image/webp', upsert: true });
    return error ? null : path;
  } catch {
    return null; // no cover is fine
  }
}

function put(path: string, file: Blob, mime: MediaMime, token: string, onProgress: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/media-inbox/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', env.VITE_SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', mime);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}

async function run(job: Job): Promise<void> {
  const { file } = job;
  try {
    const mime = await sniffFile(file);
    if (!mime) return patch(job, { status: 'unsupported', progress: 0 });
    if (file.size > MAX_SONG_BYTES) return patch(job, { status: 'tooLarge', progress: 0 });

    const [tags, duration, sha] = await Promise.all([
      readTags(file, mime),
      durationOf(file),
      file.arrayBuffer().then((b) => sha256Hex(new Uint8Array(b))),
    ]);
    const title = tags.title ?? titleFromFileName(file.name);
    patch(job, { title, artist: tags.artist });
    const art = await coverPath(job.householdId, tags.cover);

    for (;;) {
      const { data, error } = await supabase.rpc('rpc_media_upload_begin', {
        p_device: job.deviceId,
        p: {
          title,
          artist: tags.artist ?? null,
          album: tags.album ?? null,
          track_no: tags.trackNo ?? null,
          duration_s: duration,
          size_bytes: file.size,
          sha256: sha,
          mime,
          file_name: file.name.slice(0, 255),
          art_path: art,
        },
      });
      if (error?.code === 'GDMQF') {
        patch(job, { status: 'waitingRoom', progress: 0 });
        await new Promise((r) => setTimeout(r, RETRY_FULL_MS));
        continue;
      }
      if (error) throw error;
      const begun = data as { status: 'new' | 'duplicate'; id: string; inbox_path?: string };
      if (begun.status === 'duplicate') return patch(job, { status: 'duplicate', trackId: begun.id, progress: 1 });

      patch(job, { status: 'uploading', trackId: begun.id, progress: 0 });
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { data: s } = await supabase.auth.getSession();
          const token = s.session?.access_token;
          if (!token) throw new Error('signed out');
          await put(begun.inbox_path!, file, mime, token, (f) => patch(job, { progress: f }));
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      if (lastError) {
        await supabase.rpc('rpc_media_upload_abort', { p_id: begun.id });
        throw lastError;
      }
      const { error: doneError } = await supabase.rpc('rpc_media_upload_done', { p_id: begun.id });
      if (doneError) throw doneError;
      patch(job, { status: 'sent', progress: 1 });
      onSent?.(job.householdId);
      return;
    }
  } catch (e) {
    patch(job, { status: 'failed', progress: 0, error: e instanceof Error ? e.message : 'failed' });
  }
}

/** The file extension the speaker will use for a type (for display). */
export const extensionOf = (mime: MediaMime) => EXTENSIONS[mime];
