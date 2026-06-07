import { LUMA } from "../../luma.ts";
import * as mat4 from "../../mat4.ts";
import {
  CELL_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import { smoothstep } from "../../smoothstep.ts";
import fragSrc from "./orbit.frag.glsl" with { type: "text" };
import vertSrc from "./orbit.vert.glsl" with { type: "text" };

type Vec3 = [number, number, number];

export function createOrbitTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(vertSrc, fragSrc);

  const focalLen = ctx.canvasWidth * 0.5;

  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "uGRID_SIZE"),
    ctx.cols,
    ctx.rows,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uCELL_SIZE"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPITCH"), PITCH);
  gl.uniform1f(gl.getUniformLocation(program, "uFOCAL_PX"), focalLen);
  gl.uniform3f(
    gl.getUniformLocation(program, "uLUMA"),
    LUMA[0],
    LUMA[1],
    LUMA[2],
  );
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS_A"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE_A"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS_B"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE_B"), 3);
  gl.useProgram(null);

  const uCamPos = gl.getUniformLocation(program, "uCamPos")!;
  const uCamRight = gl.getUniformLocation(program, "uCamRight")!;
  const uCamUp = gl.getUniformLocation(program, "uCamUp")!;
  const uCamFwd = gl.getUniformLocation(program, "uCamFwd")!;
  const uSphereShading = gl.getUniformLocation(program, "uSphereShading")!;
  const uMVP = gl.getUniformLocation(program, "uMVP")!;

  const totalInstances = ctx.cols * ctx.rows;

  // Billboard quad in corner-space [-1, 1]^2 as a triangle list. The fragment
  // shader treats these coords as (x, y) on a unit sphere and reconstructs z
  // to fake per-pixel sphere shading — sphere impostor in two triangles
  // instead of a tessellated mesh.
  // biome-ignore format: 2-triangle quad reads better as a grid.
  const verts = new Float32Array([
    -1, -1, 1, -1, 1, 1,
    -1, -1, 1, 1, -1, 1,
  ]);
  const vertexCount = verts.length / 2;

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Distance from camera to the image plane
  const D = focalLen;
  // xy max amplitude
  const Wx = ctx.cols * PITCH * 0.55;
  const Hy = ctx.rows * PITCH * 0.55;

  const proj = mat4.create();
  const view = mat4.create();
  const mvp = mat4.create();

  // Projection is frame-invariant, so build it once. fovY is chosen so the
  // z = 0 dot plane maps 1 world unit -> 1 pixel.
  const fovY = 2 * Math.atan(ctx.canvasHeight / 2 / D);
  mat4.perspective(proj, fovY, ctx.canvasWidth / ctx.canvasHeight, 1.0, 10000);

  // Lens shift: anchor the grid to the pixel origin the way the resting
  // halftone (and every 2D transition) does, instead of centering it on the
  // canvas. The grid is rounded up to cover the canvas (cols*PITCH >=
  // canvasWidth), so a canvas-centered grid lands every dot up to half a cell
  // off, producing a visible jump on takeover/handoff. Offsetting the
  // projection's principal point by that half-overflow shifts the whole render
  // back into pixel alignment -- exact at the on-axis handoff frames,
  // imperceptible mid-flight.
  proj[8] = (ctx.canvasWidth - ctx.cols * PITCH) / ctx.canvasWidth;
  proj[9] = (ctx.canvasHeight - ctx.rows * PITCH) / ctx.canvasHeight;

  return {
    durationMs: 20000,
    prepareRender: (_durationMs: number) => {
      return (t: number) => {
        const { pos, vel, acc } = pathSample(t, Wx, Hy, D);
        const worldUpHint = cameraUp(t, pos, vel, acc, D);
        const movementForward = normalize(vel);

        // After we've crossed to the other side, we need to flip the camera
        // direction to look backwards so that we can hand over to the next
        // transition from rest position. Do this slightly after we've crossed
        // to the other side.
        const turnStart = 0.55;
        const turnEnd = 0.85;
        const blend = smoothstep(t, [turnStart, turnEnd]);
        const upDotF = dot(worldUpHint, movementForward);
        const rotationAxis = normalize([
          worldUpHint[0] - upDotF * movementForward[0],
          worldUpHint[1] - upDotF * movementForward[1],
          worldUpHint[2] - upDotF * movementForward[2],
        ]);
        const cameraForward = rotateAboutAxis(
          movementForward,
          rotationAxis,
          -blend * Math.PI,
        );
        const target: mat4.Vec3 = [
          pos[0] + cameraForward[0],
          pos[1] + cameraForward[1],
          pos[2] + cameraForward[2],
        ];
        mat4.lookAt(view, pos, target, worldUpHint);
        mat4.multiply(mvp, proj, view);

        // Fade sphere shading in at start and out at end to make sure image
        // looks the same when we take over from previous transition or hand
        // over to the next one.
        let sphereShading: number;
        if (t < 0.05) sphereShading = t / 0.05;
        else if (t > 0.95) sphereShading = (1 - t) / 0.05;
        else sphereShading = 1;

        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.uniform3f(uCamPos, pos[0], pos[1], pos[2]);
        // Camera basis in world space, read straight out of the view matrix.
        // The columns of the view matrix's rotation block are the world axes
        // expressed in camera space, so its rows are the camera axes expressed
        // in world space: row 0 = right, row 1 = up, row 2 = -forward (i.e.
        // the direction from the scene back toward the camera).
        gl.uniform3f(uCamRight, view[0], view[4], view[8]);
        gl.uniform3f(uCamUp, view[1], view[5], view[9]);
        gl.uniform3f(uCamFwd, view[2], view[6], view[10]);
        gl.uniform1f(uSphereShading, sphereShading);
        gl.uniformMatrix4fv(uMVP, false, mvp);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);

        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, totalInstances);
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

interface Derivatives {
  f: number;
  df: number;
  ddf: number;
}

interface Sample {
  pos: Vec3;
  vel: Vec3;
  acc: Vec3;
}

/**
 * Closed-form position, velocity, and acceleration on the orbit flight path.
 * Velocity feeds the camera tangent; acceleration drives banking via curvature.
 *
 * xy-axes trace a figure-8 — see {@link xyPath} for details.
 * z-axis uses a sinh/tanh blend — see {@link zProfile} for details.
 *
 * @param t - Normalized time in [0, 1].
 * @param Wx - Peak x-amplitude of the figure-8 lobes.
 * @param Hy - Peak y-amplitude of the figure-8 lobes.
 * @param D - Depth: z-distance from origin to each image plane.
 * @returns Position, first derivative (velocity), and second derivative
 *          (acceleration) at the given time.
 */
function pathSample(t: number, Wx: number, Hy: number, D: number): Sample {
  const { x, y } = xyPath(t, Wx, Hy);
  const z = zProfile(t, D);

  return {
    pos: [x.f, y.f, z.f],
    vel: [x.df, y.df, z.df],
    acc: [x.ddf, y.ddf, z.ddf],
  };
}

/**
 * Value, first, and second derivatives of the figure-8 xy-path.
 *
 *   x(t) = Wx · sin(2π·t) · sin(π·t)^P
 *   y(t) = Hy · sin(4π·t) · sin(π·t)^P
 *
 * x completes 1 full cycle while y completes 2, tracing a figure-8 in the
 * xy-plane. The sin^P envelope vanishes at both endpoints (the camera's rest
 * position on the z-axis) so transitions can hand off seamlessly.
 *
 * Derivatives use the product rule on sin(n·π·t) · envelope.
 *
 * @param t - Normalized time in [0, 1].
 * @param Wx - Peak x-amplitude of the figure-8 lobes.
 * @param Hy - Peak y-amplitude of the figure-8 lobes.
 */
function xyPath(
  t: number,
  Wx: number,
  Hy: number,
): { x: Derivatives; y: Derivatives } {
  const ENV_P = 0.5;
  const piT = Math.PI * t;

  // sin(πt)^P envelope — vanishes at both endpoints so transitions hand off
  // seamlessly. fade, fadeDot, fadeDdot are value, first, and second
  // derivatives.
  const sinPiT = Math.sin(piT);
  const cosPiT = Math.cos(piT);
  const sinPm1 = sinPiT > 1e-10 ? sinPiT ** (ENV_P - 1) : 0;
  const sinPm2 = sinPiT > 1e-10 ? sinPiT ** (ENV_P - 2) : 0;
  const fade = sinPiT * sinPm1;
  const fadeDot = ENV_P * Math.PI * sinPm1 * cosPiT;
  const fadeDdot =
    ENV_P *
    Math.PI *
    Math.PI *
    sinPm2 *
    ((ENV_P - 1) * cosPiT * cosPiT - sinPiT * sinPiT);

  const sin2PiT = Math.sin(2 * piT);
  const cos2PiT = Math.cos(2 * piT);
  const sin4PiT = Math.sin(4 * piT);
  const cos4PiT = Math.cos(4 * piT);

  return {
    x: {
      f: Wx * sin2PiT * fade,
      df: Wx * (2 * Math.PI * cos2PiT * fade + sin2PiT * fadeDot),
      ddf:
        Wx *
        (-4 * Math.PI * Math.PI * sin2PiT * fade +
          2 * 2 * Math.PI * cos2PiT * fadeDot +
          sin2PiT * fadeDdot),
    },
    y: {
      f: Hy * sin4PiT * fade,
      df: Hy * (4 * Math.PI * cos4PiT * fade + sin4PiT * fadeDot),
      ddf:
        Hy *
        (-16 * Math.PI * Math.PI * sin4PiT * fade +
          2 * 4 * Math.PI * cos4PiT * fadeDot +
          sin4PiT * fadeDdot),
    },
  };
}

/**
 * Value, first, and second derivatives of the z-axis depth profile.
 *
 * Uses a sinh/tanh blend that ramps to ±D at the endpoints with a fast crossing
 * through zero and a cruise plateau in between:
 *
 *   z(t) = D·(A·sinh(K_Z·u)/sinh(K_Z) + B·tanh(K_C·u)/tanh(K_C)) / (A+B)
 *
 * where u = 2t−1. The sinh term provides takeoff/landing ramps; the tanh term
 * saturates quickly into a cruise plateau at ±B·D/(A+B). Dividing by (A+B) pins
 * the endpoints at ±D regardless of A,B tuning.
 *
 * @param t - Normalized time in [0, 1].
 * @param D - Depth: z-distance from origin to each image plane.
 */
function zProfile(t: number, D: number): Derivatives {
  const K_Z = 16.0;
  const K_C = 10;
  const A = 2.0;
  const B = 0.1;

  const u = 2 * t - 1;
  const shZ = Math.sinh(K_Z);
  const thC = Math.tanh(K_C);
  const thCu = Math.tanh(K_C * u);
  const sech2Cu = 1 - thCu * thCu;
  const norm = -D / (A + B);

  return {
    f: norm * ((A * Math.sinh(K_Z * u)) / shZ + (B * thCu) / thC),
    df:
      norm *
      ((A * (2 * K_Z * Math.cosh(K_Z * u))) / shZ +
        (B * (2 * K_C * sech2Cu)) / thC),
    ddf:
      norm *
      ((A * (4 * K_Z * K_Z * Math.sinh(K_Z * u))) / shZ +
        (B * (-8 * K_C * K_C * sech2Cu * thCu)) / thC),
  };
}

/**
 * Computes the camera's up vector for the orbit flight path with roll and
 * banking. Roll comes from up direction changing due to different animation
 * phases requiring different up vectors. The banking is derived from the shape
 * of the movement to imitate e.g. plane flying the turns.
 *
 * @param t - Normalized time in [0, 1].
 * @param pos - Camera position at time t.
 * @param vel - Camera velocity (first derivative) at time t.
 * @param acc - Camera acceleration (second derivative) at time t.
 * @param D - Depth: z-distance from origin to each image plane.
 * @returns Normalized up vector with roll and banking applied.
 */
function cameraUp(t: number, pos: Vec3, vel: Vec3, acc: Vec3, D: number): Vec3 {
  // The up vector varies through four stages of the animation:
  // 1. `[0, 1, 0]` — Initially the camera is below the image, looking along the
  //    z-axis, with up pointing along the y-axis.
  // 2. `[0, 0, -1]` — While cruising on the A-side, up points along the
  //    negative z-axis.
  // 3. `[0, 0, 1]` — While cruising on the B-side, up is flipped to point along
  //    the positive z-axis.
  // 4. `[0, 1, 0]` — At the end, the camera returns to its initial up so the
  //    next transition can hand off seamlessly.
  //
  // The smooth transition between these states is built from two functions:
  // - `rollT = exp(-x²) - C` on `[-1, 1]`: a bell curve that starts at zero,
  //   peaks in the middle, and returns to zero.
  // - `cruiseUpZ = tanh(x)` on `[-1, 1]`: an S-curve crossing from −1 to +1.
  // Combined: `[0, 1, 0]` → `[0, 0, -1]` → `[0, 0, 1]` → `[0, 1, 0]` becomes
  // `[0, 1 - rollT, cruiseUpZ · rollT]`.

  const rollT = Math.exp(-((pos[2] / D) ** 2) * 2) - Math.exp(-2);
  const cruiseUpZ = -Math.tanh(8 * (2 * t - 1));
  const baseUp: Vec3 = [0, 1 - rollT, cruiseUpZ * rollT];

  // Bank the up vector in curves to imitate how an airplane would take the
  // turns. When moving on a curved path, we have two acceleration components:
  // tangential acceleration into your current direction, and the "sideways"
  // acceleration which keeps you on that curved path. To calculate banking we
  // want to look at the strength of that sideways acceleration to come up with
  // realistic bank.

  // Get the tangent from velocity and its dot product with the acceleration
  // vector. This gives the "strength" of the forward acceleration.
  const tangent = normalize(vel);
  const aDotT = acc[0] * tangent[0] + acc[1] * tangent[1] + acc[2] * tangent[2];

  // Subtract the forward acceleration components from the total acceleration.
  // This gives us the "sideways" acceleration vector.
  const curvNormal: Vec3 = [
    acc[0] - aDotT * tangent[0],
    acc[1] - aDotT * tangent[1],
    acc[2] - aDotT * tangent[2],
  ];

  // Scale by bank strength and add to baseUp, creating the banking effect.
  const BANK_STRENGTH = 0.000008;
  // Scale the bank strength by rollT so that we don't bank at the beginning or
  // end of the flight, avoiding the camera jumping into a bank immediately when
  // the timeline starts.
  const bank = BANK_STRENGTH * rollT;
  return normalize([
    baseUp[0] + curvNormal[0] * bank,
    baseUp[1] + curvNormal[1] * bank,
    baseUp[2] + curvNormal[2] * bank,
  ]);
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
  if (len < 0.0001) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
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

// Rodrigues' rotation: rotate v around unit axis by angle theta.
function rotateAboutAxis(v: Vec3, rotationAxis: Vec3, theta: number): Vec3 {
  const cosine = Math.cos(theta);
  const sine = Math.sin(theta);
  const kv = cross(rotationAxis, v);
  const kd = dot(rotationAxis, v) * (1 - cosine);
  return [
    v[0] * cosine + kv[0] * sine + rotationAxis[0] * kd,
    v[1] * cosine + kv[1] * sine + rotationAxis[1] * kd,
    v[2] * cosine + kv[2] * sine + rotationAxis[2] * kd,
  ];
}
