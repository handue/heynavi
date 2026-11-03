/**
 * The HeyNavi symbol as a Skia runtime shader (SkSL): a frosted glass orb with two eyes, lit from
 * the top left and glowing HeyNavi blue (#0668E1, the app's primary color) from the bottom right.
 * Original artwork for HeyNavi.
 *
 * The orb is a sphere drawn in 2D: its normal comes straight from the position inside the disc,
 * so each pixel costs a few dozen operations (the jelly it replaced ray-marched a 3D shape). The
 * outline wobbles gently (two slow lobes, plus a ripple while listening or speaking). Frosted
 * glass: no sharp glint, a broad soft highlight, color that deepens toward the edge on the side
 * away from the light, and a soft blue halo below the orb that fades out before the canvas edge.
 * The eyes are two dark ovals on the front of the orb: they slide toward where it looks, narrow
 * as they near the edge, and close for a blink.
 *
 * Per-frame values come from orb-motion.ts as uniforms. Positions are in units of half the
 * canvas, y up; `tint` is the unit direction the blue comes from.
 */
export const ORB_SKSL = `
uniform float2 res;
uniform float2 center;
uniform float radius;
uniform float4 shape;
uniform float ripple;
uniform float rp;
uniform float2 tint;
uniform float glow;
uniform float2 look;
uniform float open;

// Signed distance to an ellipse (approximate, exact enough near its edge).
float oval(float2 p, float2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 0.0001);
}

half4 main(float2 xy) {
  float3 blue = float3(0.024, 0.408, 0.882);
  float3 ink = float3(0.05, 0.06, 0.09);
  float3 white = float3(1.0);

  float2 uv = (xy - 0.5 * res) / (0.5 * res.y);
  uv.y = -uv.y;
  float2 q = (uv - center) / radius;
  // About one pixel, in orb units, for soft edges.
  float aa = 1.2 / (0.5 * res.y * radius);

  float angle = atan(q.y, q.x);
  float edge = 1.0 + shape.x * sin(2.0 * angle + shape.y) + shape.z * sin(3.0 * angle + shape.w)
    + ripple * sin(5.0 * angle - rp);
  float r = length(q) / edge;
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);

  // Blue light spilling around the orb, strongest below it, gone before the canvas edge.
  float hd = max(length(q - float2(0.04 * tint.x, -0.1)) - 0.78, 0.0);
  float halo = glow * 0.42 * exp(-hd * hd * 5.0) * (1.0 - smoothstep(0.84, 0.99, length(uv)));
  if (inside <= 0.0) {
    return half4(half3(blue * halo), half(halo));
  }

  float2 n = q / edge;
  float z = sqrt(max(1.0 - r * r, 0.0));
  float side = dot(n, tint);
  float rim = pow(1.0 - z, 1.5);

  // Frosted white glass with a light blue wash on the side away from the light, richer at the edge.
  float3 col = float3(0.975, 0.98, 0.995);
  col = mix(col, mix(white, blue, 0.42), smoothstep(-0.7, 0.9, side) * 0.9);
  col = mix(col, mix(white, blue, 0.66), rim * smoothstep(-0.2, 0.9, side));
  // A broad, soft highlight at the top left and a pale rim on the lit side: no sharp glint.
  float highlight = 1.0 - smoothstep(0.05, 0.8, length(n + tint * 0.42));
  col = mix(col, white, highlight * 0.7);
  col = mix(col, white, rim * smoothstep(0.1, -0.7, side) * 0.6);

  // The eyes: they slide toward where the orb looks and narrow as they near its edge.
  float2 ec = float2(0.0, 0.06) + look * float2(0.24, 0.16);
  float squeeze = 0.6 + 0.4 * sqrt(max(1.0 - dot(ec, ec), 0.0));
  float2 er = float2(0.07 * squeeze, mix(0.016, 0.118, open));
  float2 gap = float2(0.205 * squeeze, 0.0);
  float eyes = 1.0 - smoothstep(-aa, aa, min(oval(q - ec + gap, er), oval(q - ec - gap, er)));
  col = mix(col, ink, eyes);

  float a = inside + (1.0 - inside) * halo;
  return half4(half3(col * inside + blue * halo * (1.0 - inside)), half(a));
}
`;
