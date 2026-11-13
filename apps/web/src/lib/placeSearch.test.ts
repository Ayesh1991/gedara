import { describe, expect, it } from 'vitest';
import { fold, searchPlaces } from './placeSearch';

const places = [
  { id: 'k', name: 'Kitchen', path: 'Kitchen' },
  { id: 'kc', name: 'Cupboard 2', path: 'Kitchen › Cupboard 2' },
  { id: 'b', name: 'Bedroom', path: 'Bedroom' },
  { id: 'bd', name: 'Drawer 2', path: 'Bedroom › Wardrobe › Drawer 2' },
];
const things = [
  { id: 't1', name: 'Passport', location_id: 'bd', words: ['A-0042'] },
  { id: 't2', name: 'Drill', location_id: null },
  // In the safe: the place row never reached this person's app, only the thing did (no place on it).
  { id: 't3', name: 'Gold chain', location_id: 'safe' },
];
const products = [
  { id: 'p1', name: 'Mustard seeds', name_si: 'අබ' },
  { id: 'p2', name: 'Keeri samba rice', name_si: null },
];
const lots = [
  { product_id: 'p1', location_id: 'kc' },
  { product_id: 'p1', location_id: 'kc' },
  { product_id: 'p2', location_id: 'k' },
];
const run = (q: string) => searchPlaces(q, places, things, lots, products);

describe('search on Places', () => {
  it('finds a place by name and by path, every word must match', () => {
    expect(run('cupboard').places.map((p) => p.id)).toEqual(['kc']);
    expect(run('bedroom drawer').places.map((p) => p.id)).toEqual(['bd']);
    expect(run('kitchen').places.map((p) => p.id)).toEqual(['k', 'kc']);
    expect(run('kitchen drawer').places).toEqual([]);
  });
  it('finds a place by a thing kept in it, also by its A-number', () => {
    expect(run('passport').kept).toEqual([{ place: places[3], items: [{ kind: 'thing', id: 't1', name: 'Passport' }] }]);
    expect(run('a-0042').kept.map((k) => k.place.id)).toEqual(['bd']);
  });
  it('finds a place by a pantry item, in English or Sinhala, once per place', () => {
    expect(run('mustard').kept).toEqual([{ place: places[1], items: [{ kind: 'product', id: 'p1', name: 'Mustard seeds' }] }]);
    expect(run('අබ').kept.map((k) => k.place.id)).toEqual(['kc']);
    expect(run('RICE').kept.map((k) => k.place.id)).toEqual(['k']);
  });
  it('never shows a place the person was not given (a valuable place), nor things with no place', () => {
    expect(run('gold')).toEqual({ places: [], kept: [] });
    expect(run('drill')).toEqual({ places: [], kept: [] });
  });
  it('an empty search finds nothing; spacing and case are ignored', () => {
    expect(run('   ')).toEqual({ places: [], kept: [] });
    expect(fold('  Keeri   SAMBA ')).toBe('keeri samba');
  });
});
