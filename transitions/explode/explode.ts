import { LUMA } from "../../luma.ts";
import {
  DOT_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import fragSrc from "./explode.frag.glsl" with { type: "text" };
import vertSrc from "./explode.vert.glsl" with { type: "text" };

export function createExplodeTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;

  const program = ctx.createProgram(vertSrc, fragSrc);

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
  gl.uniform1f(gl.getUniformLocation(program, "uDOT_SIZE"), DOT_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPITCH"), PITCH);
  gl.uniform3f(
    gl.getUniformLocation(program, "uLUMA"),
    LUMA[0],
    LUMA[1],
    LUMA[2],
  );
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE"), 1);
  gl.useProgram(null);

  const uTime = gl.getUniformLocation(program, "uTime")!;
  const uPhase = gl.getUniformLocation(program, "uPhase")!;
  const vao = ctx.createQuadVAO();

  const totalInstances = ctx.cols * ctx.rows;

  return {
    durationMs: 2500,
    easing: (t: number) => t,
    prepareRender: (_durationMs: number) => (t: number) => {
      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform1f(uTime, t);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao);

      // Pass 1: draw B dots (fading in)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);
      gl.uniform1i(uPhase, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);

      // Pass 2: draw A dots (exploding outward) on top
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
      gl.uniform1i(uPhase, 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
  };
}
