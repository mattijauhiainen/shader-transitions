#version 300 es
precision highp float;

uniform sampler2D uCELL_COLORS;
uniform sampler2D uLUMA_RANGE;
uniform vec2 uGRID_SIZE;
uniform float uDOT_SIZE;
uniform float uPITCH;
uniform vec3 uLUMA;
uniform vec2 uVIEWPORT;
uniform float uFOCAL_LEN;
uniform float uNEAR_CLIP;

uniform float uFar;
uniform vec3 uCamPos;
uniform mat3 uCamRot;
// When uParticleZMin == uParticleZMax, plane is flat. Otherwise particles
// are hashed along this Z range — the scattered-cloud effect.
uniform float uParticleZMin;
uniform float uParticleZMax;
// Hash seed so different planes get different particle layouts.
uniform float uPlaneSeed;

in vec2 aPosition;

flat out vec4 vColor;
flat out float vRadius;
out vec2 vLocalPos;

float hash13(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
}

void main() {
    int col = gl_InstanceID % int(uGRID_SIZE.x);
    int row = gl_InstanceID / int(uGRID_SIZE.x);
    vec2 cellCoord = vec2(col, row);

    vec2 gridCenter = uGRID_SIZE * uPITCH * 0.5;
    vec2 cellCenter = (cellCoord + 0.5) * uPITCH;
    vec2 worldXY = cellCenter - gridCenter;

    float zScatterOffset = hash13(vec3(cellCoord, uPlaneSeed));
    float particleZ = mix(uParticleZMin, uParticleZMax, zScatterOffset);

    vec3 worldPos = vec3(worldXY, particleZ);
    vec3 camSpace = uCamRot * (worldPos - uCamPos);

    if (camSpace.z < uNEAR_CLIP || camSpace.z > uFar) {
        gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        vColor = vec4(0.0);
        vRadius = 0.0;
        vLocalPos = vec2(0.0);
        return;
    }

    vec2 uv = (cellCoord + 0.5) / uGRID_SIZE;
    vec4 color = textureLod(uCELL_COLORS, uv, 0.0);
    vec2 range = textureLod(uLUMA_RANGE, vec2(0.5), 0.0).rg;

    float normLuma = clamp(
            (dot(color.rgb, uLUMA) - range.r) / (range.g - range.r),
            0.0, 1.0);
    float radius = sqrt(normLuma) * uDOT_SIZE * 0.5;

    float perspScale = uFOCAL_LEN / camSpace.z;
    float screenRadius = radius * perspScale;
    float outerScreenRadius = screenRadius + 0.5;

    vec2 screenCenter = uVIEWPORT * 0.5;
    vec2 projected = camSpace.xy * perspScale + screenCenter;

    vec2 billboard = aPosition * outerScreenRadius;
    vec2 screen = projected + billboard;

    float ndcZ = (camSpace.z - uNEAR_CLIP) / (uFar - uNEAR_CLIP) * 2.0 - 1.0;
    gl_Position = vec4(screen / uVIEWPORT * 2.0 - 1.0, ndcZ, 1.0);

    vColor = color;
    vRadius = screenRadius;
    vLocalPos = aPosition;
}
