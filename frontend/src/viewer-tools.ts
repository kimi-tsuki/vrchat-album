export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  return Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx < 0 ? 1 : -1) : 0;
}
export function clampPan(value: number, dimension: number, zoom: number): number {
  const bound = dimension * (zoom - 1) / 2;
  return Math.max(-bound, Math.min(bound, value));
}
