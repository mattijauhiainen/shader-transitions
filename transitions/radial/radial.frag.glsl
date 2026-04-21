#version 300 es
precision highp float;
uniform sampler2D uCELL_COLORS_A;
uniform sampler2D uLUMA_RANGE_A;
uniform sampler2D uCELL_COLORS_B;
uniform sampler2D uLUMA_RANGE_B;
uniform vec2 uGRID_SIZE;

uniform float uCELL_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform float uTime;
uniform vec2 uOrigin;

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec2 cellCoord = floor(gl_FragCoord.xy / uPITCH);
  vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
  vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;
  float dist = length(gl_FragCoord.xy - cellCenter);

  float distFromOrigin = length(gl_FragCoord.xy - uOrigin);
  vec2 viewport = uGRID_SIZE * uPITCH;
  float diameter = max(
    max(length(uOrigin), length(uOrigin - vec2(viewport.x, 0.0))),
    max(length(uOrigin - vec2(0.0, viewport.y)), length(uOrigin - viewport))
  );

  vec4 colorA = texture(uCELL_COLORS_A, uv);
  vec2 rangeA = texture(uLUMA_RANGE_A, vec2(0.5)).rg;
  float normA = (dot(colorA.rgb, uLUMA) - rangeA.r) / (rangeA.g - rangeA.r);
  float rA = sqrt(normA) * uCELL_SIZE * 0.5 * (1.0 - uTime);
  float alphaA = smoothstep(rA + 0.5, rA - 0.5, dist);

  vec4 colorB = texture(uCELL_COLORS_B, uv);
  vec2 rangeB = texture(uLUMA_RANGE_B, vec2(0.5)).rg;
  float normB = (dot(colorB.rgb, uLUMA) - rangeB.r) / (rangeB.g - rangeB.r);
  float rB = sqrt(normB) * uCELL_SIZE * 0.5 * uTime;
  float alphaB = smoothstep(rB + 0.5, rB - 0.5, dist);

  if (distFromOrigin < diameter * uTime) {
    fragColor = mix(mix(vec4(0, 0, 0, 1), colorA, alphaA), colorB, alphaB);
  } else {
     fragColor = mix(vec4(0,0,0,1), colorA, alphaA);
  }
}
