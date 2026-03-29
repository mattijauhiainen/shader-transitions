import fullscreenQuadVert from "../fullscreenQuad.vert.glsl" with { type: "text" };
import { LUMA } from "../luma.ts";
import {
  CELL_SIZE,
  type HalftoneFrame,
  PITCH,
  type RendererContext,
  type Transition,
} from "../renderer.ts";
import fragSrc from "./mitosis.frag.glsl" with { type: "text" };

const LEVEL_DURATION = 0.65;
// Pause at the peak level between ascent and descent, during which
// colors crossfade from A to B. Expressed in the same time units as
// LEVEL_DURATION (normalized to [0,1] together with all other times).
const CROSSFADE_GAP = 0.3;

export function createMitosisTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;

  // How many merges we could do at most given the initial grid size
  const maxLevels = Math.ceil(Math.log2(Math.max(ctx.cols, ctx.rows)));
  const peakLevel = Math.max(1, maxLevels - 5);
  const totalLevels = peakLevel * 2;

  const program = ctx.createProgram(fullscreenQuadVert, fragSrc);

  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "uGridSize"),
    ctx.cols,
    ctx.rows,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
  gl.uniform3f(gl.getUniformLocation(program, "uLuma"), LUMA[0], LUMA[1], LUMA[2]);
  gl.uniform1i(gl.getUniformLocation(program, "uPeakLevel"), peakLevel);
  gl.uniform1i(gl.getUniformLocation(program, "uTotalLevels"), totalLevels);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColorsA"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColorsB"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
  gl.uniform1i(gl.getUniformLocation(program, "uMergeTimes"), 4);
  gl.useProgram(null);

  const uTime = gl.getUniformLocation(program, "uTime")!;
  const uLevelDuration = gl.getUniformLocation(program, "uLevelDuration")!;
  let mippedTexA: WebGLTexture | null = null;
  let mippedTexB: WebGLTexture | null = null;
  let mergeTex: WebGLTexture | null = null;

  return {
    // Each level takes ~8s wall-clock time, covering its ascent/descent
    // pair plus a share of the crossfade gap at the peak.
    durationMs: peakLevel * 8_000,
    prepareRender(_durationMs: number) {
      if (mippedTexA) gl.deleteTexture(mippedTexA);
      mippedTexA = createMippedTexture(gl, ctx.cols, ctx.rows, ctx.current);

      if (mippedTexB) gl.deleteTexture(mippedTexB);
      mippedTexB = createMippedTexture(gl, ctx.cols, ctx.rows, ctx.next);

      if (mergeTex) gl.deleteTexture(mergeTex);
      const { data: mergeData, normalizedDuration } = generateMergeData(
        ctx.cols,
        ctx.rows,
        peakLevel,
      );

      // Upload merge timing data as a texture — WebGL2 has no large random-access
      // buffer (SSBOs are WebGPU-only, UBOs cap at ~16KB), so we abuse a texture
      // as a flat data array the shader can index into.
      mergeTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, mergeTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        ctx.cols,
        ctx.rows * totalLevels,
        0,
        gl.RED,
        gl.FLOAT,
        mergeData,
      );
      // NEAREST: return exact texel values — interpolating between neighboring
      // cells' start times would produce meaningless numbers.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      // CLAMP_TO_EDGE: prevent UV precision errors from wrapping to the
      // opposite edge of the texture.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      return (t: number) => {
        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, mippedTexA);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, mippedTexB);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, mergeTex);

        gl.uniform1f(uTime, t);
        gl.uniform1f(uLevelDuration, normalizedDuration);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
    },
    dispose() {
      if (mippedTexA) {
        gl.deleteTexture(mippedTexA);
        mippedTexA = null;
      }
      if (mippedTexB) {
        gl.deleteTexture(mippedTexB);
        mippedTexB = null;
      }
      if (mergeTex) {
        gl.deleteTexture(mergeTex);
        mergeTex = null;
      }
    },
  };
}

function createMippedTexture(
  gl: WebGL2RenderingContext,
  cols: number,
  rows: number,
  frame: HalftoneFrame,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.NEAREST_MIPMAP_NEAREST,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.cellFbo);
  gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, cols, rows, 0);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/**
 * Generates the complete merge timing data for the mitosis transition.
 * Produces ascent maps (A-frame merging up), descent maps (B-frame splitting
 * down), normalizes all times to [0, 1], and packs into a flat array for
 * texture upload.
 *
 * @param cols - Grid width in cells
 * @param rows - Grid height in cells
 * @param peakLevel - Number of levels to ascend/descend
 * @returns Packed R32F data and the normalized level duration for the shader
 */
function generateMergeData(
  cols: number,
  rows: number,
  peakLevel: number,
): { data: Float32Array; normalizedDuration: number } {
  const ascentMaps = generateMergeMaps(cols, rows, peakLevel);
  const descentMaps = generateDescentMergeMaps(
    cols,
    rows,
    peakLevel,
    ascentMaps,
  );

  // Normalize all start times and duration to [0, 1]
  let maxTime = 0;
  const lastDescent = descentMaps[peakLevel - 1];
  for (let i = 0; i < lastDescent.length; i++) {
    const end = lastDescent[i] + LEVEL_DURATION;
    if (end > maxTime) maxTime = end;
  }
  if (maxTime > 0) {
    for (const level of ascentMaps) {
      for (let i = 0; i < level.length; i++) level[i] /= maxTime;
    }
    for (const level of descentMaps) {
      for (let i = 0; i < level.length; i++) level[i] /= maxTime;
    }
  }

  return {
    data: packMergeTexture(ascentMaps, descentMaps, cols, rows),
    normalizedDuration: LEVEL_DURATION / maxTime,
  };
}

/**
 * Generates start-time maps for a quadtree merge animation. The output is an
 * array of Float32Arrays — one per level — each of size `cols × rows`. Every
 * cell gets a start time for when its group begins merging at that level.
 * Duration is constant ({@link LEVEL_DURATION}) so the shader computes
 * end = start + duration.
 *
 * At level 0, a noise field staggers the start times to create a spatial
 * wavefront. At higher levels, the cascade constraint alone drives timing:
 * a group only begins after all its children have finished.
 *
 * Times are NOT normalized — the caller is responsible for normalization
 * after chaining ascent and descent.
 *
 * @param cols - Grid width in cells
 * @param rows - Grid height in cells
 * @param numLevels - How many merge levels to generate (level 0 = individual
 *   cells merging into 2×2, level 1 = 2×2 into 4×4, etc.)
 * @returns One Float32Array per level, indexed as `result[level][row * cols + col]`
 */
function generateMergeMaps(
  cols: number,
  rows: number,
  numLevels: number,
): Float32Array[] {
  const result: Float32Array[] = [];
  const seed = (Math.random() * 2147483647) | 0;

  let prevGroupEnds: number[] | null = null;
  let levelCols = cols;
  let levelRows = rows;

  for (let level = 0; level < numLevels; level++) {
    const groupCols = Math.floor(levelCols / 2);
    const groupRows = Math.floor(levelRows / 2);
    const numGroups = groupCols * groupRows;
    const groupStarts = new Array<number>(numGroups);
    const groupEnds = new Array<number>(numGroups);

    for (let groupRow = 0; groupRow < groupRows; groupRow++) {
      for (let groupCol = 0; groupCol < groupCols; groupCol++) {
        const groupIndex = groupRow * groupCols + groupCol;
        let earliest = 0;

        if (prevGroupEnds) {
          // Last group in each dimension must also check orphan children
          const maxDy =
            groupRow === groupRows - 1 ? levelRows - groupRow * 2 : 2;
          const maxDx =
            groupCol === groupCols - 1 ? levelCols - groupCol * 2 : 2;
          for (let dy = 0; dy < maxDy; dy++) {
            for (let dx = 0; dx < maxDx; dx++) {
              const childIndex =
                (groupRow * 2 + dy) * levelCols + (groupCol * 2 + dx);
              earliest = Math.max(earliest, prevGroupEnds[childIndex]);
            }
          }
        }

        let delay = 0;
        if (level === 0) {
          delay = valueNoise(
            groupCol,
            groupRow,
            Math.max(groupCols, groupRows) / 3,
            seed,
          ) * 2;
        }

        groupStarts[groupIndex] = earliest + delay;
        groupEnds[groupIndex] = earliest + delay + LEVEL_DURATION;
      }
    }

    // Map group times back to original grid resolution
    const scale = 2 ** (level + 1);
    const startMap = new Float32Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const groupCol = Math.min(Math.floor(col / scale), groupCols - 1);
        const groupRow = Math.min(Math.floor(row / scale), groupRows - 1);
        startMap[row * cols + col] = groupStarts[groupRow * groupCols + groupCol];
      }
    }
    result.push(startMap);

    prevGroupEnds = groupEnds;
    levelCols = groupCols;
    levelRows = groupRows;
  }

  return result;
}

/**
 * Generates descent start-time maps by running the same cascade as
 * {@link generateMergeMaps} (preserving the wavefront property), then
 * reversing both time and level order so large groups split first.
 * The descent is chained onto the ascent: each cell's descent starts
 * after its ascent ends plus a small crossfade gap.
 *
 * @param cols - Grid width in cells
 * @param rows - Grid height in cells
 * @param peakLevel - Number of descent levels to generate
 * @param ascentMaps - Start-time maps from {@link generateMergeMaps} for the ascent phase
 * @returns One Float32Array per descent level, same layout as generateMergeMaps
 */
function generateDescentMergeMaps(
  cols: number,
  rows: number,
  peakLevel: number,
  ascentMaps: Float32Array[],
): Float32Array[] {
  // Derive per-cell ascent end times from the last ascent level
  const lastAscent = ascentMaps[peakLevel - 1];
  const ascentEndPerCell = new Float32Array(lastAscent.length);
  for (let i = 0; i < lastAscent.length; i++) {
    ascentEndPerCell[i] = lastAscent[i] + LEVEL_DURATION;
  }

  const forwardMaps = generateMergeMaps(cols, rows, peakLevel);

  // Find the max time for these levels
  let maxEnd = 0;
  const lastLevel = forwardMaps[peakLevel - 1];
  for (let i = 0; i < lastLevel.length; i++) {
    const end = lastLevel[i] + LEVEL_DURATION;
    if (end > maxEnd) maxEnd = end;
  }

  const crossfadeGap = CROSSFADE_GAP;
  const result: Float32Array[] = [];
  // Reverse the forward map. Walk the levels from last one
  // to the first one, and assign reversed times to the result
  // array.
  for (let srcLevel = peakLevel - 1; srcLevel >= 0; srcLevel--) {
    const fwdStart = forwardMaps[srcLevel];
    const start = new Float32Array(fwdStart.length);
    for (let i = 0; i < start.length; i++) {
      start[i] =
        // Take the end time of this cell's ascent
        ascentEndPerCell[i] +
        // Add little gap to it so that it sits at
        // the max level for a bit
        crossfadeGap +
        // Take max time for the levels we are reversing, and
        // subtract the start time of this cell + duration from
        // it to get the reversed start time. E.g. if this was
        // last cell to merge in the forward map, fwdStart[i] +
        // LEVEL_DURATION === maxEnd, and we get zero, making
        // this the first cell to start its animation.
        maxEnd - (fwdStart[i] + LEVEL_DURATION);
    }
    result.push(start);
  }

  return result;
}

/**
 * Packs ascent and descent start-time maps into a single R32F Float32Array
 * for upload to a texture. Each texel stores the start time for one cell at
 * one level. Every level is the same size (cols × rows) so the shader can
 * look up any cell at any level with the same UV.x and an offset on UV.y.
 * Higher levels have fewer unique groups, so many adjacent cells store
 * duplicate values (e.g. at level 3 each 16×16 block shares the same times).
 *
 * Texture layout (width = cols, height = rows × totalLevels):
 *
 * ```
 *  ┌─────────────────────────┐ ─┐
 *  │  ascent level 0         │  │
 *  │  (cells → 2×2 groups)   │  │
 *  ├─────────────────────────┤  │ peakLevel
 *  │  ascent level 1         │  │  × rows
 *  │  (2×2 → 4×4 groups)     │  │
 *  ├─────────────────────────┤  │
 *  │  ...                    │  │
 *  ├─────────────────────────┤ ─┤
 *  │  descent level 0        │  │
 *  │  (splits peak groups)   │  │
 *  ├─────────────────────────┤  │ peakLevel
 *  │  descent level 1        │  │  × rows
 *  │  (splits next smaller)  │  │
 *  ├─────────────────────────┤  │
 *  │  ...                    │  │
 *  └─────────────────────────┘ ─┘
 *  ◄────── cols ──────►
 * ```
 *
 * @param ascentMaps - Start-time maps for the ascent phase (A-frame merging up)
 * @param descentMaps - Start-time maps for the descent phase (B-frame splitting down)
 * @param cols - Grid width in cells
 * @param rows - Grid height in cells
 * @returns Float array of start times, ready for `gl.texImage2D` with R32F format
 */
function packMergeTexture(
  ascentMaps: Float32Array[],
  descentMaps: Float32Array[],
  cols: number,
  rows: number,
): Float32Array {
  const peakLevel = ascentMaps.length;
  const totalLevels = peakLevel * 2;
  const cellCount = cols * rows;
  const mergeData = new Float32Array(cellCount * totalLevels);

  for (let level = 0; level < peakLevel; level++) {
    mergeData.set(ascentMaps[level], level * cellCount);
  }
  for (let level = 0; level < peakLevel; level++) {
    mergeData.set(descentMaps[level], (peakLevel + level) * cellCount);
  }

  return mergeData;
}

// Value noise: smooth random field sampled at (x, y) with given frequency
function valueNoise(
  x: number,
  y: number,
  freq: number,
  seed: number,
): number {
  const fx = x / freq;
  const fy = y / freq;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  // Smoothstep interpolation
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const n00 = hash2d(ix, iy, seed);
  const n10 = hash2d(ix + 1, iy, seed);
  const n01 = hash2d(ix, iy + 1, seed);
  const n11 = hash2d(ix + 1, iy + 1, seed);
  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

// Simple seeded hash for repeatable 2D noise
function hash2d(x: number, y: number, seed: number): number {
  let h = seed + x * 374761393 + y * 668265263;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
