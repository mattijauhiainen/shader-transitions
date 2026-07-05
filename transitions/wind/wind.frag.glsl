#version 300 es
precision highp float;

flat in vec4 vColor;
flat in float vRadius;
flat in float vShade;
flat in float vOpacity;
in vec2 vLocalPos;

out vec4 fragColor;

void main() {
    float dist = length(vLocalPos) * (vRadius + 0.5);

    float circle = smoothstep(vRadius + 0.5, vRadius - 0.5, dist);
    if (circle <= 0.0) discard;

    // Spherical shading for lifted grains (vShade == 1); flat for the B surface.
    float normDist = dist / max(vRadius, 0.001);
    float z = sqrt(max(0.0, 1.0 - min(normDist * normDist, 1.0)));
    float lighting = 0.3 + 0.7 * z;
    float intensity = mix(1.0, lighting, vShade);

    float alpha = circle * vOpacity;
    if (alpha <= 0.0) discard;
    fragColor = vec4(vColor.rgb * intensity * alpha, alpha);
}
