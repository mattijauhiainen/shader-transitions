// Cubic Hermite: runs 0 → 1 across the range, leaving at slope m0 and arriving
// at slope m1, and flat outside it. Defaults to the unit interval.
export function hermite(
  x: number,
  m0: number,
  m1: number,
  [edge0, edge1]: [number, number] = [0, 1],
): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  // The two tangent terms are the standard Hermite basis functions h10 and h11.
  // Both vanish at either end, so they tilt the curve on the way through
  // without moving where it starts or finishes.
  return t * t * (3 - 2 * t) + m0 * t * (1 - t) ** 2 + m1 * t * t * (t - 1);
}
