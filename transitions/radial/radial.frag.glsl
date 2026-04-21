#version 300 es
precision highp float;
uniform sampler2D uCellColorsA;
uniform sampler2D uLumaRangeA;
uniform sampler2D uCellColorsB;
uniform sampler2D uLumaRangeB;
uniform vec2 uGridSize;

uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
uniform float uTime;
uniform vec2 uOrigin;

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
  vec2 cellCenter = (cellCoord + 0.5) * uPitch;
  vec2 uv = (cellCoord + 0.5) / uGridSize;
  float dist = length(gl_FragCoord.xy - cellCenter);

  float distFromOrigin = length(gl_FragCoord.xy - uOrigin);
  vec2 viewport = uGridSize * uPitch;
  float diameter = max(
    max(length(uOrigin), length(uOrigin - vec2(viewport.x, 0.0))),
    max(length(uOrigin - vec2(0.0, viewport.y)), length(uOrigin - viewport))
  );

  vec4 colorA = texture(uCellColorsA, uv);
  vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
  float normA = (dot(colorA.rgb, uLuma) - rangeA.r) / (rangeA.g - rangeA.r);
  float rA = sqrt(normA) * uCellSize * 0.5 * (1.0 - uTime);
  float alphaA = smoothstep(rA + 0.5, rA - 0.5, dist);

  vec4 colorB = texture(uCellColorsB, uv);
  vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
  float normB = (dot(colorB.rgb, uLuma) - rangeB.r) / (rangeB.g - rangeB.r);
  float rB = sqrt(normB) * uCellSize * 0.5 * uTime;
  float alphaB = smoothstep(rB + 0.5, rB - 0.5, dist);

  if (distFromOrigin < diameter * uTime) {
    fragColor = mix(mix(vec4(0, 0, 0, 1), colorA, alphaA), colorB, alphaB);
  } else {
     fragColor = mix(vec4(0,0,0,1), colorA, alphaA);
  }
}
