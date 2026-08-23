#version 300 es
precision highp float;

// Init-tier uniforms (set once).
uniform sampler2D uCELL_COLORS;
uniform sampler2D uLUMA_RANGE;
uniform vec2 uGRID_SIZE;
uniform float uDOT_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform vec2 uVIEWPORT;
uniform float uFOCAL_LEN;
uniform float uNEAR_CLIP;
// Per-frame uniforms.
// Max visible depth for depth-buffer mapping.
uniform float uFar;
// Camera Z position (camera is at (0, 0, uCamZ), looking in +Z).
uniform float uCamZ;
// Z position of the plane currently being drawn.
uniform float uPlaneZ;
// 0 = normal image colors, 1 = rainbow unicorn magic.
uniform float uRainbowMix;
// Camera roll: (cos, sin) precomputed on CPU.
uniform vec2 uCamRollCS;
// Frustum culling: only the visible sub-rectangle of the grid is drawn.
// The CPU computes which columns/rows fall inside the (roll-adjusted) viewport
// at this plane's depth, then draws only those instances. gl_InstanceID indexes
// into this sub-rectangle; these uniforms map it back to grid coordinates.
uniform vec2 uVisibleOffset; // (startCol, startRow) of the visible region
uniform vec2 uVisibleSize;   // (cols, rows) in the visible region

vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Smooth value noise: bicubic interpolation of hashed lattice points
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Unit-disk billboard vertex from triangle fan.
in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadius;
out vec2 vLocalPos;

void main() {
    // Map instance ID back to grid coordinates via the visible sub-rectangle.
    int visW = int(uVisibleSize.x);
    int col = gl_InstanceID % visW + int(uVisibleOffset.x);
    int row = gl_InstanceID / visW + int(uVisibleOffset.y);
    vec2 cellCoord = vec2(col, row);

    // World position relative to grid center (on the XY plane at Z = uPlaneZ).
    vec2 gridCenter = uGRID_SIZE * uPITCH * 0.5;
    vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
    float worldX = cellCenter.x - gridCenter.x;
    float worldY = cellCenter.y - gridCenter.y;

    // Depth from camera to this plane
    float depth = uPlaneZ - uCamZ;

    // Clip plane if behind camera or beyond far plane
    if (depth < uNEAR_CLIP || depth > uFar) {
        gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        vColor = vec4(0.0);
        vRadius = 0.0;
        vLocalPos = vec2(0.0);
        return;
    }

    // Sample cell color and luma range
    vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;
    vec4 color = textureLod(uCELL_COLORS, uv, 0.0);
    vec2 range = textureLod(uLUMA_RANGE, vec2(0.5), 0.0).rg;

    // Rainbow unicorn magic: smooth flowing candy colors
    if (uRainbowMix > 0.0) {
        vec2 p = cellCoord * 0.15;
        float drift = uCamZ * 0.004;
        // Layer smooth noise at two scales for organic flow
        float n1 = vnoise(p + drift);
        float n2 = vnoise(p * 2.3 + vec2(drift * 1.7, 50.0));
        float hue = fract(n1 * 0.6 + n2 * 0.4 + drift * 0.3 + 0.8);
        float sat = 0.35 + 0.2 * n2;
        vec3 rainbow = hsv2rgb(vec3(hue, sat, 1.0));
        color.rgb = mix(color.rgb, rainbow, uRainbowMix);
    }

    float normLuma = clamp(
            (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
            0.0, 1.0);
    float radius = sqrt(normLuma) * uDOT_SIZE * 0.5;

    // Perspective scaling (camera looks straight down +Z)
    float perspScale = uFOCAL_LEN / depth;
    float screenRadius = radius * perspScale;
    float outerScreenRadius = screenRadius + 0.5;

    // Screen-space position: camera at origin in XY, perspective-project the dot
    float rightOff = worldX * perspScale;
    float upOff = worldY * perspScale;

    // Apply camera roll rotation around screen center
    float cosR = uCamRollCS.x;
    float sinR = uCamRollCS.y;
    float rotX = rightOff * cosR - upOff * sinR;
    float rotY = rightOff * sinR + upOff * cosR;

    // Billboard offset in screen pixels
    vec2 billboard = aPosition * outerScreenRadius;

    // Final screen position (gridCenter re-centers the image on screen)
    vec2 screen = vec2(rotX, rotY) + gridCenter + billboard;

    // Depth-buffer value: map [1, uFar] to NDC [-1, 1]
    float ndcZ = (depth - uNEAR_CLIP) / (uFar - uNEAR_CLIP) * 2.0 - 1.0;
    gl_Position = vec4(screen / uVIEWPORT * 2.0 - 1.0, ndcZ, 1.0);

    vColor = color;
    vRadius = screenRadius;
    vLocalPos = aPosition;
}
