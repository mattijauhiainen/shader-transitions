#version 300 es
precision highp float;

#define PI 3.14159265

uniform sampler2D uCellColorsA;
uniform sampler2D uLumaRangeA;
uniform sampler2D uCellColorsB;
uniform sampler2D uLumaRangeB;
uniform vec2 uGridSize;
uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
uniform vec2 uViewport;
uniform float uTime;

in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadius;
out float vEdge;

void main() {
    int col = gl_InstanceID % int(uGridSize.x);
    int row = gl_InstanceID / int(uGridSize.x);
    vec2 cellCoord = vec2(col, row);
    vec2 cellCenter = (cellCoord + 0.5) * uPitch;

    float angle = uTime * PI;
    // Precalculate cos and sin for the angle, we need this few times.
    float cosR = cos(angle);
    float sinR = sin(angle);
    // Are we rendering the frontside or the backside?
    bool isFront = cosR >= 0.0;

    // In the final position we have rotated 180 degrees around y-axis, and
    // cell at +x will be at -x. If we rendered B-frame like this it would
    // be a mirror image. Compensate by taking a mirror image from B-frame,
    // undoing the mirroring that would otherwise happen.
    vec2 sampleCoord = cellCoord;
    if (!isFront) {
        sampleCoord.x = uGridSize.x - 1.0 - cellCoord.x;
    }
    vec2 uv = (sampleCoord + 0.5) / uGridSize;

    vec4 color;
    vec2 range;
    if (isFront) {
        color = textureLod(uCellColorsA, uv, 0.0);
        range = textureLod(uLumaRangeA, vec2(0.5), 0.0).rg;
    } else {
        color = textureLod(uCellColorsB, uv, 0.0);
        range = textureLod(uLumaRangeB, vec2(0.5), 0.0).rg;
    }

    float normLuma = clamp(
            (dot(color.rgb, uLuma) - range.r) / (range.g - range.r),
            0.0, 1.0);
    float radius = sqrt(normLuma) * uCellSize * 0.5;

    // aPosition is a unit circle vertex — scale to dot radius + 0.5px
    // for antialiasing margin. Each vertex gets its own 3D position,
    // so the circle naturally becomes an ellipse when the plane rotates.
    float outerRadius = radius + 0.5;
    vec2 worldPos = cellCenter + aPosition * outerRadius;

    // Rotate around grid center for correct end-state alignment.
    // Per-vertex rotation and perspective — each vertex of the circle
    // gets its own depth and projection, unlike quad-based transitions
    // where perspective is computed once per cell center.
    vec2 gridCenter = uGridSize * uPitch * 0.5;
    float centeredX = worldPos.x - gridCenter.x;
    float centeredY = worldPos.y - gridCenter.y;

    // When we rotate around y-axis, for the first 90 degrees, the
    // cells on right and left will move towards x=0 on the x-axis.
    // On z-axis, the cells on right will move up towards camera,
    // and cells on the left will move away.
    // Then for the remaining 90 degrees, the cells will move into
    // opposite directions, bringing the image back to its normal
    // position.
    // We get the x displacement (rotX) with f(x') = x * cos(angle)
    // and z displacement (rotZ) with f(z') = x * sin(angle)
    float rotX = centeredX * cosR;
    float rotZ = centeredX * sinR;

    // Calculate the scaling that comes from our perspective with
    // camera distance / (camera distance - z displacement), saying
    // that we've moved perspScale times closer to the camera.
    float camDist = uViewport.x * 0.5;
    float perspScale = camDist / (camDist - rotZ);

    // Calculate where on the screen the cell actually gets rendered,
    // after accounting for it moving on the z-axis. A cell that is
    // right of center, when moved up on z-axis, will appear further
    // on right in our projection. Similarly when moved down, it will
    // move closer to the center on the x-axis.
    vec2 projected = vec2(rotX * perspScale, centeredY * perspScale) + gridCenter;

    gl_Position = vec4(projected / uViewport * 2.0 - 1.0, 0.0, 1.0);

    vColor = color;
    // Scale the radius by perspective — cells closer to the camera
    // will appear larger, and cells further away will appear smaller.
    vRadius = radius * perspScale;
    // 0 at center vertex, 1 at edge vertices — GPU interpolates across triangle
    vEdge = length(aPosition);
}
