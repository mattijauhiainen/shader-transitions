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
    (dot(color.rgb, uLuma) - range.r) / (range.g - range.r),
    0.0, 1.0);
  float radius = sqrt(normalizedLuma) * uCellSize * 0.5;

  vec2 cellCenter = (cellCoord + 0.5) * uPitch;
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
  vec2 pos = cellCenter + offset + aPosition * 0.5 * uPitch;

  gl_Position = vec4(pos / uViewport * 2.0 - 1.0, 0.0, 1.0);

  vColor = color;
  vRadius = r;
  vOpacity = opacity;
  vPixelOffset = aPosition * 0.5 * uPitch;
}
