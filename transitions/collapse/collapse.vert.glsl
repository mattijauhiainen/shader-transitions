#version 300 es
precision highp float;

uniform sampler2D uCellColors;
uniform sampler2D uLumaRange;
uniform vec2 uOverscanCount;

uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
uniform vec2 uMargin;
uniform vec2 uGridSize;
uniform vec2 uViewport;
uniform float uTime;
uniform float uOpacity;
uniform sampler2D uVisitMap;

#define GRAVITY 3.0
#define PERSP_STRENGTH 0.3
in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadius;
flat out float vOpacity;
out vec2 vPixelOffset;

void main() {
  int col = gl_InstanceID % int(uOverscanCount.x);
  int row = gl_InstanceID / int(uOverscanCount.x);
  vec2 cellCoord = vec2(col, row);

  // Map overscan grid back to visible grid for color sampling, use clamp
  // at edges, so that the extra grid outside the viewport will repeat the
  // color of the cell from the edge.
  vec2 visibleCoord = cellCoord - uMargin;
  vec2 colorUV = clamp((visibleCoord + 0.5) / uGridSize, vec2(0.0), vec2(1.0));

  vec4 color = textureLod(uCellColors, colorUV, 0.0);
  vec2 range = textureLod(uLumaRange, vec2(0.5), 0.0).rg;
  float normalizedLuma = clamp(
    (dot(color.rgb, uLuma) - range.r) / (range.g - range.r),
    0.0, 1.0);
  float radius = sqrt(normalizedLuma) * uCellSize * 0.5;

  vec2 cellCenter = (visibleCoord + 0.5) * uPitch;

  // Sample visit map in overscan space
  vec2 visitUV = (cellCoord + 0.5) / uOverscanCount;
  float releaseTime = texture(uVisitMap, visitUV).r;
  float secondsSinceRelease = max(0.0, uTime - releaseTime);

  // Gravity: depth = 0.5 * g * t^2
  float depth = 0.5 * GRAVITY * secondsSinceRelease * secondsSinceRelease;
  float perspectiveScale = 1.0 / (1.0 + depth);

  // As the cell falls, drift it slightly towards the center of the screen
  vec2 screenCenter = uViewport * 0.5;
  vec2 perspectivePos = mix(cellCenter, screenCenter, (1.0 - perspectiveScale) * PERSP_STRENGTH);

  float r = radius * perspectiveScale;
  // Position the quad vertex around the dot center. The quad is scaled down
  // by perspectiveScale to match the shrunk dot, so the GPU rasterizes fewer
  // fragments for deeply fallen dots.
  vec2 pos = perspectivePos + aPosition * 0.5 * uPitch * perspectiveScale;

  gl_Position = vec4(pos / uViewport * 2.0 - 1.0, 0.0, 1.0);

  vColor = color;
  vRadius = r;
  vOpacity = uOpacity;
  vPixelOffset = aPosition * 0.5 * uPitch * perspectiveScale;
}
