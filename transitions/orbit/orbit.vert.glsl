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
uniform float uDOT_SIZE;
// World-space spacing between cell centers.
uniform float uPITCH;
// Weights to calculate luma for a given RGB color.
uniform vec3 uLUMA;
// Focal length in pixels — used to convert per-dot world radius into the
// screen-space pixel radius the fragment shader needs for a 1-pixel AA
// feather. fovY in orbit.ts is chosen so D pixels of focal length give a 1:1
// world-unit-to-pixel mapping at z = 0; at depth z_eye this drops to D / -z_eye.
uniform float uFOCAL_PX;

// Per-frame uniforms (camelCase): updated on every draw.

// MVP matrix for transforming the scene.
uniform mat4 uMVP;
// Camera origin in world space.
uniform vec3 uCamPos;
// Camera basis in world space — used to orient the billboard quad toward the
// viewer and to reconstruct the impostor sphere normal in the fragment shader.
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;

// Quad corner in [-1, 1]^2. Doubles as the impostor's local (x, y) — the
// fragment shader recovers z = sqrt(1 - x² - y²) to fake a sphere normal.
in vec2 aPosition;

flat out vec4 vColor;
// Direction from this dot's center toward the camera, in world space. Constant
// per dot (hence flat); used as the light direction for a camera-tracking
// "headlight" so every sphere keeps a highlight facing the viewer.
flat out vec3 vToCam;
// Dot's apparent screen radius in pixels — used by the fragment shader to do
// pixel-space AA matching the resting halftone.
flat out float vRadiusPx;
out vec2 vCorner;

void main() {
    int col = gl_InstanceID % int(uGRID_SIZE.x);
    int row = gl_InstanceID / int(uGRID_SIZE.x);
    vec2 cellCoord = vec2(col, row);

    // World position of this dot's center, grid centered on the origin.
    vec2 gridCenter = uGRID_SIZE * uPITCH * 0.5;
    vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
    vec3 worldCenter = vec3(cellCenter.x - gridCenter.x, cellCenter.y - gridCenter.y, 0.0);

    // A/B face: front when camera is on the +Z side of the dot plane.
    bool isFront = uCamPos.z >= 0.0;

    // Mirror B-frame x-coordinates to undo viewing-from-behind mirroring.
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
            0.0, 1.0
        );
    float radius = sqrt(normLuma) * uDOT_SIZE * 0.5;

    // Pixel-perfect AA, matching the resting halftone: figure out this dot's
    // apparent screen radius, then grow the billboard by half a pixel of
    // headroom in screen space so smoothstep(rPx + 0.5, rPx - 0.5, dist) has
    // room to fade to zero on every side. We do this by projecting the dot
    // center first to get its clip-space w (= -z_eye), then scaling the
    // impostor coords so vCorner = ±1 still marks the dot edge while the
    // billboard quad itself extends a touch further.
    //
    // The 4.0 floor on pixelRadius caps `scale` at 1.125: for big dots the
    // headroom stays a true 0.5 screen pixels; for far/small dots we stop
    // inflating the billboard (and its AA-tail depth writes) into a halo that
    // smothers neighbouring dots. Sub-pixel dots lose a sliver of the AA tail
    // on the cardinal edges, but they're below one pixel anyway so the
    // cardinal cutoff is invisible.
    vec4 centerClip = uMVP * vec4(worldCenter, 1.0);
    float pixelRadius = radius * uFOCAL_PX / centerClip.w;
    float scale = 1.0 + 0.5 / max(pixelRadius, 4.0);

    // Camera-facing billboard: build the quad from the camera's right/up basis
    // so it always faces the viewer, regardless of where the orbit camera is.
    // MVP then handles perspective foreshortening (distant dots get smaller)
    // and depth ordering.
    vec3 worldPos = worldCenter
        + (aPosition.x * uCamRight + aPosition.y * uCamUp) * (radius * scale);
    gl_Position = uMVP * vec4(worldPos, 1.0);

    vColor = color;
    vCorner = aPosition * scale;
    vRadiusPx = pixelRadius;
    vToCam = normalize(uCamPos - worldCenter);
}
