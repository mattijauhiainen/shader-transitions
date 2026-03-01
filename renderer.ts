import { LUMA } from "./luma.ts";

const CELL_SIZE = 5.0;
const PITCH = 6.0;
const WALK_WINDOW = 0.10;

interface HalftoneFrame {
  cellTex: WebGLTexture;
  cellFbo: WebGLFramebuffer;
  reduceSteps: { texture: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }[];
}

export interface Transition {
  prepareRender(): (t: number) => void;
}

export class Renderer {
  private cols: number;
  private rows: number;
  private averageCellColors: {
    program: WebGLProgram;
    uImageSize: WebGLUniformLocation;
    uCanvasSize: WebGLUniformLocation;
  };
  private lumaRanges: {
    program: WebGLProgram;
    uInputSize: WebGLUniformLocation;
    uIsFirstStep: WebGLUniformLocation;
  };
  private radialRender: {
    program: WebGLProgram;
    uT: WebGLUniformLocation;
    uOrigin: WebGLUniformLocation;
  };
  private shrinkRender: {
    program: WebGLProgram;
    uT: WebGLUniformLocation;
  };
  private wipeRender: {
    program: WebGLProgram;
    uT: WebGLUniformLocation;
  };
  private walkRender: {
    program: WebGLProgram;
    uT: WebGLUniformLocation;
    uWindow: WebGLUniformLocation;
    visitMapTex: WebGLTexture;
  };
  private current: HalftoneFrame;
  private next: HalftoneFrame;
  private buffer: WebGLBuffer;
  private canvasWidth: number;
  private canvasHeight: number;

  constructor(
    private gl: WebGL2RenderingContext,
    width: number,
    height: number
  ) {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cols = Math.ceil(width / PITCH);
    this.rows = Math.ceil(height / PITCH);

    const vertSrc = `#version 300 es
      in vec2 aPosition;
      out vec2 vUV;
      void main() {
        vUV = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    const positions = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1,
    ]);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    this.averageCellColors = this.setupAverageCellColors(vertSrc);
    this.lumaRanges = this.setupLumaRanges(vertSrc);
    this.radialRender = this.setupRadialRender(vertSrc);
    this.shrinkRender = this.setupShrinkRender(vertSrc);
    this.wipeRender = this.setupWipeRender(vertSrc);
    this.walkRender = this.setupWalkRender(vertSrc);

    this.current = this.createHalftoneFrame();
    this.next = this.createHalftoneFrame();

    const loc = gl.getAttribLocation(this.radialRender.program, "aPosition");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private uploadImage(img: HTMLImageElement): WebGLTexture {
    const srcTex = this.gl.createTexture()!;
    this.gl.bindTexture(this.gl.TEXTURE_2D, srcTex);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, img);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    return srcTex;
  }

  prepareNext(img: HTMLImageElement): void {
    const srcTex = this.uploadImage(img);
    this.runAverageCellColors(srcTex, img, this.next);
    this.gl.deleteTexture(srcTex);
    this.runLumaRanges(this.next);
  }

  swap(): void {
    [this.current, this.next] = [this.next, this.current];
  }

  get transitions(): Transition[] {
    return [
      // {
      //   prepareRender: () => {
      //     const ox = this.canvasWidth * (0.25 + Math.random() * 0.5);
      //     const oy = this.canvasHeight * (0.25 + Math.random() * 0.5);
      //     return (t: number) => this.renderRadial(t, ox, oy);
      //   },
      // },
      // { prepareRender: () => (t: number) => this.renderShrink(t) },
      // { prepareRender: () => (t: number) => this.renderWipe(t) },
      {
        prepareRender: () => {
          this.prepareWalkTransition();
          return (t: number) => this.renderWalk(t);
        },
      },
    ];
  }

  private renderRadial(t: number, originX: number, originY: number): void {
    const gl = this.gl;

    gl.useProgram(this.radialRender.program);
    gl.uniform2f(this.radialRender.uOrigin, originX, originY);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
    gl.useProgram(this.radialRender.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.current.cellTex);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.current.reduceSteps[this.current.reduceSteps.length - 1].texture);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.next.cellTex);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.next.reduceSteps[this.next.reduceSteps.length - 1].texture);

    gl.uniform1f(this.radialRender.uT, t);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private renderShrink(t: number): void {
    const gl = this.gl;

    gl.useProgram(this.shrinkRender.program);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.current.cellTex);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.current.reduceSteps[this.current.reduceSteps.length - 1].texture);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.next.cellTex);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.next.reduceSteps[this.next.reduceSteps.length - 1].texture);

    gl.uniform1f(this.shrinkRender.uT, t);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private renderWipe(t: number): void {
    const gl = this.gl;

    gl.useProgram(this.wipeRender.program);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.current.cellTex);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.current.reduceSteps[this.current.reduceSteps.length - 1].texture);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.next.cellTex);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.next.reduceSteps[this.next.reduceSteps.length - 1].texture);

    gl.uniform1f(this.wipeRender.uT, t);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private prepareWalkTransition(): void {
    const gl = this.gl;
    const visitTime = this.computeWalkMap();
    gl.bindTexture(gl.TEXTURE_2D, this.walkRender.visitMapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.cols, this.rows, 0, gl.RED, gl.FLOAT, visitTime);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private renderWalk(t: number): void {
    const gl = this.gl;

    gl.useProgram(this.walkRender.program);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.current.cellTex);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.current.reduceSteps[this.current.reduceSteps.length - 1].texture);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.next.cellTex);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.next.reduceSteps[this.next.reduceSteps.length - 1].texture);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.walkRender.visitMapTex);

    gl.uniform1f(this.walkRender.uT, t);
    gl.uniform1f(this.walkRender.uWindow, WALK_WINDOW);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Compute a "visit time" for each pixel in our grid. Visit time is between
  // [0, 1] and the renderer will use the times to decide when cells need to
  // render when transitioning t between [0, 1].
  private computeWalkMap(): Float32Array {
    const totalCells = this.cols * this.rows;
    const visitTime = new Float32Array(totalCells).fill(-1);

    const NUM_WALKERS = 24;
    const walkerStacks: [number, number][][] = [];

    let step = 0;
    let visitedCount = 0;

    // Get starting positions for the walkers, divide the screen to NUM_WALKERS
    // rectangles and start each walker in a random position instead a rectangle.
    const gridCols = Math.round(Math.sqrt(NUM_WALKERS * this.cols / this.rows));
    const gridRows = Math.ceil(NUM_WALKERS / gridCols);
    for (let i = 0; i < NUM_WALKERS; i++) {
      const gx = i % gridCols;
      const gy = Math.floor(i / gridCols);
      const x0 = Math.floor(gx * this.cols / gridCols);
      const x1 = Math.floor((gx + 1) * this.cols / gridCols);
      const y0 = Math.floor(gy * this.rows / gridRows);
      const y1 = Math.floor((gy + 1) * this.rows / gridRows);
      const x = x0 + Math.floor(Math.random() * (x1 - x0));
      const y = y0 + Math.floor(Math.random() * (y1 - y0));
      const idx = y * this.cols + x;
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
          // Find unvisited neighbors
          for (const [dx, dy] of directions) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows && visitTime[ny * this.cols + nx] < 0) {
              neighbors.push([nx, ny]);
            }
          }
          // Backtrack to previous cell if we are in deadend
          if (neighbors.length === 0) {
            stack.pop();
            continue;
          }
          const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
          visitTime[pick[1] * this.cols + pick[0]] = step;
          visitedCount++;
          stack.push(pick);
          break;
        }
        // Respawn exhausted walker at a random unvisited cell
        if (stack.length === 0 && visitedCount < totalCells) {
          let idx: number;
          do {
            idx = Math.floor(Math.random() * totalCells);
          } while (visitTime[idx] >= 0);
          const x = idx % this.cols;
          const y = Math.floor(idx / this.cols);
          visitTime[idx] = step;
          visitedCount++;
          stack.push([x, y]);
        }
      }
    }

    // Normalize the steps into visit times between [0, 1]
    const maxStep = step;
    for (let i = 0; i < totalCells; i++) {
      visitTime[i] = Math.max(0, visitTime[i]) / maxStep * (1 - WALK_WINDOW);
    }

    return visitTime;
  }

  private createTextureAndFBO(w: number, h: number): { texture: WebGLTexture; fbo: WebGLFramebuffer } {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { texture, fbo };
  }

  private createHalftoneFrame(): HalftoneFrame {
    const { texture: cellTex, fbo: cellFbo } = this.createTextureAndFBO(this.cols, this.rows);

    const sizes: [number, number][] = [];
    let w = this.cols, h = this.rows;
    while (w > 1 || h > 1) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      sizes.push([w, h]);
    }

    const reduceSteps = sizes.map(([w, h]) => ({ ...this.createTextureAndFBO(w, h), w, h }));

    return { cellTex, cellFbo, reduceSteps };
  }

  private createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vert = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS))
      throw new Error("vertex shader: " + gl.getShaderInfoLog(vert));

    const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS))
      throw new Error("fragment shader: " + gl.getShaderInfoLog(frag));

    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("program link: " + gl.getProgramInfoLog(program));

    return program;
  }

  private setupAverageCellColors(vertSrc: string) {
    const gl = this.gl;
    const program = this.createProgram(vertSrc, `#version 300 es
      precision highp float;
      uniform sampler2D uTexture;
      uniform vec2 uImageSize;
      uniform vec2 uCanvasSize;
      in vec2 vUV;
      out vec4 fragColor;
      void main() {
        vec2 scale = uCanvasSize / uImageSize;
        float coverScale = max(scale.x, scale.y);
        vec2 scaledImageSize = uImageSize * coverScale;
        vec2 offset = (scaledImageSize - uCanvasSize) * 0.5;
        vec2 pixelCoord = vUV * uCanvasSize;
        vec2 imagePixel = pixelCoord + offset;
        vec2 imageUV    = imagePixel / scaledImageSize;
        fragColor = texture(uTexture, imageUV);
      }
    `);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
    gl.useProgram(null);

    return {
      program,
      uImageSize: gl.getUniformLocation(program, "uImageSize")!,
      uCanvasSize: gl.getUniformLocation(program, "uCanvasSize")!,
    };
  }

  private setupLumaRanges(vertSrc: string) {
    const gl = this.gl;
    const program = this.createProgram(vertSrc, `#version 300 es
      precision highp float;
      uniform sampler2D uTexture;
      uniform vec2 uInputSize;
      uniform bool uIsFirstStep;
      out vec4 fragColor;

      void main() {
        vec2 texel = 1.0 / uInputSize;
        vec2 uv = (floor(gl_FragCoord.xy) * 2.0 + 0.5) / uInputSize;

        vec4 a = texture(uTexture, uv);
        vec4 b = texture(uTexture, uv + vec2(texel.x, 0.0));
        vec4 c = texture(uTexture, uv + vec2(0.0, texel.y));
        vec4 d = texture(uTexture, uv + vec2(texel.x, texel.y));

        float minL, maxL;
        if (uIsFirstStep) {
          vec3 lw = vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]});
          float la = dot(a.rgb, lw);
          float lb = dot(b.rgb, lw);
          float lc = dot(c.rgb, lw);
          float ld = dot(d.rgb, lw);
          minL = min(min(la, lb), min(lc, ld));
          maxL = max(max(la, lb), max(lc, ld));
        } else {
          minL = min(min(a.r, b.r), min(c.r, d.r));
          maxL = max(max(a.g, b.g), max(c.g, d.g));
        }

        fragColor = vec4(minL, maxL, 0.0, 1.0);
      }
    `);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
    gl.useProgram(null);

    return {
      program,
      uInputSize: gl.getUniformLocation(program, "uInputSize")!,
      uIsFirstStep: gl.getUniformLocation(program, "uIsFirstStep")!,
    };
  }

  private setupRadialRender(vertSrc: string) {
    const gl = this.gl;
    const program = this.createProgram(vertSrc, `#version 300 es
    precision highp float;
    uniform sampler2D uTextureA;
    uniform sampler2D uLumaRangeA;
    uniform sampler2D uTextureB;
    uniform sampler2D uLumaRangeB;
    uniform float uCellSize;
    uniform float uPitch;
    uniform vec2 uCellCount;
    uniform float uT;
    uniform vec2 uOrigin;

    in vec2 vUV;
    out vec4 fragColor;

    void main() {
      vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
      vec2 cellCenter = (cellCoord + 0.5) * uPitch;
      vec2 uv = (cellCoord + 0.5) / uCellCount;
      float dist = length(gl_FragCoord.xy - cellCenter);

      float distFromOrigin = length(gl_FragCoord.xy - uOrigin);
      vec2 viewport = uCellCount * uPitch;
      float diameter = max(
        max(length(uOrigin), length(uOrigin - vec2(viewport.x, 0.0))),
        max(length(uOrigin - vec2(0.0, viewport.y)), length(uOrigin - viewport))
      );

      vec4 colorA = texture(uTextureA, uv);
      vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
      float normA = (dot(colorA.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeA.r) / (rangeA.g - rangeA.r);
      float rA = sqrt(normA) * uCellSize * 0.5 * (1.0 - uT);
      float alphaA = smoothstep(rA + 0.5, rA - 0.5, dist);

      vec4 colorB = texture(uTextureB, uv);
      vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
      float normB = (dot(colorB.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeB.r) / (rangeB.g - rangeB.r);
      float rB = sqrt(normB) * uCellSize * 0.5 * uT;
      float alphaB = smoothstep(rB + 0.5, rB - 0.5, dist);

      if (distFromOrigin < diameter * uT) {
        fragColor = mix(mix(vec4(0, 0, 0, 1), colorA, alphaA), colorB, alphaB);
      } else {
         fragColor = mix(vec4(0,0,0,1), colorA, alphaA);
      }
    }
    `);

    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
    gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
    gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), this.cols, this.rows);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureA"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureB"), 2);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
    gl.useProgram(null);

    return {
      program,
      uT: gl.getUniformLocation(program, "uT")!,
      uOrigin: gl.getUniformLocation(program, "uOrigin")!,
    };
  }

  private setupShrinkRender(vertSrc: string) {
    const gl = this.gl;
    const program = this.createProgram(vertSrc, `#version 300 es
    precision highp float;

    // Per-cell average colors for current (A) and next (B) frames
    uniform sampler2D uTextureA;
    uniform sampler2D uLumaRangeA;   // .r = min luma, .g = max luma
    uniform sampler2D uTextureB;
    uniform sampler2D uLumaRangeB;

    uniform float uCellSize;         // dot diameter at full brightness
    uniform float uPitch;            // cell spacing in pixels
    uniform vec2 uCellCount;         // grid dimensions (cols, rows)
    uniform float uT;                // transition progress 0..1
    in vec2 vUV;
    out vec4 fragColor;

    void main() {
      // Grid helpers
      vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
      vec2 cellCenter = (cellCoord + 0.5) * uPitch;
      vec2 uv = (cellCoord + 0.5) / uCellCount;
      float dist = length(gl_FragCoord.xy - cellCenter);

      // Current frame (A)
      vec4 colorA = texture(uTextureA, uv);
      vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
      float normA = (dot(colorA.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeA.r) / (rangeA.g - rangeA.r);

      // Next frame (B)
      vec4 colorB = texture(uTextureB, uv);
      vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
      float normB = (dot(colorB.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeB.r) / (rangeB.g - rangeB.r);

      // Natural radii for each frame
      float rA = sqrt(normA) * uCellSize * 0.5;
      float rB = sqrt(normB) * uCellSize * 0.5;

      // Interpolate between radii with overshoot
      float t = uT;
      float curve = 1.0 + 0.8 * sin(t * 3.14159);  // 1.0 -> 1.8 -> 1.0
      float radius = mix(rA, rB, t) * curve;

      vec3 blendedColor = mix(colorA.rgb, colorB.rgb, t);
      float alpha = smoothstep(radius + 0.5, radius - 0.5, dist);

      fragColor = mix(vec4(0.0, 0.0, 0.0, 1.0), vec4(blendedColor, 1.0), alpha);
    }
    `);

    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
    gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
    gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), this.cols, this.rows);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureA"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureB"), 2);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
    gl.useProgram(null);

    return {
      program,
      uT: gl.getUniformLocation(program, "uT")!,
    };
  }

  private setupWipeRender(vertSrc: string) {
    const gl = this.gl;
    const program = this.createProgram(vertSrc, `#version 300 es
    precision highp float;
    uniform sampler2D uTextureA;
    uniform sampler2D uLumaRangeA;
    uniform sampler2D uTextureB;
    uniform sampler2D uLumaRangeB;
    uniform float uCellSize;
    uniform float uPitch;
    uniform vec2 uCellCount;
    uniform float uT;

    in vec2 vUV;
    out vec4 fragColor;

    void main() {
      vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
      vec2 cellCenter = (cellCoord + 0.5) * uPitch;
      vec2 uv = (cellCoord + 0.5) / uCellCount;
      float dist = length(gl_FragCoord.xy - cellCenter);

      vec2 viewport = uCellCount * uPitch;
      float bandWidth = viewport.x * 0.30;
      float rightEdge = (viewport.x + bandWidth) * uT;
      float grad = clamp(1.0 - (rightEdge - gl_FragCoord.x) / bandWidth, 0.0, 1.0);

      vec4 colorA = texture(uTextureA, uv);
      vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
      float normA = (dot(colorA.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeA.r) / (rangeA.g - rangeA.r);

      float scaleA = clamp(grad / 0.4, 0.0, 1.0);
      float scaleB = clamp((1.0 - grad) / 0.4, 0.0, 1.0);

      float radiusA = sqrt(normA) * uCellSize * 0.5 * scaleA;
      float alphaA = smoothstep(radiusA + 0.5, radiusA - 0.5, dist);

      vec4 colorB = texture(uTextureB, uv);
      vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
      float normB = (dot(colorB.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeB.r) / (rangeB.g - rangeB.r);

      float radiusB = sqrt(normB) * uCellSize * 0.5 * scaleB;
      float alphaB = smoothstep(radiusB + 0.5, radiusB - 0.5, dist);

      vec4 bg = vec4(0.0, 0.0, 0.0, 1.0);
      fragColor = mix(mix(bg, vec4(colorA.rgb, 1.0), alphaA), vec4(colorB.rgb, 1.0), alphaB);
    }
    `);

    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
    gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
    gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), this.cols, this.rows);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureA"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureB"), 2);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
    gl.useProgram(null);

    return {
      program,
      uT: gl.getUniformLocation(program, "uT")!,
    };
  }

  private setupWalkRender(vertSrc: string) {
    const gl = this.gl;
    const program = this.createProgram(vertSrc, `#version 300 es
    precision highp float;
    uniform sampler2D uTextureA;
    uniform sampler2D uLumaRangeA;
    uniform sampler2D uTextureB;
    uniform sampler2D uLumaRangeB;
    uniform sampler2D uVisitMap;
    uniform float uCellSize;
    uniform float uPitch;
    uniform vec2 uCellCount;
    uniform float uT;
    uniform float uWindow;

    in vec2 vUV;
    out vec4 fragColor;

    void main() {
      vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
      vec2 cellCenter = (cellCoord + 0.5) * uPitch;
      vec2 uv = (cellCoord + 0.5) / uCellCount;
      float dist = length(gl_FragCoord.xy - cellCenter);

      float visitTime = texture(uVisitMap, uv).r;
      float cellT = smoothstep(visitTime, visitTime + uWindow, uT);

      vec4 colorA = texture(uTextureA, uv);
      vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
      float normA = (dot(colorA.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeA.r) / (rangeA.g - rangeA.r);

      float scaleA = 1.0 - cellT;
      float radiusA = sqrt(normA) * uCellSize * 0.5 * scaleA;
      float alphaA = smoothstep(radiusA + 0.5, radiusA - 0.5, dist);

      vec4 colorB = texture(uTextureB, uv);
      vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
      float normB = (dot(colorB.rgb, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]})) - rangeB.r) / (rangeB.g - rangeB.r);

      float scaleB = cellT;
      float radiusB = sqrt(normB) * uCellSize * 0.5 * scaleB;
      float alphaB = smoothstep(radiusB + 0.5, radiusB - 0.5, dist);

      vec4 bg = vec4(0.0, 0.0, 0.0, 1.0);
      fragColor = mix(mix(bg, vec4(colorA.rgb, 1.0), alphaA), vec4(colorB.rgb, 1.0), alphaB);
    }
    `);

    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
    gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
    gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), this.cols, this.rows);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureA"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uTextureB"), 2);
    gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);
    gl.uniform1i(gl.getUniformLocation(program, "uVisitMap"), 4);
    gl.useProgram(null);

    const visitMapTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, visitMapTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    return {
      program,
      uT: gl.getUniformLocation(program, "uT")!,
      uWindow: gl.getUniformLocation(program, "uWindow")!,
      visitMapTex,
    };
  }

  private runAverageCellColors(srcTex: WebGLTexture, img: HTMLImageElement, frame: HalftoneFrame): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.cellFbo);
    gl.viewport(0, 0, this.cols, this.rows);
    gl.useProgram(this.averageCellColors.program);
    gl.uniform2f(this.averageCellColors.uImageSize, img.width, img.height);
    gl.uniform2f(this.averageCellColors.uCanvasSize, this.canvasWidth, this.canvasHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private runLumaRanges(frame: HalftoneFrame): void {
    const gl = this.gl;
    gl.useProgram(this.lumaRanges.program);
    gl.activeTexture(gl.TEXTURE0);

    let inputTexture = frame.cellTex;
    let inputW = this.cols, inputH = this.rows;

    for (let i = 0; i < frame.reduceSteps.length; i++) {
      const step = frame.reduceSteps[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, step.fbo);
      gl.viewport(0, 0, step.w, step.h);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      gl.uniform2f(this.lumaRanges.uInputSize, inputW, inputH);
      gl.uniform1i(this.lumaRanges.uIsFirstStep, i === 0 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      inputTexture = step.texture;
      inputW = step.w;
      inputH = step.h;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
