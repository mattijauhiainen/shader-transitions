#version 300 es
precision highp float;
uniform vec3 uLuma;
uniform sampler2D uTexture;
uniform vec2 uInputSize;
uniform bool uIsFirstStep;
out vec4 fragColor;

void main() {
  vec2 texel = 1.0 / uInputSize;
  vec2 uv = (floor(gl_FragCoord.xy) * 2.0 + 0.5) / uInputSize;

  vec4 a = texture(uTexture, uv);
  vec4 b = texture(uTexture, uv + vec2(texel.x, 0.0));
  vec4 c = texture(uTexture, uv + vec2(0.0, texel.y));
  vec4 d = texture(uTexture, uv + vec2(texel.x, texel.y));

  float minL, maxL;
  if (uIsFirstStep) {
    float la = dot(a.rgb, uLuma);
    float lb = dot(b.rgb, uLuma);
    float lc = dot(c.rgb, uLuma);
    float ld = dot(d.rgb, uLuma);
    minL = min(min(la, lb), min(lc, ld));
    maxL = max(max(la, lb), max(lc, ld));
  } else {
    minL = min(min(a.r, b.r), min(c.r, d.r));
    maxL = max(max(a.g, b.g), max(c.g, d.g));
  }

  fragColor = vec4(minL, maxL, 0.0, 1.0);
}
