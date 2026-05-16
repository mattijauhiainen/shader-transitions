#version 300 es
precision highp float;

flat in vec4 vColor;
flat in vec3 vToCam;
flat in float vRadiusPx;
in vec2 vCorner;

// Camera basis in world space — used to reconstruct an impostor sphere normal
// from the billboard's local (x, y) coordinates.
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;

// Fades the 3D shading in/out at the start/end of the transition so the first
// and last frames match the flat resting halftone the neighbors leave behind.
uniform float uSphereShading;

out vec4 fragColor;

void main() {
    // Sphere impostor: treat the quad's local (x, y) as a position on the unit
    // sphere; recover z = sqrt(1 - r²). Edge AA is done in screen-pixel space
    // with the same smoothstep(rPx + 0.5, rPx - 0.5, dist) the resting halftone
    // uses, so the handoff to the next transition is pixel-identical regardless
    // of dot size — fwidth-based AA in normalized impostor coords fattens up
    // for sub-pixel dots and makes the small/dark cells look fuzzy.
    float r = length(vCorner);
    float distPx = r * vRadiusPx;
    float alpha = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, distPx);
    if (alpha <= 0.0) discard;

    float z = sqrt(max(0.0, 1.0 - r * r));
    vec3 N = normalize(vCorner.x * uCamRight + vCorner.y * uCamUp + z * uCamFwd);

    // Camera-tracking headlight: brightest where the surface faces the viewer.
    float diffuse = max(0.0, dot(N, vToCam));
    float lit = 0.3 + 0.7 * diffuse;

    // uSphereShading = 0 -> flat full-color disc (handoff); 1 -> lit sphere.
    float intensity = mix(1.0, lit, uSphereShading);

    // Premultiplied alpha — orbit.ts uses blendFunc(ONE, ONE_MINUS_SRC_ALPHA).
    fragColor = vec4(vColor.rgb * intensity * alpha, alpha);
}
