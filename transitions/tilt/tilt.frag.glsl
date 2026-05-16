#version 300 es
precision highp float;

flat in vec4 vColor;
flat in float vRadius;
in vec2 vLocalPos;

out vec4 fragColor;

void main() {
    // vLocalPos is the quad's unit-disk coord in [-1, 1]². The vertex shader
    // scaled the geometry by (vRadius + 0.5), so `length(vLocalPos) * (vRadius
    // + 0.5)` gives the pixel-space distance from the disk's center at the
    // handover frames (where 1 world unit = 1 pixel by construction). The
    // smoothstep fades alpha across the outer pixel, matching the resting
    // halftone exactly.
    float dist = length(vLocalPos) * (vRadius + 0.5);
    float circle = smoothstep(vRadius + 0.5, vRadius - 0.5, dist);
    if (circle <= 0.0) discard;
    fragColor = vec4(vColor.rgb * circle, circle);
}
