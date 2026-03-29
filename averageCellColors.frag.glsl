#version 300 es
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
