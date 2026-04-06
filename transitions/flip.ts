import { easeInOut } from "../easeInOut.ts";
import { LUMA } from "../luma.ts";
import {
  CELL_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../renderer.ts";
import fragSrc from "./flip.frag.glsl" with { type: "text" };
import vertSrc from "./flip.vert.glsl" with { type: "text" };

export function createFlipTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(vertSrc, fragSrc);

  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uGridSize"), ctx.cols, ctx.rows);
  gl.uniform2f(
    gl.getUniformLocation(program, "uViewport"),
    ctx.canvasWidth,
    ctx.canvasHeight,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
  gl.uniform3f(
    gl.getUniformLocation(program, "uLuma"),
    LUMA[0],
    LUMA[1],
    LUMA[2],
  );
  gl.uniform1i(gl.getUniformLocation(program, "uCellColorsA"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColorsB"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
  gl.useProgram(null);

  const uTime = gl.getUniformLocation(program, "uTime")!;
  const totalInstances = ctx.cols * ctx.rows;

  // Build a circle mesh as a triangle fan: center + 24 outer vertices
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

  return {
    durationMs: 3000,
    easing: easeInOut,
    prepareRender: (_durationMs: number) => (t: number) => {
      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform1f(uTime, t);

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
    },
    dispose: () => {
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
    },
  };
}
