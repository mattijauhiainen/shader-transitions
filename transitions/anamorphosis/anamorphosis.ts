import { LUMA } from "../../luma.ts";
import * as mat4 from "../../mat4.ts";
import {
  DOT_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import { smoothstep } from "../../smoothstep.ts";
import fragSrc from "./anamorphosis.frag.glsl" with { type: "text" };
import vertSrc from "./anamorphosis.vert.glsl" with { type: "text" };

/*
* Anamorphosis transition. Anamorphosis means the image is distorted in a way
* that when viewed from a certain angle, it looks normal, but when viewed from
* somewhere else, it transforms unexpectedly.

* The picture is split into rectangular tiles. Inside each tile, we have a 3D
* shape constructed of different layers, e.g. in the center we have layers of
* circles stacked on top of each other. From the rest distance the stack looks
* flat.
*
* The camera flies down the tunnel in the middle of A, on across a gap, and
* down a second tunnel in the middle of B. B is built as A's mirror image so
* that camera needs to fly past B, and turn around to get an image of B.
**/
const TILE_SIZE = 36;
// How many depth layers the shapes use
const LAYER_COUNT = 15;
// How far from the camera the "base" layer is
const DEPTH_BASE = 3.0;
// How close to the camera the closest part of a shape is
const DEPTH_NEAR = 0.4;
// How far from the camera the furthest away part of a shape is
const DEPTH_FAR = 20.0;

// How far behind image A image B sits, counted in resting-camera distances D.
const IMAGE_GAP = 42.0;

const TURN_START = 0.5;
const TURN_END = 0.85;
const FADE_A_OUT: [number, number] = [0.5, 0.62];
const FADE_B_IN: [number, number] = [0.38, 0.52];

export function createAnamorphosisTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(vertSrc, fragSrc);

  const focalLen = ctx.canvasWidth * 0.5;
  const D = focalLen;

  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "uGRID_SIZE"),
    ctx.cols,
    ctx.rows,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uDOT_SIZE"), DOT_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPITCH"), PITCH);
  gl.uniform1f(gl.getUniformLocation(program, "uFOCAL_PX"), focalLen);
  gl.uniform3f(
    gl.getUniformLocation(program, "uLUMA"),
    LUMA[0],
    LUMA[1],
    LUMA[2],
  );
  gl.uniform1f(gl.getUniformLocation(program, "uDEPTH_BASE"), DEPTH_BASE);
  gl.uniform1f(gl.getUniformLocation(program, "uDEPTH_NEAR"), DEPTH_NEAR);
  gl.uniform1f(gl.getUniformLocation(program, "uDEPTH_FAR"), DEPTH_FAR);
  gl.uniform1f(gl.getUniformLocation(program, "uTILE_SIZE"), TILE_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uLAYER_COUNT"), LAYER_COUNT);
  gl.uniform1f(gl.getUniformLocation(program, "uIMAGE_GAP"), IMAGE_GAP * D);
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
  const uFadeA = gl.getUniformLocation(program, "uFadeA")!;
  const uFadeB = gl.getUniformLocation(program, "uFadeB")!;
  const uIsImageA = gl.getUniformLocation(program, "uIsImageA")!;

  // One instance per cell. The grid is drawn once per image, A first, then B.
  const instancesPerImage = ctx.cols * ctx.rows;

  // Billboard quad in corner-space [-1, 1]^2 as a triangle list; the fragment
  // shader treats these as (x, y) on a unit sphere impostor.
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

  const proj = mat4.create();
  const view = mat4.create();
  const mvp = mat4.create();

  // The lens never changes during the flight. The field of view is picked so
  // that one world unit at the picture plane comes out as one pixel, and the
  // nudge to proj[8]/[9] below lines the grid of dots up with the grid of
  // pixels, same as orbit does.
  const fovY = 2 * Math.atan(ctx.canvasHeight / 2 / D);
  // How far the furthest dot ever is. The flight is symmetric: at the start the
  // camera looks across everything to B's nearest layer, and at the end, turned
  // around, across everything to A's.
  const maxDistance = D * (IMAGE_GAP + 2.0 - DEPTH_NEAR) * 1.01;
  mat4.perspective(
    proj,
    fovY,
    ctx.canvasWidth / ctx.canvasHeight,
    1.0,
    maxDistance,
  );

  proj[8] = (ctx.canvasWidth - ctx.cols * PITCH) / ctx.canvasWidth;
  proj[9] = (ctx.canvasHeight - ctx.rows * PITCH) / ctx.canvasHeight;

  // From A's resting camera at +D, through both pictures, to B's resting camera
  // one distance beyond B's picture.
  const travelDistance = D * (IMAGE_GAP + 2.0);

  return {
    durationMs: 24000,
    easing: (t: number) => t,
    prepareRender: (_durationMs: number) => {
      return (t: number) => {
        const eye: mat4.Vec3 = [
          0,
          0,
          D - travelDistance * smoothstep(smoothstep(t)),
        ];
        // Swing 180 degrees about the y axis, from looking down -z at the start
        // to looking back up +z at the end, which is the only heading B reads
        // as a picture from.
        const turn = smoothstep(t, [TURN_START, TURN_END]);
        const yaw = Math.PI * turn;
        const target: mat4.Vec3 = [
          eye[0] + Math.sin(yaw) * D,
          eye[1],
          eye[2] - Math.cos(yaw) * D,
        ];
        // Barrel-roll a whole revolution about the view axis on the way round.
        // Rotating up about the direction the camera is looking, which stays
        // horizontal throughout, so the two are always perpendicular and the
        // rotation is just a pair of sines. A full turn lands up back where it
        // started, so neither B's picture nor the handover after it notices.
        const roll = 2 * Math.PI * turn;
        const up: mat4.Vec3 = [
          Math.sin(roll) * Math.cos(yaw),
          Math.cos(roll),
          Math.sin(roll) * Math.sin(yaw),
        ];
        mat4.lookAt(view, eye, target, up);
        mat4.multiply(mvp, proj, view);

        // Fade sphere shading in at the very start and out at the very end so
        // the first and last frames match the flat resting halftone.
        let sphereShading: number;
        if (t < 0.05) sphereShading = t / 0.05;
        else if (t > 0.95) sphereShading = (1 - t) / 0.05;
        else sphereShading = 1;

        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.uniform3f(uCamPos, eye[0], eye[1], eye[2]);
        // Camera basis in world space, read from the view matrix rows.
        gl.uniform3f(uCamRight, view[0], view[4], view[8]);
        gl.uniform3f(uCamUp, view[1], view[5], view[9]);
        gl.uniform3f(uCamFwd, view[2], view[6], view[10]);
        gl.uniform1f(uSphereShading, sphereShading);
        gl.uniformMatrix4fv(uMVP, false, mvp);
        gl.uniform1f(uFadeA, 1 - smoothstep(t, FADE_A_OUT));
        gl.uniform1f(uFadeB, smoothstep(t, FADE_B_IN));

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
        gl.uniform1i(uIsImageA, 1);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, instancesPerImage);
        gl.uniform1i(uIsImageA, 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, instancesPerImage);
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
