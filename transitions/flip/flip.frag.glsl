#version 300 es
precision highp float;

flat in vec4 vColor;
flat in float vRadius;
in float vEdge;

out vec4 fragColor;

void main() {
    // Same antialiasing as the quad version: 1px fade centered on the radius.
    // vEdge goes 0→1 across (radius + 0.5) pixels, so convert to pixel distance.
    float dist = vEdge * (vRadius + 0.5);
    float circle = smoothstep(vRadius + 0.5, vRadius - 0.5, dist);
    fragColor = vec4(vColor.rgb * circle, circle);
}
