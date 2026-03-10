import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";
import { fullscreenQuadVert } from "../fullscreenQuadVert.ts";

export function createWipeTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(fullscreenQuadVert, `#version 300 es
  precision highp float;
  uniform sampler2D uTextureA;
  uniform sampler2D uLumaRangeA;
  uniform sampler2D uTextureB;
  uniform sampler2D uLumaRangeB;
  uniform float uCellSize;
  uniform float uPitch;
  uniform vec2 uCellCount;
  uniform float uT;

  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
    vec2 cellCenter = (cellCoord + 0.5) * uPitch;
    vec2 uv = (cellCoord + 0.5) / uCellCount;
    float dist = length(gl_FragCoord.xy - cellCenter);

    vec2 viewport = uCellCount * uPitch;
    float bandWidth = viewport.x * 0.30;
    float rightEdge = (viewport.x + bandWidth) * uT;
    float grad = clamp(1.0 - (rightEdge - gl_FragCoord.x) / bandWidth, 0.0, 1.0);

    vec4 colorA = texture(uTextureA, uv);
    vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
    float normA = (dot(colorA.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeA.r) / (rangeA.g - rangeA.r);

    float scaleA = clamp(grad / 0.4, 0.0, 1.0);
    float scaleB = clamp((1.0 - grad) / 0.4, 0.0, 1.0);

    float radiusA = sqrt(normA) * uCellSize * 0.5 * scaleA;
    float alphaA = smoothstep(radiusA + 0.5, radiusA - 0.5, dist);

    vec4 colorB = texture(uTextureB, uv);
    vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
    float normB = (dot(colorB.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeB.r) / (rangeB.g - rangeB.r);

    float radiusB = sqrt(normB) * uCellSize * 0.5 * scaleB;
    float alphaB = smoothstep(radiusB + 0.5, radiusB - 0.5, dist);

    vec4 bg = vec4(0.0, 0.0, 0.0, 1.0);
    fragColor = mix(mix(bg, vec4(colorA.rgb, 1.0), alphaA), vec4(colorB.rgb, 1.0), alphaB);
  }
  `);

  gl.useProgram(program);
  gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
  gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), ctx.cols, ctx.rows);
  gl.uniform1i(gl.getUniformLocation(program, "uTextureA"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uTextureB"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
  gl.useProgram(null);

  const uT = gl.getUniformLocation(program, "uT")!;

  return {
    durationMs: 2500,
    prepareRender: (_durationMs: number) => (t: number) => {
      gl.useProgram(program);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctx.current.reduceSteps[ctx.current.reduceSteps.length - 1].texture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.reduceSteps[ctx.next.reduceSteps.length - 1].texture);

      gl.uniform1f(uT, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
