#version 300 es
precision highp float;

// Per-cell average colors for current (A) and next (B) frames
uniform sampler2D uCELL_COLORS_A;
uniform sampler2D uLUMA_RANGE_A;   // .r = min luma, .g = max luma
uniform sampler2D uCELL_COLORS_B;
uniform sampler2D uLUMA_RANGE_B;

uniform vec2 uGRID_SIZE;         // grid dimensions (cols, rows)

uniform float uDOT_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform float uTime;                // transition progress 0..1
in vec2 vUV;
out vec4 fragColor;

void main() {
  // Grid helpers
  vec2 cellCoord = floor(gl_FragCoord.xy / uPITCH);
  vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
  vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;
  float dist = length(gl_FragCoord.xy - cellCenter);

  // Current frame (A)
  vec4 colorA = texture(uCELL_COLORS_A, uv);
  vec2 rangeA = texture(uLUMA_RANGE_A, vec2(0.5)).rg;
  float normA = (dot(colorA.rgb, uLUMA) - rangeA.r) / (rangeA.g - rangeA.r);

  // Next frame (B)
  vec4 colorB = texture(uCELL_COLORS_B, uv);
  vec2 rangeB = texture(uLUMA_RANGE_B, vec2(0.5)).rg;
  float normB = (dot(colorB.rgb, uLUMA) - rangeB.r) / (rangeB.g - rangeB.r);

  // Natural radii for each frame
  float rA = sqrt(normA) * uDOT_SIZE * 0.5;
  float rB = sqrt(normB) * uDOT_SIZE * 0.5;

  // Interpolate between radii with overshoot
  float t = uTime;
  float curve = 1.0 + 0.8 * sin(t * 3.14159);  // 1.0 -> 1.8 -> 1.0
  float radius = mix(rA, rB, t) * curve;

  vec3 blendedColor = mix(colorA.rgb, colorB.rgb, t);
  float alpha = smoothstep(radius + 0.5, radius - 0.5, dist);

  fragColor = mix(vec4(0.0, 0.0, 0.0, 1.0), vec4(blendedColor, 1.0), alpha);
}
