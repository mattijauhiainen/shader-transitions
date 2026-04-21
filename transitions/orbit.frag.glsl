#version 300 es
precision highp float;

flat in vec4 vColor;
flat in float vRadius;
in vec2 vLocalPos;

uniform float uSphereShading;

out vec4 fragColor;

void main() {
    // Distance from center in screen pixels
    float dist = length(vLocalPos) * (vRadius + 0.5);

    // Antialiased circle edge (1px fade)
    float circle = smoothstep(vRadius + 0.5, vRadius - 0.5, dist);
    if (circle <= 0.0) discard;

    // Sphere shading: compute surface z from normalized distance
    float normDist = dist / max(vRadius, 0.001);
    float z = sqrt(max(0.0, 1.0 - min(normDist * normDist, 1.0)));

    // Lambertian lighting from camera direction (z = brightest at center)
    float lighting = 0.3 + 0.7 * z;
    float intensity = mix(1.0, lighting, uSphereShading);

    fragColor = vec4(vColor.rgb * intensity * circle, circle);
}
