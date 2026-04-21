import averageCellColorsFrag from "./averageCellColors.frag.glsl" with {
  type: "text",
};
import fullscreenQuadVert from "./fullscreenQuad.vert.glsl" with {
  type: "text",
};
import { LUMA } from "./luma.ts";
import lumaRangesFrag from "./lumaRanges.frag.glsl" with { type: "text" };
import { createCollapseTransition } from "./transitions/collapse.ts";
import { createExplodeTransition } from "./transitions/explode.ts";
import { createFlipTransition } from "./transitions/flip.ts";
import { createMitosisTransition } from "./transitions/mitosis.ts";
import { createOrbitTransition } from "./transitions/orbit.ts";
import { createPageflipTransition } from "./transitions/pageflip.ts";
import { createRadialTransition } from "./transitions/radial.ts";
import { createRainTransition } from "./transitions/rain.ts";
import { createShrinkTransition } from "./transitions/shrink.ts";
import { createWalkTransition } from "./transitions/walk.ts";
import { createWipeTransition } from "./transitions/wipe.ts";

export const CELL_SIZE = 5.0;
export const PITCH = 6.0;

export interface HalftoneFrame {
  cellTex: WebGLTexture;
  cellFbo: WebGLFramebuffer;
  lumaRangeTex: WebGLTexture;
  reduceSteps: {
    texture: WebGLTexture;
    fbo: WebGLFramebuffer;
    w: number;
    h: number;
  }[];
}

export interface RendererContext {
  readonly gl: WebGL2RenderingContext;
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly current: HalftoneFrame;
  readonly next: HalftoneFrame;
  createProgram(vertSrc: string, fragSrc: string): WebGLProgram;
  createQuadVAO(): WebGLVertexArrayObject;
}

export interface Transition {
  prepareRender(durationMs: number): (t: number) => void;
  easing?: (t: number) => number;
  durationMs: number;
  dispose?: () => void;
}

export class Renderer implements RendererContext {
  readonly cols: number;
  readonly rows: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
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
  private _current: HalftoneFrame;
  private _next: HalftoneFrame;
  private _transitions: Transition[];
  private quadVAO: WebGLVertexArrayObject;

  get current(): HalftoneFrame {
    return this._current;
  }
  get next(): HalftoneFrame {
    return this._next;
  }

  constructor(
    readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ) {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.cols = Math.ceil(width / PITCH);
    this.rows = Math.ceil(height / PITCH);

    this.quadVAO = this.createQuadVAO();

    this.averageCellColors = this.setupAverageCellColors();
    this.lumaRanges = this.setupLumaRanges();

    this._current = this.createHalftoneFrame();
    this._next = this.createHalftoneFrame();

    this._transitions = [
      createRadialTransition(this),
      createShrinkTransition(this),
      createWipeTransition(this),
      createWalkTransition(this),
      createExplodeTransition(this),
      createPageflipTransition(this),
      createCollapseTransition(this),
      createRainTransition(this),
      createMitosisTransition(this),
      createFlipTransition(this),
      createOrbitTransition(this),
    ];
  }

  private uploadImage(img: HTMLImageElement): WebGLTexture {
    const srcTex = this.gl.createTexture()!;
    this.gl.bindTexture(this.gl.TEXTURE_2D, srcTex);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      img,
    );
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.LINEAR_MIPMAP_LINEAR,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.LINEAR,
    );
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    return srcTex;
  }

  prepareNext(img: HTMLImageElement): void {
    const srcTex = this.uploadImage(img);
    this.runAverageCellColors(srcTex, img, this._next);
    this.gl.deleteTexture(srcTex);
    this.runLumaRanges(this._next);
  }

  swap(): void {
    [this._current, this._next] = [this._next, this._current];
  }

  get transitions(): Transition[] {
    return this._transitions;
  }

  private createTextureAndFBO(
    w: number,
    h: number,
  ): { texture: WebGLTexture; fbo: WebGLFramebuffer } {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { texture, fbo };
  }

  private createHalftoneFrame(): HalftoneFrame {
    const { texture: cellTex, fbo: cellFbo } = this.createTextureAndFBO(
      this.cols,
      this.rows,
    );

    const sizes: [number, number][] = [];
    let w = this.cols,
      h = this.rows;
    while (w > 1 || h > 1) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      sizes.push([w, h]);
    }

    const reduceSteps = sizes.map(([w, h]) => ({
      ...this.createTextureAndFBO(w, h),
      w,
      h,
    }));

    return {
      cellTex,
      cellFbo,
      lumaRangeTex: reduceSteps[reduceSteps.length - 1].texture,
      reduceSteps,
    };
  }

  // Creates a Vertex array object with a quad (two triangles,
  // four vertices), forming a square.
  createQuadVAO(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vert = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS))
      throw new Error(`vertex shader: ${gl.getShaderInfoLog(vert)}`);

    const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS))
      throw new Error(`fragment shader: ${gl.getShaderInfoLog(frag)}`);

    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`program link: ${gl.getProgramInfoLog(program)}`);

    return program;
  }

  private setupAverageCellColors() {
    const gl = this.gl;
    const program = this.createProgram(
      fullscreenQuadVert,
      averageCellColorsFrag,
    );

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
    gl.useProgram(null);

    return {
      program,
      uImageSize: gl.getUniformLocation(program, "uImageSize")!,
      uCanvasSize: gl.getUniformLocation(program, "uCanvasSize")!,
    };
  }

  private setupLumaRanges() {
    const gl = this.gl;
    const program = this.createProgram(fullscreenQuadVert, lumaRangesFrag);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
    gl.uniform3f(
      gl.getUniformLocation(program, "uLuma"),
      LUMA[0],
      LUMA[1],
      LUMA[2],
    );
    gl.useProgram(null);

    return {
      program,
      uInputSize: gl.getUniformLocation(program, "uInputSize")!,
      uIsFirstStep: gl.getUniformLocation(program, "uIsFirstStep")!,
    };
  }

  private runAverageCellColors(
    srcTex: WebGLTexture,
    img: HTMLImageElement,
    frame: HalftoneFrame,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.cellFbo);
    gl.viewport(0, 0, this.cols, this.rows);
    gl.useProgram(this.averageCellColors.program);
    gl.uniform2f(this.averageCellColors.uImageSize, img.width, img.height);
    gl.uniform2f(
      this.averageCellColors.uCanvasSize,
      this.canvasWidth,
      this.canvasHeight,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private runLumaRanges(frame: HalftoneFrame): void {
    const gl = this.gl;
    gl.useProgram(this.lumaRanges.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.quadVAO);

    let inputTexture = frame.cellTex;
    let inputW = this.cols,
      inputH = this.rows;

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

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
