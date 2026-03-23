import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";
import { fullscreenQuadVert } from "../fullscreenQuadVert.ts";

export function createShrinkTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(fullscreenQuadVert, `#version 300 es
  precision highp float;

  // Per-cell average colors for current (A) and next (B) frames
  uniform sampler2D uTextureA;
  uniform sampler2D uLumaRangeA;   // .r = min luma, .g = max luma
  uniform sampler2D uTextureB;
  uniform sampler2D uLumaRangeB;

  uniform vec2 uGridSize;         // grid dimensions (cols, rows)

  #define CELL_SIZE ${CELL_SIZE.toFixed(1)}
  #define PITCH ${PITCH.toFixed(1)}
  #define LUMA vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})
  uniform float uT;                // transition progress 0..1
  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    // Grid helpers
    vec2 cellCoord = floor(gl_FragCoord.xy / PITCH);
    vec2 cellCenter = (cellCoord + 0.5) * PITCH;
    vec2 uv = (cellCoord + 0.5) / uGridSize;
    float dist = length(gl_FragCoord.xy - cellCenter);

    // Current frame (A)
    vec4 colorA = texture(uTextureA, uv);
    vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
    float normA = (dot(colorA.rgb, LUMA) - rangeA.r) / (rangeA.g - rangeA.r);

    // Next frame (B)
    vec4 colorB = texture(uTextureB, uv);
    vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
    float normB = (dot(colorB.rgb, LUMA) - rangeB.r) / (rangeB.g - rangeB.r);

    // Natural radii for each frame
    float rA = sqrt(normA) * CELL_SIZE * 0.5;
    float rB = sqrt(normB) * CELL_SIZE * 0.5;

    // Interpolate between radii with overshoot
    float t = uT;
    float curve = 1.0 + 0.8 * sin(t * 3.14159);  // 1.0 -> 1.8 -> 1.0
    float radius = mix(rA, rB, t) * curve;

    vec3 blendedColor = mix(colorA.rgb, colorB.rgb, t);
    float alpha = smoothstep(radius + 0.5, radius - 0.5, dist);

    fragColor = mix(vec4(0.0, 0.0, 0.0, 1.0), vec4(blendedColor, 1.0), alpha);
  }
  `);

  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uGridSize"), ctx.cols, ctx.rows);
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
      gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);

      gl.uniform1f(uT, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
