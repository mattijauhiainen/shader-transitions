import { LUMA } from "../luma.ts";
import {
  CELL_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../renderer.ts";
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
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS_A"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE_A"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS_B"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE_B"), 3);
  gl.useProgram(null);

  const uCamPos = gl.getUniformLocation(program, "uCamPos")!;
  const uCamRight = gl.getUniformLocation(program, "uCamRight")!;
  const uCamUp = gl.getUniformLocation(program, "uCamUp")!;
  const uCamForward = gl.getUniformLocation(program, "uCamForward")!;
  const uSphereShading = gl.getUniformLocation(program, "uSphereShading")!;

  const totalInstances = ctx.cols * ctx.rows;

  const SEGMENTS = 24;
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

  // Distance from camera to the image plane
  const D = focalLen;
  // xy max amplitude
  const Wx = ctx.cols * PITCH * 0.55;
  const Hy = ctx.rows * PITCH * 0.55;

  return {
    durationMs: 20000,
    prepareRender: (_durationMs: number) => {
      return (t: number) => {
        const { pos, vel, acc } = pathSample(t, Wx, Hy, D);
        const cam = cameraOrientation(t, pos, vel, acc, D);

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
        gl.enable(gl.DEPTH_TEST);

        gl.uniform3f(uCamPos, pos[0], pos[1], pos[2]);
        gl.uniform3f(uCamRight, cam.right[0], cam.right[1], cam.right[2]);
        gl.uniform3f(uCamUp, cam.up[0], cam.up[1], cam.up[2]);
        gl.uniform3f(
          uCamForward,
          cam.forward[0],
          cam.forward[1],
          cam.forward[2],
        );
        gl.uniform1f(uSphereShading, sphereShading);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);

        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, vertexCount, totalInstances);
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
  const norm = D / (A + B);

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
 * Computes the camera orientation (forward, right, up) for a given point on the
 * orbit flight path. Combines the velocity-derived forward direction with
 * banking-aware up vector from {@link cameraUp}.
 *
 * @param t - Normalized time in [0, 1].
 * @param pos - Camera position at time t.
 * @param vel - Camera velocity (first derivative) at time t.
 * @param acc - Camera acceleration (second derivative) at time t.
 * @param D - Depth: z-distance from origin to each image plane.
 * @returns Orthonormal camera basis (forward, right, up) in world space.
 */
function cameraOrientation(
  t: number,
  pos: Vec3,
  vel: Vec3,
  acc: Vec3,
  D: number,
): { forward: Vec3; right: Vec3; up: Vec3 } {
  // Flip the forward direction instantly at t = 0.5. This hides the size
  // discontinuity when crossing the dot plane — the same dot on frame B has
  // different luma (and therefore a different radius), so snapping the view
  // direction keeps that mismatch behind the camera where it isn't visible.
  const flipSign = Math.sign(0.5 - t);
  const forward = normalize([
    vel[0] * flipSign,
    vel[1] * flipSign,
    vel[2] * flipSign,
  ]);
  const worldUpHint = cameraUp(t, pos, vel, acc, D);

  // The "worldUpHint" gives us the desired up direction for the current
  // animation phase. "forward" gives the direction we are actually
  // looking at. We want to roll on that axis, so that the up direction there
  // matches the up-direction of the worldUpHint. This can be done by first
  // taking cross product between worldUpHint and forward, which gives a vector
  // that is perpendicular to those two vectors. Then we use the "right" vector
  // and do another cross product between it and forward. This will give a new
  // up direction for the camera, which will be perpendicular to forward
  // (meaning it is as aligned with the world up hint as possible given the
  // camera direction.)
  const right = normalize(cross(worldUpHint, forward));
  const camUp = cross(forward, right);
  return { forward, right, up: camUp };
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
  const cruiseUpZ = Math.tanh(8 * (2 * t - 1));
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
