// Places floor plan (migration 53, MASTER_PLAN §5.2): one picture per floor with places pinned on it.
// A pin is the place's floor_plan_id + map_x / map_y (fractions 0–1 of the picture), so it stays put
// at any screen size. The picture is the plan's primary photo (lib/photos, entity 'floor_plan').
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { entityPhotosQuery, removeEntityPhoto, setEntityPhoto, type EntityPhoto } from './photos';
import { supabase } from './supabase';

export interface FloorPlan {
  id: string;
  name: string;
  sort: number;
}

export interface Pin {
  id: string;
  name: string;
  kind: string | null;
  floor_plan_id: string;
  x: number;
  y: number;
}

export const planKey = (householdId: string, ...rest: unknown[]) => ['floor-plan', householdId, ...rest] as const;
export const invalidatePlans = (qc: QueryClient, householdId: string) => qc.invalidateQueries({ queryKey: planKey(householdId) });

export const floorPlansQuery = (householdId: string) =>
  queryOptions({
    queryKey: planKey(householdId, 'plans'),
    queryFn: async (): Promise<FloorPlan[]> => {
      const { data, error } = await supabase
        .from('floor_plan')
        .select('id, name, sort')
        .eq('household_id', householdId)
        .order('sort')
        .order('created_at');
      if (error) throw error;
      return data;
    },
    staleTime: 60 * 1000,
  });

export const planPhotosQuery = (householdId: string) =>
  entityPhotosQuery(householdId, 'floor_plan', planKey(householdId, 'photos'));

export const pinsQuery = (householdId: string) =>
  queryOptions({
    queryKey: planKey(householdId, 'pins'),
    queryFn: async (): Promise<Pin[]> => {
      const { data, error } = await supabase
        .from('location')
        .select('id, name, kind, floor_plan_id, map_x, map_y')
        .eq('household_id', householdId)
        .not('floor_plan_id', 'is', null);
      if (error) throw error;
      return data.flatMap((l) =>
        l.floor_plan_id && l.map_x !== null && l.map_y !== null
          ? [{ id: l.id, name: l.name, kind: l.kind, floor_plan_id: l.floor_plan_id, x: Number(l.map_x), y: Number(l.map_y) }]
          : [],
      );
    },
    staleTime: 30 * 1000,
  });

export async function createPlan(householdId: string, name: string, sort: number): Promise<string> {
  const id = crypto.randomUUID();
  const { error } = await supabase.from('floor_plan').insert({ id, household_id: householdId, name: name.trim(), sort });
  if (error) throw error;
  return id;
}

export async function renamePlan(id: string, name: string) {
  const { error } = await supabase.from('floor_plan').update({ name: name.trim() }).eq('id', id);
  if (error) throw error;
}

/** Deleting a plan unpins its places (FK set null) and removes its picture. */
export async function deletePlan(id: string, photo: EntityPhoto | undefined) {
  const { error } = await supabase.from('floor_plan').delete().eq('id', id);
  if (error) throw error;
  if (photo) await removeEntityPhoto(photo).catch(() => undefined);
}

export function setPlanPicture(householdId: string, planId: string, file: File, previous: EntityPhoto | null | undefined) {
  return setEntityPhoto(householdId, 'floor_plan', planId, file, previous);
}

/** Round to 0.1 % (plenty on a phone) and keep inside the picture. */
export const clampPin = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;

export async function placePin(locationId: string, planId: string | null, x: number | null, y: number | null) {
  const { error } = await supabase
    .from('location')
    .update({ floor_plan_id: planId, map_x: x === null ? null : clampPin(x), map_y: y === null ? null : clampPin(y) })
    .eq('id', locationId);
  if (error) throw error;
}
