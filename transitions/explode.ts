import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";

export function createExplodeTransition(ctx: RendererContext): Transition {
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
  uniform float uTime;
  uniform int uPhase; // 0 = A (exploding out), 1 = B (growing in)

  in vec2 aPosition;

  flat out vec4 vColor;
  flat out float vRadius;
  flat out float vOpacity;
  out vec2 vPixelOffset;

  // For generating "random" numbers for a position
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

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
    vec2 offset = vec2(0.0);
    float scale = 1.0;
    float opacity = 1.0;

    vec2 viewportCenter = uViewport * 0.5;
    float normalizedDistFromCenter = length(cellCenter - viewportCenter) / length(viewportCenter);
    float staggerSpread = 0.8;
    float maxDelay = 0.2;
    float staggerDelay = normalizedDistFromCenter * staggerSpread * maxDelay;
    float localT = clamp((uTime - staggerDelay) / (1.0 - staggerDelay), 0.0, 1.0);

    if (uPhase == 0) {
      // A: explode outward
      scale = 1.0 - localT;
      opacity = 1.0 - localT;
      vec2 direction = cellCenter - viewportCenter;
      float randAngle = (hash(cellCoord) - 0.5) * 2.5;
      float cosA = cos(randAngle), sinA = sin(randAngle);
      direction = vec2(direction.x * cosA - direction.y * sinA, direction.x * sinA + direction.y * cosA);
      float speed = 0.2 + hash(cellCoord + 100.0) * 0.8;
      float maxDist = max(uViewport.x, uViewport.y) * 1.5;
      offset = normalize(direction + 0.001) * speed * localT * maxDist;
    } else {
      // B: full scale, fade in as A starts moving
      scale = 1.0;
      opacity = localT;
    }

    float r = radius * scale;
    vec2 pos = cellCenter + offset + aPosition * 0.5 * PITCH;

    gl_Position = vec4(pos / uViewport * 2.0 - 1.0, 0.0, 1.0);

    vColor = color;
    vRadius = r;
    vOpacity = opacity;
    vPixelOffset = aPosition * 0.5 * PITCH;
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

  const uTime = gl.getUniformLocation(program, "uTime")!;
  const uPhase = gl.getUniformLocation(program, "uPhase")!;

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
      gl.disable(gl.BLEND);
    },
  };
}
