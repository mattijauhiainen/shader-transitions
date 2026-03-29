import { LUMA } from "../luma.ts";
import { CELL_SIZE, PITCH, type RendererContext, type Transition } from "../renderer.ts";

const WALK_WINDOW = 0.10;
const NUM_WALKERS = 24;

import { fullscreenQuadVert } from "../fullscreenQuadVert.ts";

export function createWalkTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(fullscreenQuadVert, `#version 300 es
  precision highp float;
  uniform sampler2D uCellColorsA;
  uniform sampler2D uLumaRangeA;
  uniform sampler2D uCellColorsB;
  uniform sampler2D uLumaRangeB;
  uniform sampler2D uVisitMap;
  uniform vec2 uGridSize;

  #define CELL_SIZE ${CELL_SIZE.toFixed(1)}
  #define PITCH ${PITCH.toFixed(1)}
  #define LUMA vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})
  uniform float uTime;
  uniform float uWindow;

  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    vec2 cellCoord = floor(gl_FragCoord.xy / PITCH);
    vec2 cellCenter = (cellCoord + 0.5) * PITCH;
    vec2 uv = (cellCoord + 0.5) / uGridSize;
    float dist = length(gl_FragCoord.xy - cellCenter);

    float visitTime = texture(uVisitMap, uv).r;
    float cellT = smoothstep(visitTime, visitTime + uWindow, uTime);

    vec4 colorA = texture(uCellColorsA, uv);
    vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
    float normA = (dot(colorA.rgb, LUMA) - rangeA.r) / (rangeA.g - rangeA.r);

    float scaleA = 1.0 - cellT;
    float radiusA = sqrt(normA) * CELL_SIZE * 0.5 * scaleA;
    float alphaA = smoothstep(radiusA + 0.5, radiusA - 0.5, dist);

    vec4 colorB = texture(uCellColorsB, uv);
    vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
    float normB = (dot(colorB.rgb, LUMA) - rangeB.r) / (rangeB.g - rangeB.r);

    float scaleB = cellT;
    float radiusB = sqrt(normB) * CELL_SIZE * 0.5 * scaleB;
    float alphaB = smoothstep(radiusB + 0.5, radiusB - 0.5, dist);

    vec4 bg = vec4(0.0, 0.0, 0.0, 1.0);
    fragColor = mix(mix(bg, vec4(colorA.rgb, 1.0), alphaA), vec4(colorB.rgb, 1.0), alphaB);
  }
  `);

  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uGridSize"), ctx.cols, ctx.rows);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColorsA"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "uCellColorsB"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
  gl.uniform1i(gl.getUniformLocation(program, "uVisitMap"), 4);
  gl.useProgram(null);

  const uTime = gl.getUniformLocation(program, "uTime")!;
  const uWindow = gl.getUniformLocation(program, "uWindow")!;

  const visitMapTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, visitMapTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    durationMs: 2500,
    prepareRender(_durationMs: number) {
      const visitTime = computeWalkMap(ctx.cols, ctx.rows);
      gl.bindTexture(gl.TEXTURE_2D, visitMapTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, ctx.cols, ctx.rows, 0, gl.RED, gl.FLOAT, visitTime);
      gl.bindTexture(gl.TEXTURE_2D, null);

      return (t: number) => {
        gl.useProgram(program);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.cellTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.current.lumaRangeTex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.cellTex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, ctx.next.lumaRangeTex);

        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, visitMapTex);

        gl.uniform1f(uTime, t);
        gl.uniform1f(uWindow, WALK_WINDOW);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
    },
  };
}

function computeWalkMap(cols: number, rows: number): Float32Array {
  const totalCells = cols * rows;
  const visitTime = new Float32Array(totalCells).fill(-1);

  const walkerStacks: [number, number][][] = [];

  let step = 0;
  let visitedCount = 0;

  const gridCols = Math.round(Math.sqrt(NUM_WALKERS * cols / rows));
  const gridRows = Math.ceil(NUM_WALKERS / gridCols);
  for (let i = 0; i < NUM_WALKERS; i++) {
    const gx = i % gridCols;
    const gy = Math.floor(i / gridCols);
    const x0 = Math.floor(gx * cols / gridCols);
    const x1 = Math.floor((gx + 1) * cols / gridCols);
    const y0 = Math.floor(gy * rows / gridRows);
    const y1 = Math.floor((gy + 1) * rows / gridRows);
    const x = x0 + Math.floor(Math.random() * (x1 - x0));
    const y = y0 + Math.floor(Math.random() * (y1 - y0));
    const idx = y * cols + x;
    if (visitTime[idx] < 0) {
      visitTime[idx] = 0;
      visitedCount++;
    }
    walkerStacks.push([[x, y]]);
  }

  const directions: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  while (visitedCount < totalCells) {
    step++;
    for (const stack of walkerStacks) {
      while (stack.length > 0) {
        const [cx, cy] = stack[stack.length - 1];
        const neighbors: [number, number][] = [];
        for (const [dx, dy] of directions) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && visitTime[ny * cols + nx] < 0) {
            neighbors.push([nx, ny]);
          }
        }
        if (neighbors.length === 0) {
          stack.pop();
          continue;
        }
        const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
        visitTime[pick[1] * cols + pick[0]] = step;
        visitedCount++;
        stack.push(pick);
        break;
      }
      if (stack.length === 0 && visitedCount < totalCells) {
        let idx: number;
        do {
          idx = Math.floor(Math.random() * totalCells);
        } while (visitTime[idx] >= 0);
        const x = idx % cols;
        const y = Math.floor(idx / cols);
        visitTime[idx] = step;
        visitedCount++;
        stack.push([x, y]);
      }
    }
  }

  const maxStep = step;
  for (let i = 0; i < totalCells; i++) {
    visitTime[i] = Math.max(0, visitTime[i]) / maxStep * (1 - WALK_WINDOW);
  }

  return visitTime;
}
