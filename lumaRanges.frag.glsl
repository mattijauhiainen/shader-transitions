#version 300 es
precision highp float;
uniform vec3 uLUMA;
uniform sampler2D uTEXTURE;
uniform vec2 uINPUT_SIZE;
uniform bool uIsFirstStep;
out vec4 fragColor;

void main() {
  vec2 texel = 1.0 / uINPUT_SIZE;
  vec2 uv = (floor(gl_FragCoord.xy) * 2.0 + 0.5) / uINPUT_SIZE;

  vec4 a = texture(uTEXTURE, uv);
  vec4 b = texture(uTEXTURE, uv + vec2(texel.x, 0.0));
  vec4 c = texture(uTEXTURE, uv + vec2(0.0, texel.y));
  vec4 d = texture(uTEXTURE, uv + vec2(texel.x, texel.y));

  float minL, maxL;
  if (uIsFirstStep) {
    float la = dot(a.rgb, uLUMA);
    float lb = dot(b.rgb, uLUMA);
    float lc = dot(c.rgb, uLUMA);
    float ld = dot(d.rgb, uLUMA);
    minL = min(min(la, lb), min(lc, ld));
    maxL = max(max(la, lb), max(lc, ld));
  } else {
    minL = min(min(a.r, b.r), min(c.r, d.r));
    maxL = max(max(a.g, b.g), max(c.g, d.g));
  }

  fragColor = vec4(minL, maxL, 0.0, 1.0);
}
