const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const gl = canvas.getContext("webgl2")!;

// --- shared ---

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const DURATION = 2000;
const PAUSE = 1500;

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function animateTo(duration: number, fn: (t: number) => void): Promise<void> {
  return new Promise(resolve => {
    const start = performance.now();
    function frame() {
      const t = easeInOut(Math.min((performance.now() - start) / duration, 1));
      fn(t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function renderIntoFrame(img: HTMLImageElement, frame: FrameResources) {
  const srcTex = uploadImage(img);
  runPass1(srcTex, img, frame);
  runPassReduce(frame);
}

async function runSlideshow(paths: string[]) {
  let current = frameA;
  let next = frameB;

  renderIntoFrame(await loadImage(paths[0]), current);
  runPass2(current, current, 0);  // display first image statically (B same as A, t=0)

  for (let i = 0; ; i = (i + 1) % paths.length) {
    const nextImgPromise = loadImage(paths[(i + 1) % paths.length]);

    await sleep(PAUSE);

    const nextImg = await nextImgPromise;
    renderIntoFrame(nextImg, next);

    await animateTo(DURATION, t => runPass2(current, next, t));

    // swap: next becomes current for the next iteration
    [current, next] = [next, current];
  }
}

type FrameResources = {
  cellTex: WebGLTexture;
  cellFbo: WebGLFramebuffer;
  reduceSteps: { texture: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }[];
};

function createFrameResources(): FrameResources {
  const cellTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, cellTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const cellFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, cellFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cellTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const sizes: [number, number][] = [];
  let w = cols, h = rows;
  while (w > 1 || h > 1) {
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
    sizes.push([w, h]);
  }

  const reduceSteps = sizes.map(([w, h]) => {
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

    return { texture, fbo, w, h };
  });

  return { cellTex, cellFbo, reduceSteps };
}

const CELL_SIZE = 5.0;
const PITCH = 6.0;
const cols = Math.ceil(canvas.width / PITCH);
const rows = Math.ceil(canvas.height / PITCH);

function createProgram(vertSrc: string, fragSrc: string) {
  const vert = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vert, vertSrc);
  gl.compileShader(vert);
  console.log("vert:", gl.getShaderInfoLog(vert));

  const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(frag, fragSrc);
  gl.compileShader(frag);
  console.log("frag:", gl.getShaderInfoLog(frag));

  const program = gl.createProgram()!;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  console.log("link:", gl.getProgramInfoLog(program));

  return program;
}

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
const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

// --- pass 1: downsample image into smallTex via fbo ---

// Sets up the render target for pass 1: a cols×rows texture backed by an FBO.
// The passthrough shader simply copies whatever source texture is bound.
// The GPU does the averaging implicitly via mipmaps when downsampling to cols×rows.
// Leaves no bindings active. Returns the program, texture, and FBO for use at render time.
function setupPass1() {
  const program = createProgram(vertSrc, `#version 300 es
    precision highp float;
    uniform sampler2D uTexture;
    uniform vec2 uImageSize;   // original image width and height in pixels
    uniform vec2 uCanvasSize;  // canvas width and height in pixels
    in vec2 vUV;
    out vec4 fragColor;
    void main() {
      vec2 scale = uCanvasSize / uImageSize;       // how much to scale on each axis to fill that axis
      float coverScale = max(scale.x, scale.y);    // pick the larger — this axis fills exactly, the other overflows
      vec2 scaledImageSize = uImageSize * coverScale;  // image size after scaling, in pixels
      vec2 offset = (scaledImageSize - uCanvasSize) * 0.5;  // pixels cropped off each edge
      vec2 pixelCoord = vUV * uCanvasSize;                      // canvas pixel this fragment corresponds to
      vec2 imagePixel = pixelCoord + offset;                    // shift into the image's pixel space
      vec2 imageUV    = imagePixel / scaledImageSize;           // normalise to [0,1] within the scaled image
      fragColor = texture(uTexture, imageUV); // passthrough — copy input pixel to output
    }
  `);

  return { program };
}

function setupPassReduce() {
  const program = createProgram(vertSrc, `#version 300 es
    precision highp float;
    uniform sampler2D uTexture;   // input texture for this step
    uniform vec2 uInputSize;      // pixel dimensions of the input texture
    uniform bool uIsFirstStep;    // true on first step — input is RGB colors, not (minLuma, maxLuma)
    out vec4 fragColor;

    void main() {
      vec2 texel = 1.0 / uInputSize;                               // size of one input pixel in UV space
      vec2 uv = (floor(gl_FragCoord.xy) * 2.0 + 0.5) / uInputSize; // UV of top-left pixel of the 2×2 input block

      // sample the 2×2 block of input pixels
      vec4 a = texture(uTexture, uv);
      vec4 b = texture(uTexture, uv + vec2(texel.x, 0.0));
      vec4 c = texture(uTexture, uv + vec2(0.0, texel.y));
      vec4 d = texture(uTexture, uv + vec2(texel.x, texel.y));

      float minL, maxL;
      if (uIsFirstStep) {
        // input is RGB averaged colors from pass 1 — compute luma for each
        vec3 lw = vec3(0.2126, 0.7152, 0.0722);
        float la = dot(a.rgb, lw);
        float lb = dot(b.rgb, lw);
        float lc = dot(c.rgb, lw);
        float ld = dot(d.rgb, lw);
        minL = min(min(la, lb), min(lc, ld));
        maxL = max(max(la, lb), max(lc, ld));
      } else {
        // input is (minLuma, maxLuma) from a previous reduction step — propagate them
        minL = min(min(a.r, b.r), min(c.r, d.r));
        maxL = max(max(a.g, b.g), max(c.g, d.g));
      }

      fragColor = vec4(minL, maxL, 0.0, 1.0); // store min in R, max in G
    }
  `)
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
  gl.useProgram(null);
  return { program };
}

// --- pass 2: render halftone to canvas ---

// Compiles the halftone shader and pre-loads all uniforms that never change between renders.
// Leaves no bindings active. Returns the program for use at render time.
function setupPass2() {
  const program = createProgram(vertSrc, `#version 300 es
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

    vec4 colorA = texture(uTextureA, uv);
    vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
    float normA = (dot(colorA.rgb, vec3(0.2126, 0.7152, 0.0722)) - rangeA.r) / (rangeA.g - rangeA.r);
    float rA = sqrt(normA) * uCellSize * 0.5 * (1.0 - uT);
    float alphaA = smoothstep(rA + 0.5, rA - 0.5, dist);

    vec4 colorB = texture(uTextureB, uv);
    vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
    float normB = (dot(colorB.rgb, vec3(0.2126, 0.7152, 0.0722)) - rangeB.r) / (rangeB.g - rangeB.r);
    float rB = sqrt(normB) * uCellSize * 0.5 * uT;
    float alphaB = smoothstep(rB + 0.5, rB - 0.5, dist);

    fragColor = mix(mix(vec4(0, 0, 0, 1), colorA, alphaA), colorB, alphaB);
  }
  `);

  gl.useProgram(program);
  gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
  gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
  gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), cols, rows);
  gl.uniform1i(gl.getUniformLocation(program, "uTextureA"), 0);    // slot 0
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);  // slot 1
  gl.uniform1i(gl.getUniformLocation(program, "uTextureB"), 2);    // slot 2
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);  // slot 3
  gl.uniform1f(gl.getUniformLocation(program, "uT"), 0.0);
  gl.useProgram(null);

  return { program };
}

const pass1 = setupPass1();
const passReduce = setupPassReduce();
const pass2 = setupPass2();
const frameA = createFrameResources();
const frameB = createFrameResources();

const loc = gl.getAttribLocation(pass2.program, "aPosition");
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

// Uploads an image to the GPU as a texture with mipmaps for averaging.
// Returns the texture object. Leaves no bindings active.
function uploadImage(img: HTMLImageElement) {
  const srcTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, srcTex);           // target this texture for configuration
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);    // flip y so (0,0) is bottom-left, matching gl_FragCoord
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); // upload pixel data to GPU
  gl.generateMipmap(gl.TEXTURE_2D);                // precompute averaged downsized versions for pass 1
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // use mipmaps when shrinking
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);               // interpolate when enlarging
  gl.bindTexture(gl.TEXTURE_2D, null);             // unbind — configuration is stored in the texture object
  return srcTex;
}

function runPass1(srcTex: WebGLTexture, img: HTMLImageElement, frame: FrameResources) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, frame.cellFbo);   // render into this frame's cell texture
  gl.viewport(0, 0, cols, rows);
  gl.useProgram(pass1.program);
  gl.uniform2f(gl.getUniformLocation(pass1.program, "uImageSize"), img.width, img.height);
  gl.uniform2f(gl.getUniformLocation(pass1.program, "uCanvasSize"), canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(gl.getUniformLocation(pass1.program, "uTexture"), 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function runPassReduce(frame: FrameResources) {
  gl.useProgram(passReduce.program);
  gl.activeTexture(gl.TEXTURE0);

  let inputTexture = frame.cellTex;
  let inputW = cols, inputH = rows;

  for (let i = 0; i < frame.reduceSteps.length; i++) {
    const step = frame.reduceSteps[i];
    gl.bindFramebuffer(gl.FRAMEBUFFER, step.fbo);
    gl.viewport(0, 0, step.w, step.h);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform2f(gl.getUniformLocation(passReduce.program, "uInputSize"), inputW, inputH);
    gl.uniform1i(gl.getUniformLocation(passReduce.program, "uIsFirstStep"), i === 0 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    inputTexture = step.texture;
    inputW = step.w;
    inputH = step.h;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function runPass2(a: FrameResources, b: FrameResources, t: number) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(pass2.program);

  // Put frame a source texture to slot 0
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, a.cellTex);

  // Put frame a luma range to slot 1
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, a.reduceSteps[a.reduceSteps.length - 1].texture);

  // Put frame b source texture to slot 2
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, b.cellTex);

  // Put frame b luma range to slot 3
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, b.reduceSteps[b.reduceSteps.length - 1].texture);

  gl.uniform1f(gl.getUniformLocation(pass2.program, "uT"), t);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

const paths: string[] = await fetch("/images").then(r => r.json());
runSlideshow(paths);
