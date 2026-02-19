# WebGL Halftone Shader — Learning Plan

## Concept

In canvas 2D, you loop over cells in JS and draw circles. In WebGL, the GPU runs a
**fragment shader** — a function called once per pixel that returns a color. Your halftone
logic becomes: *"for this pixel, should I output the dot color or the background?"*

Pipeline:
```
CPU: sends a rectangle covering the screen
GPU vertex shader: positions it in clip space (-1 to 1)
GPU rasterizer: figures out which pixels are covered
GPU fragment shader: colors each pixel → runs your halftone logic
```

---

## Steps

### Step 1 — New file ✅
`halftone-gl.html` + `halftone-gl.ts`, route added in `server.ts`.
Open at http://localhost:4000/halftone-gl.html

---

### Step 2 — Get a WebGL context
```ts
const gl = canvas.getContext('webgl2')!;
```
Unlike `getContext('2d')`, this gives you a low-level GPU API. Most operations are stateful
(you bind things, set state, then draw).

**Verify:** log `gl` to console — should not be null.

---

### Step 3 — Shaders (the core concept)

Shaders are written in **GLSL** — a C-like language that runs on the GPU. You write them
as plain strings in your TS file, then hand them to WebGL to compile at runtime.

You need two shaders, and they work as a pair:

---

**Vertex shader** — runs once per *vertex* (corner of a shape). You'll have 4 vertices
(the corners of your fullscreen rectangle). Its job is just to tell the GPU where each
corner is. You've already written this one:
```glsl
#version 300 es
in vec2 aPosition;   // input: position of this vertex, set from JS
out vec2 vUV;        // output: passed through to the fragment shader
void main() {
  vUV = aPosition * 0.5 + 0.5; // remap -1..1 → 0..1 (UV coordinates)
  gl_Position = vec4(aPosition, 0.0, 1.0); // tell GPU where this corner is
}
```

---

**Fragment shader** — runs once per *pixel* that is covered by your rectangle (so: every
pixel on screen). The GPU calls this function millions of times in parallel. Each call
handles one pixel and must produce one color.

You have no loop — instead, the shader is *called* for you, once per pixel. Inside it,
you can ask "which pixel am I?" via the built-in `gl_FragCoord.xy`, which gives you the
pixel's position in screen space (e.g. `(142.5, 87.5)` — always `.5` because it's the
pixel center).

The output is a `vec4` (r, g, b, a) that you write to a declared output variable.

A minimal fragment shader that turns everything red:
```glsl
#version 300 es
precision highp float;   // required: declare float precision

out vec4 fragColor;      // output: the color of this pixel

void main() {
  fragColor = vec4(1.0, 0.0, 0.0, 1.0);  // r, g, b, a — all between 0 and 1
}
```

That's it. Every pixel → red. This is your starting point before adding halftone logic.

---

**Compiling and linking** — GLSL doesn't get compiled ahead of time like TypeScript.
You compile it at runtime using WebGL API calls:

```
gl.createShader(gl.VERTEX_SHADER)   → create a shader object
gl.shaderSource(shader, sourceStr)  → give it the GLSL source string
gl.compileShader(shader)            → compile it on the GPU
gl.getShaderInfoLog(shader)         → check for errors (do this! errors are common)

...repeat for fragment shader...

gl.createProgram()                  → create a program (the linked pair)
gl.attachShader(program, vertShader)
gl.attachShader(program, fragShader)
gl.linkProgram(program)             → link them together
gl.useProgram(program)              → activate this program for drawing
```

Write a helper function `createProgram(vertSrc, fragSrc)` that does all of the above and
returns the linked program. You'll thank yourself later.

**Verify:** Start with the red fragment shader above. Once geometry is set up in step 4,
the canvas should turn entirely red.

---

### Step 4 — Fullscreen quad geometry

The GPU can only draw triangles. To cover the whole screen, you need a rectangle made of
two triangles. You describe it as 4 corner points in **clip space** — a coordinate system
where (-1,-1) is bottom-left and (1,1) is top-right, regardless of canvas size:

```
(-1, 1) ---- (1, 1)
   |    \       |
   |      \     |
(-1,-1) --- (1,-1)
```

You store these points in a **buffer** — a chunk of memory on the GPU. Here's the flow:

**1. Create the data on the CPU side:**
```ts
const positions = new Float32Array([
  -1, -1,   // bottom-left
   1, -1,   // bottom-right
  -1,  1,   // top-left
   1,  1,   // top-right
]);
```

**2. Upload it to the GPU:**
```ts
const buffer = gl.createBuffer();        // allocate a buffer on the GPU
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);  // "I'm talking about this buffer now"
gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);  // upload the data
```

**3. Tell the vertex shader how to read it:**

Your vertex shader has `in vec2 aPosition;` — an input that expects 2 floats per vertex.
You need to connect the buffer data to that input:
```ts
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
```

**4. Draw:**
```ts
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```
`TRIANGLE_STRIP` means: form triangles by connecting consecutive points. With 4 points it
makes exactly 2 triangles that together form the rectangle. `0` is the start index, `4`
is the number of vertices.

This triggers the whole pipeline: vertex shader runs 4 times (once per corner), the GPU
rasterizes the two triangles into pixels, then the fragment shader runs once per pixel.

**Verify:** Red canvas fills the entire viewport.

---

### Step 5 — Upload image as texture

A **texture** is an image living on the GPU that your fragment shader can sample from.
The process is: load image on CPU with JS → upload to GPU as a texture → sample it in
the shader.

**1. Load the image (same as before):**
```ts
const img = new Image();
img.onload = () => { /* do the WebGL stuff here */ };
img.src = "/images/clockenflap.avif";
```
Everything from here down goes inside `onload` — you can't upload to the GPU before the
image has actually loaded.

**2. Create and bind a texture:**
```ts
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
```
`bindTexture` is the same pattern as `bindBuffer` — you're saying "subsequent texture
operations apply to this texture."

**3. Upload the image to the GPU:**
```ts
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
```
The arguments: target, mipmap level (0 = full size), internal format, source format,
data type, image element. Both formats being `gl.RGBA` means "store it as RGBA, read it
as RGBA." You can mostly treat this as boilerplate.

**4. Set filtering:**
```ts
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
```
Filtering controls how the GPU interpolates when a texture is displayed at a size
different from its native resolution. `LINEAR` blends between adjacent pixels (smooth).
The alternative is `NEAREST` which snaps to the closest pixel (blocky/pixelated).

You need to set both MIN (texture displayed smaller than native) and MAG (larger).

**5. Tell the shader about it:**

In your fragment shader, declare a uniform to receive the texture:
```glsl
uniform sampler2D uTexture;
```

Then in `main()`, sample it using the UV coordinates passed from the vertex shader:
```glsl
vec4 color = texture(uTexture, vUV);
fragColor = color;
```

`vUV` travels from the vertex shader to the fragment shader — for each pixel, the GPU
automatically interpolates the UV based on where that pixel sits between the corners.
So a pixel in the middle of the screen gets UV `(0.5, 0.5)`, sampling the center of the
image.

**6. Pass the texture to the shader from JS:**

After `gl.useProgram(program)`:
```ts
gl.activeTexture(gl.TEXTURE0);         // activate texture slot 0
gl.bindTexture(gl.TEXTURE_2D, texture); // bind your texture to that slot
const loc = gl.getUniformLocation(program, "uTexture");
gl.uniform1i(loc, 0);                  // tell the shader: uTexture = slot 0
```

The GPU has a fixed number of texture slots (at least 16). You bind your texture to a
slot, then tell the shader which slot number to read from.

**Verify:** Output `fragColor = color` from the texture sample — the image should appear
on the canvas.

---

### Step 6 — Uniforms

Your fragment shader needs to know the canvas size, cell size, and pitch — but right now
those values only exist in your JS. **Uniforms** are how you pass values from JS into a
shader. Think of them as read-only globals: you set them from JS once, and every pixel
can read them.

You've already used one uniform — `uTexture`. `uResolution`, `uCellSize`, and `uPitch`
work exactly the same way, just with different types.

**In the shader — declare them:**

Add these alongside `uTexture` in your fragment shader:
```glsl
uniform vec2 uResolution;  // canvas width and height in pixels
uniform float uCellSize;   // diameter of each cell (e.g. 6.0)
uniform float uPitch;      // cell + gap (e.g. 7.0)
```

These are just declarations — they don't have values yet. The values come from JS.

**In JS — find and set them:**

After `gl.useProgram(program)`, for each uniform:
```ts
// vec2: two floats together
const resLoc = gl.getUniformLocation(program, "uResolution");
gl.uniform2f(resLoc, canvas.width, canvas.height);

// float: one float
const cellLoc = gl.getUniformLocation(program, "uCellSize");
gl.uniform1f(cellLoc, 6.0);

const pitchLoc = gl.getUniformLocation(program, "uPitch");
gl.uniform1f(pitchLoc, 7.0);
```

`getUniformLocation` finds the uniform by name and gives you a handle to it (just like
`getAttribLocation` did for `aPosition`). Then `gl.uniform*` sets the value — the suffix
tells it what type:
- `uniform1f` — one float
- `uniform2f` — two floats (a vec2, x and y as separate arguments)
- `uniform1i` — one integer (used for texture slot numbers)

**When to set them:**

Uniforms only need to be set once before drawing, as long as the values don't change.
Put them after `gl.useProgram` and before `gl.drawArrays`. They don't need to go inside
`onload` unless the values depend on the image.

**Verify:** The uniforms don't produce any visible output on their own — you'll use them
in step 7. But you can test `uResolution` is working by temporarily outputting it as a
color in the shader:
```glsl
fragColor = vec4(gl_FragCoord.xy / uResolution, 0.0, 1.0);
```
This should produce a gradient — red increasing left→right, green increasing bottom→top.

---

### Step 7 — Fragment shader halftone logic

Remember: this function is called once per pixel. `gl_FragCoord.xy` tells you which pixel
you are. You don't loop — you just answer the question *"what color should I be?"*

Here's the reasoning, step by step:

**1. Which cell am I in?**
Divide my pixel position by the pitch (cell + gap size), then floor it:
```glsl
vec2 cellCoord = floor(gl_FragCoord.xy / uPitch);
```
This gives you e.g. `(3.0, 7.0)` — the column and row of the cell this pixel belongs to.

**2. Where is the center of that cell?**
Multiply back by pitch and add half a cell:
```glsl
vec2 cellCenter = (cellCoord + 0.5) * uPitch;
```
Now you know the screen-space position of the dot center for this cell.

**3. What color is the image at this cell?**
To sample the texture, you need UV coordinates (0..1), not pixel coordinates. Divide by
canvas resolution:
```glsl
vec2 uv = cellCenter / uResolution;
vec4 color = texture(uTexture, uv);
```
This samples the image at the center of the cell — same color for every pixel in the cell.

**4. How big should the dot be?**
Calculate luma (perceived brightness) from the color, map it to a radius:
```glsl
float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
float radius = sqrt(luma) * uCellSize * 0.5;
```
`sqrt` gives a nicer curve than linear (same as our canvas version).

**5. Am I inside the dot or outside it?**
Calculate distance from this pixel to the cell center:
```glsl
float dist = length(gl_FragCoord.xy - cellCenter);
```

**6. Output the final color:**
```glsl
if (dist < radius) {
  fragColor = color;         // inside dot → image color
} else {
  fragColor = vec4(0, 0, 0, 1);  // outside dot → black background
}
```

That's the whole halftone logic. Each pixel independently decides: *am I inside my cell's
dot?* No loops, no JS, all running in parallel on the GPU.

**Key GLSL types/functions you'll use:**
- `vec2`, `vec4` — 2 and 4 component vectors (x/y and r/g/b/a)
- `floor(v)` — round down each component
- `length(v)` — distance from origin (Pythagoras)
- `dot(a, b)` — dot product (used here for weighted sum of rgb)
- `sqrt(x)` — square root
- `texture(sampler, uv)` — sample the texture

**Verify:** Halftone pattern appears on the concert image.

---

## Simplifications vs. canvas version

- **No per-image luma normalization** — use raw luma × scale factor, tune manually
- **Cell center sampling** instead of averaging (true averaging needs a loop over all cell pixels)
- **No animation** — static render only
- **No slideshow** — single image

---

## Suggested debug order

1. Red canvas → WebGL pipeline works
2. Image drawn via UV → texture sampling works
3. Solid colored cells (no circles) → cell grid logic works
4. Circle masking → halftone works
5. Tune luma → radius mapping to taste

---

## Two-pass averaged cell color

Instead of sampling the image at each cell's center point, render the image into a small
texture first — one texel per cell — so each texel naturally represents the average color
of that cell. The halftone pass then samples from this small texture instead.

### Concept

```
Pass 1: original image (1440×900) → [downsample shader] → small texture (cols×rows)
Pass 2: small texture (cols×rows) → [halftone shader]   → canvas (1440×900)
```

A **framebuffer object (FBO)** is an off-screen render target. Instead of drawing to the
canvas, you draw into a texture. That texture can then be used as input to the next pass.

---

### Step A — Understand what size the small texture should be

The small texture needs one texel per cell. Calculate:
```ts
const cols = Math.ceil(canvas.width / PITCH);
const rows = Math.ceil(canvas.height / PITCH);
```
This is the same grid you already use in the halftone shader — just made explicit in JS
so you can create a texture of that exact size.

---

### Step B — Create the small render-target texture

Unlike your source texture (which was uploaded from an image), this texture starts empty
— you're allocating space for the GPU to write into.

```ts
gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, smallTex)
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
```

The `null` at the end means "allocate the memory but don't fill it yet." Set filtering to
`NEAREST` for this texture — you'll be sampling it at exact cell coordinates, so you
don't want any blending between texels.

---

### Step C — Create a framebuffer and attach the texture

A framebuffer is just a collection of attachments — textures or renderbuffers that the
GPU writes into when you draw. The color attachment is where `fragColor` output goes.

```ts
gl.createFramebuffer()
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, smallTex, 0)
```

After attaching, check it's complete:
```ts
gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
```

**Verify:** status should be `FRAMEBUFFER_COMPLETE`. If not, the texture format is wrong.

---

### Step D — Write a passthrough shader program

Pass 1 needs its own simple fragment shader — it just reads from the source texture and
outputs the color unchanged:

```glsl
uniform sampler2D uTexture;
in vec2 vUV;
out vec4 fragColor;
void main() {
  fragColor = texture(uTexture, vUV);
}
```

The vertex shader is identical to what you already have. You'll need a second compiled
shader program for this — same `createProgram` boilerplate, different fragment source.

---

### Step E — Enable mipmaps on the source texture

When the GPU renders the large image into the small (cols×rows) framebuffer, each output
texel covers a whole cell-sized region of the source image. Without mipmaps, the GPU
samples just one point from that region — not an average. With mipmaps, it uses a
pre-averaged version of the source at the right scale, giving you true averaging for free.

**What are mipmaps?**
A mipmap is a precomputed sequence of progressively halved versions of a texture:
level 0 = full size, level 1 = half size, level 2 = quarter size, and so on — each level
averaging the pixels from the level above. `gl.generateMipmap()` computes all levels
automatically from the uploaded image data.

**Where to put this:**
Inside `onload`, after `gl.texImage2D` uploads the image data (the data must exist before
mipmaps can be generated from it). Replace the existing `TEXTURE_MIN_FILTER` line:

```ts
gl.generateMipmap(gl.TEXTURE_2D);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
```

`LINEAR_MIPMAP_LINEAR` (trilinear filtering) means: find the two mip levels that bracket
the current scale, sample each with LINEAR, then blend between them. The GPU picks the
right levels automatically based on how much the texture is being shrunk in this draw call.

For pass 1, where you're shrinking a ~1440×900 image to ~206×129, the GPU will select
a mip level close to the right scale and blend adjacent levels — resulting in a proper
area average rather than a single point sample.

**Important:** `generateMipmap` must be called while the source texture is still bound
(`gl.bindTexture` must refer to the source image texture, not `smallTex`).

---

### Step F — Execute pass 1

This goes inside `onload`, after the source texture is set up. The goal is to render the
source image into `smallTex` via the FBO, shrinking it to one texel per cell.

**1. Bind the FBO as the render target:**
```ts
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
```
Any subsequent `drawArrays` call will now write into `smallTex` instead of the canvas.

**2. Set the viewport to the small texture size:**
```ts
gl.viewport(0, 0, cols, rows);
```
This tells the GPU how large the render target is. `gl_FragCoord` will now range from
`(0,0)` to `(cols, rows)`, matching the small texture's dimensions. Without this, the
GPU would try to fill a 1440×900 area into a 206×129 texture — wrong.

**3. Switch to the passthrough program:**
```ts
gl.useProgram(passthroughProgram);
```

**4. Bind the source texture and tell the shader where to find it:**
```ts
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, texture);  // the loaded image, not smallTex
const ptLoc = gl.getUniformLocation(passthroughProgram, "uTexture");
gl.uniform1i(ptLoc, 0);
```
The source image goes into slot 0. The passthrough shader samples it and writes each
output pixel's color directly to `fragColor` — no logic, just a copy. Because the output
is much smaller than the input, the GPU uses the mipmaps you generated to average the
source pixels down to each output texel.

**5. Draw:**
```ts
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```
Same quad, same vertex shader — just rendering into a tiny target now.

**Verify:** before writing pass 2, temporarily bind `null` framebuffer, restore the
viewport, and render `smallTex` directly to the canvas using the passthrough program.
You should see a tiny pixelated image in the corner — one pixel per cell, each pixel
being the averaged color of that cell. This confirms pass 1 is working before you add
the halftone logic on top.

---

### Step G — Execute pass 2

This goes in `onload`, immediately after pass 1's `drawArrays`. At this point `smallTex`
contains the averaged colors. Now you render the halftone to the canvas.

**1. Unbind the FBO — switch back to rendering to the canvas:**
```ts
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
```
Passing `null` restores the default framebuffer, which is the canvas. Any subsequent
`drawArrays` will now write to the screen.

**2. Restore the viewport to the full canvas size:**
```ts
gl.viewport(0, 0, canvas.width, canvas.height);
```
You shrunk the viewport to `(cols, rows)` for pass 1. Without restoring it, the halftone
would only render into a tiny corner of the canvas.

**3. Switch to the halftone program:**
```ts
gl.useProgram(program);
```

**4. Bind `smallTex` so the halftone shader can sample it:**
```ts
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, smallTex);
const htLoc = gl.getUniformLocation(program, "uTexture");
gl.uniform1i(htLoc, 0);
```
The halftone shader reads from `uTexture` — now that's the averaged small texture instead
of the original image. The `uResolution`, `uCellSize`, and `uPitch` uniforms are already
set from earlier (outside `onload`) so you don't need to set them again.

**5. Draw:**
```ts
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
```

---

### Step H — Update the halftone shader's UV calculation

This is a change inside the fragment shader string (in `fragmentShaderInput`). The shader
currently samples the original image using `cellCenter / uResolution`. But now `uTexture`
is `smallTex` — a texture that has exactly one texel per cell. The UV calculation needs
to change to match.

**Why the old UV doesn't work:**
`cellCenter / uResolution` gives a UV that points to the right place in the original
1440×900 image. But `smallTex` is only `cols×rows` pixels. If you sample `smallTex`
using a UV derived from pixel positions, you'll land on the wrong texel.

**The new UV:**
`smallTex` has one texel per cell. Cell `(0,0)` is texel `(0,0)`, cell `(1,0)` is texel
`(1,0)`, etc. To convert from cell coordinate to UV (0..1), divide by the total cell
count:
```glsl
vec2 uv = (cellCoord + 0.5) / uCellCount;
vec4 color = texture(uTexture, uv);
```
`+ 0.5` centers the sample within the texel, same as why pixel centers are at `.5` in
`gl_FragCoord`. Without it you'd be sampling right on the boundary between texels.

**Add a new uniform to the shader:**
In the fragment shader declarations, add:
```glsl
uniform vec2 uCellCount;
```

**Set it from JS**, outside `onload` alongside your other uniforms:
```ts
gl.useProgram(program);
const cellCountLoc = gl.getUniformLocation(program, "uCellCount");
gl.uniform2f(cellCountLoc, cols, rows);
```

**Also remove `uResolution` from the shader** — it's no longer used once you switch to
the `uCellCount`-based UV. You can leave it in JS for now, it just won't do anything.

**Verify:** halftone renders with averaged cell colors — should look smoother in areas
with high-contrast detail compared to single-point sampling.
