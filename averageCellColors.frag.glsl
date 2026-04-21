#version 300 es
precision highp float;
uniform sampler2D uTEXTURE;
uniform vec2 uIMAGE_SIZE;
uniform vec2 uCANVAS_SIZE;
in vec2 vUV;
out vec4 fragColor;
void main() {
  vec2 scale = uCANVAS_SIZE / uIMAGE_SIZE;
  float coverScale = max(scale.x, scale.y);
  vec2 scaledImageSize = uIMAGE_SIZE * coverScale;
  vec2 offset = (scaledImageSize - uCANVAS_SIZE) * 0.5;
  vec2 pixelCoord = vUV * uCANVAS_SIZE;
  vec2 imagePixel = pixelCoord + offset;
  vec2 imageUV    = imagePixel / scaledImageSize;
  fragColor = texture(uTEXTURE, imageUV);
}
