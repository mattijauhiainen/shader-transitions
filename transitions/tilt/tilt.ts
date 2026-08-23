import { LUMA } from "../../luma.ts";
import * as mat4 from "../../mat4.ts";
import {
  DOT_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import fragSrc from "./tilt.frag.glsl" with { type: "text" };
import vertSrc from "./tilt.vert.glsl" with { type: "text" };

// Billboard quad in unit-disk space [-1, 1]². Two triangles instead of a
// tessellated fan so the geometry fully contains the AA-feathered disk —
// a 16-segment fan dips inside the unit circle at the edge midpoints and
// clips the outermost ~2% of each dot, visible as a slight color shift
// against the resting halftone at the handover frame.
// biome-ignore format: 2-triangle quad reads better as a grid.
const QUAD_VERTS = new Float32Array([
  -1, -1, 1, -1, 1, 1,
  -1, -1, 1, 1, -1, 1,
]);

export function createTiltTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(vertSrc, fragSrc);

  // Init-time uniforms (set once).
  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "uGRID_SIZE"),
    ctx.cols,
    ctx.rows,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uDOT_SIZE"), DOT_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPITCH"), PITCH);
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

  const uMVP = gl.getUniformLocation(program, "uMVP")!;
  const uShowB = gl.getUniformLocation(program, "uShowB")!;

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const vertexCount = QUAD_VERTS.length / 2;

  // Reusable matrix scratch space — avoid allocating per-frame.
  const proj = mat4.create();
  const view = mat4.create();
  const model = mat4.create();
  const mvp = mat4.create();

  // Pick a focal length and calibrate fovY so 1 world unit at z=0 maps to
  // exactly 1 screen pixel. Same trick orbit uses: with the z=0 plane on a
  // 1:1 world-to-pixel mapping, the grid renders at its native pixel size,
  // so the takeover/handover frames match the resting halftone exactly.
  const distance = ctx.canvasWidth * 0.5;
  const fovY = 2 * Math.atan(ctx.canvasHeight / 2 / distance);
  mat4.perspective(proj, fovY, ctx.canvasWidth / ctx.canvasHeight, 1.0, 10000);

  // Lens shift, copied straight from orbit: the grid is rounded up to cover
  // the canvas (cols*PITCH >= canvasWidth), so a canvas-centered grid lands
  // every dot up to half a cell off the resting halftone's pixel origin --
  // visible as a one- or two-pixel jolt at takeover. Offset the projection's
  // principal point by that half-overflow to put the rendered grid back on
  // the resting halftone's pixel grid. Exact at the on-axis handoff frames,
  // imperceptible mid-flight.
  proj[8] = (ctx.canvasWidth - ctx.cols * PITCH) / ctx.canvasWidth;
  proj[9] = (ctx.canvasHeight - ctx.rows * PITCH) / ctx.canvasHeight;

  return {
    durationMs: 3000,
    prepareRender(_durationMs: number) {
      return (t: number) => {
        gl.useProgram(program);

        // VIEW — camera on +Z looking back toward origin. The +Z side is
        // important: with up = +Y, `cross(forward=-Z, up=+Y) = +X`, so world
        // +X maps to screen right. That matches the resting halftone (and
        // every 2D transition), so the takeover from the previous transition
        // lands without a horizontal mirror jump.
        mat4.lookAt(
          view,
          [0, 0, distance], // eye
          [0, 0, 0], // target
          [0, 1, 0], // world up
        );

        // MODEL — the tilt itself. Identity, then rotate around Y by t*π
        // (one half-flip over the transition).
        mat4.identity(model);
        mat4.rotateY(model, model, t * Math.PI);

        // Compose: mvp = proj * view * model
        mat4.multiply(mvp, proj, view);
        mat4.multiply(mvp, mvp, model);

        gl.uniformMatrix4fv(uMVP, false, mvp);

        // After we've rotated past edge-on (t >= 0.5), the back face is the
        // one pointing at the camera, so hand off to image B. The plane is
        // edge-on at the handoff frame, so there's nothing to see — the swap
        // is invisible.
        gl.uniform1f(uShowB, t >= 0.5 ? 1 : 0);

        // A on texture units 0/1, B on 2/3.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);

        // Bind the default framebuffer (the canvas).
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(
          gl.TRIANGLES,
          0,
          vertexCount,
          ctx.cols * ctx.rows,
        );
        gl.bindVertexArray(null);

        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);

        gl.useProgram(null);
      };
    },
  };
}
