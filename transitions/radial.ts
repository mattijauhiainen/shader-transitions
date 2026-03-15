import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";
import { fullscreenQuadVert } from "../fullscreenQuadVert.ts";

export function createRadialTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(fullscreenQuadVert, `#version 300 es
  precision highp float;
  uniform sampler2D uTextureA;
  uniform sampler2D uLumaRangeA;
  uniform sampler2D uTextureB;
  uniform sampler2D uLumaRangeB;
  uniform vec2 uCellCount;

  #define CELL_SIZE ${CELL_SIZE.toFixed(1)}
  #define PITCH ${PITCH.toFixed(1)}
  #define LUMA vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})
  uniform float uT;
  uniform vec2 uOrigin;

  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    vec2 cellCoord = floor(gl_FragCoord.xy / PITCH);
    vec2 cellCenter = (cellCoord + 0.5) * PITCH;
    vec2 uv = (cellCoord + 0.5) / uCellCount;
    float dist = length(gl_FragCoord.xy - cellCenter);

    float distFromOrigin = length(gl_FragCoord.xy - uOrigin);
    vec2 viewport = uCellCount * PITCH;
    float diameter = max(
      max(length(uOrigin), length(uOrigin - vec2(viewport.x, 0.0))),
      max(length(uOrigin - vec2(0.0, viewport.y)), length(uOrigin - viewport))
    );

    vec4 colorA = texture(uTextureA, uv);
    vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
    float normA = (dot(colorA.rgb, LUMA) - rangeA.r) / (rangeA.g - rangeA.r);
    float rA = sqrt(normA) * CELL_SIZE * 0.5 * (1.0 - uT);
    float alphaA = smoothstep(rA + 0.5, rA - 0.5, dist);

    vec4 colorB = texture(uTextureB, uv);
    vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
    float normB = (dot(colorB.rgb, LUMA) - rangeB.r) / (rangeB.g - rangeB.r);
    float rB = sqrt(normB) * CELL_SIZE * 0.5 * uT;
    float alphaB = smoothstep(rB + 0.5, rB - 0.5, dist);

    if (distFromOrigin < diameter * uT) {
      fragColor = mix(mix(vec4(0, 0, 0, 1), colorA, alphaA), colorB, alphaB);
    } else {
       fragColor = mix(vec4(0,0,0,1), colorA, alphaA);
    }
  }
  `);

  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), ctx.cols, ctx.rows);
  gl.uniform1i(gl.getUniformLocation(program, "uTextureA"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uTextureB"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
  gl.useProgram(null);

  const uT = gl.getUniformLocation(program, "uT")!;
  const uOrigin = gl.getUniformLocation(program, "uOrigin")!;

  return {
    durationMs: 2500,
    prepareRender(_durationMs: number) {
      const ox = ctx.canvasWidth * (0.25 + Math.random() * 0.5);
      const oy = ctx.canvasHeight * (0.25 + Math.random() * 0.5);
      return (t: number) => {
        gl.useProgram(program);
        gl.uniform2f(uOrigin, ox, oy);

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
      };
    },
  };
}
