// 4x4 matrix utilities for 3D transforms.
//
// LAYOUT
// ------
// A Mat4 is a Float32Array of length 16, in COLUMN-MAJOR order. This matches
// GLSL's `mat4` and means we can pass it straight to
// `gl.uniformMatrix4fv(loc, false, m)` (the `false` = "don't transpose").
//
// Index = col * 4 + row. So the identity matrix is stored as:
//   [1, 0, 0, 0,   // column 0  (first column of the matrix)
//    0, 1, 0, 0,   // column 1
//    0, 0, 1, 0,   // column 2
//    0, 0, 0, 1]   // column 3  (translation column)
//
// Reading the matrix as written on paper:
//   row 0: m[0],  m[4],  m[8],  m[12]
//   row 1: m[1],  m[5],  m[9],  m[13]
//   row 2: m[2],  m[6],  m[10], m[14]
//   row 3: m[3],  m[7],  m[11], m[15]

export type Mat4 = Float32Array;
export type Vec3 = readonly [number, number, number];

export function create(): Mat4 {
  return new Float32Array(16);
}

export function identity(out: Mat4): Mat4 {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;

  out[4] = 0;
  out[5] = 1;
  out[6] = 0;
  out[7] = 0;

  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;

  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}

// Computes out = left * right. Matrix multiplication is non-commutative —
// composition reads right to left, so `right` is applied to a vector first,
// then `left`. `out` may alias `left` or `right`.
export function multiply(out: Mat4, left: Mat4, right: Mat4): Mat4 {
  const result = new Array<number>(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let index = 0; index < 4; index++) {
        sum += left[index * 4 + row] * right[col * 4 + index];
      }
      result[col * 4 + row] = sum;
    }
  }
  for (let index = 0; index < 16; index++) {
    out[index] = result[index];
  }
  return out;
}

// Computes out = matrix * T(tx, ty, tz), where T is a translation matrix.
// In effect: "after whatever `matrix` already does, translate by (tx, ty, tz)
// in the matrix's local frame."
export function translate(
  out: Mat4,
  matrix: Mat4,
  tx: number,
  ty: number,
  tz: number,
): Mat4 {
  const translation: Mat4 = new Float32Array(16);
  translation[0] = 1;
  translation[1] = 0;
  translation[2] = 0;
  translation[3] = 0;

  translation[4] = 0;
  translation[5] = 1;
  translation[6] = 0;
  translation[7] = 0;

  translation[8] = 0;
  translation[9] = 0;
  translation[10] = 1;
  translation[11] = 0;

  // Column 3 holds the actual translation. Diagonal stays at 1.
  translation[12] = tx;
  translation[13] = ty;
  translation[14] = tz;
  translation[15] = 1;
  return multiply(out, matrix, translation);
}

// Computes out = matrix * Rx(angleRad), rotating around the x-axis.
// Right-handed: a 90° rotation sends +y to +z.
export function rotateX(out: Mat4, matrix: Mat4, angleRad: number): Mat4 {
  // Rx in math notation (rows-as-rows):
  //   [1,  0,    0,   0,
  //    0,  cos, -sin, 0,
  //    0,  sin,  cos, 0,
  //    0,  0,    0,   1]
  //
  // Stored column-major: -sin at row 1 col 2 → index 2*4+1 = 9.
  //                       sin at row 2 col 1 → index 1*4+2 = 6.
  const sine = Math.sin(angleRad);
  const cosine = Math.cos(angleRad);
  const rotation = new Float32Array(16);
  rotation[0] = 1;
  rotation[1] = 0;
  rotation[2] = 0;
  rotation[3] = 0;

  rotation[4] = 0;
  rotation[5] = cosine;
  rotation[6] = sine;
  rotation[7] = 0;

  rotation[8] = 0;
  rotation[9] = -sine;
  rotation[10] = cosine;
  rotation[11] = 0;

  rotation[12] = 0;
  rotation[13] = 0;
  rotation[14] = 0;
  rotation[15] = 1;

  return multiply(out, matrix, rotation);
}

// Computes out = matrix * Ry(angleRad), rotating around the y-axis.
// Right-handed: a 90° rotation sends +z to +x.
export function rotateY(out: Mat4, matrix: Mat4, angleRad: number): Mat4 {
  // Ry in math notation (rows-as-rows):
  //   [ cos, 0, sin, 0,
  //     0,   1, 0,   0,
  //    -sin, 0, cos, 0,
  //     0,   0, 0,   1]
  //
  // Stored column-major:  sin at row 0 col 2 → index 2*4+0 = 8.
  //                      -sin at row 2 col 0 → index 0*4+2 = 2.
  const sine = Math.sin(angleRad);
  const cosine = Math.cos(angleRad);
  const rotation = new Float32Array(16);
  rotation[0] = cosine;
  rotation[1] = 0;
  rotation[2] = -sine;
  rotation[3] = 0;

  rotation[4] = 0;
  rotation[5] = 1;
  rotation[6] = 0;
  rotation[7] = 0;

  rotation[8] = sine;
  rotation[9] = 0;
  rotation[10] = cosine;
  rotation[11] = 0;

  rotation[12] = 0;
  rotation[13] = 0;
  rotation[14] = 0;
  rotation[15] = 1;

  return multiply(out, matrix, rotation);
}

export function perspective(
  out: Mat4,
  fovYRad: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  // focalScale = "lens zoom" factor derived from vertical FOV.
  // tan(fovY/2) is half the height of the viewing frustum at depth 1.
  // Taking 1 / that scales view-space y so that y = ±1 lands at the
  // top/bottom of the screen exactly when y/depth = tan(fovY/2).
  // Wider FOV → larger tan → smaller focalScale → things appear smaller.
  const focalScale = 1 / Math.tan(fovYRad / 2);

  // ---- Column 0 — scales view-space X into clip-space X. ----
  // After the GPU's perspective divide (x/w), this column produces
  //   clip_x / w = (focalScale / aspect) * view_x / -view_z
  // The /aspect compensates for non-square canvases so circles stay
  // circles. Without it, a wide canvas would horizontally stretch
  // the image because both axes would use the same scale.
  out[0] = focalScale / aspect;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;

  // ---- Column 1 — scales view-space Y into clip-space Y. ----
  // Same idea as column 0, but no aspect divide because we define
  // FOV in terms of the *vertical* axis. Together columns 0 and 1
  // define the shape of the viewing frustum.
  out[4] = 0;
  out[5] = focalScale;
  out[6] = 0;
  out[7] = 0;

  // ---- Column 2 — turns view-space Z into depth, AND enables perspective. ----
  // Two crucial entries here:
  //
  // out[10] maps view-space depth into NDC depth (the [-1, +1] range
  // the GPU uses). Combined with column 3, the mapping is:
  //   view z = -near  →  NDC z = -1   (closest visible)
  //   view z = -far   →  NDC z = +1   (farthest visible)
  // The mapping is non-linear — most NDC precision is near the camera,
  // which is why "z-fighting" gets worse for far-away surfaces.
  //
  // out[11] = -1 is THE critical entry. It copies view-space -z into
  // the output w component. The GPU then divides x, y, z by w
  // automatically (the "perspective divide"). That division is what
  // makes distant things smaller on screen. Without this -1, w stays
  // at 1 and you get an orthographic projection (no foreshortening).
  out[8] = 0;
  out[9] = 0;
  out[10] = (far + near) / (near - far);
  out[11] = -1;

  // ---- Column 3 — the "constant offset" for the depth mapping. ----
  // out[14] is the partner to out[10]: together they shift+scale view-z
  // into the NDC depth range. out[10] alone would map z = 0 (the camera)
  // to NDC z = 0; out[14] biases that so the near plane lands at -1
  // and the far plane at +1.
  //
  // out[15] = 0 (NOT 1!). In a translation matrix that slot would be 1,
  // but here it's part of the depth math, not a translation. The whole
  // last column gets multiplied by the input w (which is 1 for points),
  // contributing a constant to clip-space z and w.
  out[12] = 0;
  out[13] = 0;
  out[14] = (2 * far * near) / (near - far);
  out[15] = 0;
  return out;
}

export function lookAt(out: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  // Build a view matrix: a transform that moves the world so the camera
  // sits at the origin looking down -z.
  //
  // Steps:
  //   1. forward = normalize(target - eye)        the camera's forward direction
  //   2. side    = normalize(cross(forward, up))  the camera's right direction
  //   3. newUp   = cross(side, forward)           re-orthogonalized up
  //   4. Build the view matrix (column-major storage):
  //        column 0: ( side.x,  newUp.x, -forward.x, 0)
  //        column 1: ( side.y,  newUp.y, -forward.y, 0)
  //        column 2: ( side.z,  newUp.z, -forward.z, 0)
  //        column 3: (-dot(side, eye), -dot(newUp, eye), dot(forward, eye), 1)
  //
  // Intuition: the top-left 3×3 is a rotation that aligns the camera basis
  // with world axes. The last column translates the world by -eye so the
  // camera ends up at the origin.

  // The direction the camera is looking, in WORLD coordinates. (After the
  // view transform is applied, this direction will become -z in camera space
  // which is why we negate it when placing it into the matrix below.)
  // Subtracting eye from target gives the vector pointing from eye to target.
  const forward = normalize([
    target[0] - eye[0],
    target[1] - eye[1],
    target[2] - eye[2],
  ]);
  // The camera's "right" axis. Cross product of forward and up gives a vector
  // perpendicular to both — exactly the camera's right direction by the
  // right-hand rule. Normalize because forward and up might not be
  // perpendicular, which would make the cross product non-unit-length.
  const side = normalize(cross(forward, up));
  // Re-orthogonalized up. The user-provided `up` is only a hint; it might not
  // be exactly perpendicular to forward. Crossing side with forward gives an
  // up that's guaranteed perpendicular to both, completing the orthonormal
  // camera basis.
  const newUp = cross(side, forward);

  // Construct the transformation matrix

  // Column 0: where the WORLD x-axis lands in camera space.
  //   side[0]      = how far along the camera's RIGHT it points
  //   newUp[0]     = how far along the camera's UP it points
  //  -forward[0]   = how far along the camera's BACK it points (negative = in front)
  out[0] = side[0];
  out[1] = newUp[0];
  out[2] = -forward[0];
  out[3] = 0;

  // Column 1: where the WORLD y-axis lands in camera space.
  //   side[1]      = how far along the camera's RIGHT it points
  //   newUp[1]     = how far along the camera's UP it points
  //  -forward[1]   = how far along the camera's BACK it points (negative = in front)
  out[4] = side[1];
  out[5] = newUp[1];
  out[6] = -forward[1];
  out[7] = 0;

  // Column 2: where the WORLD z-axis lands in camera space.
  //   side[2]      = how far along the camera's RIGHT it points
  //   newUp[2]     = how far along the camera's UP it points
  //  -forward[2]   = how far along the camera's BACK it points (negative = in front)
  out[8] = side[2];
  out[9] = newUp[2];
  out[10] = -forward[2];
  out[11] = 0;

  /*
    Fourth column is for translating.
    Take the rotation matrix (math notation: each row is a row)
    [
         side.x,    side.y,    side.z, 0
        newUp.x,   newUp.y,   newUp.z, 0
     -forward.x, -forward.y, -forward.z, 0
              0,         0,         0, 1
    ]
    and translation matrix
    [
      1, 0, 0, -eye.x,
      0, 1, 0, -eye.y,
      0, 0, 1, -eye.z,
      0, 0, 0,      1
    ]

   Multiplication is associative, we can multiply these two matrices together
   which gives us the final result
   [
         side.x,    side.y,    side.z, -dot(side,    eye)
        newUp.x,   newUp.y,   newUp.z, -dot(newUp,   eye)
     -forward.x, -forward.y, -forward.z,  dot(forward, eye)
              0,         0,         0,  1
   ]
  */
  out[12] = -dot(side, eye);
  out[13] = -dot(newUp, eye);
  out[14] = dot(forward, eye);
  out[15] = 1;
  return out;
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.sqrt(
    vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2],
  );
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
