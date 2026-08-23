import { LUMA } from "../../luma.ts";
import {
  DOT_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import fragSrc from "./wind.frag.glsl" with { type: "text" };
import vertSrc from "./wind.vert.glsl" with { type: "text" };

export function createWindTransition(ctx: RendererContext): Transition {
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
  gl.uniform1f(
    gl.getUniformLocation(program, "uFOCAL_LEN"),
    ctx.canvasWidth * 0.5,
  );

  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS_A"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE_A"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS_B"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE_B"), 3);
  gl.useProgram(null);

  const uTime = gl.getUniformLocation(program, "uTime")!;
  const uWindDir = gl.getUniformLocation(program, "uWindDir")!;
  const uPhase = gl.getUniformLocation(program, "uPhase")!;
  const vao = ctx.createQuadVAO();

  const totalInstances = ctx.cols * ctx.rows;

  return {
    durationMs: 7000,
    easing: (t: number) => t,
    prepareRender: (_durationMs: number) => {
      // Random wind direction, stable across this run (picked once, like radial).
      // Blows either straight left (180°) or straight right (0°), jittered ±30°.
      const base = Math.random() < 0.5 ? 0 : 180;
      const angle = ((base + (Math.random() - 0.5) * 60) * Math.PI) / 180;
      const windX = Math.cos(angle);
      const windY = Math.sin(angle);

      return (t: number) => {
        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        gl.uniform1f(uTime, t);
        gl.uniform2f(uWindDir, windX, windY);

        // A = current (units 0/1), B = next (units 2/3). All four bound so one
        // program can read both images.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);

        gl.bindVertexArray(vao);

        // B pass first (settled surface), then A pass (blowing dots) over it.
        gl.uniform1i(uPhase, 1);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);
        gl.uniform1i(uPhase, 0);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);

        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
      };
    },
    dispose: () => {
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
