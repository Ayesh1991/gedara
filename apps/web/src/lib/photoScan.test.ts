import { describe, expect, it } from 'vitest';
import { mayAddPhoto, photoRefusal, photoSearchSchema, stillSource } from './photoScan';

describe('photo by scan', () => {
  it('reads ?photo=1 as a string or a number, keeps the number, and drops anything else', () => {
    expect(photoSearchSchema.parse({ photo: '1' })).toEqual({ photo: 1 });
    expect(photoSearchSchema.parse({ photo: 1 })).toEqual({ photo: 1 });
    expect(photoSearchSchema.parse({ photo: '2' })).toEqual({ photo: undefined });
    expect(photoSearchSchema.parse({})).toEqual({ photo: undefined });
  });

  it('lets writers add photos, valuables only for the owner', () => {
    expect(mayAddPhoto({ canWrite: true, isOwner: false, valuable: false })).toBe(true);
    expect(mayAddPhoto({ canWrite: false, isOwner: false, valuable: false })).toBe(false);
    expect(mayAddPhoto({ canWrite: true, isOwner: false, valuable: true })).toBe(false);
    expect(mayAddPhoto({ canWrite: true, isOwner: true, valuable: true })).toBe(true);
    expect(photoRefusal({ canWrite: false, isOwner: false, valuable: true })).toBe('viewer');
    expect(photoRefusal({ canWrite: true, isOwner: false, valuable: true })).toBe('valuable');
    expect(photoRefusal({ canWrite: true, isOwner: true, valuable: true })).toBeNull();
  });

  it('uses ImageCapture only where it exists', () => {
    expect(stillSource({ ImageCapture: class {} })).toBe('imageCapture');
    expect(stillSource({})).toBe('frame');
    expect(stillSource(undefined)).toBe('frame');
  });
});
