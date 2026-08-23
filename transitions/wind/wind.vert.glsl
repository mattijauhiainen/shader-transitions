#version 300 es
precision highp float;

// Init-tier uniforms (set once).
uniform sampler2D uCELL_COLORS_A;
uniform sampler2D uLUMA_RANGE_A;
uniform sampler2D uCELL_COLORS_B;
uniform sampler2D uLUMA_RANGE_B;
uniform vec2 uGRID_SIZE;
uniform vec2 uVIEWPORT;
uniform float uDOT_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform float uFOCAL_LEN;
// Per-frame uniforms.
uniform float uTime; // 0..1 progress
uniform vec2 uWindDir; // unit vector, random per run
uniform int uPhase; // 0 = A (blowing dots), 1 = B (underlying reveal)

in vec2 aPosition; // unit quad corners in [-1, 1]

flat out vec4 vColor;
flat out float vRadius; // screen-space radius in pixels
flat out float vShade; // 1 = spherical grain shading, 0 = flat
flat out float vOpacity;
out vec2 vLocalPos; // == aPosition, unit-disk coord for the AA disc

// --- value noise (inlined from hyperdrive.vert.glsl) ---
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float halftoneRadius(vec4 color, vec2 range) {
    float normLuma = clamp(
            (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
            0.0, 1.0);
    return sqrt(normLuma) * uDOT_SIZE * 0.5;
}

// Perspective depth range for the NDC mapping, derived from focal length so the
// resting plane (camDepth == uFOCAL_LEN) lands safely inside (-1, 1).
const float NEAR_FRAC = 0.1;
const float FAR_FRAC = 1.2;

// Project a world-space dot (centred grid coords + a lift toward the camera)
// into screen space, filling gl_Position and the shared varyings.
void emit(vec2 worldXY, float liftZ, float r, vec4 color) {
    float camDepth = uFOCAL_LEN - liftZ;
    float perspScale = uFOCAL_LEN / camDepth;
    float screenRadius = r * perspScale;

    vec2 projected = worldXY * perspScale + uVIEWPORT * 0.5;
    vec2 screen = projected + aPosition * (screenRadius + 0.5);

    float nearD = uFOCAL_LEN * NEAR_FRAC;
    float farD = uFOCAL_LEN * FAR_FRAC;
    float ndcZ = (camDepth - nearD) / (farD - nearD) * 2.0 - 1.0;

    gl_Position = vec4(screen / uVIEWPORT * 2.0 - 1.0, ndcZ, 1.0);
    vColor = color;
    vRadius = screenRadius;
    vLocalPos = aPosition;
}

void cull() {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vColor = vec4(0.0);
    vRadius = 0.0;
    vLocalPos = vec2(0.0);
    vShade = 0.0;
    vOpacity = 0.0;
}

void main() {
    int col = gl_InstanceID % int(uGRID_SIZE.x);
    int row = gl_InstanceID / int(uGRID_SIZE.x);
    vec2 cellCoord = vec2(col, row);
    vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;

    // Center on the canvas (same reference emit() projects around) so a resting dot
    // lands at (cellCoord+0.5)*uPITCH, matching the pixel-space transitions (wipe, …).
    vec2 gridCenter = uVIEWPORT * 0.5;
    vec2 worldXY = (cellCoord + 0.5) * uPITCH - gridCenter;

    // Release timing
    const float NOISE_SCALE = 0.08; // low → neighbouring cells share a gust (patchiness)
    const float DRIFT = 1.5; // how fast the gust field scrolls downwind over time
    // Patchy [0, 1] release schedule: higher → this cell is picked up later.
    // Blended with dirBias below to form the actual release time.
    float gust = vnoise(cellCoord * NOISE_SCALE + uWindDir * uTime * DRIFT);
    // Take offset from center, and project that to wind direction axis. Use
    // this when calculating tRelease to lift cells that are upwind first
    float dirBias = dot(uv - 0.5, uWindDir) + 0.5;
    const float DIR_BIAS = 0.35; // 0 = pure patches, 1 = clean downwind sweep
    float tRelease = clamp(mix(gust, dirBias, DIR_BIAS), 0.0, 1.0);

    // Squeeze so every cell finishes (localT == 1) by uTime == 1 → last frame is
    // the plain next halftone.
    const float RELEASE_WINDOW = 0.28; // t-span a cell takes to go from resting to fully gone
    tRelease *= (1.0 - RELEASE_WINDOW);
    float localT = smoothstep(tRelease, tRelease + RELEASE_WINDOW, uTime);

    if (uPhase == 1) {
        // First pass: Draw B frame so that it appears under A.
        vec4 colorB = textureLod(uCELL_COLORS_B, uv, 0.0);
        vec2 rangeB = textureLod(uLUMA_RANGE_B, vec2(0.5), 0.0).rg;
        float rBTrue = halftoneRadius(colorB, rangeB);

        vec4 colorA = textureLod(uCELL_COLORS_A, uv, 0.0);
        vec2 rangeA = textureLod(uLUMA_RANGE_A, vec2(0.5), 0.0).rg;
        float rA = halftoneRadius(colorA, rangeA);

        // If the A cell has not yet lifted off, clamp B-cells size to A-cell's,
        // so that it doesn't bleed in around its edges.
        const float AA_EPSILON = 0.5; // px the hidden B dot shrinks below A so its AA edge can't poke out
        bool departed = localT >= 0.01;
        float radius = departed ? rBTrue : max(0.0, min(rBTrue, rA) - AA_EPSILON);

        vShade = 0.0;
        vOpacity = 1.0;
        emit(worldXY, 0.0, radius, colorB);
        return;
    }

    // Second pass: Draw the A frame on top of B.
    vec4 colorA = textureLod(uCELL_COLORS_A, uv, 0.0);
    vec2 rangeA = textureLod(uLUMA_RANGE_A, vec2(0.5), 0.0).rg;
    float rA = halftoneRadius(colorA, rangeA);

    const float FADE_START = 0.35; // localT at which a grain begins to dissolve
    float opacity = 1.0 - smoothstep(FADE_START, 1.0, localT);
    if (localT >= 1.0 || opacity <= 0.0) {
        cull();
        return;
    }

    // Per-dot randomness for organic spread.
    // Vary height with h0
    float h0 = hash(cellCoord + 3.0);
    // Vary sway (drift from true wind direction) with h1
    float h1 = hash(cellCoord + 17.0);

    float maxDim = max(uVIEWPORT.x, uVIEWPORT.y);
    // Wind direction rotated 90°: the axis grains sway along, across the wind.
    vec2 crossWind = vec2(-uWindDir.y, uWindDir.x);

    // Lift toward camera accelerates (localT^2); drift + sway grow linearly.
    const float LIFT_FRAC = 0.6; // max lift toward camera, as fraction of focal length
    const float HEIGHT_VAR = 0.6; // per-dot spread of lift height
    float rise = localT * localT;
    float liftZ = uFOCAL_LEN * LIFT_FRAC * (1.0 - HEIGHT_VAR + HEIGHT_VAR * h0) * rise;

    const float DRIFT_FRAC = 0.22; // downwind travel, as fraction of the larger viewport dim
    const float SWAY_FRAC = 0.05; // perpendicular turbulence, same units as drift
    vec2 drifted = worldXY
            + uWindDir * (maxDim * DRIFT_FRAC) * localT
            + crossWind * (maxDim * SWAY_FRAC) * (h1 - 0.5) * localT;

    // Ramp spherical shading in with the lift so a resting grain reads flat
    // (matching the halftone the previous transition hands over), rounding out
    // only as it rises. Same handover fix as orbit/freefall/globe.
    vShade = rise;
    vOpacity = opacity;
    emit(drifted, liftZ, rA, colorA);
}
