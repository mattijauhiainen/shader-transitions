const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const gl = canvas.getContext("webgl2")!;

const PITCH = 7.0;
const cols = Math.ceil(canvas.width / PITCH);
const rows = Math.ceil(canvas.height / PITCH);

const smallTex = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, smallTex)
gl.texImage2D(
  gl.TEXTURE_2D,
  0,
  gl.RGBA,
  cols,
  rows,
  0,
  gl.RGBA,
  gl.UNSIGNED_BYTE, null
)
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

const fbo = gl.createFramebuffer()
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, smallTex, 0)

const vertexShaderInput = `#version 300 es
  in vec2 aPosition;
  out vec2 vUV;
  void main() {
    vUV = aPosition * 0.5 + 0.5; // convert -1..1 to 0..1
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`
const vertexShader = gl.createShader(gl.VERTEX_SHADER)!;
gl.shaderSource(vertexShader, vertexShaderInput);
gl.compileShader(vertexShader);

const passthroughShaderInput = `#version 300 es
  precision highp float;
  uniform sampler2D uTexture;
  in vec2 vUV;
  out vec4 fragColor;
  void main() {
    fragColor = texture(uTexture, vUV);
  }
`
const passthroughShader = gl.createShader(gl.FRAGMENT_SHADER)!;
gl.shaderSource(passthroughShader, passthroughShaderInput);
gl.compileShader(passthroughShader);

const passthroughProgram = gl.createProgram()!;
gl.attachShader(passthroughProgram, vertexShader);
gl.attachShader(passthroughProgram, passthroughShader);
gl.linkProgram(passthroughProgram);
gl.useProgram(passthroughProgram);
const meh = gl.getAttribLocation(passthroughProgram, "aPosition")
gl.enableVertexAttribArray(meh);                          // activate it

const fragmentShaderInput = `#version 300 es
  precision highp float;
  uniform sampler2D uTexture;
  uniform float uCellSize;   // diameter of each cell (e.g. 6.0)
  uniform float uPitch;      // cell + gap (e.g. 7.0)
  uniform vec2 uCellCount;

  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
    vec2 cellCenter = (cellCoord + 0.5) * uPitch;
    vec2 uv = (cellCoord + 0.5) / uCellCount;
    vec4 color = texture(uTexture, uv);

    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float radius = sqrt(luma) * uCellSize * 0.5;
    float dist = length(gl_FragCoord.xy - cellCenter);
    if (dist < radius) {
      fragColor = color;         // inside dot → image color
    } else {
      fragColor = vec4(0, 0, 0, 1);  // outside dot → black background
    }
  }
`

const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!;
gl.shaderSource(fragmentShader, fragmentShaderInput);
gl.compileShader(fragmentShader);

const program = gl.createProgram()!;
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);
gl.useProgram(program);

const htLoc = gl.getUniformLocation(program, "uTexture");
gl.uniform1i(htLoc, 0);

// float: one float
const cellLoc = gl.getUniformLocation(program, "uCellSize");
gl.uniform1f(cellLoc, 6.0);

const pitchLoc = gl.getUniformLocation(program, "uPitch");
gl.uniform1f(pitchLoc, PITCH);

const positions = new Float32Array([
  -1, -1,   // bottom-left
   1, -1,   // bottom-right
  -1,  1,   // top-left
   1,  1,   // top-right
]);

const buffer = gl.createBuffer();        // allocate a buffer on the GPU
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);  // "I'm talking about this buffer now"
gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);  // upload the data

const loc = gl.getAttribLocation(program, "aPosition");  // find the input by name
gl.enableVertexAttribArray(loc);                          // activate it
gl.vertexAttribPointer(
  loc,       // which attribute
  2,         // how many floats per vertex (we have x, y)
  gl.FLOAT,  // data type
  false,     // don't normalize
  0,         // stride: 0 means "tightly packed"
  0          // offset: start at the beginning of the buffer
);

const img = new Image();
img.onload = () => {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, cols, rows);
  gl.useProgram(passthroughProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);  // the loaded image, not smallTex
  const ptLoc = gl.getUniformLocation(passthroughProgram, "uTexture");
  gl.uniform1i(ptLoc, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // Second pass
  // Restore default framebuffer which is canvas. Draw operations will now happen on canvas
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(program);
  const cellCountLoc = gl.getUniformLocation(program, "uCellCount");
  gl.uniform2f(cellCountLoc, cols, rows);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, smallTex);
  const htLoc = gl.getUniformLocation(program, "uTexture");
  gl.uniform1i(htLoc, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};
img.src = "/images/clockenflap.avif";
