# Cover scaling in the WebGL halftone

Currently the pass 1 shader samples `vUV` directly, which stretches the image to fill the canvas regardless of aspect ratio. The goal is to replicate the canvas version's cover behaviour: scale the image so it fills the canvas, cropping the overflow, centered.

---

## Step A — Add image size uniforms to the pass 1 shader

The shader needs to know the image's original pixel dimensions so it can compute the scale. Add two new uniforms to the pass 1 fragment shader:

```glsl
uniform vec2 uImageSize;   // original image width and height in pixels
uniform vec2 uCanvasSize;  // canvas width and height in pixels
```

---

## Step B — Compute the cover scale factor in the shader

Inside `main()`, before sampling, compute the scale factor. Cover means the image fills the canvas completely — whichever dimension needs to grow more wins:

```glsl
vec2 scale = uCanvasSize / uImageSize;       // how much to scale on each axis to fill that axis
float coverScale = max(scale.x, scale.y);    // pick the larger — this axis fills exactly, the other overflows
```

`coverScale` is the single uniform scale applied to the image, same as `Math.max(...)` in the canvas version.

---

## Step C — Remap vUV into image UV space

`vUV` goes from `(0,0)` to `(1,1)` across the canvas. You need to transform it so `(0,0)` to `(1,1)` maps to the visible portion of the image.

The scaled image size in canvas-relative units is:

```glsl
vec2 scaledImageSize = uImageSize * coverScale;  // image size after scaling, in pixels
```

The image is centered, so there's an offset on each axis (this is the crop amount split equally on both sides):

```glsl
vec2 offset = (scaledImageSize - uCanvasSize) * 0.5;  // pixels cropped off each edge
```

Now convert `vUV` (which is in canvas pixel space when multiplied by canvas size) to image UV:

```glsl
vec2 pixelCoord = vUV * uCanvasSize;                      // canvas pixel this fragment corresponds to
vec2 imagePixel = pixelCoord + offset;                    // shift into the image's pixel space
vec2 imageUV    = imagePixel / scaledImageSize;           // normalise to [0,1] within the scaled image
```

Replace `vUV` with `imageUV` in the `texture(...)` call:

```glsl
fragColor = texture(uTexture, imageUV);
```

Because the image exactly covers the canvas (cover scaling), `imageUV` will always be within `[0,1]` — no out-of-bounds fragments to handle.

---

## Step D — Upload the uniforms from JavaScript

In `runPass1`, after `gl.useProgram`, pass the image dimensions and canvas dimensions:

```js
gl.uniform2f(gl.getUniformLocation(pass1.program, "uImageSize"), img.width, img.height);
gl.uniform2f(gl.getUniformLocation(pass1.program, "uCanvasSize"), canvas.width, canvas.height);
```

`img` is the `HTMLImageElement` — its `.width` and `.height` are the original pixel dimensions.

These values are per-image (different images have different dimensions), so they belong in `runPass1` alongside the draw call, not in `setupPass1`.

---

## Step E — Verify

Load the page and confirm:
- The image fills the canvas completely with no black bars
- Aspect ratio is preserved (no stretching)
- The image is centered (equal crop on both sides)

Compare with the canvas version in `index.ts` — the result should look the same.
