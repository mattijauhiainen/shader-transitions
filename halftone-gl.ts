const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const gl = canvas.getContext("webgl2")!;

// --- shared ---

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

  const texture = gl.createTexture()!;  // allocate a texture object on the GPU
  gl.bindTexture(gl.TEXTURE_2D, texture); // target it for configuration
  // texImage2D defines the texture's size, format, and optionally its pixel data.
  // Think of it as "declare and allocate" — it tells the GPU how big the texture is
  // and what format each pixel uses. Passing null for data allocates empty GPU memory
  // that the FBO will write into during pass 1.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,           // mip level 0 (base)
    gl.RGBA,     // internal format — how the GPU stores the data
    cols,        // width: one pixel per halftone column
    rows,        // height: one pixel per halftone row
    0,           // border (must be 0 in WebGL)
    gl.RGBA,     // pixel format of the data we're providing
    gl.UNSIGNED_BYTE, // data type of each channel
    null         // no initial data — GPU allocates empty memory, pass 1 will fill it
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); // no interpolation when shrinking — each texel maps exactly to one cell
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // no interpolation when enlarging — same reason

  const fbo = gl.createFramebuffer()!;  // allocate a framebuffer object — a render target
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); // target it for configuration
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0); // attach the texture as the color output — GPU writes rendered pixels into it

  gl.bindTexture(gl.TEXTURE_2D, null);    // unbind — configuration is stored in the texture object
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); // unbind — restore canvas as the default render target

  return { program, texture, fbo };
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

  // pre-compute the size at each step
  const sizes: [number, number][] = [];
  let w = cols, h = rows;
  while (w > 1 || h > 1) {
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
    sizes.push([w, h]);
  }
  // sizes[sizes.length - 1] is always [1, 1]

  // create a texture + FBO for each step
  const steps = sizes.map(([w, h]) => {
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

  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
  gl.useProgram(null);

  return { program, steps };
}

// --- pass 2: render halftone to canvas ---

// Compiles the halftone shader and pre-loads all uniforms that never change between renders.
// Leaves no bindings active. Returns the program for use at render time.
function setupPass2() {
  const program = createProgram(vertSrc, `#version 300 es
    precision highp float;
    uniform sampler2D uTexture;  // the cols×rows averaged cell texture from pass 1
    uniform float uCellSize;     // max dot diameter in pixels
    uniform float uPitch;        // cell + gap size in pixels
    uniform vec2 uCellCount;     // grid dimensions (cols, rows)
    uniform sampler2D uLumaRange;  // 1×1 texture: R = minLuma, G = maxLuma

    in vec2 vUV;
    out vec4 fragColor;

    void main() {
      vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);        // which cell this pixel belongs to
      vec2 cellCenter = (cellCoord + 0.5) * uPitch;            // pixel coordinate of that cell's center
      vec2 uv = (cellCoord + 0.5) / uCellCount;               // UV into the small texture — one texel per cell
      vec4 color = texture(uTexture, uv);                      // averaged color of this cell from pass 1

      vec2 lumaRange = texture(uLumaRange, vec2(0.5)).rg;  // sample center of 1×1 tex — R=min, G=max
      float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      float normalizedLuma = (luma - lumaRange.r) / (lumaRange.g - lumaRange.r);
      float radius = sqrt(normalizedLuma) * uCellSize * 0.5;
      float dist = length(gl_FragCoord.xy - cellCenter);       // distance from this pixel to the cell center
      float alpha = smoothstep(radius + 0.5, radius - 0.5, dist); // smooth 1px edge instead of hard cutoff
      fragColor = mix(vec4(0, 0, 0, 1), color, alpha);         // blend between black and dot color at the edge
    }
  `);

  gl.useProgram(program);                                                  // activate program so uniform calls target it
  gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);         // max dot diameter in pixels
  gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);          // cell + gap size in pixels
  gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), cols, rows); // grid dimensions
  gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);            // always read from texture slot 0
  gl.uniform1i(gl.getUniformLocation(program, "uLumaRange"), 1);
  gl.useProgram(null);                                                     // unbind — uniforms are stored in the program object

  return { program };
}

const pass1 = setupPass1();
const passReduce = setupPassReduce();
const pass2 = setupPass2();

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

// Downsamples srcTex into pass1.texture via the FBO.
// Each texel in pass1.texture becomes the averaged color of one halftone cell.
function runPass1(srcTex: WebGLTexture) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, pass1.fbo);   // render into pass1.texture instead of the canvas
  gl.viewport(0, 0, cols, rows);                   // one output pixel per cell
  gl.useProgram(pass1.program);                    // passthrough shader — just copies the texture
  gl.uniform2f(gl.getUniformLocation(pass1.program, "uImageSize"), img.width, img.height);
  gl.uniform2f(gl.getUniformLocation(pass1.program, "uCanvasSize"), canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0);                   // activate slot 0
  gl.bindTexture(gl.TEXTURE_2D, srcTex);           // put the source image in slot 0
  gl.uniform1i(gl.getUniformLocation(pass1.program, "uTexture"), 0); // tell shader to read from slot 0
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);          // draw fullscreen quad — GPU averages via mipmaps
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);        // unbind FBO — restore canvas as render target
  gl.bindTexture(gl.TEXTURE_2D, null);             // unbind texture
}

function runPassReduce() {
  gl.useProgram(passReduce.program);
  gl.activeTexture(gl.TEXTURE0);

  let inputTexture = pass1.texture;
  let inputW = cols, inputH = rows;

  for (let i = 0; i < passReduce.steps.length; i++) {
    const step = passReduce.steps[i];
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

// Renders the halftone pattern to the canvas using averaged cell colors from pass1.texture.
function runPass2() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);        // render to canvas
  gl.viewport(0, 0, canvas.width, canvas.height);  // full canvas resolution
  gl.useProgram(pass2.program);                    // halftone shader
  gl.activeTexture(gl.TEXTURE0);                   // activate slot 0
  gl.bindTexture(gl.TEXTURE_2D, pass1.texture);    // put the averaged cell texture in slot 0

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, passReduce.steps[passReduce.steps.length - 1].texture);
  gl.activeTexture(gl.TEXTURE0);  // restore slot 0 as active for pass1.texture

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);          // draw fullscreen quad — shader renders halftone dots
  gl.bindTexture(gl.TEXTURE_2D, null);             // unbind texture
}

const img = new Image();
img.onload = () => {
  const srcTex = uploadImage(img);
  runPass1(srcTex);
  runPassReduce();
  runPass2();
};
img.src = "/images/clockenflap.avif";
