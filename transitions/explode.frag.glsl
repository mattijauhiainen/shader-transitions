#version 300 es
precision highp float;

flat in vec4 vColor;
flat in float vRadius;
flat in float vOpacity;
in vec2 vPixelOffset;

out vec4 fragColor;

void main() {
  float dist = length(vPixelOffset);
  float circle = smoothstep(vRadius + 0.5, vRadius - 0.5, dist);
  float opacity = circle * vOpacity;
  fragColor = vec4(vColor.rgb * opacity, opacity);
}
