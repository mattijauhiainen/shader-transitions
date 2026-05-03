import { LUMA } from "../../luma.ts";
import {
  CELL_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import fragSrc from "./freefall.frag.glsl" with { type: "text" };
import vertSrc from "./freefall.vert.glsl" with { type: "text" };

interface PlaneSpec {
  zPosition: number;
  scatterZ: boolean;
  useNext: boolean;
}

export function createFreefallTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(vertSrc, fragSrc);

  const focalLen = ctx.canvasWidth * 0.5;
  const PLANE_SPACING = focalLen * 8;

  // Six planes along world +Z. The frame swap (current → next) happens at
  // plane 3 — the scattered slabs on the way through hide the seam. The
  // final plane is offset by 1.5·focalLen so the camera can rest one
  // focalLen behind it after passing plane 4.
  const planes: PlaneSpec[] = [
    { zPosition: 0, scatterZ: false, useNext: false }, // flat A entry
    { zPosition: PLANE_SPACING, scatterZ: true, useNext: false }, // scattered, frame A
    { zPosition: 2 * PLANE_SPACING, scatterZ: true, useNext: false },
    { zPosition: 3 * PLANE_SPACING, scatterZ: true, useNext: true }, // scattered, frame B (swap)
    { zPosition: 4 * PLANE_SPACING, scatterZ: true, useNext: true },
    {
      zPosition: 4 * PLANE_SPACING + focalLen * 1.5,
      scatterZ: false,
      useNext: true,
    }, // flat B target
  ];

  const camStart = -focalLen;
  const finalPlaneZ = planes[planes.length - 1].zPosition;
  const camRest = finalPlaneZ - focalLen;
  const totalTravel = camRest - camStart;

  // Camera angle keyframes. Each curve is evaluated independently with cubic
  // Hermite interpolation (see evalCurve below). Tweak by editing values
  // here and the curves.html plot — no other math depends on these.
  //
  // Times are in t ∈ [0, 1]. Holding a value across two consecutive keys
  // freezes the curve in between (the interpolator detects flat spans and
  // suppresses overshoot). The crossing of plane 0 happens around t ≈ 0.09;
  // motion ends well before t=1 so the camera holds while the fall cushions.

  // Start facing directly down, then do a quick half turn by 0.11 so that we
  // look directly up to the image plane we passed. Then keep turning until
  // 0.5 and settle facing down again for the rest of the timeline.
  const pitchKeys: Keyframe[] = [
    { t: 0, value: 0 },
    { t: 0.06, value: 0 },
    { t: 0.13, value: 1 * Math.PI },
    { t: 0.5, value: 4 * Math.PI },
    { t: 1, value: 4 * Math.PI },
  ];

  // Skip yaw, pitch and roll gives us enough chaos.
  const yawKeys: Keyframe[] = [
    { t: 0, value: 0 },
    { t: 1, value: 0 },
  ];

  // Start rolling same time as we start pitch, keep turning slowly around
  // z-axis until almost the end.
  const rollKeys: Keyframe[] = [
    { t: 0, value: 0 },
    { t: 0.06, value: 0 },
    { t: 0.14, value: 0.5 * Math.PI },
    { t: 0.93, value: 4 * Math.PI },
    { t: 1, value: 4 * Math.PI },
  ];

  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "uGRID_SIZE"),
    ctx.cols,
    ctx.rows,
  );
  gl.uniform2f(
    gl.getUniformLocation(program, "uVIEWPORT"),
    ctx.canvasWidth,
    ctx.canvasHeight,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uCELL_SIZE"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPITCH"), PITCH);
  gl.uniform3f(
    gl.getUniformLocation(program, "uLUMA"),
    LUMA[0],
    LUMA[1],
    LUMA[2],
  );
  gl.uniform1f(gl.getUniformLocation(program, "uFOCAL_LEN"), focalLen);
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE"), 1);
  gl.uniform1f(gl.getUniformLocation(program, "uNEAR_CLIP"), 1.0);
  gl.useProgram(null);

  const uCamPos = gl.getUniformLocation(program, "uCamPos")!;
  const uCamRot = gl.getUniformLocation(program, "uCamRot")!;
  const uParticleZMin = gl.getUniformLocation(program, "uParticleZMin")!;
  const uParticleZMax = gl.getUniformLocation(program, "uParticleZMax")!;
  const uPlaneSeed = gl.getUniformLocation(program, "uPlaneSeed")!;
  const uSphereShading = gl.getUniformLocation(program, "uSphereShading")!;
  const uPlaneAlpha = gl.getUniformLocation(program, "uPlaneAlpha")!;
  const uFar = gl.getUniformLocation(program, "uFar")!;

  const SEGMENTS = 12;
  const verts = new Float32Array((SEGMENTS + 2) * 2);
  verts[0] = 0;
  verts[1] = 0;
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    verts[(i + 1) * 2] = Math.cos(a);
    verts[(i + 1) * 2 + 1] = Math.sin(a);
  }
  const vertexCount = SEGMENTS + 2;

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // 3x3 rotation matrix that converts world-space points into camera-space
  // (i.e. "where does this point sit relative to the current camera view").
  // Mutated in place every frame to avoid per-frame allocations. Stored
  // column-major because that's what WebGL's uniformMatrix3fv expects. Each
  // frame the 9 entries are rebuilt from Rz(roll)·Rx(pitch)·Ry(yaw) — yaw
  // (look left/right) is applied first, then pitch (look up/down), then roll
  // (tilt sideways); changing that order changes the resulting orientation.
  // Initialized to the identity matrix so the very first frame, before any
  // rotation has been computed, is a no-op rotation.
  const rot = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  // Randomize per-run so the particle layout differs each time the transition
  // plays. Per-plane offset (i * 13.37) keeps planes distinct from each other.
  const seedOffset = Math.random() * 1000;

  return {
    durationMs: 30_000,
    prepareRender: (_durationMs: number) => {
      return (t: number) => {
        const camZ = camStart + totalTravel * camTrajectory(t);

        // Get the current camera direction from keyframes, and build the camera
        // direction matrix for the GPU to apply on the vertex shader when doing
        // projection.
        const pitch = evalCurve(pitchKeys, t);
        const yaw = evalCurve(yawKeys, t);
        const roll = evalCurve(rollKeys, t);
        const ca = Math.cos(pitch);
        const sa = Math.sin(pitch);
        const cb = Math.cos(yaw);
        const sb = Math.sin(yaw);
        const cg = Math.cos(roll);
        const sg = Math.sin(roll);
        // world→cam = Rz(roll) * Rx(pitch) * Ry(yaw), stored column-major.
        rot[0] = cg * cb - sg * sa * sb;
        rot[1] = sg * cb + cg * sa * sb;
        rot[2] = -ca * sb;
        rot[3] = -sg * ca;
        rot[4] = cg * ca;
        rot[5] = sa;
        rot[6] = cg * sb + sg * sa * cb;
        rot[7] = sg * sb - cg * sa * cb;
        rot[8] = ca * cb;

        // Sphere shading: fade in as camera approaches plane 0, then on
        // throughout. Final plane is forced flat below.
        const sphereShading =
          camZ < planes[0].zPosition
            ? Math.max(0, 1 - (planes[0].zPosition - camZ) / focalLen)
            : 1;

        const farDist = totalTravel + focalLen * 2 + PLANE_SPACING * 0.9;

        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);

        gl.uniform3f(uCamPos, 0, 0, camZ);
        gl.uniformMatrix3fv(uCamRot, false, rot);
        gl.uniform1f(uFar, farDist);

        gl.bindVertexArray(vao);

        // Draw back-to-front so far planes are behind near planes.
        for (let i = planes.length - 1; i >= 0; i--) {
          const p = planes[i];

          let zMin = p.zPosition;
          let zMax = p.zPosition;
          if (p.scatterZ) {
            zMin = planes[i - 1].zPosition + PLANE_SPACING * 0.01;
          } else if (i === planes.length - 1) {
            // Final plane starts as a forward-spread cloud (extending past
            // the resting plane, away from the camera) and collapses back
            // to the flat target as the camera closes in on rest. Particles
            // slide backward toward the camera to land on the resting Z.
            // spread = 0 at camRest, full at SETTLE_DIST away.
            const SPREAD_MAX = PLANE_SPACING * 0.4;
            const SETTLE_DIST = focalLen;
            const distFromRest = Math.max(0, camRest - camZ);
            const collapse = Math.min(1, distFromRest / SETTLE_DIST);
            zMax = p.zPosition + SPREAD_MAX * collapse;
          }

          // Distance to the nearest point of the slab (0 if camera is inside
          // it). Use unsigned distance so a slab stays visible after the
          // camera pitches past it and looks back.
          const FADE_FAR = focalLen * 4.0;
          const FADE_NEAR = focalLen * 1.01;
          const dist = Math.max(zMin - camZ, camZ - zMax, 0);
          if (dist > FADE_FAR) continue;

          let alpha = Math.min(
            1,
            Math.max(0, (FADE_FAR - dist) / (FADE_FAR - FADE_NEAR)),
          );

          // Reveal gate: hide deeper planes until camera is near plane 0,
          // so this transition can blend in from any prior frame.
          if (camZ < planes[0].zPosition && i > 0) {
            const REVEAL_START = 0.6;
            const progress = 1 - (planes[0].zPosition - camZ) / focalLen;
            const gated = Math.max(
              0,
              (progress - REVEAL_START) / (1 - REVEAL_START),
            );
            alpha *= gated;
          }

          if (alpha <= 0) continue;

          const frame = p.useNext ? ctx.next : ctx.current;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, frame.cellTex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, frame.lumaRangeTex);

          gl.uniform1f(uParticleZMin, zMin);
          gl.uniform1f(uParticleZMax, zMax);
          gl.uniform1f(uPlaneSeed, i * 13.37 + 1.0 + seedOffset);

          const isLast = i === planes.length - 1;
          gl.uniform1f(uSphereShading, isLast ? 0 : sphereShading);
          gl.uniform1f(uPlaneAlpha, alpha);

          const instanceCount = ctx.cols * ctx.rows;
          gl.drawArraysInstanced(
            gl.TRIANGLE_FAN,
            0,
            vertexCount,
            instanceCount,
          );
        }

        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
      };
    },
    dispose: () => {
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}

// Smoothstep: zero velocity at both ends, accelerates through the middle.
// With total travel of 33.5·focalLen, plane 0 (at camStart + focalLen) is
// crossed when camTrajectory(t) = 1/33.5 ≈ 0.030, which lands at t ≈ 0.10.
function camTrajectory(t: number): number {
  return t * t * (3 - 2 * t);
}

interface Keyframe {
  t: number;
  value: number;
}

// Interpolate value from keyframes table with Cubic Hermite interpolation. Use
// Catmull-Rom to calculate tangets for the interpolation. Keyframes must be
// sorted by t.
function evalCurve(keys: Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].value;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].value;
  let i = 0;
  // Find the keyframe pair that this value of t falls between of.
  while (keys[i + 1].t < t) i++;
  const keyframe0 = keys[i];
  const keyframe1 = keys[i + 1];

  // Normalize t to s on this segment to [0, 1]
  const dt = keyframe1.t - keyframe0.t;
  const s = (t - keyframe0.t) / dt;

  const sSquared = s * s;
  const sCubed = sSquared * s;
  // Tanget at the start of this segment
  const m0 = tangentAt(keys, i);
  // Tanget at the end of this segment
  const m1 = tangentAt(keys, i + 1);
  // Calculate the Cubic Hermite interpolation
  return (
    (2 * sCubed - 3 * sSquared + 1) * keyframe0.value +
    (sCubed - 2 * sSquared + s) * m0 * dt +
    (-2 * sCubed + 3 * sSquared) * keyframe1.value +
    (sCubed - sSquared) * m1 * dt
  );
}

// Pick a tangent (slope) for keyframe i, used by the cubic Hermite formula
// in evalCurve. The user supplies only values, so we infer reasonable slopes
// using the Catmull-Rom rule: average the chord slopes of the two adjacent
// segments. Two special cases:
//   - At endpoints there's no neighbour on one side, so return 0. The curve
//     eases in at the start and eases out at the end.
//   - If either neighbouring segment is flat, return 0 as well. Without this,
//     a non-zero averaged tangent against a flat target would force the cubic
//     to overshoot before settling, turning a deliberate hold into a wobble.
function tangentAt(keys: Keyframe[], i: number): number {
  if (i === 0 || i === keys.length - 1) return 0;
  const slopeLeft =
    (keys[i].value - keys[i - 1].value) / (keys[i].t - keys[i - 1].t);
  const slopeRight =
    (keys[i + 1].value - keys[i].value) / (keys[i + 1].t - keys[i].t);
  if (slopeLeft === 0 || slopeRight === 0) return 0;
  return (slopeLeft + slopeRight) * 0.5;
}
