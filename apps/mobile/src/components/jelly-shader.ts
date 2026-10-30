/**
 * The HeyNavi symbol as a Skia runtime shader (SkSL): a soft, translucent blue jelly of four
 * folded lobes around a core, ray-marched in 3D. Original artwork for HeyNavi, not the Meta logo.
 *
 * The shape is a smooth union of curved, flattened ellipsoids (the lobes) and a sphere (the core),
 * with a slow sine wobble through it (jelly) and an optional ripple (listening and speaking). The
 * shading fakes translucency: color deepens with how much jelly the view ray passes through, so
 * lobes folding over each other read as layers; a soft rim, a wrap light from the top left, and a
 * sharp highlight make it glossy. Rays that miss leave a faint blue glow around the shape.
 *
 * Per-frame values (lobe frames, wobble phases, scale) are computed once per frame on the UI
 * thread (jelly-motion.ts) and passed as uniforms, so each pixel only evaluates the distance
 * field. Cost is bounded: rays outside the bounding sphere stop at once, marching stops after 40
 * steps, and thickness takes 5 extra samples.
 */
export const JELLY_SKSL = `
uniform float2 res;
uniform float lift;
uniform float scale;
uniform float core;
uniform float wob;
uniform float3 wp;
uniform float ripple;
uniform float rp;
uniform float3 u0;
uniform float3 v0;
uniform float3 w0;
uniform float4 d0;
uniform float3 u1;
uniform float3 v1;
uniform float3 w1;
uniform float4 d1;
uniform float3 u2;
uniform float3 v2;
uniform float3 w2;
uniform float4 d2;
uniform float3 u3;
uniform float3 v3;
uniform float3 w3;
uniform float4 d3;

float ellipsoid(float3 p, float3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 0.0001);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// One lobe: a flattened ellipsoid along u, starting near the center, curled along its length and
// cupped across its width like a folded petal. d = (length, width, thickness, curl).
float lobe(float3 p, float3 u, float3 v, float3 w, float4 d) {
  float x = dot(p, u) - d.x * 0.62;
  float y = dot(p, v);
  float z = dot(p, w) + d.w * (x * x - 0.25 * y * y);
  return ellipsoid(float3(x, y, z), d.xyz);
}

float map(float3 q) {
  float3 p = q / scale;
  p += wob * sin(p.yzx * 3.1 + wp);
  float s = length(p) - core;
  s = smin(s, lobe(p, u0, v0, w0, d0), 0.16);
  s = smin(s, lobe(p, u1, v1, w1, d1), 0.16);
  s = smin(s, lobe(p, u2, v2, w2, d2), 0.16);
  s = smin(s, lobe(p, u3, v3, w3, d3), 0.16);
  s += ripple * sin(17.0 * length(p) - rp);
  return s * scale * 0.72;
}

float3 normalAt(float3 p) {
  float e = 0.003;
  float3 a = float3(1.0, -1.0, -1.0);
  float3 b = float3(-1.0, -1.0, 1.0);
  float3 c = float3(-1.0, 1.0, -1.0);
  float3 d = float3(1.0, 1.0, 1.0);
  return normalize(a * map(p + a * e) + b * map(p + b * e) + c * map(p + c * e) + d * map(p + d * e));
}

half4 main(float2 xy) {
  float2 uv = (xy - 0.5 * res) / (0.5 * res.y);
  uv.y = -uv.y - lift;
  float3 ro = float3(0.0, 0.0, 3.2);
  float3 rd = normalize(float3(uv * 0.29, -1.0));

  // Bounding sphere of radius 1: rays that miss it are transparent.
  float b = dot(ro, rd);
  float h = b * b - dot(ro, ro) + 1.0;
  if (h < 0.0) { return half4(0.0); }
  h = sqrt(h);
  float t = -b - h;
  float tEnd = -b + h;
  float closest = 10.0;
  float hit = 0.0;
  for (int i = 0; i < 40; i++) {
    float d = map(ro + rd * t);
    closest = min(closest, d);
    if (d < 0.0015) { hit = 1.0; break; }
    t += d;
    if (t > tEnd) { break; }
  }

  if (hit < 0.5) {
    // A faint glow around the jelly, gone before the canvas edge.
    float g = exp(-max(closest, 0.0) * 14.0) * 0.3 * smoothstep(1.0, 0.75, length(uv));
    return half4(half3(float3(0.40, 0.62, 1.0) * g), half(g));
  }

  float3 p = ro + rd * t;
  float3 n = normalAt(p);
  float3 v = -rd;
  float3 light = normalize(float3(-0.55, 0.8, 0.6));
  float wrapLight = clamp(dot(n, light) * 0.5 + 0.5, 0.0, 1.0);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  float rim = pow(1.0 - facing, 4.0);
  float spec = pow(clamp(dot(n, normalize(light + v)), 0.0, 1.0), 70.0);
  float fill = pow(clamp(dot(n, normalize(float3(0.7, -0.5, 0.5) + v)), 0.0, 1.0), 14.0);

  // How much jelly the view ray passes through behind this point: overlapping lobes read deeper.
  float thick = 0.0;
  for (int i = 1; i < 6; i++) {
    thick += clamp(-map(p + rd * (0.07 * float(i))) * 6.0, 0.0, 1.0);
  }
  thick /= 5.0;

  // Light from the top left of the symbol, deep blue toward the bottom right (wireframe 01).
  float topLeft = smoothstep(-0.8, 0.8, uv.y - uv.x);

  float3 pale = float3(0.76, 0.88, 1.0);
  float3 mid = float3(0.11, 0.45, 1.0);
  float3 deep = float3(0.015, 0.2, 0.7);
  // A vivid blue body, deeper where lobes overlap, paler where a lobe is thin and lets light in.
  float3 col = mix(mid, deep, smoothstep(0.3, 0.95, thick) * 0.75);
  col = mix(col, pale, (1.0 - smoothstep(0.0, 0.3, thick)) * 0.35);
  col = mix(col, deep, (1.0 - topLeft) * 0.4);
  col = mix(col, pale, topLeft * wrapLight * wrapLight * 0.5);
  col *= 0.72 + 0.36 * wrapLight;
  col = mix(col, deep, (1.0 - wrapLight) * 0.4);
  col += float3(0.5, 0.74, 1.0) * rim * 0.45;
  col += float3(1.0, 1.0, 1.0) * spec * 0.95 + float3(0.62, 0.82, 1.0) * fill * 0.22;
  float a = clamp(0.7 + 0.28 * thick + 0.18 * rim + spec, 0.0, 1.0);
  return half4(half3(col * a), half(a));
}
`;
