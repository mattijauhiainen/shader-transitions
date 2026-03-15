import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";

const DURATION_MS = 15000;
// Fraction of normalized time [0,1] for a single drop's fall animation
const FALL_WINDOW = 0.8 / (DURATION_MS / 1000);
// Standard deviation for Gaussian distribution of release times
const SIGMA = 0.2;

// Approximate inverse normal CDF (Beasley-Springer-Moro), rescaled by SIGMA
function invNormCDF(u: number): number {
  let x = u - 0.5;
  let r: number;
  if (Math.abs(x) < 0.42) {
    r = x * x;
    x = x * ((((-25.44106049637 * r + 41.39119773534) * r - 18.61500062529) * r + 2.50662823884) /
      ((((3.13082909833 * r - 21.06224101826) * r + 23.08336743743) * r - 8.47351093090) * r + 1));
  } else {
    r = u;
    if (x > 0) r = 1 - u;
    r = Math.log(-Math.log(r));
    x = 0.3374754822726147 + r * (0.9761690190917186 + r * (0.1607979714918209 +
      r * (0.0276438810333863 + r * (0.0038405729373609 + r * (0.0003951896511919 +
        r * (0.0000321767881768 + r * (0.0000002888167364 + r * 0.0000003960315187)))))));
    if (u < 0.5) x = -x;
  }
  return 0.5 + x * SIGMA;
}

// Diamond offsets: all cells within Manhattan distance 2 (13 cells)
const BLAST_OFFSETS = [
  [0, 0],
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-2, 0], [2, 0], [0, -2], [0, 2],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

/*
 * Generates the order and timing for the cells to flip and for the raindrops to
 * fall. Each drop will flip the cell it hits and everything within distance of
 * two cells around it. The drops are distributed randomly, and to be able to
 * cover the entire grid there is some overlap between the cells they flip.
 *
 * The fall times are distributed on a bell curve so that the rain starts softly,
 * then builds to max intensitety, and then dies out slowly.
 *
 * Returns: Float32Array (RG per cell) containing
 * - R: release time
 * - G: Manhattan distance to drop center (0 = center, 1 or 2 = neighbor)
 */
function generateDropMap(cols: number, rows: number): Float32Array {
  const total = cols * rows;
  const covered = new Uint8Array(total);
  let uncoveredCount = total;

  // R = release time, G = Manhattan distance from center
  const result = new Float32Array(total * 2); // RG32F
  const assigned = new Uint8Array(total);

  // Collect centers in order
  const centers: number[] = [];

  // Build list of uncovered cell indices for efficient random picking
  const uncoveredList = Array.from({ length: total }, (_, i) => i);

  while (uncoveredCount > 0) {
    // Pick a random uncovered cell as center
    let pickIdx: number;
    let centerIdx: number;
    do {
      pickIdx = Math.floor(Math.random() * uncoveredList.length);
      centerIdx = uncoveredList[pickIdx];
      // Remove from list (swap with last)
      uncoveredList[pickIdx] = uncoveredList[uncoveredList.length - 1];
      uncoveredList.pop();
    } while (covered[centerIdx] && uncoveredList.length > 0);

    if (covered[centerIdx]) break; // all remaining cells are covered

    const centerCol = centerIdx % cols;
    const centerRow = Math.floor(centerIdx / cols);

    centers.push(centerIdx);

    // Cover diamond-shape neighbors
    for (const [dx, dy] of BLAST_OFFSETS) {
      const neighborCol = centerCol + dx, neighborRow = centerRow + dy;
      if (neighborCol >= 0 && neighborCol < cols && neighborRow >= 0 && neighborRow < rows) {
        const neighborIdx = neighborRow * cols + neighborCol;
        if (!covered[neighborIdx]) {
          covered[neighborIdx] = 1;
          uncoveredCount--;
        }
      }
    }
  }


  // Create random order for centers to fall in
  const order = Float32Array.from({ length: centers.length }, (_, i) => i);
  for (let i = centers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }

  // Get the release times for the centers. These define when a given centers
  // raindrop will fall.
  const centerTimes = new Float32Array(centers.length);
  for (let i = 0; i < centers.length; i++) {
    const uniformRank = (order[i] + 0.5) / centers.length;
    let normalizedTime = Math.max(0, Math.min(1, invNormCDF(uniformRank)));
    // Bell curve is infinite. We cannot do that, so the values far on the left
    // and far on the right get clamped to the beginning of the range. This
    // creates cluster of cells at start and end of the animation. Take the first
    // and last 0.1% of cells on our curve, and redistribute them towards the middle.
    const tailThreshold = 0.001;
    if (normalizedTime < tailThreshold || normalizedTime > 1 - tailThreshold) {
      const r1 = Math.random(), r2 = Math.random();
      normalizedTime = 0.3 + 0.4 * (r1 + r2) / 2;
    }
    // Instead of normalizing between (0..1) normalize between (FALL_WINDOW..1 - FALL_WINDOW)
    // to give cells time to finish their animations.
    const range = 1.0 - FALL_WINDOW * 2.0;
    centerTimes[i] = normalizedTime * range;
  }

  // Assign times to centers and neighbors in our result array. Each neighbor gets
  // same time as the center whose raindrop flips it. Neighbors can be within the
  // range of multiple centers, so the latest center we loop her will override the
  // timing for a given cell.
  for (let i = 0; i < centers.length; i++) {
    const centerIdx = centers[i];
    const centerCol = centerIdx % cols;
    const centerRow = Math.floor(centerIdx / cols);
    const releaseTime = centerTimes[i];

    // Assign release time and distance for center
    result[centerIdx * 2] = releaseTime;
    result[centerIdx * 2 + 1] = 0.0;
    assigned[centerIdx] = 1;

    // Assign release time and distance for centers neighbors
    for (const [dx, dy] of BLAST_OFFSETS) {
      const neighborCol = centerCol + dx, neighborRow = centerRow + dy;
      if (neighborCol >= 0 && neighborCol < cols && neighborRow >= 0 && neighborRow < rows) {
        const neighborIdx = neighborRow * cols + neighborCol;
        if (!assigned[neighborIdx]) {
          result[neighborIdx * 2] = releaseTime;
          result[neighborIdx * 2 + 1] = Math.abs(dx) + Math.abs(dy);
          assigned[neighborIdx] = 1;
        }
      }
    }
  }

  return result;
}

export function createRainTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;

  const program = ctx.createProgram(
    `#version 300 es
    precision highp float;

    uniform sampler2D uCellColors;
    uniform sampler2D uLumaRange;
    uniform vec2 uCellCount;
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

    #define CELL_SIZE ${CELL_SIZE.toFixed(1)}
    #define PITCH ${PITCH.toFixed(1)}
    #define LUMA vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})
    #define FALL_WINDOW ${FALL_WINDOW}
    #define SPLASH_WINDOW (FALL_WINDOW * 1.5)

    void main() {
      int col = gl_InstanceID % int(uCellCount.x);
      int row = gl_InstanceID / int(uCellCount.x);
      vec2 cellCoordCells = vec2(col, row);
      vec2 colorUv = (cellCoordCells + 0.5) / uCellCount;

      vec4 color = textureLod(uCellColors, colorUv, 0.0);
      vec2 lumaRange = textureLod(uLumaRange, vec2(0.5), 0.0).rg;
      float lumaNorm = clamp(
        (dot(color.rgb, LUMA) - lumaRange.r) / (lumaRange.g - lumaRange.r),
        0.0,
        1.0
      );
      float halftoneRadiusPx = sqrt(lumaNorm) * CELL_SIZE * 0.5;
      vec2 cellPosPx = (cellCoordCells + 0.5) * PITCH;

      vec2 dropData = texelFetch(uDropMap, ivec2(col, row), 0).rg;
      float releaseTimeNorm = dropData.r;
      float cellDistCells = dropData.g; // Manhattan distance from drop center (0, 1, or 2)
      bool isDropCenter = cellDistCells < 0.5;
      float elapsedNorm = max(0.0, uTimeNorm - releaseTimeNorm);
      float fallProgressNorm = clamp(elapsedNorm / FALL_WINDOW, 0.0, 1.0);
      float splashElapsedNorm = elapsedNorm - FALL_WINDOW;
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
        vec2 quadOffsetPx = aPosition * 0.5 * PITCH;
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

        posPx += stretchedPos * 0.5 * PITCH * perspectiveScale;
        vOffsetPx = stretchedPos * 0.5 * PITCH * perspectiveScale;
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
        vec2 quadOffsetPx = aPosition * 0.5 * PITCH * rippleScale;
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
      vec2 quadOffsetPx = aPosition * 0.5 * PITCH;
      vOffsetPx = quadOffsetPx;
      gl_Position = vec4((cellPosPx + quadOffsetPx) / uViewportPx * 2.0 - 1.0, 0.0, 1.0);
    }
    `,
    `#version 300 es
    precision highp float;

    flat in vec4 vColor;
    flat in float vRadiusPx;
    flat in float vOpacityNorm;
    flat in float vDropHeightNorm;
    flat in vec2 vRadialDir;
    flat in float vSplashNorm;
    in vec2 vOffsetPx;

    out vec4 fragColor;

    void main() {
      float distPx = length(vOffsetPx);

      if (vSplashNorm >= 0.0) {
        // Landed: draw solid circle + expanding ripple ring
        float circle = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, distPx);

        // Ripple: expanding ring from radius outward
        float rippleRadiusPx = vRadiusPx + vSplashNorm * vRadiusPx * 6.0;
        float ringWidthPx = 1.5;
        float ring = smoothstep(rippleRadiusPx - ringWidthPx, rippleRadiusPx, distPx)
                   * smoothstep(rippleRadiusPx + ringWidthPx, rippleRadiusPx, distPx);
        float rippleAlpha = ring * (1.0 - vSplashNorm);

        float a = circle * vOpacityNorm;
        vec3 col = vColor.rgb * a + vColor.rgb * rippleAlpha * (1.0 - a);
        float alpha = a + rippleAlpha * (1.0 - a);
        fragColor = vec4(col, alpha);
      } else if (vDropHeightNorm > 0.001) {
        // Still falling: motion blur + sphere shading
        float stretch = 1.0 + vDropHeightNorm * 2.0;
        float radialCompPx = dot(vOffsetPx, vRadialDir);
        float tangentCompPx = dot(vOffsetPx, vec2(-vRadialDir.y, vRadialDir.x));
        vec2 compressedPx = vec2(radialCompPx / stretch, tangentCompPx);
        float compDistPx = length(compressedPx);
        float circle = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, compDistPx);

        vec2 nxy = compressedPx / max(vRadiusPx, 0.001);
        float r2 = dot(nxy, nxy);
        float nz = sqrt(max(0.0, 1.0 - r2));
        vec3 lightDir = normalize(vec3(-0.4, 0.5, 0.8));
        vec3 normal = vec3(nxy, nz);
        float diffuse = max(dot(normal, lightDir), 0.0);
        float shading = mix(0.5 + 0.5 * diffuse, 1.0, vDropHeightNorm);

        fragColor = vec4(vColor.rgb * shading * circle * vOpacityNorm, circle * vOpacityNorm);
      } else {
        // Phase A: flat circles
        float circle = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, distPx);
        fragColor = vec4(vColor.rgb * circle * vOpacityNorm, circle * vOpacityNorm);
      }
    }
    `
  );

  // Cache uniform locations
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), ctx.cols, ctx.rows);
  gl.uniform2f(gl.getUniformLocation(program, "uViewportPx"), ctx.canvasWidth, ctx.canvasHeight);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColors"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRange"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uDropMap"), 2);
  gl.useProgram(null);

  const uTime = gl.getUniformLocation(program, "uTimeNorm")!;
  const uPhase = gl.getUniformLocation(program, "uPhase")!;
  const totalInstances = ctx.cols * ctx.rows;

  const dropMapData = generateDropMap(ctx.cols, ctx.rows);

  const dropMapTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, dropMapTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, ctx.cols, ctx.rows, 0, gl.RG, gl.FLOAT, dropMapData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    durationMs: DURATION_MS,
    easing: (t: number) => t,
    prepareRender: (_durationMs: number) => {
      return (t: number) => {
        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.uniform1f(uTime, t);

        // Pass A: fading out current cells
        gl.uniform1i(uPhase, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.reduceSteps[ctx.current.reduceSteps.length - 1].texture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, dropMapTex);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);

        // Pass B: rain drops falling in
        gl.uniform1i(uPhase, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.reduceSteps[ctx.next.reduceSteps.length - 1].texture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, dropMapTex);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);
        gl.disable(gl.BLEND);
      };
    },
    dispose: () => {
      gl.deleteTexture(dropMapTex);
      gl.deleteProgram(program);
    },
  };
}
