# Slideshow with cross-fade for halftone-gl.ts

The canvas version cross-fades between images by drawing the current image's dots shrinking
(scale = 1-t) and the next image's dots growing (scale = t) simultaneously. The GL version
does the same thing, but in a shader: pass 2 reads cell data for both images and composites
the two layers per fragment.

This requires two complete sets of GPU resources (one for the "current" image, one for the
"next"), and a pass 2 shader that takes both simultaneously plus a blend factor `uTime`.

---

## Step A — Add `loadImage` helper

```ts
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
```

---

## Step B — Introduce `FrameResources` and `createFrameResources()`

A "frame" is all the GPU memory needed to hold one image's halftone data:
- a `cols×rows` cell texture + its FBO (pass 1 output)
- a reduction FBO chain ending in a 1×1 luma range texture (passReduce output)

Add a type alias and a factory function that allocates both:

```ts
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
```

---

## Step C — Refactor setupPass1 and setupPassReduce to return only programs

Remove the texture/FBO creation from both functions — those now live in `createFrameResources`.

`setupPass1` becomes:
```ts
function setupPass1() {
  const program = createProgram(vertSrc, `/* same shader as before */`);
  return { program };
}
```

`setupPassReduce` becomes:
```ts
function setupPassReduce() {
  const program = createProgram(vertSrc, `/* same shader as before */`);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
  gl.useProgram(null);
  return { program };
}
```

Then update the setup calls and create two frames:
```ts
const pass1 = setupPass1();
const passReduce = setupPassReduce();
const pass2 = setupPass2();
const frameA = createFrameResources();
const frameB = createFrameResources();
```

---

## Step D — Parameterize runPass1 and runPassReduce

`runPass1` currently hardcodes `pass1.fbo` and references the global `img`. Add parameters:

```ts
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
```

`runPassReduce` currently hardcodes `pass1.texture` and `passReduce.steps`. Add a frame parameter:

```ts
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
```

---

## Step E — Update the pass 2 shader for cross-fade

The shader now takes two sets of cell data (`uCellColorsA`/`uLumaRangeA` and
`uCellColorsB`/`uLumaRangeB`) plus a blend factor `uTime`. Both images share the same cell grid,
so `cellCoord`, `cellCenter`, `uv`, and `dist` are computed once and reused for both.

The composite order is: black → A dots (scale 1-t) → B dots (scale t). B renders on top.

```glsl
#version 300 es
precision highp float;
uniform sampler2D uCellColorsA;
uniform sampler2D uLumaRangeA;
uniform sampler2D uCellColorsB;
uniform sampler2D uLumaRangeB;
uniform float uCellSize;
uniform float uPitch;
uniform vec2 uCellCount;
uniform float uTime;

in vec2 vUV;
out vec4 fragColor;

void main() {
  vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
  vec2 cellCenter = (cellCoord + 0.5) * uPitch;
  vec2 uv = (cellCoord + 0.5) / uCellCount;
  float dist = length(gl_FragCoord.xy - cellCenter);

  vec4 colorA = texture(uCellColorsA, uv);
  vec2 rangeA = texture(uLumaRangeA, vec2(0.5)).rg;
  float normA = (dot(colorA.rgb, vec3(0.2126, 0.7152, 0.0722)) - rangeA.r) / (rangeA.g - rangeA.r);
  float rA = sqrt(normA) * uCellSize * 0.5 * (1.0 - uTime);
  float alphaA = smoothstep(rA + 0.5, rA - 0.5, dist);

  vec4 colorB = texture(uCellColorsB, uv);
  vec2 rangeB = texture(uLumaRangeB, vec2(0.5)).rg;
  float normB = (dot(colorB.rgb, vec3(0.2126, 0.7152, 0.0722)) - rangeB.r) / (rangeB.g - rangeB.r);
  float rB = sqrt(normB) * uCellSize * 0.5 * uTime;
  float alphaB = smoothstep(rB + 0.5, rB - 0.5, dist);

  fragColor = mix(mix(vec4(0, 0, 0, 1), colorA, alphaA), colorB, alphaB);
}
```

---

## Step F — Update setupPass2 uniform pre-loads

Replace the old `uTexture`/`uLumaRange` pre-loads with the new uniform names and slots:

```ts
gl.useProgram(program);
gl.uniform1f(gl.getUniformLocation(program, "uCellSize"), CELL_SIZE);
gl.uniform1f(gl.getUniformLocation(program, "uPitch"), PITCH);
gl.uniform2f(gl.getUniformLocation(program, "uCellCount"), cols, rows);
gl.uniform1i(gl.getUniformLocation(program, "uCellColorsA"), 0);    // slot 0
gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeA"), 1);  // slot 1
gl.uniform1i(gl.getUniformLocation(program, "uCellColorsB"), 2);    // slot 2
gl.uniform1i(gl.getUniformLocation(program, "uLumaRangeB"), 3);  // slot 3
gl.uniform1f(gl.getUniformLocation(program, "uTime"), 0.0);
gl.useProgram(null);
```

---

## Step G — Parameterize runPass2

`runPass2` now takes two frames and a blend factor:

```ts
function runPass2(a: FrameResources, b: FrameResources, t: number) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(pass2.program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, a.cellTex);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, a.reduceSteps[a.reduceSteps.length - 1].texture);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, b.cellTex);

  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, b.reduceSteps[b.reduceSteps.length - 1].texture);

  gl.uniform1f(gl.getUniformLocation(pass2.program, "uTime"), t);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
```

---

## Step H — Add easeInOut and animateTo

```ts
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
```

---

## Step I — Implement renderIntoFrame and runSlideshow

`renderIntoFrame` uploads and processes one image into a `FrameResources`:

```ts
function renderIntoFrame(img: HTMLImageElement, frame: FrameResources) {
  const srcTex = uploadImage(img);
  runPass1(srcTex, img, frame);
  runPassReduce(frame);
  // srcTex is no longer needed after pass 1 — could delete, but fine to leave
}
```

`runSlideshow` mirrors the canvas version's loop. It uses `frameA` as the current display
and `frameB` as the staging area for the next image. At the end of each transition, A and B
swap by reference so the "current" frame is always `frameA` and the "next" is always `frameB`.

```ts
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
```

---

## Step J — Wire up

Replace the old `img.onload` block at the bottom with:

```ts
const paths: string[] = await fetch("/images").then(r => r.json());
runSlideshow(paths);
```

---

## Step K — Verify

- Images should cycle through automatically
- Each transition should show current dots shrinking while next dots grow
- The full animation should take ~2 seconds with ~1.5 seconds pause between transitions
- Try a slow transition by temporarily setting `DURATION = 10000` to inspect the mid-frame state
