# Luma normalization via a GPU reduction pass

The goal is to find the min and max luma across all halftone cells entirely on the GPU, then use those values in pass 2 to normalize dot sizes so the darkest cell is always radius 0 and the brightest always max radius.

The strategy: after pass 1 produces the `cols×rows` averaged cell texture, add a new pass that repeatedly halves the texture size, computing min/max at each step, until we reach 1×1. That single pixel holds the global min (in R) and max (in G) across all cells.

---

## Step A — Understand the reduction approach

You can't compute a global min/max in a single shader invocation because each fragment only sees one pixel. Instead you do it iteratively:

- Start with the `cols×rows` texture from pass 1
- Render it into a texture half the size, where each output pixel holds the min/max of a 2×2 block of input pixels
- Repeat, halving each time, until the texture is 1×1

Each step is a draw call with a different input texture and output FBO. After the final step, the 1×1 texture contains the global min luma in R and global max luma in G.

---

## Step B — Write the reduction shader

This goes in a new `setupPassReduce()` function. The shader needs to handle two different cases:

- **First step**: the input is the `cols×rows` RGB color texture from pass 1 — compute luma via dot product
- **Subsequent steps**: the input already holds `(minLuma, maxLuma, 0)` — just propagate min/max from R and G

Use a `uIsFirstStep` bool uniform to switch between the two:

```glsl
#version 300 es
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
```

---

## Step C — Create the chain of FBOs

The reduction needs a series of textures, one per step, each half the size of the previous. Create them in `setupPassReduce()`:

```ts
function setupPassReduce() {
  const program = createProgram(vertSrc, `/* shader from step B */`);

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
```

`steps[steps.length - 1]` is the 1×1 step — its texture will hold the final global min/max.

---

## Step D — Write runPassReduce

Each step binds the previous step's texture as input and the current step's FBO as output, then draws. Use an index-based loop so you can pass `i === 0` to `uIsFirstStep`:

```ts
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
```

---

## Step E — Pass min/max to pass 2

The 1×1 result texture is `passReduce.steps[passReduce.steps.length - 1].texture`. Pass it to pass 2 via a second texture slot so the halftone shader can read the min/max values:

In `setupPass2`, add a second sampler uniform and bind it to slot 1:
```glsl
uniform sampler2D uLumaRange;  // 1×1 texture: R = minLuma, G = maxLuma
```

In `runPass2`, bind the result texture to slot 1:
```ts
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, passReduce.steps[passReduce.steps.length - 1].texture);
gl.activeTexture(gl.TEXTURE0);  // restore slot 0 as active for pass1.texture
```

In `setupPass2`, set the sampler uniform to slot 1:
```ts
gl.uniform1i(gl.getUniformLocation(program, "uLumaRange"), 1);
```

---

## Step F — Use min/max in the pass 2 shader

In the pass 2 fragment shader, sample the 1×1 texture and normalize luma before computing the radius:

```glsl
vec2 lumaRange = texture(uLumaRange, vec2(0.5)).rg;  // sample center of 1×1 tex — R=min, G=max
float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
float normalizedLuma = (luma - lumaRange.r) / (lumaRange.g - lumaRange.r);
float radius = sqrt(normalizedLuma) * uCellSize * 0.5;
```

`texture(uLumaRange, vec2(0.5))` samples the exact center of the 1×1 texture — there's only one pixel so any UV works, but 0.5 is conventional.

---

## Step G — Wire it up in onload

Call `runPassReduce` between pass 1 and pass 2:

```ts
img.onload = () => {
  const srcTex = uploadImage(img);
  runPass1(srcTex);
  runPassReduce();
  runPass2();
};
```

---

## Step H — Verify

- Dark images should now show large dots (dark cells get small dots, but the darkest cell will be exactly 0 and the contrast is stretched)
- Actually: bright cells → large dots, dark cells → small dots, but the full range of the image always uses the full range of dot sizes
- Try with a very dark or low-contrast image — dots should still span from nearly 0 to max radius
