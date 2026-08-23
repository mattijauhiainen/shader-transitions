#version 300 es
precision highp float;

// Init-tier uniforms, these are set once.

// The two images: A is the current frame, B the next. Nothing blends between
// them — each is drawn as its own grid of dots, B far behind A, and the camera
// flies from one to the other, on through B, and then turns around to look
// back at it.
uniform sampler2D uCELL_COLORS_A;
uniform sampler2D uCELL_COLORS_B;
// 1x1 textures holding each image's darkest and brightest cell, in .rg. Used to
// stretch its brightness over the full range.
uniform sampler2D uLUMA_RANGE_A;
uniform sampler2D uLUMA_RANGE_B;
uniform vec2 uGRID_SIZE;
// Dot diameter at full luma, in world units (less than uPITCH).
uniform float uDOT_SIZE;
// World-space spacing between cell centers.
uniform float uPITCH;
// Weights to calculate luma for a given RGB color.
uniform vec3 uLUMA;
// Focal length in pixels. Converts a dot's size in world units into its size on
// screen, which the fragment shader needs to smooth the edge over one pixel.
// anamorphosis.ts picks fovY so that one world unit at the picture plane is one
// pixel, which makes this double as the distance from a picture to its own
// resting camera in world units — the placement below relies on that.
uniform float uFOCAL_PX;

// How the dots are placed. Draw a line from the resting camera, which sits at
// (0, 0, uFOCAL_PX), through the spot this dot occupies in the flat picture.
// The dot is placed somewhere along that line, and depth says where: depth = 1
// is the flat spot, smaller is nearer the camera, larger is further off. Its
// size is scaled by depth as well, and the two exactly cancel — a dot twice as
// far away is twice as big, so it covers the same pixels. From the resting
// camera the whole thing therefore looks like the ordinary flat halftone, no
// matter how the depths are arranged. Move the camera and it comes apart: the
// depths separate, each tile turns into a well or a spike, and the camera flies
// down the well in the middle of the screen.
//
// B is that same construction reflected: its resting camera sits behind its
// picture rather than in front, so B's depths reach back toward A instead of
// away, and B only reads as a picture from a camera that has flown all the way
// past it and turned around. The reflection is also what aims the middle
// tile's tunnel at us — tile (0, 0) is one of the tiles that sinks away from
// its own resting camera, and for B "away" points back up the flight path, so
// the tunnel we fly down arrives tip first.

// Depth most of the dots sit at — far enough back that flying past barely
// shifts them on screen, so the picture stays readable.
uniform float uDEPTH_BASE;
// Depth the innermost layer of a tile reaches: uDEPTH_NEAR for the tiles that
// reach out toward the camera, uDEPTH_FAR for the ones that sink away from it.
uniform float uDEPTH_NEAR;
uniform float uDEPTH_FAR;
// Tile size, in cells. Each tile carries one shape's concentric layers.
uniform float uTILE_SIZE;
// Number of depth layers per tile.
uniform float uLAYER_COUNT;
// How far behind A's picture B's picture sits, in world units. B's own resting
// camera is a further uFOCAL_PX behind that, on the far side of B's picture,
// and that is where the camera ends up at the end of the flight. The gap has to
// be wide enough for both structures — see IMAGE_GAP in anamorphosis.ts.
uniform float uIMAGE_GAP;

// Per-frame uniforms (camelCase): updated on every draw.

uniform mat4 uMVP;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
// Which of the two images this draw call is for. The grid is drawn once per
// image, and this says whether the dots go in A's plane or B's.
uniform bool uIsImageA;
uniform float uFadeA;
uniform float uFadeB;

in vec2 aPosition;

flat out vec4 vColor;
flat out vec3 vToCam;
flat out float vRadiusPx;
flat out float vFade;
out vec2 vCorner;

// Which layer of its tile a cell belongs to: 0 at the tile centre, up to
// uLAYER_COUNT-1 at the edge. The grid is cut into square tiles, and each tile
// measures distance from its own centre using one of three shapes — circle,
// square or diamond, cycling from tile to tile — so the cells fall into
// concentric rings of that shape. The ring a cell lands in is its layer, and
// the layer is what sets the dot's depth, which turns each tile into a stack.
// tileCoord is the caller's tile index for this cell, passed in rather than
// recomputed; tilePhase must be the same shift used to derive it.
float layerIndex(vec2 cellCoord, vec2 tileCoord, vec2 tilePhase) {
    // Position within the tile, remapped to [-1, 1]. Subtracting the tile index
    // off the shifted coordinate is the fract() that produced tileCoord.
    vec2 tileLocal =
        (cellCoord / uTILE_SIZE + tilePhase - tileCoord) * 2.0 - 1.0;
    float shape = mod(tileCoord.x + tileCoord.y, 3.0);
    float metric;
    if (shape < 0.5) {
        metric = length(tileLocal); // circle
    } else if (shape < 1.5) {
        metric = max(abs(tileLocal.x), abs(tileLocal.y)); // square
    } else {
        metric = (abs(tileLocal.x) + abs(tileLocal.y)) * 0.70710678; // diamond
    }
    return floor(clamp(metric, 0.0, 1.0) * (uLAYER_COUNT - 1.0) + 0.5);
}

void main() {
    // One instance per cell. The whole grid is drawn twice, once per image,
    // with B's copy sitting uIMAGE_GAP further back.
    int col = gl_InstanceID % int(uGRID_SIZE.x);
    int row = gl_InstanceID / int(uGRID_SIZE.x);
    vec2 cellCoord = vec2(col, row);
    float planeZ = uIsImageA ? 0.0 : -uIMAGE_GAP;
    // Which side of its own picture an image's resting camera sits on: in front
    // for A, behind for B. This one sign is the whole mirror.
    float side = uIsImageA ? 1.0 : -1.0;

    // Where this dot's centre sits in the flat picture, with the grid centred
    // on the origin.
    vec2 gridCenter = uGRID_SIZE * uPITCH * 0.5;
    vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
    vec2 flat0 = cellCenter - gridCenter;

    // Shift the tile grid so that tile (0, 0) lands in the middle of the
    // screen. That is the stack the camera flies down, so it has to be lined up
    // with the z axis. Being tile (0, 0) also puts it among the tiles that sink
    // away, and gives it the round shape, which is what makes the tunnel.
    // The extra quarter of a cell nudges the grid off dead centre on purpose:
    // at some window sizes a whole column of cells would otherwise land exactly
    // on the seam between two tiles, where nothing but rounding decides which
    // one they join — and with it their shape and their depth.
    vec2 tilePhase =
        vec2(0.5 + 0.25 / uTILE_SIZE) - uGRID_SIZE / (2.0 * uTILE_SIZE);
    vec2 tileCoord = floor(cellCoord / uTILE_SIZE + tilePhase);
    float layer = layerIndex(cellCoord, tileCoord, tilePhase);
    // 0 at the tile centre, 1 at the outer layer
    float layerPhase = layer / (uLAYER_COUNT - 1.0);


    // The stacks form a checkerboard pattern, where every other stack goes away
    // from camera and every other towards the camera.
    float stackDirection = mod(tileCoord.x + tileCoord.y, 2.0);
    float stackTip = stackDirection < 0.5 ? uDEPTH_FAR : uDEPTH_NEAR;
    // How deep this dot goes. The outer layer of every tile stays at
    // uDEPTH_BASE.
    float depth = mix(uDEPTH_BASE, stackTip, 1.0 - layerPhase);

    // Push the dot along its own picture's line by depth, and scale its size to
    // match. A's lines meet at a camera uFOCAL_PX in front of A's picture, B's
    // at one uFOCAL_PX behind B's, so the two structures point opposite ways.
    vec3 worldCenter =
        vec3(depth * flat0, planeZ + side * uFOCAL_PX * (1.0 - depth));

    // Colour and brightness for this cell, from whichever of the two images
    // this dot belongs to. Brightness is stretched over the image's own range,
    // and sets the dot's size — bright cells get big dots.
    vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;
    // The camera reads B while facing +z, which puts world +x on the left of
    // the screen. Mirroring which cell of the picture each dot carries cancels
    // that out, so B lands the right way round. Only the lookup is mirrored,
    // not the geometry: the dots stay on their grid and the tile pattern stays
    // lined up with the z axis.
    if (!uIsImageA) uv.x = 1.0 - uv.x;
    vec4 color = uIsImageA
        ? textureLod(uCELL_COLORS_A, uv, 0.0)
        : textureLod(uCELL_COLORS_B, uv, 0.0);
    vec2 range = uIsImageA
        ? textureLod(uLUMA_RANGE_A, vec2(0.5), 0.0).rg
        : textureLod(uLUMA_RANGE_B, vec2(0.5), 0.0).rg;
    float normLuma = clamp(
            (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
            0.0, 1.0
        );
    float radius = sqrt(normLuma) * uDOT_SIZE * 0.5 * depth;

    // Antialiasing. Project the dot's centre to find how far from the camera it
    // is (that is what w comes out as), turn that into a radius in pixels, then
    // grow the quad by half a pixel all round so the fragment shader has
    // somewhere to fade the edge out. The 4.0 floor stops tiny far-off dots
    // being blown up by that margin.
    vec4 centerClip = uMVP * vec4(worldCenter, 1.0);
    float pixelRadius = radius * uFOCAL_PX / centerClip.w;
    float scale = 1.0 + 0.5 / max(pixelRadius, 4.0);

    // Turn the square to face the camera, using the camera's own right and up
    // directions.
    vec3 worldPos = worldCenter
        + (aPosition.x * uCamRight + aPosition.y * uCamUp) * (radius * scale);
    gl_Position = uMVP * vec4(worldPos, 1.0);

    vColor = color;
    vCorner = aPosition * scale;
    vRadiusPx = pixelRadius;
    vToCam = normalize(uCamPos - worldCenter);
    vFade = uIsImageA ? uFadeA : uFadeB;
}
