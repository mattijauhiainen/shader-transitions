#version 300 es
precision highp float;

// Mitosis transition: A-frame halftone dots merge up a quadtree
// (ascent), colors crossfade from A to B at the peak, then B-frame
// dots split back down (descent). Three variables drive the rendering:
//   level      — current quadtree depth. Also used as the mip LOD for
//                textureLod() and as the exponent in pow(2, level) to
//                derive the grid scale — these coincide because each
//                mip level halves the grid, doubling the cell size.
//   mergeT     — merge progress within the current level (0→1 ascent, 1→0 descent)
//   colorBlend — which frame's colors to use (0 = A, 1 = B)

uniform sampler2D uCellColorsA;
uniform sampler2D uLumaRangeA;
uniform sampler2D uCellColorsB;
uniform sampler2D uLumaRangeB;
uniform sampler2D uMergeTimes;
uniform vec2 uGridSize;
uniform float uTime;
uniform float uLevelDuration;

uniform float uCellSize;
uniform float uPitch;
uniform vec3 uLuma;
// Number of ascent levels. Also the boundary in the timing texture
// between ascent (steps 0..uPeakLevel-1) and descent (steps
// uPeakLevel..uTotalLevels-1). Between the two phases, a crossfade
// blends A→B colors while dots hold at the peak.
uniform int uPeakLevel;
// How many levels (both ascending and descending) we have in the
// texture
uniform int uTotalLevels;

out vec4 fragColor;

void main() {
  vec2 baseCell = floor(gl_FragCoord.xy / uPitch);
  vec2 cellUV = (baseCell + 0.5) / uGridSize;

  float level = 0.0;
  float mergeT = 0.0;
  float colorBlend = 0.0;

  /*
   * Walk the merge timing texture to find the current animation state.
   * The first uPeakLevel entries are ascent (A-frame merging up), the
   * next uPeakLevel are descent (B-frame splitting down). We scan until
   * we find the active step, setting level, mergeT, and colorBlend.
   */
  for (int step = 0; step < uTotalLevels; step++) {
    float texY = (cellUV.y + float(step)) / float(uTotalLevels);
    float startTime = texture(uMergeTimes, vec2(cellUV.x, texY)).r;
    float endTime = startTime + uLevelDuration;

    // Extract different animation states into conditions to make the
    // loop less painful to read
    bool notStarted = step == 0 && uTime < startTime;
    bool ascending = step < uPeakLevel;
    bool belowThisLevel = uTime < startTime;
    bool pastThisLevel = uTime >= endTime;
    bool onThisLevel = !belowThisLevel && !pastThisLevel;
    bool crossfading = step == uPeakLevel && belowThisLevel;
    bool isLastLevel = step == uTotalLevels - 1;

    if (notStarted) {
      // Animation hasn't started yet — keep defaults (level=0, mergeT=0)
      break;
    // --- Ascent ---
    } else if (ascending && belowThisLevel) {
      // Waiting for a sibling cell in this group to finish the
      // previous step before this step can begin
      level = float(step) - 1.0;
      mergeT = 1.0;
      break;
    } else if (ascending && onThisLevel) {
      // Currently on this ascent step
      level = float(step);
      mergeT = (uTime - startTime) / uLevelDuration;
      break;
    } else if (ascending && pastThisLevel) {
      // Continue to next step
    } else if (crossfading) {
      // Ascent complete, descent hasn't started yet.
      // Look back at the last ascent step to get when it ended.
      float ascentTexY = (cellUV.y + float(uPeakLevel - 1)) / float(uTotalLevels);
      float ascentEnd = texture(uMergeTimes, vec2(cellUV.x, ascentTexY)).r + uLevelDuration;
      level = float(uPeakLevel) - 1.0;
      mergeT = 1.0;
      colorBlend = clamp(
        (uTime - ascentEnd) / max(startTime - ascentEnd, 0.001),
        0.0, 1.0
      );
      break;
    // --- Descent ---
    } else if (!ascending && onThisLevel) {
      // Descent: in progress
      level = float(uPeakLevel - 1 - (step - uPeakLevel));
      mergeT = 1.0 - (uTime - startTime) / uLevelDuration;
      colorBlend = 1.0;
      break;
    } else if (!ascending && pastThisLevel && !isLastLevel) {
      // Continue to next step
    } else if (!ascending && belowThisLevel) {
      // Waiting for a sibling group to finish splitting.
      // Previous step completed, so set state for that step.
      level = float(2 * uPeakLevel - step);
      mergeT = 0.0;
      colorBlend = 1.0;
      break;
    } else if (isLastLevel) {
      // All descent steps complete — animation finished, show B-frame
      colorBlend = 1.0;
      break;
    }
  }

  /*
   * Now we have level, mergeT, and colorBlend. Rendering works in three stages:
   *
   * 1. Grid geometry — from level, derive the scale, pitch, and cell size
   *    at this mip level. Find which 2x2 group this pixel belongs to.
   *
   * 2. Merge target — the 4 children are merging into a parent cell one
   *    mip level up. We need its color and radius so we can interpolate
   *    toward them. To get these, sample both A and B frame colors from
   *    the coarser mip level, then blend between them using colorBlend
   *    to get the actual target color. Convert that color to luminance,
   *    normalize using the blended luma range, and derive the target
   *    radius via sqrt(normLuma) * cellSize.
   *
   * 3. Per-child metaball — for each of the 4 children in the group:
   *    a. Sample both A and B frame colors at the current mip level,
   *       blend by colorBlend to get the child's actual color. Convert
   *       to luminance and normalize against the blended luma range to
   *       get the child's radius.
   *    b. Blend color and radius toward the merge target by mergeT
   *    c. Move center toward the merged center by mergeT
   *    d. Compute metaball field strength (r²/d²) at this pixel
   *    e. Accumulate field and field-weighted color
   *
   * Finally, threshold the combined field to get the dot shape, and
   * use the field-weighted color average as the dot's color.
   */
  // --- Stage 1: Grid geometry ---
  // Luma range for normalizing brightness (blend A/B ranges by colorBlend)
  vec2 lumaRangeA = texture(uLumaRangeA, vec2(0.5)).rg;
  vec2 lumaRangeB = texture(uLumaRangeB, vec2(0.5)).rg;
  vec2 lumaRange = mix(lumaRangeA, lumaRangeB, colorBlend);

  // Scale grid dimensions to the current mip level
  float scale = pow(2.0, level);
  float currentPitch = uPitch * scale;
  float currentCellSize = uCellSize * scale;

  // Which 2x2 group does this pixel belong to, and where does it merge?
  vec2 groupCoord = floor(gl_FragCoord.xy / (currentPitch * 2.0));
  vec2 mergedCenter = (groupCoord + 0.5) * currentPitch * 2.0;
  vec2 levelDim = max(vec2(1.0), floor(uGridSize / scale));

  // --- Stage 2: Merge target (parent cell, one mip level up) ---
  vec2 nextDim = max(vec2(1.0), floor(uGridSize / (scale * 2.0)));
  vec2 mergedUV = (groupCoord + 0.5) / nextDim;
  // Sample A and B frame colors from the coarser mip, blend by colorBlend
  vec4 mergedColorA = textureLod(uCellColorsA, mergedUV, level + 1.0);
  vec4 mergedColorB = textureLod(uCellColorsB, mergedUV, level + 1.0);
  vec4 mergedColor = mix(mergedColorA, mergedColorB, colorBlend);
  // Convert to luminance → normalize → radius (the target the children merge into)
  float mergedNormLuma = clamp(
    (dot(mergedColor.rgb, uLuma) - lumaRange.r) / (lumaRange.g - lumaRange.r),
    0.0, 1.0
  );
  float mergedRadius = sqrt(mergedNormLuma) * currentCellSize;

  // --- Stage 3: Per-child metaball ---
  // We use a metaball field to render the dots. The field function
  // field = r²/d² gives 1.0 at the circle surface, >1 inside, <1 outside.
  // When blobs are close, their summed fields exceed 1.0 between them,
  // forming bridges. We accumulate both max (for clean independent circles)
  // and sum (for bridging), and blend between them using mergeT.
  float sumField = 0.0;
  float maxField = 0.0;
  vec4 colorAccum = vec4(0.0);
  float weightAccum = 0.0;

  // Iterate over the 4 children in this 2x2 group
  for (int dy = 0; dy < 2; dy++) {
    for (int dx = 0; dx < 2; dx++) {
      vec2 childCoord = groupCoord * 2.0 + vec2(float(dx), float(dy));
      vec2 childCenter = (childCoord + 0.5) * currentPitch;

      // 3a: Sample A and B colors at current mip, blend by colorBlend
      vec2 childUV = (childCoord + 0.5) / levelDim;
      vec4 colorA = textureLod(uCellColorsA, childUV, level);
      vec4 colorB = textureLod(uCellColorsB, childUV, level);
      vec4 color = mix(colorA, colorB, colorBlend);

      // Convert to luminance → normalize against blended luma range → radius
      float normLuma = clamp(
        (dot(color.rgb, uLuma) - lumaRange.r) / (lumaRange.g - lumaRange.r),
        0.0, 1.0
      );
      float childRadius = sqrt(normLuma) * currentCellSize * 0.5;

      // 3b: Blend radius and color toward the merge target
      float radius = mix(childRadius, mergedRadius, mergeT) / sqrt(1.0 + 3.0 * mergeT);
      color = mix(color, mergedColor, mergeT);

      // 3c: Move child center toward merged center
      vec2 center = mix(childCenter, mergedCenter, mergeT);

      // 3d: Compute metaball field strength at this pixel
      vec2 delta = gl_FragCoord.xy - center;
      float dist2 = dot(delta, delta);
      float field = (radius * radius) / max(dist2, 0.01);

      // 3e: Accumulate field and field-weighted color
      sumField += field;
      maxField = max(maxField, field);
      colorAccum += color * field;
      weightAccum += field;
    }
  }

  // sumField alone would enlarge circles even at mergeT=0, because nearby
  // blobs contribute small field values that add up — causing dots to bleed
  // into each other before any animation has started. At mergeT=0, use max
  // instead (each blob independent, no interaction). As mergeT grows, blend
  // toward sum to let the fields interact and form bridges.
  float totalField = mix(maxField, sumField, mergeT);
  // Field-weighted color average — closer/larger blobs dominate
  vec4 blendedColor = weightAccum > 0.0 ? colorAccum / weightAccum : vec4(0.0);

  float fieldWidth = fwidth(totalField) * 0.5;
  float alpha = smoothstep(1.0 - fieldWidth, 1.0 + fieldWidth, totalField);

  fragColor = mix(vec4(0, 0, 0, 1), blendedColor, alpha);
}
