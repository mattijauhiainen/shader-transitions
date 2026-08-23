#version 300 es
precision highp float;

// Per-instance grid lookup. A is shown until the plane passes edge-on,
// B after. Each side has its own cell colors + luma range.
uniform sampler2D uCELL_COLORS_A;
uniform sampler2D uLUMA_RANGE_A;
uniform sampler2D uCELL_COLORS_B;
uniform sampler2D uLUMA_RANGE_B;
uniform vec2 uGRID_SIZE;
uniform float uDOT_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;

// The whole point of this transition: a single combined matrix.
// Built on the CPU as projection * view * model and passed in here.
uniform mat4 uMVP;
// 1 once the plane has rotated past edge-on and the back face (image B)
// is the one facing the camera. CPU sets it from t.
uniform float uShowB;

// Unit-disk billboard vertex (same convention as orbit/freefall/etc.)
in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadius;
out vec2 vLocalPos;

void main() {
    // Decode instance ID into grid coordinate.
    int col = gl_InstanceID % int(uGRID_SIZE.x);
    int row = gl_InstanceID / int(uGRID_SIZE.x);
    vec2 cellCoord = vec2(col, row);

    // While the back face is toward the camera, mirror x so image B reads
    // left-to-right instead of appearing reversed through the plane.
    bool showB = uShowB > 0.5;
    vec2 sampleCoord = cellCoord;
    if (showB) {
        sampleCoord.x = uGRID_SIZE.x - 1.0 - cellCoord.x;
    }
    vec2 uv = (sampleCoord + 0.5) / uGRID_SIZE;

    vec4 color;
    vec2 range;
    if (showB) {
        color = textureLod(uCELL_COLORS_B, uv, 0.0);
        range = textureLod(uLUMA_RANGE_B, vec2(0.5), 0.0).rg;
    } else {
        color = textureLod(uCELL_COLORS_A, uv, 0.0);
        range = textureLod(uLUMA_RANGE_A, vec2(0.5), 0.0).rg;
    }

    float normLuma = clamp(
            (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
            0.0, 1.0);
    float radius = sqrt(normLuma) * uDOT_SIZE * 0.5;

    // World position of this dot. Center the grid on the origin so rotation
    // happens around the middle of the plane (not the corner).
    vec2 gridCenter = uGRID_SIZE * uPITCH * 0.5;
    vec3 worldCenter = vec3((cellCoord + 0.5) * uPITCH - gridCenter, 0.0);
    // Add half a pixel of AA headroom so the fragment shader's smoothstep
    // over [radius-0.5, radius+0.5] has room to fade alpha to zero on the
    // outer edge. At z=0 (the handover frames) the projection is calibrated
    // for 1 world unit = 1 pixel, so `radius + 0.5` is exactly half a screen
    // pixel of padding. Mid-flight perspective scales this, which is fine —
    // pixel-perfect matching only matters at the on-axis handoff.
    float outerRadius = radius + 0.5;
    vec4 dotWorldPosition = vec4(worldCenter + vec3(aPosition * outerRadius, 0.0), 1);

    // Apply perspective, rotation and translation by multiplying with the MVP
    // matrix.
    gl_Position = uMVP * dotWorldPosition;

    vColor = color;
    vRadius = radius;
    vLocalPos = aPosition; // unit-disk local coord, used for AA in the frag shader
}
