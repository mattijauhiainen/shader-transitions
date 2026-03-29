#version 300 es
precision highp float;

flat in vec4 vColor;
flat in float vRadiusPx;
flat in float vOpacityNorm;
flat in float vDropHeightNorm;
flat in vec2 vRadialDir;
flat in float vSplashNorm;
in vec2 vOffsetPx;

out vec4 fragColor;

void main() {
  float distPx = length(vOffsetPx);

  if (vSplashNorm >= 0.0) {
    // Landed: draw solid circle + expanding ripple ring
    float circle = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, distPx);

    // Ripple: expanding ring from radius outward
    float rippleRadiusPx = vRadiusPx + vSplashNorm * vRadiusPx * 6.0;
    float ringWidthPx = 1.5;
    float ring = smoothstep(rippleRadiusPx - ringWidthPx, rippleRadiusPx, distPx)
               * smoothstep(rippleRadiusPx + ringWidthPx, rippleRadiusPx, distPx);
    float rippleAlpha = ring * (1.0 - vSplashNorm);

    float a = circle * vOpacityNorm;
    vec3 col = vColor.rgb * a + vColor.rgb * rippleAlpha * (1.0 - a);
    float alpha = a + rippleAlpha * (1.0 - a);
    fragColor = vec4(col, alpha);
  } else if (vDropHeightNorm > 0.001) {
    // Still falling: motion blur + sphere shading
    float stretch = 1.0 + vDropHeightNorm * 2.0;
    float radialCompPx = dot(vOffsetPx, vRadialDir);
    float tangentCompPx = dot(vOffsetPx, vec2(-vRadialDir.y, vRadialDir.x));
    vec2 compressedPx = vec2(radialCompPx / stretch, tangentCompPx);
    float compDistPx = length(compressedPx);
    float circle = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, compDistPx);

    vec2 nxy = compressedPx / max(vRadiusPx, 0.001);
    float r2 = dot(nxy, nxy);
    float nz = sqrt(max(0.0, 1.0 - r2));
    vec3 lightDir = normalize(vec3(-0.4, 0.5, 0.8));
    vec3 normal = vec3(nxy, nz);
    float diffuse = max(dot(normal, lightDir), 0.0);
    float shading = mix(0.5 + 0.5 * diffuse, 1.0, vDropHeightNorm);

    fragColor = vec4(vColor.rgb * shading * circle * vOpacityNorm, circle * vOpacityNorm);
  } else {
    // Phase A: flat circles
    float circle = smoothstep(vRadiusPx + 0.5, vRadiusPx - 0.5, distPx);
    fragColor = vec4(vColor.rgb * circle * vOpacityNorm, circle * vOpacityNorm);
  }
}
