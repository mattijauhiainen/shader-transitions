#version 300 es
precision highp float;

flat in vec4 vColor;
flat in float vRadius;
in vec2 vLocalPos;

uniform float uSphereShading;
uniform float uPlaneAlpha;

out vec4 fragColor;

void main() {
    float dist = length(vLocalPos) * (vRadius + 0.5);

    float circle = smoothstep(vRadius + 0.5, vRadius - 0.5, dist);
    if (circle <= 0.0) discard;

    float normDist = dist / max(vRadius, 0.001);
    float z = sqrt(max(0.0, 1.0 - min(normDist * normDist, 1.0)));

    float lighting = 0.3 + 0.7 * z;
    float intensity = mix(1.0, lighting, uSphereShading);

    float alpha = circle * uPlaneAlpha;
    fragColor = vec4(vColor.rgb * intensity * alpha, alpha);
}
