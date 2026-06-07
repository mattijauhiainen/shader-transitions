import { LUMA } from "../../luma.ts";
import {
  CELL_SIZE,
  PITCH,
  type RendererContext,
  type Transition,
} from "../../renderer.ts";
import { smoothstep } from "../../smoothstep.ts";
import fragSrc from "./hyperdrive.frag.glsl" with { type: "text" };
import vertSrc from "./hyperdrive.vert.glsl" with { type: "text" };

export function createHyperdriveTransition(ctx: RendererContext): Transition {
  const gl = ctx.gl;
  const program = ctx.createProgram(vertSrc, fragSrc);

  const focalLen = ctx.canvasWidth * 0.5;
  const NEAR_CLIP = 1.0;

  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "uGRID_SIZE"),
    ctx.cols,
    ctx.rows,
  );
  gl.uniform2f(
    gl.getUniformLocation(program, "uVIEWPORT"),
    ctx.canvasWidth,
    ctx.canvasHeight,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uCELL_SIZE"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPITCH"), PITCH);
  gl.uniform3f(
    gl.getUniformLocation(program, "uLUMA"),
    LUMA[0],
    LUMA[1],
    LUMA[2],
  );
  gl.uniform1f(gl.getUniformLocation(program, "uFOCAL_LEN"), focalLen);
  gl.uniform1i(gl.getUniformLocation(program, "uCELL_COLORS"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "uLUMA_RANGE"), 1);
  gl.uniform1f(gl.getUniformLocation(program, "uNEAR_CLIP"), NEAR_CLIP);
  gl.useProgram(null);

  const uCamZ = gl.getUniformLocation(program, "uCamZ")!;
  const uPlaneZ = gl.getUniformLocation(program, "uPlaneZ")!;
  const uSphereShading = gl.getUniformLocation(program, "uSphereShading")!;
  const uPlaneAlpha = gl.getUniformLocation(program, "uPlaneAlpha")!;
  const uFar = gl.getUniformLocation(program, "uFar")!;
  const uRainbowMix = gl.getUniformLocation(program, "uRainbowMix")!;
  const uCamRollCS = gl.getUniformLocation(program, "uCamRollCS")!;
  const uVisibleOffset = gl.getUniformLocation(program, "uVisibleOffset")!;
  const uVisibleSize = gl.getUniformLocation(program, "uVisibleSize")!;

  // Circle mesh (triangle fan: center + ring)
  const SEGMENTS = 12;
  const verts = new Float32Array((SEGMENTS + 2) * 2);
  verts[0] = 0;
  verts[1] = 0;
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    verts[(i + 1) * 2] = Math.cos(a);
    verts[(i + 1) * 2 + 1] = Math.sin(a);
  }
  const vertexCount = SEGMENTS + 2;

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Plane layout: variable spacing
  // Spacing is large at the edges (next plane invisible) and shrinks toward
  // the midpoint (planes flash by). The camera moves at roughly constant
  // speed so the visual acceleration comes entirely from the spacing.
  const TOTAL_PLANES = 80;
  const S_MAX = focalLen;
  const S_MIN = focalLen * 0.05;
  const MAX_VISIBLE = 10;

  // Precompute plane Z positions. Spacing follows a geometric progression
  // from S_MAX at the edges to S_MIN at the midpoint, then back to S_MAX.
  // The power curve (RAMP_BIAS < 1) makes spacing drop to S_MIN quickly,
  // so the closely-packed phase is much longer than the initial approach.
  const RAMP_BIAS = 0.3;
  const planeZ: number[] = [0];
  for (let i = 0; i < TOTAL_PLANES - 1; i++) {
    // Linear goes from 0 to 1 to 0, peaking in the middle
    const linear =
      1 - Math.abs(2 * i - (TOTAL_PLANES - 2)) / (TOTAL_PLANES - 2);
    // Raise it to ramp bias to ramp it up faster to 1
    const distFromEdge = linear ** RAMP_BIAS;
    // Log-space interpolation
    const spacing = S_MAX * (S_MIN / S_MAX) ** distFromEdge;
    planeZ.push(planeZ[i] + spacing);
  }

  // Camera travels from viewing-distance before plane 0 to viewing-distance
  // before the last plane (which it does NOT pass through — it's the
  // destination image).
  const camStart = -focalLen;
  const totalTravel = planeZ[TOTAL_PLANES - 1];

  const halfW = ctx.canvasWidth * 0.5;
  const halfH = ctx.canvasHeight * 0.5;

  // Compute the visible sub-rectangle of the grid at a given depth and
  // camera roll. Near planes are magnified by perspective, so most of the
  // grid is off-screen — drawing only the visible portion avoids launching
  // thousands of GPU instances that produce no visible pixels.
  //
  // When the camera is rolled, the viewport rectangle rotates in world
  // space. We expand to the axis-aligned bounding box of the rotated
  // viewport so no visible dots are missed.
  function visibleRegion(
    depth: number,
    absCosR: number,
    absSinR: number,
  ): { startCol: number; startRow: number; visCols: number; visRows: number } {
    // Bounding box half-extents of the viewport rotated by -camRoll.
    // For a rectangle [-hw,hw]x[-hh,hh] rotated by angle a:
    //   bbHalfX = hw*|cos a| + hh*|sin a|
    const cosR = absCosR;
    const sinR = absSinR;
    const bbHalfX = halfW * cosR + halfH * sinR;
    const bbHalfY = halfW * sinR + halfH * cosR;

    // Inverse-project from screen to world at this depth
    const worldHalfX = (bbHalfX * depth) / focalLen;
    const worldHalfY = (bbHalfY * depth) / focalLen;

    // Convert to column/row counts from grid center (+1 margin for partially visible dots)
    const halfCols = Math.ceil(worldHalfX / PITCH) + 1;
    const halfRows = Math.ceil(worldHalfY / PITCH) + 1;
    const centerCol = ctx.cols * 0.5;
    const centerRow = ctx.rows * 0.5;

    const startCol = Math.max(0, Math.floor(centerCol - halfCols));
    const startRow = Math.max(0, Math.floor(centerRow - halfRows));
    const endCol = Math.min(ctx.cols, Math.ceil(centerCol + halfCols));
    const endRow = Math.min(ctx.rows, Math.ceil(centerRow + halfRows));

    return {
      startCol,
      startRow,
      visCols: endCol - startCol,
      visRows: endRow - startRow,
    };
  }

  return {
    durationMs: 30000,
    prepareRender: (_durationMs: number) => {
      return (t: number) => {
        // Camera Z position
        const camZ = camStart + totalTravel * cruiseProfile(t);

        // Find first plane ahead of camera (linear scan, ≤40 planes)
        let firstAhead = TOTAL_PLANES;
        for (let i = 0; i < TOTAL_PLANES; i++) {
          if (planeZ[i] >= camZ) {
            firstAhead = i;
            break;
          }
        }

        // Sphere shading: fade in as camera approaches plane 0, then stay on
        // during the tunnel. The last plane is always forced flat per-draw via
        // the isLastPlane check below.
        const sphereShading =
          firstAhead === 0 ? Math.max(0, 1 - (planeZ[0] - camZ) / focalLen) : 1;

        // Compute farDist so that we can clip planes that don't need to be
        // visible in the shader.
        const lastVisible = Math.min(
          firstAhead + MAX_VISIBLE - 1,
          TOTAL_PLANES - 1,
        );
        const farDist =
          firstAhead < TOTAL_PLANES
            ? planeZ[lastVisible] - camZ + focalLen
            : focalLen;

        // GL state
        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.canvasWidth, ctx.canvasHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        // Rainbow unicorn magic
        const RAINBOW_START = 0.35;
        const RAINBOW_END = 0.75;
        const RAINBOW_FADE = (RAINBOW_END - RAINBOW_START) * 0.33;
        let rainbowMix = 0;
        if (t > RAINBOW_START && t < RAINBOW_END) {
          const fadeIn = Math.min(1, (t - RAINBOW_START) / RAINBOW_FADE);
          const fadeOut = Math.min(1, (RAINBOW_END - t) / RAINBOW_FADE);
          rainbowMix = Math.min(fadeIn, fadeOut);
        }

        // Roll the camera 360 degrees in the middle of the timeline
        const ROLL_START = 0.3;
        const ROLL_END = 0.85;
        let rollProgress = 0;
        if (t > ROLL_START && t < ROLL_END) {
          const u = (t - ROLL_START) / (ROLL_END - ROLL_START);
          rollProgress = smoothstep(u);
        } else if (t >= ROLL_END) {
          rollProgress = 1;
        }
        const camRoll = rollProgress * Math.PI * 2;
        const cosR = Math.cos(camRoll);
        const sinR = Math.sin(camRoll);

        gl.uniform1f(uCamZ, camZ);
        gl.uniform1f(uFar, farDist);
        gl.uniform1f(uRainbowMix, rainbowMix);
        gl.uniform2f(uCamRollCS, cosR, sinR);

        gl.bindVertexArray(vao);

        // Draw visible planes. Do this back to front so that far planes appear
        // behind the near planes.
        const endIdx = Math.min(firstAhead + MAX_VISIBLE, TOTAL_PLANES);
        for (let i = endIdx - 1; i >= firstAhead; i--) {
          // If the plane is too close or too far to the camera, don't draw it
          const depth = planeZ[i] - camZ;
          if (depth < NEAR_CLIP || depth > farDist) continue;

          // Skip planes whose largest dot would be < 1 screen pixel
          const maxScreenRadius = (CELL_SIZE * 0.5 * focalLen) / depth;
          if (maxScreenRadius < 0.5) continue;

          // Depth-based fade: planes near the far edge of the visible
          // range fade in smoothly rather than popping in at full alpha.
          const FADE_NEAR = focalLen * 1.01;
          const FADE_FAR = focalLen * 2.5;
          let alpha = Math.min(
            1,
            Math.max(0, (FADE_FAR - depth) / (FADE_FAR - FADE_NEAR)),
          );

          // Before crossing plane 0, gate visibility so the tunnel only reveals
          // once the camera is close to the first plane. Do this so that we can
          // seamlessly transition from previous transition into this one. If we
          // didn't, there would be a weird rectangle popping into existence
          // behind this image that would partially show due to the transparency
          // between the halftone dots.
          const REVEAL_START = 0.6;
          if (firstAhead === 0 && i > 0) {
            const progress = 1 - (planeZ[0] - camZ) / focalLen;
            const gatedProgress = Math.max(
              0,
              (progress - REVEAL_START) / (1 - REVEAL_START),
            );
            alpha *= gatedProgress;
          }

          // First half uses frame A, rest uses frame B
          const useB = i >= TOTAL_PLANES / 2;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(
            gl.TEXTURE_2D,
            useB ? ctx.next.cellTex : ctx.current.cellTex,
          );
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(
            gl.TEXTURE_2D,
            useB ? ctx.next.lumaRangeTex : ctx.current.lumaRangeTex,
          );

          // Frustum cull: only draw the grid cells visible at this depth
          const region = visibleRegion(depth, Math.abs(cosR), Math.abs(sinR));
          const instanceCount = region.visCols * region.visRows;
          if (instanceCount <= 0) continue;

          const isLastPlane = i === TOTAL_PLANES - 1;
          gl.uniform2f(uVisibleOffset, region.startCol, region.startRow);
          gl.uniform2f(uVisibleSize, region.visCols, region.visRows);
          gl.uniform1f(uSphereShading, isLastPlane ? 0 : sphereShading);
          gl.uniform1f(uPlaneZ, planeZ[i]);
          gl.uniform1f(uPlaneAlpha, alpha);
          gl.drawArraysInstanced(
            gl.TRIANGLE_FAN,
            0,
            vertexCount,
            instanceCount,
          );
        }

        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      };
    },
    dispose: () => {
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}

/**
 * Quick ramp to constant speed, cruise, quick ramp down. The ramp phases
 * each take RAMP fraction of the timeline — the rest is linear cruise.
 */
function cruiseProfile(t: number): number {
  const RAMP = 0.05;
  const V = 1 / (1 - RAMP); // cruise velocity (normalized so p(1) = 1)
  if (t < RAMP) {
    return (V * t * t) / (2 * RAMP);
  }
  if (t > 1 - RAMP) {
    const u = 1 - t;
    return 1 - (V * u * u) / (2 * RAMP);
  }
  return (V * RAMP) / 2 + V * (t - RAMP);
}
