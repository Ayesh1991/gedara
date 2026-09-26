import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { DEFAULT_PROFILE, type SheetProfile } from './labels/sheet';
import { entityPhotosQuery, removeEntityPhoto, removeFiles, setEntityPhoto, type EntityPhoto } from './photos';
import { supabase } from './supabase';
import type { Tables, TablesInsert } from './db.types';

export const PLACE_KINDS = ['room', 'furniture', 'container', 'drawer', 'shelf', 'zone', 'vehicle', 'offsite'] as const;
export const CLIMATES = ['ambient', 'fridge', 'freezer', 'dry', 'humid'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
export type Climate = (typeof CLIMATES)[number];

export type Place = Pick<
  Tables<'location'>,
  'id' | 'household_id' | 'parent_id' | 'name' | 'kind' | 'climate' | 'code' | 'notes' | 'sort' | 'path' | 'updated_at'
>;

const PLACE_COLUMNS = 'id, household_id, parent_id, name, kind, climate, code, notes, sort, path, updated_at';

export const placesKey = (householdId: string) => ['places', householdId] as const;

export const placesQuery = (householdId: string) =>
  queryOptions({
    queryKey: placesKey(householdId),
    queryFn: async (): Promise<Place[]> => {
      const { data, error } = await supabase.from('location').select(PLACE_COLUMNS).eq('household_id', householdId);
      if (error) throw error;
      // A place waiting out its Undo window stays hidden even if the list is refetched.
      return data.filter((r) => !pendingDeletes.has(r.id));
    },
    staleTime: 60 * 1000,
  });

// ── Photos (shared helpers in ./photos) ────────────────────────────────────────

export type PlacePhoto = EntityPhoto;

export const placePhotosKey = (householdId: string) => ['place-photos', householdId] as const;

export const placePhotosQuery = (householdId: string) =>
  entityPhotosQuery(householdId, 'location', placePhotosKey(householdId));

export const setPlacePhoto = (householdId: string, placeId: string, file: Blob, previous?: PlacePhoto | null) =>
  setEntityPhoto(householdId, 'location', placeId, file, previous);

export const removePlacePhoto = removeEntityPhoto;

// ── Places ────────────────────────────────────────────────────────────────────

export interface PlaceInput {
  name: string;
  parentId: string | null;
  kind: PlaceKind | null;
  climate: Climate | null;
  notes: string | null;
}

export async function createPlace(householdId: string, input: PlaceInput): Promise<Place> {
  // `code` and `path` are set by database triggers; clients have no privilege to write them.
  const row: Omit<TablesInsert<'location'>, 'code' | 'path'> = {
    id: crypto.randomUUID(),
    household_id: householdId,
    parent_id: input.parentId,
    name: input.name.trim(),
    kind: input.kind,
    climate: input.climate,
    notes: input.notes?.trim() || null,
  };
  const { data, error } = await supabase
    .from('location')
    .insert(row as TablesInsert<'location'>)
    .select(PLACE_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

export async function updatePlace(id: string, input: Partial<PlaceInput>): Promise<Place> {
  const patch: { name?: string; parent_id?: string | null; kind?: string | null; climate?: string | null; notes?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.parentId !== undefined) patch.parent_id = input.parentId;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.climate !== undefined) patch.climate = input.climate;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  const { data, error } = await supabase.from('location').update(patch).eq('id', id).select(PLACE_COLUMNS).single();
  if (error) throw error;
  return data;
}

/** Row first (the DB refuses if anything is inside), then the files, best effort. */
export async function deletePlace(id: string, photo?: PlacePhoto | null) {
  const { error } = await supabase.from('location').delete().eq('id', id);
  if (error) throw error;
  if (photo) await removeFiles([photo.storagePath, photo.thumbPath]).catch(() => undefined);
}

// Undo for deletes (§5.4): the place disappears at once, but the row is only deleted after 8 s.
// If the app is sent to the background first, the delete is committed right away.
const UNDO_MS = 8000;
const pendingDeletes = new Map<string, { timer: ReturnType<typeof setTimeout>; commit: () => void }>();

function flushPendingDeletes() {
  if (document.visibilityState !== 'hidden') return;
  for (const p of [...pendingDeletes.values()]) p.commit();
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', flushPendingDeletes);

export function scheduleDelete(
  qc: QueryClient,
  place: Place,
  photo: PlacePhoto | null | undefined,
  onError: (e: unknown) => void,
): { undo: () => void; ms: number } {
  const key = placesKey(place.household_id);
  qc.setQueryData<Place[]>(key, (rows) => rows?.filter((r) => r.id !== place.id));
  const commit = () => {
    const pending = pendingDeletes.get(place.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDeletes.delete(place.id);
    deletePlace(place.id, photo)
      .catch(onError)
      .finally(() => void invalidatePlaces(qc, place.household_id));
  };
  pendingDeletes.set(place.id, { timer: setTimeout(commit, UNDO_MS), commit });
  return {
    ms: UNDO_MS,
    undo: () => {
      const pending = pendingDeletes.get(place.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingDeletes.delete(place.id);
      void qc.invalidateQueries({ queryKey: key });
    },
  };
}

export function invalidatePlaces(qc: QueryClient, householdId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: placesKey(householdId) }),
    qc.invalidateQueries({ queryKey: placePhotosKey(householdId) }),
  ]);
}

/** Postgres error → i18n key suffix under places.errors. */
export function placeErrorKey(e: unknown): 'hasChildren' | 'cycle' | 'denied' | 'generic' {
  const code = (e as { code?: string } | null)?.code;
  if (code === '23503') return 'hasChildren';
  if (code === '23514') return 'cycle';
  if (code === '42501') return 'denied';
  return 'generic';
}

// ── Label printer profile ─────────────────────────────────────────────────────

export const PROFILE_NAME = 'Epson L3110';
/** Small raw-code labels (10 mm) on their own sticker paper: a second saved grid. */
export const MINI_PROFILE_NAME = 'Epson L3110 mini';

const ProfileRow = z.object({
  id: z.string(),
  orientation: z.enum(['landscape', 'portrait']),
  rows: z.number().int(),
  cols: z.number().int(),
  margin_top: z.coerce.number(),
  margin_right: z.coerce.number(),
  margin_bottom: z.coerce.number(),
  margin_left: z.coerce.number(),
  gutter_x: z.coerce.number(),
  gutter_y: z.coerce.number(),
  offset_x: z.coerce.number(),
  offset_y: z.coerce.number(),
  qr_mm: z.coerce.number(),
});

export interface SavedProfile {
  id: string | null;
  profile: SheetProfile;
}

export const labelProfileQuery = (householdId: string, name = PROFILE_NAME, fallback: SheetProfile = DEFAULT_PROFILE) =>
  queryOptions({
    queryKey: ['label-profile', householdId, name],
    queryFn: async (): Promise<SavedProfile> => {
      const { data, error } = await supabase
        .from('label_profile')
        .select('*')
        .eq('household_id', householdId)
        .eq('name', name)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { id: null, profile: fallback };
      const r = ProfileRow.parse(data);
      return {
        id: r.id,
        profile: {
          orientation: r.orientation,
          rows: r.rows,
          cols: r.cols,
          marginTop: r.margin_top,
          marginRight: r.margin_right,
          marginBottom: r.margin_bottom,
          marginLeft: r.margin_left,
          gutterX: r.gutter_x,
          gutterY: r.gutter_y,
          offsetX: r.offset_x,
          offsetY: r.offset_y,
          qrMm: r.qr_mm,
        },
      };
    },
    staleTime: 10 * 60 * 1000,
  });

export async function saveLabelProfile(householdId: string, saved: SavedProfile, p: SheetProfile, name = PROFILE_NAME) {
  const cols = {
    orientation: p.orientation,
    rows: p.rows,
    cols: p.cols,
    margin_top: p.marginTop,
    margin_right: p.marginRight,
    margin_bottom: p.marginBottom,
    margin_left: p.marginLeft,
    gutter_x: p.gutterX,
    gutter_y: p.gutterY,
    offset_x: p.offsetX,
    offset_y: p.offsetY,
    qr_mm: p.qrMm,
  };
  // Not an upsert: that would also try to SET household_id/name, which clients may not update.
  const { error } = saved.id
    ? await supabase.from('label_profile').update(cols).eq('id', saved.id)
    : await supabase.from('label_profile').insert({ household_id: householdId, name, ...cols });
  if (error) throw error;
}
