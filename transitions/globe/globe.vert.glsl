#version 300 es
precision highp float;

#define PI 3.14159265359
#define TAU 6.28318530718

// Init-tier uniforms, set once.
uniform sampler2D uCELL_COLORS_A;
uniform sampler2D uCELL_COLORS_B;
uniform sampler2D uLUMA_RANGE_A;
uniform sampler2D uLUMA_RANGE_B;
uniform vec2 uGRID_SIZE;
uniform float uDOT_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform float uFOCAL_PX;
// Radius of the globe in world units.
uniform float uRADIUS;
// Time range during which dots may flip from A to B. Outside this range the
// shader forces A (before) or B (after).
uniform vec2 uFLIP_WINDOW;

// Per-frame uniforms.
uniform mat4 uMVP;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
// 0 = flat grid (resting halftone), 1 = full sphere.
uniform float uCurl;
// 0 = sphere shading off (handoff match), 1 = full sphere lighting.
uniform float uSphereShading;
// Normalized timeline position in [0, 1]. Used together with each dot's
// hashed flipT to choose A vs B during the flip window.
uniform float uPhase;

in vec2 aPosition;

flat out vec4 vColor;
flat out vec3 vToCam;
flat out float vRadiusPx;
out vec2 vCorner;

// 2D hash → [0, 1). Cheap, stable per (col, row).
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void main() {
    int col = gl_InstanceID % int(uGRID_SIZE.x);
    int row = gl_InstanceID / int(uGRID_SIZE.x);
    vec2 cellCoord = vec2(col, row);

    // Flat target: same grid placement every other transition uses. Grid is
    // centered on the world origin so the sphere (also at origin) shares the
    // same center, keeping the lerp visually anchored.
    vec2 gridCenter = uGRID_SIZE * uPITCH * 0.5;
    vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
    vec3 flatPos = vec3(cellCenter.x - gridCenter.x, cellCenter.y - gridCenter.y, 0.0);

    // Equirectangular mapping: column → longitude, row → latitude. Longitude
    // is centered at 0 (+Z, facing the camera) so the middle column of the
    // flat image lands on the front of the globe and both edges curl
    // backwards to meet at the back — a poster rolling into a tube. Without
    // the -0.5 shift, both flat edges would map to the front and cross
    // through each other during curl.
    float lon = ((float(col) + 0.5) / uGRID_SIZE.x - 0.5) * TAU;
    float lat = ((float(row) + 0.5) / uGRID_SIZE.y - 0.5) * PI;
    float cosLat = cos(lat);

    vec3 spherePos = uRADIUS * vec3(
                cosLat * sin(lon),
                sin(lat),
                cosLat * cos(lon)
            );

    vec3 worldCenter = mix(flatPos, spherePos, uCurl);

    // A/B selection. Each dot picks its own random flip time inside the flip
    // window; outside the window we force the side the timeline declares.
    float flipT = mix(uFLIP_WINDOW.x, uFLIP_WINDOW.y, hash(cellCoord + vec2(17.3, 31.7)));
    bool useB;
    if (uPhase <= uFLIP_WINDOW.x) useB = false;
    else if (uPhase >= uFLIP_WINDOW.y) useB = true;
    else useB = uPhase > flipT;

    vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;

    vec4 color;
    vec2 range;
    if (useB) {
        color = textureLod(uCELL_COLORS_B, uv, 0.0);
        range = textureLod(uLUMA_RANGE_B, vec2(0.5), 0.0).rg;
    } else {
        color = textureLod(uCELL_COLORS_A, uv, 0.0);
        range = textureLod(uLUMA_RANGE_A, vec2(0.5), 0.0).rg;
    }

    float normLuma = clamp(
            (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
            0.0, 1.0
        );
    float radius = sqrt(normLuma) * uDOT_SIZE * 0.5;

    // Scale the impostor quad by ~half a screen pixel of headroom so the
    // fragment shader's smoothstep can fade cleanly to zero.
    vec4 centerClip = uMVP * vec4(worldCenter, 1.0);
    float pixelRadius = radius * uFOCAL_PX / centerClip.w;
    float scale = 1.0 + 0.5 / max(pixelRadius, 4.0);

    // Camera-facing billboard.
    vec3 worldPos = worldCenter
            + (aPosition.x * uCamRight + aPosition.y * uCamUp) * (radius * scale);
    gl_Position = uMVP * vec4(worldPos, 1.0);

    vColor = color;
    vCorner = aPosition * scale;
    vRadiusPx = pixelRadius;
    vToCam = normalize(uCamPos - worldCenter);
}
