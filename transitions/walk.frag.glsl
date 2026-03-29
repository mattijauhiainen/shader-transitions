#version 300 es
precision highp float;
uniform sampler2D uCellColorsA;
uniform sampler2D uLumaRangeA;
uniform sampler2D uCellColorsB;
uniform sampler2D uLumaRangeB;
uniform sampler2D uVisitMap;
uniform vec2 uGridSize;

uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
uniform float uTime;
uniform float uWindow;

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
  vec2 cellCenter = (cellCoord + 0.5) * uPitch;
  vec2 uv = (cellCoord + 0.5) / uGridSize;
  float dist = length(gl_FragCoord.xy - cellCenter);

  float visitTime = texture(uVisitMap, uv).r;
  float cellT = smoothstep(visitTime, visitTime + uWindow, uTime);

  vec4 colorA = texture(uCellColorsA, uv);
  vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
  float normA = (dot(colorA.rgb, uLuma) - rangeA.r) / (rangeA.g - rangeA.r);

  float scaleA = 1.0 - cellT;
  float radiusA = sqrt(normA) * uCellSize * 0.5 * scaleA;
  float alphaA = smoothstep(radiusA + 0.5, radiusA - 0.5, dist);

  vec4 colorB = texture(uCellColorsB, uv);
  vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
  float normB = (dot(colorB.rgb, uLuma) - rangeB.r) / (rangeB.g - rangeB.r);

  float scaleB = cellT;
  float radiusB = sqrt(normB) * uCellSize * 0.5 * scaleB;
  float alphaB = smoothstep(radiusB + 0.5, radiusB - 0.5, dist);

  vec4 bg = vec4(0.0, 0.0, 0.0, 1.0);
  fragColor = mix(mix(bg, vec4(colorA.rgb, 1.0), alphaA), vec4(colorB.rgb, 1.0), alphaB);
}
