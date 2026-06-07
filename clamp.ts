export function clamp(x: number, [lo, hi]: [number, number] = [0, 1]): number {
  return Math.min(hi, Math.max(lo, x));
}
