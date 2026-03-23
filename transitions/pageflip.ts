import { easeIn } from "../easeIn.ts";
import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";

export function createPageflipTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;

  const program = ctx.createProgram(`#version 300 es
  precision highp float;

  uniform sampler2D uCellColors;
  uniform sampler2D uLumaRange;
  uniform vec2 uGridSize;

  #define CELL_SIZE ${CELL_SIZE.toFixed(1)}
  #define PITCH ${PITCH.toFixed(1)}
  #define LUMA vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})
  uniform vec2 uViewport;
  uniform float uT;
  uniform int uPhase; // 0 = A (curling page), 1 = B (revealed flat)

  #define PI 3.14159265

  in vec2 aPosition;

  flat out vec4 vColor;
  flat out float vRadius;
  flat out float vOpacity;
  out vec2 vPixelOffset;

  void main() {
    int col = gl_InstanceID % int(uGridSize.x);
    int row = gl_InstanceID / int(uGridSize.x);
    vec2 cellCoord = vec2(col, row);
    vec2 uv = (cellCoord + 0.5) / uGridSize;

    vec4 color = textureLod(uCellColors, uv, 0.0);
    vec2 range = textureLod(uLumaRange, vec2(0.5), 0.0).rg;
    float normalizedLuma = clamp(
      (dot(color.rgb, LUMA) - range.r) / (range.g - range.r),
      0.0, 1.0);
    float radius = sqrt(normalizedLuma) * CELL_SIZE * 0.5;

    vec2 cellCenter = (cellCoord + 0.5) * PITCH;

    float foldX = uViewport.x * (1.0 - uT);

    float opacity = 1.0;
    float scale = 1.0;
    vec2 projPos = cellCenter;

    if (uPhase == 1) {
      // B: flat, only visible right of fold (revealed region)
      if (cellCenter.x < foldX) {
        opacity = 0.0;
      }
    } else if (cellCenter.x > foldX) {
      // A: dots right of fold curl around a cylinder
      float cylinderRadius = uViewport.x * 0.15;
      float cameraDistance = uViewport.x * 2.0;
      vec2 viewportCenter = uViewport * 0.5;
      float distPastFold = cellCenter.x - foldX;
      /*
      The curl wraps around a cylinder. Cross-section view:
                π (180°)
                 .  .  .
               .    |    .
          π/2 .     o     .       3π/2
         (90°) .    |    .       (270°)
                 .  .  .
               0 (0°)  ← fold tangent point, on the surface
    ────────────────┼──────────── surface (z = 0)
         ← left       foldX
      */
      float theta = distPastFold / cylinderRadius;
      // Projected x position on the surface
      float curledX = foldX - cylinderRadius * sin(theta);
      // Height above the surface (z = 0)
      float curledZ = cylinderRadius * (1.0 - cos(theta));

      // Perspective projection
      scale = cameraDistance / (cameraDistance - curledZ);
      projPos.x = viewportCenter.x + (curledX - viewportCenter.x) * scale;
      projPos.y = viewportCenter.y + (cellCenter.y - viewportCenter.y) * scale;

      // Fade out back of page (past 90°)
      opacity = smoothstep(PI, PI * 0.5, theta);
    }

    float scaledRadius = radius * scale;
    vec2 pos = projPos + aPosition * 0.5 * PITCH * scale;

    gl_Position = vec4(pos / uViewport * 2.0 - 1.0, 0.0, 1.0);

    vColor = color;
    vRadius = scaledRadius;
    vOpacity = opacity;
    vPixelOffset = aPosition * 0.5 * PITCH * scale;
  }
  `, `#version 300 es
  precision highp float;

  flat in vec4 vColor;
  flat in float vRadius;
  flat in float vOpacity;
  in vec2 vPixelOffset;

  out vec4 fragColor;

  void main() {
    float dist = length(vPixelOffset);
    float circle = smoothstep(vRadius + 0.5, vRadius - 0.5, dist);
    float opacity = circle * vOpacity;
    fragColor = vec4(vColor.rgb * opacity, opacity);
  }
  `);

  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uGridSize"), ctx.cols, ctx.rows);
  gl.uniform2f(gl.getUniformLocation(program, "uViewport"), ctx.canvasWidth, ctx.canvasHeight);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColors"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRange"), 1);
  gl.useProgram(null);

  const uT = gl.getUniformLocation(program, "uT")!;
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

      gl.uniform1f(uT, t);

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
