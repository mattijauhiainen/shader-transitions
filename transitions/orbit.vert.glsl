#version 300 es
precision highp float;

// Init-tier uniforms, these are set once.

// A is outgoing image (front face of dot plane)
uniform sampler2D uCELL_COLORS_A;
// B is incoming image (back face).
uniform sampler2D uCELL_COLORS_B;
// 1x1 textures holding (minLuma, maxLuma) in .rg — normalizes per-frame contrast.
uniform sampler2D uLUMA_RANGE_A;
uniform sampler2D uLUMA_RANGE_B;
uniform vec2 uGRID_SIZE;
// Dot diameter at full luma, in world units (less than uPITCH).
uniform float uCELL_SIZE;
// World-space spacing between cell centers.
uniform float uPITCH;
// Weights to calculate luma for a given RGB color.
uniform vec3 uLUMA;
// Canvas size in pixels; billboard math runs in screen space.
uniform vec2 uVIEWPORT;
// Pinhole focal length in pixels (the initial distance from the image plane)
uniform float uFOCAL_LEN;

// Per-frame uniforms (camelCase): updated on every draw.

// Camera origin in world space.
uniform vec3 uCamPos;
// Orthonormal camera basis in world space.
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;

// Unit-disk billboard vertex from triangle fan (center + ring at radius 1).
in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadius;
out vec2 vLocalPos;

void main() {
    int col = gl_InstanceID % int(uGRID_SIZE.x);
    int row = gl_InstanceID / int(uGRID_SIZE.x);
    vec2 cellCoord = vec2(col, row);

    // World position relative to grid center
    vec2 gridCenter = uGRID_SIZE * uPITCH * 0.5;
    vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
    vec3 worldPos = vec3(cellCenter.x - gridCenter.x, cellCenter.y - gridCenter.y, 0.0);

    // Project dot onto camera basis
    vec3 toPoint = worldPos - uCamPos;
    float depth = dot(toPoint, uCamForward);

    // Clip dots behind camera
    if (depth < 1.0) {
        gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        vColor = vec4(0.0);
        vRadius = 0.0;
        vLocalPos = vec2(0.0);
        return;
    }

    // A/B face: front when camera is on the -Z side of the dot plane
    bool isFront = uCamPos.z <= 0.0;

    // Mirror B-frame x-coordinates to undo viewing-from-behind mirroring
    vec2 sampleCoord = cellCoord;
    if (!isFront) {
        sampleCoord.x = uGRID_SIZE.x - 1.0 - cellCoord.x;
    }
    vec2 uv = (sampleCoord + 0.5) / uGRID_SIZE;

    vec4 color;
    vec2 range;
    if (isFront) {
        color = textureLod(uCELL_COLORS_A, uv, 0.0);
        range = textureLod(uLUMA_RANGE_A, vec2(0.5), 0.0).rg;
    } else {
        color = textureLod(uCELL_COLORS_B, uv, 0.0);
        range = textureLod(uLUMA_RANGE_B, vec2(0.5), 0.0).rg;
    }

    float normLuma = clamp(
            (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
            0.0, 1.0);
    float radius = sqrt(normLuma) * uCELL_SIZE * 0.5;

    // Perspective scaling
    float perspScale = uFOCAL_LEN / depth;
    float screenRadius = radius * perspScale;
    float outerScreenRadius = screenRadius + 0.5;

    // Camera-space offsets (projected to screen pixels)
    float rightOff = dot(toPoint, uCamRight) * perspScale;
    float upOff = dot(toPoint, uCamUp) * perspScale;

    // Billboard offset in screen pixels
    vec2 billboard = aPosition * outerScreenRadius;

    // Final screen position
    vec2 screen = vec2(rightOff, upOff) + gridCenter + billboard;

    // Calculate the stacking order
    float ndcZ = (depth - 1.0) / (uFOCAL_LEN * 1.5 - 1.0) * 2.0 - 1.0;
    gl_Position = vec4(screen / uVIEWPORT * 2.0 - 1.0, ndcZ, 1.0);

    vColor = color;
    vRadius = screenRadius;
    vLocalPos = aPosition;
}
