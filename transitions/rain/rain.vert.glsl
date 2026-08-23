#version 300 es
precision highp float;

uniform sampler2D uCELL_COLORS;
uniform sampler2D uLUMA_RANGE;
uniform vec2 uGRID_SIZE;
uniform vec2 uVIEWPORT;
uniform float uTimeNorm;
uniform int uPhase; // 0 = A (fading out), 1 = B (rain drops)
uniform sampler2D uDROP_MAP;

in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadiusPx;
flat out float vOpacityNorm;
flat out float vDropHeightNorm;
flat out vec2 vRadialDir;
out vec2 vOffsetPx;

flat out float vSplashNorm;

uniform float uDOT_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform float uFALL_WINDOW;

#define SPLASH_WINDOW (uFALL_WINDOW * 1.5)

void main() {
  int col = gl_InstanceID % int(uGRID_SIZE.x);
  int row = gl_InstanceID / int(uGRID_SIZE.x);
  vec2 cellCoordCells = vec2(col, row);
  vec2 colorUv = (cellCoordCells + 0.5) / uGRID_SIZE;

  vec4 color = textureLod(uCELL_COLORS, colorUv, 0.0);
  vec2 lumaRange = textureLod(uLUMA_RANGE, vec2(0.5), 0.0).rg;
  float lumaNorm = clamp(
    (dot(color.rgb, uLUMA) - lumaRange.r) / (lumaRange.g - lumaRange.r),
    0.0,
    1.0
  );
  float halftoneRadiusPx = sqrt(lumaNorm) * uDOT_SIZE * 0.5;
  vec2 cellPosPx = (cellCoordCells + 0.5) * uPITCH;

  vec2 dropData = texelFetch(uDROP_MAP, ivec2(col, row), 0).rg;
  float releaseTimeNorm = dropData.r;
  float cellDistCells = dropData.g; // Manhattan distance from drop center (0, 1, or 2)
  bool isDropCenter = cellDistCells < 0.5;
  float elapsedNorm = max(0.0, uTimeNorm - releaseTimeNorm);
  float fallProgressNorm = clamp(elapsedNorm / uFALL_WINDOW, 0.0, 1.0);
  float splashElapsedNorm = elapsedNorm - uFALL_WINDOW;
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
    vec2 quadOffsetPx = aPosition * 0.5 * uPITCH;
    vOffsetPx = quadOffsetPx;
    gl_Position = vec4((cellPosPx + quadOffsetPx) / uVIEWPORT * 2.0 - 1.0, 0.0, 1.0);
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
    vec2 screenCenterPx = uVIEWPORT * 0.5;
    float observerHeightPx = uVIEWPORT.x * 1.0;
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

    posPx += stretchedPos * 0.5 * uPITCH * perspectiveScale;
    vOffsetPx = stretchedPos * 0.5 * uPITCH * perspectiveScale;
    gl_Position = vec4(posPx / uVIEWPORT * 2.0 - 1.0, 0.0, 1.0);
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
    vec2 quadOffsetPx = aPosition * 0.5 * uPITCH * rippleScale;
    vOffsetPx = quadOffsetPx;
    gl_Position = vec4((cellPosPx + quadOffsetPx) / uVIEWPORT * 2.0 - 1.0, 0.0, 1.0);
    return;
  }

  // Phase B: neighbor landed, fade in staggered by distance
  vRadiusPx = halftoneRadiusPx;
  vDropHeightNorm = 0.0;
  vRadialDir = vec2(0.0, 1.0);
  vSplashNorm = -1.0;
  float staggerDelay = cellDistCells * 0.1;
  vOpacityNorm = clamp((splashProgressNorm - staggerDelay) / (1.0 - staggerDelay), 0.0, 1.0);
  vec2 quadOffsetPx = aPosition * 0.5 * uPITCH;
  vOffsetPx = quadOffsetPx;
  gl_Position = vec4((cellPosPx + quadOffsetPx) / uVIEWPORT * 2.0 - 1.0, 0.0, 1.0);
}
