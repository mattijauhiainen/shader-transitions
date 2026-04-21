#version 300 es
precision highp float;

uniform sampler2D uCELL_COLORS;
uniform sampler2D uLUMA_RANGE;
uniform vec2 uGRID_SIZE;

uniform float uCELL_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform vec2 uVIEWPORT;
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
  int col = gl_InstanceID % int(uGRID_SIZE.x);
  int row = gl_InstanceID / int(uGRID_SIZE.x);
  vec2 cellCoord = vec2(col, row);
  vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;

  vec4 color = textureLod(uCELL_COLORS, uv, 0.0);
  vec2 range = textureLod(uLUMA_RANGE, vec2(0.5), 0.0).rg;
  float normalizedLuma = clamp(
    (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
    0.0, 1.0);
  float radius = sqrt(normalizedLuma) * uCELL_SIZE * 0.5;

  vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
  vec2 offset = vec2(0.0);
  float scale = 1.0;
  float opacity = 1.0;

  vec2 viewportCenter = uVIEWPORT * 0.5;
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
    float maxDist = max(uVIEWPORT.x, uVIEWPORT.y) * 1.5;
    offset = normalize(direction + 0.001) * speed * localT * maxDist;
  } else {
    // B: full scale, fade in as A starts moving
    scale = 1.0;
    opacity = localT;
  }

  float r = radius * scale;
  vec2 pos = cellCenter + offset + aPosition * 0.5 * uPITCH;

  gl_Position = vec4(pos / uVIEWPORT * 2.0 - 1.0, 0.0, 1.0);

  vColor = color;
  vRadius = r;
  vOpacity = opacity;
  vPixelOffset = aPosition * 0.5 * uPITCH;
}
