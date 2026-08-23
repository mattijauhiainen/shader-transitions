import { clamp } from "../../clamp.ts";
import { LUMA } from "../../luma.ts";
import * as mat4 from "../../mat4.ts";
import {
  DOT_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import { smoothstep } from "../../smoothstep.ts";
import fragSrc from "./globe.frag.glsl" with { type: "text" };
import vertSrc from "./globe.vert.glsl" with { type: "text" };

type Vec3 = [number, number, number];

// One camera orbit, plus curl-in and uncurl bookends. The sphere itself stays
// fixed; only the camera flies around it. Times are normalized t ∈ [0,1].
//
//   [0.00, CURL_END]                 curl: flat → sphere, all A
//   [CURL_END, FLIP_START]           pre-flip orbit, all A
//   [FLIP_START, FLIP_END]           random A→B flips happen here
//   [FLIP_END, UNCURL_START]         post-flip orbit, all B
//   [UNCURL_START, 1.0]              uncurl: sphere → flat, all B
const CURL_END = 0.1;
const FLIP_START = 0.4;
const FLIP_END = 0.6;
const UNCURL_START = 0.93;
const ORBIT_TURNS = 1;

// --- Flyover camera knobs ---
// How far above the sphere the camera moves (relative to radius)
const FLYOVER_ALT = 1.2;
// How much we pitch the camera down towards the sphere center
const PITCH_DOWN_DEG = 38;
// 0 tilt means camera orbits over equator, 90 tilt means camera will orbit from
// pole to pole.
const TILT_DEG = 60;
// Overlap the curl / uncurl with the orbit to avoid an awkward pause when we
// move from one phase to the next.
const ORBIT_START = CURL_END - 0.06;
const ORBIT_END = UNCURL_START + 0.06;

export function createGlobeTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(vertSrc, fragSrc);

  const focalLen = ctx.canvasWidth * 0.5;
  const radius = Math.min(ctx.canvasWidth, ctx.canvasHeight) * 0.55;

  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "uGRID_SIZE"),
    ctx.cols,
    ctx.rows,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uDOT_SIZE"), DOT_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPITCH"), PITCH);
  gl.uniform1f(gl.getUniformLocation(program, "uFOCAL_PX"), focalLen);
  gl.uniform1f(gl.getUniformLocation(program, "uRADIUS"), radius);
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
  gl.uniform2f(
    gl.getUniformLocation(program, "uFLIP_WINDOW"),
    FLIP_START,
    FLIP_END,
  );
  gl.useProgram(null);

  const uCamPos = gl.getUniformLocation(program, "uCamPos")!;
  const uCamRight = gl.getUniformLocation(program, "uCamRight")!;
  const uCamUp = gl.getUniformLocation(program, "uCamUp")!;
  const uCamFwd = gl.getUniformLocation(program, "uCamFwd")!;
  const uSphereShading = gl.getUniformLocation(program, "uSphereShading")!;
  const uMVP = gl.getUniformLocation(program, "uMVP")!;
  const uCurl = gl.getUniformLocation(program, "uCurl")!;
  const uPhase = gl.getUniformLocation(program, "uPhase")!;

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

  // Camera distance from the globe's center. fovY is picked so 1 world unit
  // at z=0 maps to 1 screen pixel, matching the resting halftone.
  const restDist = focalLen;
  const proj = mat4.create();
  const view = mat4.create();
  const mvp = mat4.create();
  const fovY = 2 * Math.atan(ctx.canvasHeight / 2 / restDist);
  mat4.perspective(proj, fovY, ctx.canvasWidth / ctx.canvasHeight, 1.0, 10000);
  // Lens shift. 2D transitions anchor the grid to a corner, so the ceil()
  // over-scan (cols*PITCH >= canvasWidth) spills off the far edges. This grid
  // is centered on the origin, splitting that over-scan across all four sides.
  // proj[8]/proj[9] (principal-point terms) slide it back by half the
  // over-scan so the curl=0 rest frame is pixel-exact with the other
  // transitions.
  proj[8] = (ctx.canvasWidth - ctx.cols * PITCH) / ctx.canvasWidth;
  proj[9] = (ctx.canvasHeight - ctx.rows * PITCH) / ctx.canvasHeight;

  return {
    durationMs: 15000,
    prepareRender: (_durationMs: number) => {
      return (t: number) => {
        // --- Curl: 0 at the bookend edges, 1 across the entire orbit span ---
        let curl: number;
        if (t < CURL_END) curl = smoothstep(t / CURL_END);
        else if (t > UNCURL_START)
          curl = smoothstep((1 - t) / (1 - UNCURL_START));
        else curl = 1;

        // --- Orbit: constant angular velocity across [ORBIT_START, ORBIT_END] ---
        // Held at 0 before ORBIT_START (curl is still forming the sphere) and
        // held at the final angle after ORBIT_END (uncurl is unfolding it), so
        // the orbit doesn't leak into the flat bookends.
        const orbitT = clamp((t - ORBIT_START) / (ORBIT_END - ORBIT_START));

        // --- Sphere shading: off at the flat bookends so the dots match the
        // resting halftone, ramping in over curl and back out over uncurl. ---
        const sphereShading = curl;

        const { eye, target, up } = computeCamera(
          curl,
          orbitT,
          restDist,
          radius * FLYOVER_ALT,
          (TILT_DEG * Math.PI) / 180,
          (PITCH_DOWN_DEG * Math.PI) / 180,
        );

        mat4.lookAt(view, eye, target, up);
        mat4.multiply(mvp, proj, view);

        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.uniform3f(uCamPos, eye[0], eye[1], eye[2]);
        // Camera basis read out of the view matrix's rows — same as orbit.
        gl.uniform3f(uCamRight, view[0], view[4], view[8]);
        gl.uniform3f(uCamUp, view[1], view[5], view[9]);
        gl.uniform3f(uCamFwd, view[2], view[6], view[10]);
        gl.uniform1f(uSphereShading, sphereShading);
        gl.uniformMatrix4fv(uMVP, false, mvp);
        gl.uniform1f(uCurl, curl);
        gl.uniform1f(uPhase, t);

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

interface Camera {
  eye: Vec3;
  target: Vec3;
  up: Vec3;
}

/**
 * Camera pose for the flyover orbit around the globe.
 *
 * Position: the orbit is a great circle that passes through +Z (the
 * resting equator point) at az=0 and az=2π, so the bookend frames line
 * up with the flat-grid rest pose regardless of `tilt`. We get this by
 * rotating +Z around an axis n = (sin(tilt), cos(tilt), 0) — a "north"
 * pole tilted into the +X side of the XY plane — which yields a great
 * circle whose peak latitude equals `tilt` and whose az=0 point is
 * fixed at +Z:
 *   eye = ( dist·cos(tilt)·sin(az),
 *          -dist·sin(tilt)·sin(az),
 *           dist·cos(az) )
 * This keeps the camera on the equator at the start and end of the orbit
 * span. Azimuth advances one full turn across the orbit span.
 *
 * Orientation: when curl=1 we're in full "satellite flyover" mode.
 *   up      = radial outward from globe center to camera
 *   forward = orbital tangent (direction of travel), pitched toward the
 *             surface so the planet fills the lower frame.
 * When curl=0 we want the rest pose (look at origin, up=+Y) so the
 * flat-grid handoff is pixel-aligned. We blend both target and up with
 * curl — at the bookends the lookAt collapses to the original centerward
 * pose, and at full curl it's a pure flyover.
 */
function computeCamera(
  curl: number,
  orbitT: number,
  restDist: number,
  flyoverDist: number,
  tiltPeak: number,
  pitchDown: number,
): Camera {
  const tilt = tiltPeak * curl;
  const dist = restDist + (flyoverDist - restDist) * curl;
  const az = -orbitT * ORBIT_TURNS * 2 * Math.PI;
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const eye: Vec3 = [
    dist * cosTilt * sinAz,
    -dist * sinTilt * sinAz,
    dist * cosAz,
  ];

  // upRadial is the unit vector from globe center to camera (since the
  // orbit is at constant distance `dist`, this is normalize(eye) — and
  // the algebra works out to length 1 already: cos²tilt·sin²az +
  // sin²tilt·sin²az + cos²az = sin²az + cos²az = 1).
  const upRadial: Vec3 = [cosTilt * sinAz, -sinTilt * sinAz, cosAz];
  // Tangent to the orbital circle in the camera's direction of travel.
  // d(eye)/d(az) gives (cosTilt·cosAz, -sinTilt·cosAz, -sinAz) up to
  // dist; we negate because az decreases with time (negated orbitT).
  const fwdTangent: Vec3 = [-cosTilt * cosAz, sinTilt * cosAz, sinAz];
  // Pitch forward toward the surface: rotate forward in the plane spanned
  // by tangent and -radial.
  const cosPitch = Math.cos(pitchDown);
  const sinPitch = Math.sin(pitchDown);
  const forward: Vec3 = [
    fwdTangent[0] * cosPitch - upRadial[0] * sinPitch,
    fwdTangent[1] * cosPitch - upRadial[1] * sinPitch,
    fwdTangent[2] * cosPitch - upRadial[2] * sinPitch,
  ];

  // At curl = 0 we want to be looking directly down into the uncurled image. By
  // the time curl = 1, the camera direction should be to the forward vector. Do
  // this by  blending the centerward vector out and forward vector in with
  // curl.
  const centerward: Vec3 = [-upRadial[0], -upRadial[1], -upRadial[2]];
  const lookDir: Vec3 = [
    centerward[0] * (1 - curl) + forward[0] * curl,
    centerward[1] * (1 - curl) + forward[1] * curl,
    centerward[2] * (1 - curl) + forward[2] * curl,
  ];
  const target: Vec3 = [
    eye[0] + lookDir[0],
    eye[1] + lookDir[1],
    eye[2] + lookDir[2],
  ];
  const up: Vec3 = [
    upRadial[0] * curl,
    upRadial[1] * curl + (1 - curl),
    upRadial[2] * curl,
  ];

  return { eye, target, up };
}
