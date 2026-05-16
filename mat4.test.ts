import { describe, expect, test } from "bun:test";
import * as mat4 from "./mat4.ts";

const EPS = 1e-5;

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThan(EPS);
  }
}

// Apply a 4x4 matrix to a homogeneous (x, y, z, w) point.
// Replicates what the GPU does in the vertex shader (before perspective divide).
function applyPoint(
  m: mat4.Mat4,
  p: [number, number, number, number],
): [number, number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * p[3],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * p[3],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * p[3],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * p[3],
  ];
}

// Perspective divide: clip space → NDC.
function divideW(
  p: [number, number, number, number],
): [number, number, number] {
  return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
}

const I = mat4.identity(mat4.create());

const A = new Float32Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
]);

describe("identity", () => {
  test("has 1s on the diagonal and 0s elsewhere", () => {
    expectClose(I, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});

describe("multiply", () => {
  test("A * I == A", () => {
    const out = mat4.create();
    mat4.multiply(out, A, I);
    expectClose(out, A);
  });

  test("I * A == A", () => {
    const out = mat4.create();
    mat4.multiply(out, I, A);
    expectClose(out, A);
  });

  test("aliasing: multiply(B, B, I) still produces B", () => {
    const B = new Float32Array(A);
    mat4.multiply(B, B, I);
    expectClose(B, A);
  });

  test("known answer A * A (column-major)", () => {
    // Computed by hand from the standard definition.
    // A interpreted as on-paper matrix (column-major storage):
    //   row 0: 1  5  9 13
    //   row 1: 2  6 10 14
    //   row 2: 3  7 11 15
    //   row 3: 4  8 12 16
    const expected = new Float32Array([
      90, 100, 110, 120, 202, 228, 254, 280, 314, 356, 398, 440, 426, 484, 542,
      600,
    ]);
    const out = mat4.create();
    mat4.multiply(out, A, A);
    expectClose(out, expected);
  });
});

describe("perspective", () => {
  // Square aspect, 90° FOV, near=1, far=100.
  // Chosen so f = 1/tan(45°) = 1 — keeps the math easy to verify by hand.
  const P = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 100);

  test("point on near plane projects to NDC z = -1", () => {
    // View space point at z = -near = -1 (right in front of camera).
    const clip = applyPoint(P, [0, 0, -1, 1]);
    const ndc = divideW(clip);
    expectClose(ndc, [0, 0, -1]);
  });

  test("point on far plane projects to NDC z = +1", () => {
    // View space point at z = -far = -100.
    const clip = applyPoint(P, [0, 0, -100, 1]);
    const ndc = divideW(clip);
    expectClose(ndc, [0, 0, 1]);
  });

  test("point at right edge of FOV maps to NDC x = +1", () => {
    // With 90° FOV, the right edge at depth z = -d is at x = d.
    const clip = applyPoint(P, [5, 0, -5, 1]);
    const ndc = divideW(clip);
    expect(Math.abs(ndc[0] - 1)).toBeLessThan(EPS);
    expect(Math.abs(ndc[1])).toBeLessThan(EPS);
  });

  test("point at top edge of FOV maps to NDC y = +1", () => {
    // 90° vertical FOV: top edge at depth -d is at y = d.
    const clip = applyPoint(P, [0, 5, -5, 1]);
    const ndc = divideW(clip);
    expect(Math.abs(ndc[1] - 1)).toBeLessThan(EPS);
    expect(Math.abs(ndc[0] - 0)).toBeLessThan(EPS);
  });

  test("aspect ratio scales x by 1/aspect", () => {
    // Wide canvas: aspect = 2. Same point as the right-edge test now lands
    // at NDC x = 0.5 (half-width) rather than 1.
    const Pwide = mat4.perspective(mat4.create(), Math.PI / 2, 2, 1, 100);
    const ndc = divideW(applyPoint(Pwide, [5, 0, -5, 1]));
    expect(Math.abs(ndc[0] - 0.5)).toBeLessThan(EPS);
  });
});

describe("lookAt", () => {
  test("camera at (0,0,5) looking at origin: world origin lands at (0,0,-5)", () => {
    const V = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const result = applyPoint(V, [0, 0, 0, 1]);
    expectClose(result, [0, 0, -5, 1]);
  });

  test("camera at origin looking down -z is identity-shaped (rotation = I)", () => {
    // eye=(0,0,0), target=(0,0,-1), up=(0,1,0): forward = -z, up = +y, right = +x.
    // No translation. Should equal the identity matrix.
    const V = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    expectClose(V, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  test("camera to the right of origin: target appears straight ahead at depth = eye-distance", () => {
    // Camera at (5, 0, 0) looking at origin. The origin should land
    // in view space at (0, 0, -5) — straight ahead, 5 units away.
    const V = mat4.lookAt(mat4.create(), [5, 0, 0], [0, 0, 0], [0, 1, 0]);
    const result = applyPoint(V, [0, 0, 0, 1]);
    expectClose(result, [0, 0, -5, 1]);
  });

  test("point behind camera ends up with positive view-space z", () => {
    // Camera at (0,0,5) looking at origin. A point at (0,0,10) is BEHIND
    // the camera; in view space, behind-camera means +z.
    const V = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const result = applyPoint(V, [0, 0, 10, 1]);
    expect(result[2]).toBeGreaterThan(0);
  });
});

describe("rotateX", () => {
  test("0° rotation is identity", () => {
    const R = mat4.rotateX(mat4.create(), I, 0);
    expectClose(R, I);
  });

  test("90° rotation sends +y to +z", () => {
    // Rotating the +y axis by 90° around +x should land it on +z.
    const R = mat4.rotateX(mat4.create(), I, Math.PI / 2);
    const p = applyPoint(R, [0, 1, 0, 1]);
    expect(Math.abs(p[0])).toBeLessThan(EPS);
    expect(Math.abs(p[1])).toBeLessThan(EPS);
    expect(Math.abs(p[2] - 1)).toBeLessThan(EPS);
  });

  test("90° rotation sends +z to -y", () => {
    // Continuing the same rotation: +z lands on -y.
    const R = mat4.rotateX(mat4.create(), I, Math.PI / 2);
    const p = applyPoint(R, [0, 0, 1, 1]);
    expect(Math.abs(p[0])).toBeLessThan(EPS);
    expect(Math.abs(p[1] + 1)).toBeLessThan(EPS);
    expect(Math.abs(p[2])).toBeLessThan(EPS);
  });

  test("x-axis is unchanged by rotation around x", () => {
    const R = mat4.rotateX(mat4.create(), I, Math.PI / 3);
    const p = applyPoint(R, [1, 0, 0, 1]);
    expectClose([p[0], p[1], p[2], p[3]], [1, 0, 0, 1]);
  });

  test("360° rotation returns to identity", () => {
    const R = mat4.rotateX(mat4.create(), I, Math.PI * 2);
    expectClose(R, I);
  });

  test("rotation composes: rotateX(m, θ) == multiply(m, Rx(θ))", () => {
    // Pre-rotate by some angle, then rotateX by another — should equal
    // applying both rotations in sequence to a vector.
    const R1 = mat4.rotateX(mat4.create(), I, Math.PI / 4);
    const R2 = mat4.rotateX(mat4.create(), R1, Math.PI / 4);
    // R2 should equal rotateX(I, π/2)
    const expected = mat4.rotateX(mat4.create(), I, Math.PI / 2);
    expectClose(R2, expected);
  });
});

describe("translate", () => {
  test("translate by (0,0,0) leaves matrix unchanged", () => {
    const out = mat4.create();
    mat4.translate(out, I, 0, 0, 0);
    expectClose(out, I);
  });

  test("translate(I, tx, ty, tz) applied to origin gives (tx, ty, tz)", () => {
    const out = mat4.create();
    mat4.translate(out, I, 3, -2, 5);
    const p = applyPoint(out, [0, 0, 0, 1]);
    expectClose([p[0], p[1], p[2], p[3]], [3, -2, 5, 1]);
  });

  test("translate by (tx,ty,tz) applied to (1,2,3) gives (1+tx, 2+ty, 3+tz)", () => {
    const out = mat4.create();
    mat4.translate(out, I, 10, 20, 30);
    const p = applyPoint(out, [1, 2, 3, 1]);
    expectClose([p[0], p[1], p[2], p[3]], [11, 22, 33, 1]);
  });

  test("translate composes: T(a) then T(b) == T(a+b)", () => {
    const t1 = mat4.create();
    mat4.translate(t1, I, 1, 2, 3);
    const t2 = mat4.create();
    mat4.translate(t2, t1, 4, 5, 6);
    const expected = mat4.create();
    mat4.translate(expected, I, 5, 7, 9);
    expectClose(t2, expected);
  });

  test("direction vectors (w=0) are not translated", () => {
    // A direction vector with w=0 should NOT be moved by translation.
    // (Only positions, with w=1, get translated.)
    const out = mat4.create();
    mat4.translate(out, I, 100, 200, 300);
    const dir = applyPoint(out, [1, 0, 0, 0]);
    expectClose([dir[0], dir[1], dir[2], dir[3]], [1, 0, 0, 0]);
  });
});

describe("rotateY", () => {
  test("0° rotation is identity", () => {
    const R = mat4.rotateY(mat4.create(), I, 0);
    expectClose(R, I);
  });

  test("90° rotation sends +z to +x (right-hand rule: thumb along +y)", () => {
    const R = mat4.rotateY(mat4.create(), I, Math.PI / 2);
    const p = applyPoint(R, [0, 0, 1, 1]);
    expect(Math.abs(p[0] - 1)).toBeLessThan(EPS);
    expect(Math.abs(p[1])).toBeLessThan(EPS);
    expect(Math.abs(p[2])).toBeLessThan(EPS);
  });

  test("90° rotation sends +x to -z", () => {
    const R = mat4.rotateY(mat4.create(), I, Math.PI / 2);
    const p = applyPoint(R, [1, 0, 0, 1]);
    expect(Math.abs(p[0])).toBeLessThan(EPS);
    expect(Math.abs(p[1])).toBeLessThan(EPS);
    expect(Math.abs(p[2] + 1)).toBeLessThan(EPS);
  });

  test("y-axis is unchanged by rotation around y", () => {
    const R = mat4.rotateY(mat4.create(), I, Math.PI / 3);
    const p = applyPoint(R, [0, 1, 0, 1]);
    expectClose([p[0], p[1], p[2], p[3]], [0, 1, 0, 1]);
  });

  test("360° rotation returns to identity", () => {
    const R = mat4.rotateY(mat4.create(), I, Math.PI * 2);
    expectClose(R, I);
  });
});

describe("MVP composition (smoke test)", () => {
  test("a point at the camera target projects to NDC origin", () => {
    const proj = mat4.perspective(
      mat4.create(),
      Math.PI / 3,
      16 / 9,
      0.1,
      1000,
    );
    const view = mat4.lookAt(mat4.create(), [0, 0, 50], [0, 0, 0], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const ndc = divideW(applyPoint(vp, [0, 0, 0, 1]));
    expect(Math.abs(ndc[0])).toBeLessThan(EPS);
    expect(Math.abs(ndc[1])).toBeLessThan(EPS);
    // NDC z somewhere in [-1, +1] since the origin is between near and far.
    expect(ndc[2]).toBeGreaterThan(-1);
    expect(ndc[2]).toBeLessThan(1);
  });
});
