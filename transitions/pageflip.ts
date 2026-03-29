import { easeIn } from "../easeIn.ts";
import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";
import fragSrc from "./pageflip.frag.glsl" with { type: "text" };
import vertSrc from "./pageflip.vert.glsl" with { type: "text" };

export function createPageflipTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;

  const program = ctx.createProgram(vertSrc, fragSrc);

  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uGridSize"), ctx.cols, ctx.rows);
  gl.uniform2f(gl.getUniformLocation(program, "uViewport"), ctx.canvasWidth, ctx.canvasHeight);
  gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
  gl.uniform3f(gl.getUniformLocation(program, "uLuma"), LUMA[0], LUMA[1], LUMA[2]);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColors"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRange"), 1);
  gl.useProgram(null);

  const uTime = gl.getUniformLocation(program, "uTime")!;
  const uPhase = gl.getUniformLocation(program, "uPhase")!;

  const totalInstances = ctx.cols * ctx.rows;

  return {
    durationMs: 2500,
    easing: easeIn,
    prepareRender: (_durationMs: number) => (t: number) => {
      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform1f(uTime, t);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // Pass 1: draw B dots (revealed region, flat)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);
      gl.uniform1i(uPhase, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);

      // Pass 2: draw A dots (curling page) on top
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
      gl.uniform1i(uPhase, 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);
      gl.disable(gl.BLEND);
    },
  };
}
