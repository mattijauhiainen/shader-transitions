#version 300 es
precision highp float;
uniform sampler2D uCELL_COLORS_A;
uniform sampler2D uLUMA_RANGE_A;
uniform sampler2D uCELL_COLORS_B;
uniform sampler2D uLUMA_RANGE_B;
uniform sampler2D uVISIT_MAP;
uniform vec2 uGRID_SIZE;

uniform float uCELL_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform float uTime;
uniform float uWindow;

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec2 cellCoord = floor(gl_FragCoord.xy / uPITCH);
  vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
  vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;
  float dist = length(gl_FragCoord.xy - cellCenter);

  float visitTime = texture(uVISIT_MAP, uv).r;
  float cellT = smoothstep(visitTime, visitTime + uWindow, uTime);

  vec4 colorA = texture(uCELL_COLORS_A, uv);
  vec2 rangeA = texture(uLUMA_RANGE_A, vec2(0.5)).rg;
  float normA = (dot(colorA.rgb, uLUMA) - rangeA.r) / (rangeA.g - rangeA.r);

  float scaleA = 1.0 - cellT;
  float radiusA = sqrt(normA) * uCELL_SIZE * 0.5 * scaleA;
  float alphaA = smoothstep(radiusA + 0.5, radiusA - 0.5, dist);

  vec4 colorB = texture(uCELL_COLORS_B, uv);
  vec2 rangeB = texture(uLUMA_RANGE_B, vec2(0.5)).rg;
  float normB = (dot(colorB.rgb, uLUMA) - rangeB.r) / (rangeB.g - rangeB.r);

  float scaleB = cellT;
  float radiusB = sqrt(normB) * uCELL_SIZE * 0.5 * scaleB;
  float alphaB = smoothstep(radiusB + 0.5, radiusB - 0.5, dist);

  vec4 bg = vec4(0.0, 0.0, 0.0, 1.0);
  fragColor = mix(mix(bg, vec4(colorA.rgb, 1.0), alphaA), vec4(colorB.rgb, 1.0), alphaB);
}
