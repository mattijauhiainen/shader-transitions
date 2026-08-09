#version 300 es
precision highp float;

flat in vec4 vColor;
flat in vec3 vToCam;
flat in float vRadiusPx;
// Opacity of the image this dot belongs to. Used when image B fades in.
flat in float vFade;
in vec2 vCorner;

// Which way the camera is pointing. Each dot is really a flat square turned to
// face the camera, and these let us work out which way a ball drawn on that
// square would be facing, so it can be shaded like one.
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;

// Fades the 3D shading in and out at the start and end of the transition, so
// the first and last frames match the flat halftone the neighbouring slides
// leave behind.
uniform float uSphereShading;

out vec4 fragColor;

void main() {
    // Pretend the square is a ball: read its local (x, y) as a point on a ball
    // of radius 1 and work out the missing height. The edge is smoothed over
    // one screen pixel, exactly as the resting halftone smooths its dots, so
    // however big a dot is the handover to the next transition matches. Fading
    // the edge in the square's own coordinates instead would thicken up dots
    // smaller than a pixel and leave the dark cells looking fuzzy.
    float r = length(vCorner);
    float distPx = r * vRadiusPx;
    float alpha = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, distPx) * vFade;
    if (alpha <= 0.0) discard;

    float z = sqrt(max(0.0, 1.0 - r * r));
    vec3 N = normalize(vCorner.x * uCamRight + vCorner.y * uCamUp + z * uCamFwd);

    // A lamp that always shines from where the camera is: brightest where the
    // ball faces us, falling off toward its edges.
    float diffuse = max(0.0, dot(N, vToCam));
    float lit = 0.3 + 0.7 * diffuse;

    // 0 leaves the dot a flat disc of solid colour, the way the still frames
    // draw it; 1 gives it the full shading.
    float intensity = mix(1.0, lit, uSphereShading);

    // Colour is multiplied by the coverage here rather than by the blender —
    // anamorphosis.ts pairs this with blendFunc(ONE, ONE_MINUS_SRC_ALPHA).
    fragColor = vec4(vColor.rgb * intensity * alpha, alpha);
}
