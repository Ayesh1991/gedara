import { describe, expect, it } from 'vitest';
import { dragOffset, lockAxis, releaseAction, threshold } from './swipe';

const both = { right: true, left: true };

describe('pantry card swipe', () => {
  it('waits for real movement, and lets vertical scrolling win', () => {
    expect(lockAxis(4, 3)).toBe('none');
    expect(lockAxis(20, 4)).toBe('x');
    expect(lockAxis(-20, 5)).toBe('x');
    expect(lockAxis(12, 11)).toBe('y');
    expect(lockAxis(3, -25)).toBe('y');
  });

  it('needs 35 % of the card (72–140 px)', () => {
    expect(threshold(160)).toBe(72);
    expect(threshold(300)).toBe(105);
    expect(threshold(800)).toBe(140);
  });

  it('fires only past the threshold, in an allowed direction', () => {
    expect(releaseAction(110, 300, both)).toBe('right');
    expect(releaseAction(-110, 300, both)).toBe('left');
    expect(releaseAction(90, 300, both)).toBeNull();
    expect(releaseAction(-110, 300, { right: true, left: false })).toBeNull();
  });

  it('follows the finger with resistance past the threshold', () => {
    expect(dragOffset(50, 300, both)).toBe(50);
    expect(dragOffset(205, 300, both)).toBeCloseTo(105 + 100 * 0.3);
    expect(dragOffset(-40, 300, { right: true, left: false })).toBe(0);
    expect(dragOffset(1000, 300, both)).toBe(180);
  });
});
