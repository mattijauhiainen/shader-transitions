#version 300 es
precision highp float;

// Per-cell average colors for current (A) and next (B) frames
uniform sampler2D uCellColorsA;
uniform sampler2D uLumaRangeA;   // .r = min luma, .g = max luma
uniform sampler2D uCellColorsB;
uniform sampler2D uLumaRangeB;

uniform vec2 uGridSize;         // grid dimensions (cols, rows)

uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
uniform float uTime;                // transition progress 0..1
in vec2 vUV;
out vec4 fragColor;

void main() {
  // Grid helpers
  vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
  vec2 cellCenter = (cellCoord + 0.5) * uPitch;
  vec2 uv = (cellCoord + 0.5) / uGridSize;
  float dist = length(gl_FragCoord.xy - cellCenter);

  // Current frame (A)
  vec4 colorA = texture(uCellColorsA, uv);
  vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
  float normA = (dot(colorA.rgb, uLuma) - rangeA.r) / (rangeA.g - rangeA.r);

  // Next frame (B)
  vec4 colorB = texture(uCellColorsB, uv);
  vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
  float normB = (dot(colorB.rgb, uLuma) - rangeB.r) / (rangeB.g - rangeB.r);

  // Natural radii for each frame
  float rA = sqrt(normA) * uCellSize * 0.5;
  float rB = sqrt(normB) * uCellSize * 0.5;

  // Interpolate between radii with overshoot
  float t = uTime;
  float curve = 1.0 + 0.8 * sin(t * 3.14159);  // 1.0 -> 1.8 -> 1.0
  float radius = mix(rA, rB, t) * curve;

  vec3 blendedColor = mix(colorA.rgb, colorB.rgb, t);
  float alpha = smoothstep(radius + 0.5, radius - 0.5, dist);

  fragColor = mix(vec4(0.0, 0.0, 0.0, 1.0), vec4(blendedColor, 1.0), alpha);
}
