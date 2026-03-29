#version 300 es
precision highp float;

uniform sampler2D uCellColors;
uniform sampler2D uLumaRange;
uniform vec2 uGridSize;

uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
uniform vec2 uViewport;
uniform float uTime;
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
    (dot(color.rgb, uLuma) - range.r) / (range.g - range.r),
    0.0, 1.0);
  float radius = sqrt(normalizedLuma) * uCellSize * 0.5;

  vec2 cellCenter = (cellCoord + 0.5) * uPitch;

  float foldX = uViewport.x * (1.0 - uTime);

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
  vec2 pos = projPos + aPosition * 0.5 * uPitch * scale;

  gl_Position = vec4(pos / uViewport * 2.0 - 1.0, 0.0, 1.0);

  vColor = color;
  vRadius = scaledRadius;
  vOpacity = opacity;
  vPixelOffset = aPosition * 0.5 * uPitch * scale;
}
