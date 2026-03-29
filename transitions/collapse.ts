import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";
import fragSrc from "./collapse.frag.glsl" with { type: "text" };
import vertSrc from "./collapse.vert.glsl" with { type: "text" };

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const VISIT_TIME_MAX = 0.9;

// Circular flood-fill from center, returning visit order in GL texture layout.
// Cells visited first (center) get low values, last (edges) get VISIT_TIME_MAX.
function generateVisitOrder(cols: number, rows: number): Float32Array {
  const total = cols * rows;

  const visited = new Uint8Array(total); // 0 = unvisited, 1 = in frontier/visited
  const visitTime = new Float32Array(total);

  // Frontier as a plain array with swap-remove for O(1) removal
  const frontier = new Int32Array(total);
  let frontierLen = 0;

  function addFrontier(col: number, row: number) {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    const cellKey = row * cols + col;
    if (visited[cellKey]) return;
    visited[cellKey] = 1;
    frontier[frontierLen++] = cellKey;
  }

  addFrontier(Math.floor(cols / 2), Math.floor(rows / 2));

  for (let step = 0; step < total; step++) {
    if (frontierLen === 0) break;

    // Pick a random frontier cell
    const pickedIdx = Math.floor(Math.random() * frontierLen);
    const pickedKey = frontier[pickedIdx];
    const pickedCol = pickedKey % cols;
    const pickedRow = Math.floor(pickedKey / cols);

    // Copy the last element in the frontier to the slot we just
    // picked, effectively shifting the array.
    frontier[pickedIdx] = frontier[--frontierLen];

    visitTime[pickedKey] = step / (total - 1);

    addFrontier(pickedCol - 1, pickedRow);
    addFrontier(pickedCol + 1, pickedRow);
    addFrontier(pickedCol, pickedRow - 1);
    addFrontier(pickedCol, pickedRow + 1);
  }

  // Write into GL texture layout (flip rows)
  const result = new Float32Array(total);
  for (let screenRow = 0; screenRow < rows; screenRow++) {
    const glRow = rows - 1 - screenRow;
    for (let col = 0; col < cols; col++) {
      result[glRow * cols + col] = visitTime[screenRow * cols + col] * VISIT_TIME_MAX;
    }
  }
  return result;
}

export function createCollapseTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;

  const OVERSCAN = 0.2; // 20% extra cells on each side
  const overscanCols = Math.ceil(ctx.cols * (1 + 2 * OVERSCAN));
  const overscanRows = Math.ceil(ctx.rows * (1 + 2 * OVERSCAN));
  const marginCols = Math.floor((overscanCols - ctx.cols) / 2);
  const marginRows = Math.floor((overscanRows - ctx.rows) / 2);

  const program = ctx.createProgram(vertSrc, fragSrc);

  // Cache all uniform locations at setup time
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uGridSize"), ctx.cols, ctx.rows);
  gl.uniform2f(gl.getUniformLocation(program, "uViewport"), ctx.canvasWidth, ctx.canvasHeight);
  gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
  gl.uniform3f(gl.getUniformLocation(program, "uLuma"), LUMA[0], LUMA[1], LUMA[2]);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColors"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRange"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uVisitMap"), 2);
  gl.useProgram(null);

  const uOverscanCount = gl.getUniformLocation(program, "uOverscanCount")!;
  const uMargin = gl.getUniformLocation(program, "uMargin")!;
  const uTime = gl.getUniformLocation(program, "uTime")!;
  const uOpacity = gl.getUniformLocation(program, "uOpacity")!;

  const totalInstances = overscanCols * overscanRows;
  const visibleInstances = ctx.cols * ctx.rows;
  const visitOrder = generateVisitOrder(overscanCols, overscanRows);

  // Allocate visit map texture (data uploaded in prepareRender)
  const visitMapTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, visitMapTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, overscanCols, overscanRows, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const FALL_TIME = 2.0; // seconds each cell needs to visibly fall

  return {
    durationMs: 8000,
    easing: (t: number) => t, // linear — the shader handles its own timing via elapsed seconds
    prepareRender: (durationMs: number) => {
      const durationS = durationMs / 1000;
      const releaseSpan = Math.max(0.1, durationS - FALL_TIME);

      // Scale visit map to seconds with power curve (slow center stagger, fast edges)
      const scaledVisitOrder = new Float32Array(visitOrder.length);
      for (let i = 0; i < visitOrder.length; i++) {
        const normalized = visitOrder[i] / VISIT_TIME_MAX;
        const curved = Math.sqrt(normalized);
        scaledVisitOrder[i] = curved * releaseSpan;
      }
      gl.bindTexture(gl.TEXTURE_2D, visitMapTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, overscanCols, overscanRows, 0, gl.RED, gl.FLOAT, scaledVisitOrder);
      gl.bindTexture(gl.TEXTURE_2D, null);

      return (t: number) => {
        const elapsedSeconds = t * durationS;

        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, visitMapTex);

        // B-frame: fade in behind the falling A-frame (no fall, visible grid only)
        const bOpacity = smoothstep(0.85, 1.0, t);
        if (bOpacity > 0.001) {
          gl.uniform1f(uTime, -1000.0);
          gl.uniform1f(uOpacity, bOpacity);
          gl.uniform2f(uOverscanCount, ctx.cols, ctx.rows);
          gl.uniform2f(uMargin, 0, 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, visibleInstances);
        }

        // A-frame: falling dots with overscan (always restore overscan uniforms)
        gl.uniform2f(uOverscanCount, overscanCols, overscanRows);
        gl.uniform2f(uMargin, marginCols, marginRows);
        gl.uniform1f(uTime, elapsedSeconds);
        gl.uniform1f(uOpacity, 1.0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, totalInstances);
        gl.disable(gl.BLEND);
      };
    },
    dispose: () => {
      gl.deleteTexture(visitMapTex);
      gl.deleteProgram(program);
    },
  };
}
