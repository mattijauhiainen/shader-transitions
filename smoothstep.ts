// GLSL-style smoothstep: 0 below the low edge, 1 above the high edge, Hermite
// in between. Defaults to the unit interval.
export function smoothstep(
  x: number,
  [edge0, edge1]: [number, number] = [0, 1],
): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
