#version 300 es
precision highp float;

uniform sampler2D uCellColors;
uniform sampler2D uLumaRange;
uniform vec2 uGridSize;
uniform vec2 uViewportPx;
uniform float uTimeNorm;
uniform int uPhase; // 0 = A (fading out), 1 = B (rain drops)
uniform sampler2D uDropMap;

in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadiusPx;
flat out float vOpacityNorm;
flat out float vDropHeightNorm;
flat out vec2 vRadialDir;
out vec2 vOffsetPx;

flat out float vSplashNorm;

uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
uniform float uFallWindow;

#define SPLASH_WINDOW (uFallWindow * 1.5)

void main() {
  int col = gl_InstanceID % int(uGridSize.x);
  int row = gl_InstanceID / int(uGridSize.x);
  vec2 cellCoordCells = vec2(col, row);
  vec2 colorUv = (cellCoordCells + 0.5) / uGridSize;

  vec4 color = textureLod(uCellColors, colorUv, 0.0);
  vec2 lumaRange = textureLod(uLumaRange, vec2(0.5), 0.0).rg;
  float lumaNorm = clamp(
    (dot(color.rgb, uLuma) - lumaRange.r) / (lumaRange.g - lumaRange.r),
    0.0,
    1.0
  );
  float halftoneRadiusPx = sqrt(lumaNorm) * uCellSize * 0.5;
  vec2 cellPosPx = (cellCoordCells + 0.5) * uPitch;

  vec2 dropData = texelFetch(uDropMap, ivec2(col, row), 0).rg;
  float releaseTimeNorm = dropData.r;
  float cellDistCells = dropData.g; // Manhattan distance from drop center (0, 1, or 2)
  bool isDropCenter = cellDistCells < 0.5;
  float elapsedNorm = max(0.0, uTimeNorm - releaseTimeNorm);
  float fallProgressNorm = clamp(elapsedNorm / uFallWindow, 0.0, 1.0);
  float splashElapsedNorm = elapsedNorm - uFallWindow;
  float splashProgressNorm = clamp(splashElapsedNorm / SPLASH_WINDOW, 0.0, 1.0);

  vColor = color;

  // Phase A: fade out old cells, staggered by distance from drop center
  if (uPhase == 0) {
    vRadiusPx = halftoneRadiusPx;
    vDropHeightNorm = 0.0;
    vRadialDir = vec2(0.0, 1.0);
    vSplashNorm = -1.0;
    float staggerDelay = cellDistCells * 0.1;
    float staggeredProgress = clamp((splashProgressNorm - staggerDelay) / (1.0 - staggerDelay), 0.0, 1.0);
    vOpacityNorm = 1.0 - staggeredProgress;
    vec2 quadOffsetPx = aPosition * 0.5 * uPitch;
    vOffsetPx = quadOffsetPx;
    gl_Position = vec4((cellPosPx + quadOffsetPx) / uViewportPx * 2.0 - 1.0, 0.0, 1.0);
    return;
  }

  // Phase B: not yet released, hide off-screen
  if (splashElapsedNorm <= 0.0 && !isDropCenter) {
    vRadiusPx = 0.0;
    vOpacityNorm = 0.0;
    vDropHeightNorm = 0.0;
    vRadialDir = vec2(0.0, 1.0);
    vSplashNorm = -1.0;
    vOffsetPx = vec2(0.0);
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }

  // Phase B: drop center still falling
  if (isDropCenter && splashElapsedNorm <= 0.0) {
    vec2 screenCenterPx = uViewportPx * 0.5;
    float observerHeightPx = uViewportPx.x * 1.0;
    float dropHeightPx = observerHeightPx * (1.0 - fallProgressNorm);
    vec2 groundOffsetPx = cellPosPx - screenCenterPx;
    float perspectiveScale = observerHeightPx / max(observerHeightPx - dropHeightPx, observerHeightPx * 0.05);
    vec2 projectedOffsetPx = groundOffsetPx * perspectiveScale;
    vec2 posPx = screenCenterPx + projectedOffsetPx;

    vRadiusPx = halftoneRadiusPx * perspectiveScale;
    vOpacityNorm = smoothstep(0.0, 0.15, fallProgressNorm);
    vDropHeightNorm = 1.0 - fallProgressNorm;
    vSplashNorm = -1.0;

    vec2 radialDir = normalize(projectedOffsetPx);
    float radialLenPx = length(projectedOffsetPx);
    vRadialDir = radialLenPx > 0.001 ? radialDir : vec2(0.0, 1.0);

    float stretch = 1.0 + vDropHeightNorm * 1.0;
    vec2 tangentDir = vec2(-vRadialDir.y, vRadialDir.x);
    vec2 localPos = vec2(dot(aPosition, vRadialDir), dot(aPosition, tangentDir));
    localPos.x *= stretch;
    vec2 stretchedPos = localPos.x * vRadialDir + localPos.y * tangentDir;

    posPx += stretchedPos * 0.5 * uPitch * perspectiveScale;
    vOffsetPx = stretchedPos * 0.5 * uPitch * perspectiveScale;
    gl_Position = vec4(posPx / uViewportPx * 2.0 - 1.0, 0.0, 1.0);
    return;
  }

  // Phase B: center landed, show ripple
  if (isDropCenter && splashElapsedNorm > 0.0) {
    vRadiusPx = halftoneRadiusPx;
    vOpacityNorm = 1.0;
    vDropHeightNorm = 0.0;
    vRadialDir = vec2(0.0, 1.0);
    vSplashNorm = splashProgressNorm;
    float rippleScale = 1.0 + splashProgressNorm * 6.0;
    vec2 quadOffsetPx = aPosition * 0.5 * uPitch * rippleScale;
    vOffsetPx = quadOffsetPx;
    gl_Position = vec4((cellPosPx + quadOffsetPx) / uViewportPx * 2.0 - 1.0, 0.0, 1.0);
    return;
  }

  // Phase B: neighbor landed, fade in staggered by distance
  vRadiusPx = halftoneRadiusPx;
  vDropHeightNorm = 0.0;
  vRadialDir = vec2(0.0, 1.0);
  vSplashNorm = -1.0;
  float staggerDelay = cellDistCells * 0.1;
  vOpacityNorm = clamp((splashProgressNorm - staggerDelay) / (1.0 - staggerDelay), 0.0, 1.0);
  vec2 quadOffsetPx = aPosition * 0.5 * uPitch;
  vOffsetPx = quadOffsetPx;
  gl_Position = vec4((cellPosPx + quadOffsetPx) / uViewportPx * 2.0 - 1.0, 0.0, 1.0);
}
