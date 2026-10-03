import { describe, it, expect } from 'vitest';
import { clampPan, swipeDirection } from './viewer-tools';
describe('viewer gestures', () => {
  it('requires a deliberate horizontal swipe', () => {
    expect(swipeDirection(-80, 20)).toBe(1);
    expect(swipeDirection(90, 10)).toBe(-1);
    expect(swipeDirection(40, 0)).toBe(0);
    expect(swipeDirection(90, 100)).toBe(0);
  });
  it('keeps the zoomed image within the stage', () => {
    expect(clampPan(500, 400, 2)).toBe(200);
    expect(clampPan(-500, 400, 2)).toBe(-200);
    expect(clampPan(20, 400, 1)).toBe(0);
  });
});
