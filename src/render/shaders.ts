// WGSL for the deferred splat renderer (brief section 4).
export const MAX_INSTANCES = 16;
export const MAX_ANIMATORS = 8;
export const MAX_LIGHTS = 16;
export const MAX_SHADOW_LAYERS = 12;

const common = /* wgsl */ `
struct Inst { model: mat4x4f, p0: vec4f, p1: vec4f, cropMin: vec4f, cropMax: vec4f }
struct Anim { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f }
struct Scene { insts: array<Inst, ${MAX_INSTANCES}>, anims: array<Anim, ${MAX_ANIMATORS}>, counts: vec4f, eye: vec4f }
struct View { view: mat4x4f, proj: mat4x4f, vp: vec4f }

fn hash11(n: u32) -> f32 {
  var h = n * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967296.0;
}
fn hash3(p: vec3f) -> f32 {
  let q = vec3u(vec3i(floor(p)) + vec3i(32768));
  return hash11((q.x * 1597334677u) ^ (q.y * 3812015801u) ^ (q.z * 2798796415u));
}
// Value noise, 0..1.
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y),
    mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y),
    u.z);
}
fn fbm(p: vec3f) -> f32 { return vnoise(p) * 0.65 + vnoise(p * 2.03 + vec3f(17.1, 3.7, 9.2)) * 0.35; }
// Vector noise, -1..1 per axis.
fn vnoise3(p: vec3f) -> vec3f {
  return vec3f(fbm(p), fbm(p + vec3f(31.4, 12.7, 5.3)), fbm(p + vec3f(7.9, 44.2, 21.6))) * 2.0 - 1.0;
}
`;

export const splatShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var<storage, read> gA: array<vec4f>;   // pos.xyz, opacity
@group(0) @binding(3) var<storage, read> gB: array<vec4f>;   // scale.xyz, low-frequency luminance
@group(0) @binding(4) var<storage, read> gC: array<vec4f>;   // quaternion xyzw
@group(0) @binding(5) var<storage, read> gD: array<vec4f>;   // linear rgb, instance slot
@group(0) @binding(6) var<storage, read> gE: array<vec4f>;   // normal.xyz
@group(0) @binding(7) var<storage, read> order: array<u32>;

struct Gs { pos: vec3f, alpha: f32, scale: f32, colMul: vec3f, emis: vec3f }

// Splat animators (brief section 6). Offsets to position, scale and opacity, plus colour for the sweep.
fn animate(g: ptr<function, Gs>, nrm: vec3f, slot: u32, idx: u32, base: vec3f) {
  let n = u32(scene.counts.x);
  let rnd = hash11(idx * 2654435761u + 12345u);
  for (var i = 0u; i < n; i++) {
    let an = scene.anims[i];
    let mask = u32(an.a.w);
    if (((mask >> slot) & 1u) == 0u) { continue; }
    let kind = u32(an.a.x);
    let fade = an.a.y;
    let time = an.a.z;
    let p = (*g).pos;
    if (kind == 1u) {
      // Disperse
      let amount = an.b.x * fade;
      let field = vnoise3(p * an.b.y + vec3f(0.0, time * an.b.z, time * an.b.z * 0.37));
      let dir = mix(field, nrm, an.b.w) + an.c.xyz;
      let disp = dir * amount * (0.35 + 1.3 * rnd);
      (*g).pos = p + disp;
      let dl = clamp(length(disp), 0.0, 1.0);
      (*g).alpha *= 1.0 - an.c.w * dl;
      (*g).scale *= 1.0 - an.d.x * dl;
    } else if (kind == 2u) {
      // Wobble: spatially coherent phases, so neighbours drift together.
      let ph = vnoise3(p * an.b.z) * 3.14159;
      let t = time * an.b.y * 6.28318;
      let w = vec3f(sin(t + ph.x * 2.0), sin(t * 0.83 + ph.y * 2.0), sin(t * 1.17 + ph.z * 2.0));
      (*g).pos = p + w * an.c.xyz * an.b.x * fade;
    } else if (kind == 3u) {
      // Depth sweep
      let pattern = u32(an.b.x);
      let effect = u32(an.b.y);
      var d = 0.0;
      if (pattern == 0u) { d = dot(p - an.c.xyz, an.d.xyz); }
      else if (pattern == 1u) { d = distance(p, an.c.xyz); }
      else if (pattern == 2u) { d = distance(p, scene.eye.xyz); }
      else { d = fbm(p * an.d.w); }
      let hw = an.b.w * 0.5;
      let band = 1.0 - smoothstep(hw, hw + max(an.c.w, 1e-5), abs(d - an.b.z));
      if (effect == 0u) { (*g).alpha *= mix(1.0, band, fade); }
      else if (effect == 1u) { (*g).alpha *= mix(1.0, 1.0 - band, fade); }
      else if (effect == 2u) { (*g).emis += base * an.e.w * band * fade; }
      else {
        let lum = max(dot(base, vec3f(0.2126, 0.7152, 0.0722)), 0.04);
        (*g).emis += an.e.xyz * lum * an.e.w * band * fade;
        (*g).colMul *= mix(vec3f(1.0), an.e.xyz, band * fade);
      }
    } else if (kind == 4u) {
      // Depth cut-off
      var o = scene.eye.xyz;
      if (an.b.x > 0.5) { o = an.c.xyz; }
      let d = distance(p, o);
      let ft = max(an.b.w, 1e-5);
      var inside = smoothstep(an.b.y - ft, an.b.y, d) * (1.0 - smoothstep(an.b.z, an.b.z + ft, d));
      if (an.b.y <= 0.0) { inside = 1.0 - smoothstep(an.b.z, an.b.z + ft, d); }
      if (an.c.w > 0.5) { inside = 1.0 - inside; }
      (*g).alpha *= mix(1.0, inside, fade);
    }
  }
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) albedo: vec4f,
  @location(2) normal: vec3f,
  @location(3) baked: vec4f,
  @location(4) depth: f32,
  @location(5) @interpolate(flat) seed: u32,
  /** Change of view depth per unit of uv: the splat's own plane, so depth is not flat across its footprint. */
  @location(6) @interpolate(flat) slope: vec2f,
  /** proj[2][2], proj[3][2] and the ortho flag, to turn a view depth back into a depth-buffer value. */
  @location(7) @interpolate(flat) zc: vec3f,
}

fn quatMat(q: vec4f) -> mat3x3f {
  let x = q.x; let y = q.y; let z = q.z; let w = q.w;
  return mat3x3f(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w),
    2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w),
    2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y));
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var out: VOut;
  out.pos = vec4f(0.0, 0.0, 2.0, 1.0); // culled unless we get to the end
  let idx = order[ii];
  let A = gA[idx]; let B = gB[idx]; let D = gD[idx];
  let slot = u32(D.w);
  let inst = scene.insts[slot];
  if (inst.p1.w < 0.5) { return out; }
  if (inst.p1.z > 0.5 && (any(A.xyz < inst.cropMin.xyz) || any(A.xyz > inst.cropMax.xyz))) { return out; }
  let M3 = mat3x3f(inst.model[0].xyz, inst.model[1].xyz, inst.model[2].xyz);
  let wpos = (inst.model * vec4f(A.xyz, 1.0)).xyz;
  var nrm = normalize(M3 * gE[idx].xyz);
  let toEye = scene.eye.xyz - wpos;
  if (inst.p0.w < 0.5) { if (dot(nrm, toEye) < 0.0) { nrm = -nrm; } }
  else if (inst.p0.w > 1.5) { nrm = -nrm; }

  var g: Gs;
  g.pos = wpos; g.alpha = A.w * inst.p0.z; g.scale = 1.0; g.colMul = vec3f(1.0); g.emis = vec3f(0.0);
  animate(&g, nrm, slot, idx, D.rgb);
  if (g.alpha < 0.004) { return out; }

  let vpos = (view.view * vec4f(g.pos, 1.0)).xyz;
  let ortho = view.vp.z > 0.5;
  let dist = -vpos.z;
  if (!ortho && dist < 0.05) { return out; }
  let clip = view.proj * vec4f(vpos, 1.0);
  if (clip.w <= 0.0) { return out; }
  let lim = clip.w * 1.3;
  if (abs(clip.x) > lim || abs(clip.y) > lim || clip.z < 0.0 || clip.z > clip.w) { return out; }

  let Mm = M3 * quatMat(gC[idx]);
  let s = B.xyz * g.scale;
  let c0 = Mm[0] * s.x; let c1 = Mm[1] * s.y; let c2 = Mm[2] * s.z;
  // cov = L Lᵀ with L = [c0 c1 c2]; project rows through the view rotation and the projection Jacobian.
  let W = mat3x3f(view.view[0].xyz, view.view[1].xyz, view.view[2].xyz);
  let F = vec2f(view.proj[0][0], view.proj[1][1]) * view.vp.xy * 0.5;
  var j0: vec3f; var j1: vec3f;
  if (ortho) { j0 = vec3f(F.x, 0.0, 0.0); j1 = vec3f(0.0, F.y, 0.0); }
  else {
    j0 = vec3f(F.x / dist, 0.0, F.x * vpos.x / (dist * dist));
    j1 = vec3f(0.0, F.y / dist, F.y * vpos.y / (dist * dist));
  }
  let r0 = transpose(W) * j0;
  let r1 = transpose(W) * j1;
  let a0 = vec3f(dot(r0, c0), dot(r0, c1), dot(r0, c2));
  let a1 = vec3f(dot(r1, c0), dot(r1, c1), dot(r1, c2));
  let cxx = dot(a0, a0) + 0.3;
  let cxy = dot(a0, a1);
  let cyy = dot(a1, a1) + 0.3;
  let mid = 0.5 * (cxx + cyy);
  let rad = length(vec2f(0.5 * (cxx - cyy), cxy));
  let l1 = mid + rad;
  let l2 = max(mid - rad, 0.1);
  var ax = vec2f(cxy, l1 - cxx);
  if (dot(ax, ax) < 1e-12) { ax = vec2f(1.0, 0.0); }
  ax = normalize(ax);
  let maxPx = 1024.0;
  let v1 = ax * min(sqrt(l1), maxPx);
  let v2 = vec2f(-ax.y, ax.x) * min(sqrt(l2), maxPx);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let k = 2.8284;
  let off = (corner.x * v1 + corner.y * v2) * k;
  out.pos = vec4f(clip.xy + off * 2.0 / view.vp.xy * clip.w, clip.z, clip.w);
  out.uv = corner * k;

  // Depth across the footprint follows the plane through the centre with the splat's normal.
  // Slope is clamped so splats seen edge-on do not produce extreme depths.
  var nv = W * nrm;
  if (abs(nv.z) < 1e-3) { nv.z = select(-1e-3, 1e-3, nv.z >= 0.0); }
  var gxy = nv.xy / nv.z;
  let gl = length(gxy);
  if (gl > SLOPE_MAX) { gxy *= SLOPE_MAX / gl; }
  var pixToView = 2.0 / view.vp.xy / vec2f(view.proj[0][0], view.proj[1][1]);
  if (!ortho) { pixToView *= dist; }
  out.slope = vec2f(dot(v1 * pixToView, gxy), dot(v2 * pixToView, gxy));
  out.zc = vec3f(view.proj[2][2], view.proj[3][2], select(0.0, 1.0, ortho));

  // Surface colour: between the de-lit albedo (0) and the scan's original baked colours (1).
  // Either way it is only seen where the virtual lights reach it, so no light means black.
  let deLight = clamp(pow(inst.p1.x / max(B.w, 1e-3), inst.p0.x), 0.2, 5.0);
  let bakedMix = inst.p0.y;
  out.albedo = vec4f(mix(D.rgb * deLight, D.rgb, bakedMix) * g.colMul, g.alpha);
  out.normal = nrm * inst.p1.y;
  // Glow from animators (depth sweep brighten / tint): the only light the splats emit themselves.
  out.baked = vec4f(g.emis, 0.0);
  out.depth = dist;
  out.seed = idx;
  return out;
}

const SLOPE_MAX = 1.5;
const FRONT_ALPHA = 0.3;
fn planeDepth(in: VOut) -> f32 { return max(in.depth + dot(in.uv, in.slope), 0.01); }

struct GOut { @location(0) albedo: vec4f, @location(1) normal: vec4f, @location(2) baked: vec4f, @location(3) aux: vec4f }

@fragment fn fsG(in: VOut) -> GOut {
  let d2 = dot(in.uv, in.uv);
  if (d2 > 8.0) { discard; }
  let a = in.albedo.a * exp(-0.5 * d2);
  if (a < 0.004) { discard; }
  var o: GOut;
  o.albedo = vec4f(in.albedo.rgb * a, a);
  o.normal = vec4f(in.normal * a, a);
  o.baked = vec4f(in.baked.rgb * a, a);
  // Front surface depth. Splats are drawn back to front with "over" blending; here a fragment's weight
  // saturates at FRONT_ALPHA, so a reasonably solid splat replaces what is behind it outright. The result
  // is the depth of the front-most surface rather than an average through the object, which would put
  // thinly covered points inside it, where its own front shadows them.
  let w = clamp(a / FRONT_ALPHA, 0.0, 1.0);
  o.aux = vec4f(planeDepth(in) * w, 0.0, 0.0, w);
  return o;
}

// Shadow pass: each Gaussian occludes where it is reasonably opaque. A fixed threshold (no per-pixel
// dithering) keeps shadow edges clean; the filtering in the lighting pass softens them.
@fragment fn fsShadow(in: VOut) -> @builtin(frag_depth) f32 {
  let d2 = dot(in.uv, in.uv);
  if (d2 > 8.0) { discard; }
  let a = in.albedo.a * exp(-0.5 * d2);
  if (a < 0.35) { discard; }
  let d = planeDepth(in);
  let w = select(d, 1.0, in.zc.z > 0.5);
  return clamp((-in.zc.x * d + in.zc.y) / w, 0.0, 1.0);
}
`;

export const lightingShader = /* wgsl */ `
struct Light { posType: vec4f, dirRange: vec4f, color: vec4f, spot: vec4f, area: vec4f, extra: vec4f }
struct Lighting {
  invView: mat4x4f,
  proj: vec4f,       // p00, p11, width, height
  sky: vec4f,        // rgb, intensity
  ground: vec4f,     // rgb, debug view
  background: vec4f, // rgb, light count
  lights: array<Light, ${MAX_LIGHTS}>,
  shadowMat: array<mat4x4f, ${MAX_SHADOW_LAYERS}>,
  shadowParam: array<vec4f, ${MAX_SHADOW_LAYERS}>, // near, far, ortho, tanHalfFov | half width
}
@group(0) @binding(0) var<uniform> L: Lighting;
@group(0) @binding(1) var tAlbedo: texture_2d<f32>;
@group(0) @binding(2) var tNormal: texture_2d<f32>;
@group(0) @binding(3) var tBaked: texture_2d<f32>;
@group(0) @binding(4) var tAux: texture_2d<f32>;
@group(0) @binding(5) var tShadow: texture_depth_2d_array;
@group(0) @binding(6) var sShadow: sampler;
@group(0) @binding(7) var sShadowCmp: sampler_comparison;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  return vec4f(f32((vi << 1u) & 2u) * 2.0 - 1.0, f32(vi & 2u) * 2.0 - 1.0, 0.0, 1.0);
}

const POISSON = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725), vec2f(-0.094184101, -0.92938870), vec2f(0.34495938, 0.29387760),
  vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464), vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
  vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420), vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
  vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590), vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790));

fn linDepth(z: f32, p: vec4f) -> f32 {
  if (p.z > 0.5) { return p.x + z * (p.y - p.x); }
  return p.x * p.y / (p.y - z * (p.y - p.x));
}

fn ign(px: vec2f) -> f32 { return fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715)))); }

// Depth in the shadow map's own 0..1 units for a linear distance from the light.
fn ndcDepth(d: f32, p: vec4f) -> f32 {
  if (p.z > 0.5) { return (d - p.x) / (p.y - p.x); }
  return p.y * (d - p.x) / (d * (p.y - p.x));
}

// 32-tap Vogel disk: even coverage, so one rotation per pixel is enough and noise stays low.
fn vogel(i: i32, n: i32, ang: f32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(n));
  let t = f32(i) * 2.39996323 + ang;
  return vec2f(cos(t), sin(t)) * r;
}

// Soft shadows: blocker search, then filtered depth comparisons (bilinear PCF) over a disk sized by the
// estimated penumbra. Splats are fuzzy and their footprints in the shadow map are depth-flat, so the
// comparison tolerance grows with the distance of each tap from the centre (receiver-plane bias).
// lightSize is a world radius (for the sun: tan of the angular radius); bias is the light's shadow bias in metres.
fn shadow(layer: i32, wpos: vec3f, n: vec3f, toLight: vec3f, lightSize: f32, bias: f32, px: vec2f) -> f32 {
  let prm = L.shadowParam[layer];
  let res = f32(textureDimensions(tShadow).x);
  let sp0 = L.shadowMat[layer] * vec4f(wpos, 1.0);
  if (sp0.w <= 0.0) { return 1.0; }
  let d0 = linDepth(clamp(sp0.z / sp0.w, 0.0, 1.0), prm);
  var texelWorld = 2.0 * prm.w / res;
  if (prm.z < 0.5) { texelWorld *= d0; }
  // Normal offset (scaled by how grazing the light is) plus a push towards the light.
  let ndl = clamp(dot(n, toLight), 0.0, 1.0);
  let offs = n * (texelWorld * 2.0 + bias) * (1.0 - ndl * 0.6) + toLight * (texelWorld + bias);
  let sp = L.shadowMat[layer] * vec4f(wpos + offs, 1.0);
  let ndc = sp.xyz / sp.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z > 1.0) { return 1.0; }
  let zr = linDepth(ndc.z, prm);
  var worldToUv = 1.0 / (2.0 * prm.w);
  if (prm.z < 0.5) { worldToUv /= zr; }
  let texel = 1.0 / res;
  let ang = ign(px) * 6.28318;

  // Blocker search: average depth of what is in front of us, within the light's footprint.
  var searchR = lightSize * worldToUv;
  if (prm.z > 0.5) { searchR = lightSize * 4.0 * worldToUv; }
  searchR = clamp(searchR, texel * 3.0, 0.06);
  var zb = 0.0; var nb = 0.0;
  for (var i = 0; i < 12; i++) {
    let o = vogel(i, 12, ang) * searchR;
    let z = linDepth(textureSampleLevel(tShadow, sShadow, uv + o, layer, 0), prm);
    let tol = length(o) / worldToUv + bias * 0.5;
    if (z < zr - tol) { zb += z; nb += 1.0; }
  }
  if (nb < 0.5) { return 1.0; }
  zb /= nb;

  // Penumbra width from similar triangles (PCSS).
  var pen = 0.0;
  if (prm.z > 0.5) { pen = (zr - zb) * lightSize; } else { pen = lightSize * (zr - zb) / max(zb, 0.01); }
  let r = clamp(pen * worldToUv, texel * 1.5, 0.08);
  var lit = 0.0;
  for (var i = 0; i < 32; i++) {
    let o = vogel(i, 32, ang) * r;
    let tol = length(o) / worldToUv;
    lit += textureSampleCompareLevel(tShadow, sShadowCmp, uv + o, layer, ndcDepth(max(zr - tol, prm.x), prm));
  }
  return lit / 32.0;
}

fn cubeFace(v: vec3f) -> i32 {
  let a = abs(v);
  if (a.x >= a.y && a.x >= a.z) { return select(1, 0, v.x > 0.0); }
  if (a.y >= a.z) { return select(3, 2, v.y > 0.0); }
  return select(5, 4, v.z > 0.0);
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let alb = textureLoad(tAlbedo, px, 0);
  let cov = alb.a;
  let bg = L.background.rgb;
  let debug = i32(L.ground.w);
  if (cov < 0.002) { return vec4f(bg, 1.0); }
  let inv = 1.0 / cov;
  let albedo = alb.rgb * inv;
  let nRaw = textureLoad(tNormal, px, 0).xyz * inv;
  let glow = textureLoad(tBaked, px, 0).rgb * inv;
  let aux = textureLoad(tAux, px, 0);
  let depth = aux.x / max(aux.a, 1e-4);
  let nLen = clamp(length(nRaw), 0.0, 1.0);
  let n = nRaw / max(length(nRaw), 1e-5);

  let ndc = vec2f(frag.x / L.proj.z * 2.0 - 1.0, 1.0 - frag.y / L.proj.w * 2.0);
  let vpos = vec3f(ndc.x * depth / L.proj.x, ndc.y * depth / L.proj.y, -depth);
  let wpos = (L.invView * vec4f(vpos, 1.0)).xyz;
  let cam = L.invView[3].xyz;
  let V = normalize(cam - wpos);

  var diffuse = mix(L.ground.rgb, L.sky.rgb, n.y * 0.5 * nLen + 0.5) * L.sky.a;
  var spec = vec3f(0.0);
  var shadowOnly = 0.0;
  var firstShadow = -1.0;
  let count = i32(L.background.a);
  for (var i = 0; i < count; i++) {
    let lt = L.lights[i];
    let kind = i32(lt.posType.w);
    var toL: vec3f;
    var atten = 1.0;
    var lightSize = lt.spot.z;
    if (kind == 2) {
      toL = -lt.dirRange.xyz;
    } else {
      var lp = lt.posType.xyz;
      if (kind == 3) {
        // Area: aim at the closest point of the emitter to this surface point (representative point).
        let fwd = lt.dirRange.xyz;
        var right = cross(fwd, vec3f(0.0, 1.0, 0.0));
        if (dot(right, right) < 1e-6) { right = vec3f(1.0, 0.0, 0.0); }
        right = normalize(right);
        let up = cross(right, fwd);
        let rel = wpos - lp;
        var q = vec2f(dot(rel, right), dot(rel, up));
        let hs = lt.area.xy * 0.5;
        if (lt.area.z > 0.5) { let e = q / max(hs, vec2f(1e-4)); let l = length(e); if (l > 1.0) { q = q / l; } }
        else { q = clamp(q, -hs, hs); }
        lp = lp + right * q.x + up * q.y;
      }
      let d = lp - wpos;
      let dist = length(d);
      toL = d / max(dist, 1e-4);
      let rr = lt.dirRange.w;
      let win = clamp(1.0 - pow(dist / rr, 4.0), 0.0, 1.0);
      let r0 = max(lt.extra.x, 0.05);
      atten = win * win / (dist * dist + r0 * r0);
      if (kind == 1) {
        let c = dot(-toL, lt.dirRange.xyz);
        atten *= smoothstep(lt.spot.x, lt.spot.y, c);
      } else if (kind == 3) {
        atten *= max(dot(-toL, lt.dirRange.xyz), 0.0);
      }
    }
    if (atten <= 0.0) { continue; }
    var sh = 1.0;
    let layer0 = i32(lt.area.w);
    if (layer0 >= 0) {
      var layer = layer0;
      if (kind == 0) { layer += cubeFace(-toL); }
      sh = shadow(layer, wpos, n * nLen, toL, lightSize, lt.extra.y, frag.xy);
    }
    // Wrapped diffuse; short (noisy) normals fall back towards unshaded so blotches soften.
    let ndl = mix(1.0, clamp((dot(n, toL) + 0.15) / 1.15, 0.0, 1.0), nLen);
    let radiance = lt.color.rgb * atten * sh;
    diffuse += radiance * ndl;
    let H = normalize(toL + V);
    spec += radiance * pow(max(dot(n, H), 0.0), 36.0) * lt.color.a * nLen * ndl;
    shadowOnly += sh * atten * ndl;
    if (firstShadow < 0.0 && layer0 >= 0) { firstShadow = sh; }
  }

  var color = albedo * diffuse + spec + glow;
  if (debug == 1) { color = albedo; }
  else if (debug == 2) { color = n * 0.5 + 0.5; }
  else if (debug == 3) { color = glow; }
  else if (debug == 4) { color = vec3f(fract(depth * 0.25), depth * 0.05, depth * 0.01); }
  else if (debug == 5) { color = diffuse + spec; }
  else if (debug == 6) { color = select(vec3f(max(firstShadow, 0.0)), vec3f(0.0, 0.0, 1.0), firstShadow < 0.0); }
  return vec4f(mix(bg, color, clamp(cov, 0.0, 1.0)), 1.0);
}
`;

export const postShader = /* wgsl */ `
struct Post {
  a: vec4f, // exposure (linear gain), contrast, saturation, bloom
  b: vec4f, // tint rgb, vignette
  c: vec4f, // master, supersample, threshold, mode
  d: vec4f, // src texel size xy, encode sRGB, _
  e: vec4f, // flat colour rgb, mix (show safety: fade to colour)
}
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var tSrc: texture_2d<f32>;
@group(0) @binding(2) var tBloom: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn box4(uv: vec2f, r: f32) -> vec3f {
  let t = P.d.xy * r;
  return (textureSampleLevel(tSrc, samp, uv + vec2f(-t.x, -t.y), 0).rgb + textureSampleLevel(tSrc, samp, uv + vec2f(t.x, -t.y), 0).rgb +
          textureSampleLevel(tSrc, samp, uv + vec2f(-t.x, t.y), 0).rgb + textureSampleLevel(tSrc, samp, uv + vec2f(t.x, t.y), 0).rgb) * 0.25;
}

// Bloom prefilter (threshold with a soft knee) and downsample.
@fragment fn fsDown(in: VOut) -> @location(0) vec4f {
  var c = box4(in.uv, 1.0);
  if (P.c.w > 0.5) {
    let br = max(c.r, max(c.g, c.b));
    let th = P.c.z;
    let knee = th * 0.5 + 1e-4;
    let soft = clamp(br - th + knee, 0.0, 2.0 * knee);
    let contrib = max(soft * soft / (4.0 * knee), br - th) / max(br, 1e-4);
    c = min(c * max(contrib, 0.0), vec3f(64.0));
  }
  return vec4f(c, 1.0);
}
@fragment fn fsUp(in: VOut) -> @location(0) vec4f { return vec4f(box4(in.uv, 0.75), 1.0); }
@fragment fn fsCopy(in: VOut) -> @location(0) vec4f { return vec4f(textureSampleLevel(tSrc, samp, in.uv, 0).rgb, 1.0); }

fn tonemap(x: vec3f) -> vec3f {
  // Narkowicz ACES fit: filmic shoulder, keeps LED highlights from clipping to flat white.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn toSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment fn fsFinal(in: VOut) -> @location(0) vec4f {
  // Supersample resolve: box filter over the source footprint.
  let ss = i32(P.c.y);
  var c = vec3f(0.0);
  if (ss <= 1) { c = textureSampleLevel(tSrc, samp, in.uv, 0).rgb; }
  else {
    let taps = (ss + 1) / 2;
    for (var y = 0; y < taps; y++) { for (var x = 0; x < taps; x++) {
      let o = (vec2f(f32(x), f32(y)) + 0.5) / f32(taps) - 0.5;
      c += textureSampleLevel(tSrc, samp, in.uv + o * P.d.xy * f32(ss), 0).rgb;
    } }
    c /= f32(taps * taps);
  }
  c += textureSampleLevel(tBloom, samp, in.uv, 0).rgb * P.a.w;
  c *= P.a.x * P.b.rgb;
  c = pow(max(c, vec3f(0.0)) / 0.18, vec3f(P.a.y)) * 0.18;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3f(l), c, P.a.z), vec3f(0.0));
  c = tonemap(c);
  let q = in.uv - 0.5;
  c *= 1.0 - P.b.w * smoothstep(0.25, 0.75, length(q));
  c = mix(c, P.e.rgb, P.e.a);
  c *= P.c.x;
  if (P.d.z > 0.5) { c = toSrgb(c); }
  return vec4f(c, 1.0);
}
`;

export const lineShader = /* wgsl */ `
@group(0) @binding(0) var<uniform> viewProj: mat4x4f;
struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec4f }
@vertex fn vs(@location(0) pos: vec3f, @location(1) color: vec4f) -> VOut {
  var o: VOut;
  o.pos = viewProj * vec4f(pos, 1.0);
  o.color = color;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return vec4f(in.color.rgb * in.color.a, in.color.a); }
`;
