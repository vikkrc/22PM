// Deferred Gaussian-splat renderer on WebGPU (brief section 4).
// Input is a FrameState from evaluate(); the renderer keeps caches (sort order, shadow maps) but no
// animation state, so the same FrameState always gives the same image.
import type { FrameState, LightState } from '../core/evaluate';
import type { PreparedSplat } from '../splat/types';
import { composeTRS, DEG, eulerToQuat, invert, lookAt, mul, ortho, perspective, transformPoint, v3, type Mat4, type Vec3 } from '../core/math';
import { lightingShader, lineShader, MAX_ANIMATORS, MAX_INSTANCES, MAX_LIGHTS, MAX_SHADOW_LAYERS, postShader, splatShader } from './shaders';
import { makeScratch, sortByDepth } from './sort';

export interface ScenePart { id: string; data: PreparedSplat }

export interface RenderTarget { view: GPUTextureView; format: GPUTextureFormat }

export interface RenderOptions {
  /** Output size in pixels. */
  width: number;
  height: number;
  /** Supersampling factor 1–4. */
  ss?: number;
  /** 0 final, 1 albedo, 2 normals, 3 baked, 4 depth, 5 lighting only. */
  debugView?: number;
  /** Sort on this thread before drawing (frame-stepped render). Live playback sorts in a worker. */
  sync?: boolean;
  shadowRes?: number;
  maxShadowLights?: number;
  /** Editor overlay lines: xyz rgba per vertex, in world space. Never part of output or export. */
  overlay?: Float32Array;
  /** Extra sub-frame states for motion blur; averaged with `state`. */
  subFrames?: FrameState[];
  /** Flat colour [r,g,b,mix] blended over the graded image (show safety: fade to colour). */
  flat?: [number, number, number, number];
  /** Camera aspect override (defaults to width/height). */
  aspect?: number;
}

export interface RenderStats {
  gaussians: number;
  shadowMaps: number;
  shadowMapsRendered: number;
  lights: number;
  /** GPU milliseconds per pass when timestamp queries are available. */
  passMs: { gbuffer: number; shadows: number; lighting: number; post: number } | null;
  cpuMs: number;
  sortMs: number;
}

const HDR: GPUTextureFormat = 'rgba16float';
const BLOOM_LEVELS = 5;

function fnv(data: Float32Array, start = 0, end = data.length): number {
  const u = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let h = 2166136261;
  for (let i = start; i < end; i++) h = Math.imul(h ^ u[i], 16777619);
  return h >>> 0;
}

function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s ? -Infinity : Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

interface ShadowView { view: Mat4; proj: Mat4; ortho: boolean; near: number; far: number; w: number }

export function cameraMatrices(cam: FrameState['camera'], aspect: number): { view: Mat4; proj: Mat4; forward: Vec3 } {
  const forward = v3.norm(v3.sub(cam.target, cam.pos));
  // Roll: rotate the up vector around the view direction.
  const r = cam.roll * DEG;
  let right = v3.cross(forward, [0, 1, 0]);
  if (v3.len(right) < 1e-5) right = [1, 0, 0];
  right = v3.norm(right);
  const up0 = v3.cross(right, forward);
  const up = v3.add(v3.scale(up0, Math.cos(r)), v3.scale(right, Math.sin(r)));
  return { view: lookAt(cam.pos, cam.target, up), proj: perspective(cam.fov * DEG, aspect, 0.05, 500), forward };
}

export class Renderer {
  device!: GPUDevice;
  canvasFormat: GPUTextureFormat = 'bgra8unorm';
  stats: RenderStats = { gaussians: 0, shadowMaps: 0, shadowMapsRendered: 0, lights: 0, passMs: null, cpuMs: 0, sortMs: 0 };
  lost = false;

  private splatLayout!: GPUBindGroupLayout;
  private gPipe!: GPURenderPipeline;
  private shadowPipe!: GPURenderPipeline;
  private lightPipe!: GPURenderPipeline;
  private downPipe!: GPURenderPipeline;
  private upPipe!: GPURenderPipeline;
  private accumPipe!: GPURenderPipeline;
  private finalPipes = new Map<GPUTextureFormat, GPURenderPipeline>();
  private linePipes = new Map<GPUTextureFormat, GPURenderPipeline>();
  private postLayout!: GPUBindGroupLayout;
  private postModule!: GPUShaderModule;
  private lineModule!: GPUShaderModule;
  private lineLayout!: GPUBindGroupLayout;
  private linSampler!: GPUSampler;
  private nearSampler!: GPUSampler;

  private sceneUbo!: GPUBuffer;
  private sceneData = new Float32Array(680);
  private viewUbo!: GPUBuffer;
  private lightUbo!: GPUBuffer;
  private lightData = new Float32Array(656);
  private postUbos: GPUBuffer[] = [];
  private lineUbo!: GPUBuffer;
  private lineVbo: GPUBuffer | null = null;
  private lineVboSize = 0;

  // Scene
  private parts: (ScenePart & { slot: number; offset: number })[] = [];
  private count = 0;
  private gBuffers: GPUBuffer[] = [];
  private orderBuf: GPUBuffer | null = null;
  private mainBind: GPUBindGroup | null = null;
  private localPos = new Float32Array(0);
  private slotOf = new Uint8Array(0);
  private worldPos = new Float32Array(0);
  private worldKey = -1;
  private sceneGen = 0;
  private sortScratch = makeScratch(0);
  private orderCpu = new Uint32Array(0);
  private sortKey = '';
  private worker: Worker | null = null;
  private workerBusy = false;
  private workerHasGen = -1;
  private pendingSortKey = '';

  // Targets
  private rw = 0; private rh = 0; private ow = 0; private oh = 0;
  private gTex: GPUTexture[] = [];
  private gViews: GPUTextureView[] = [];
  private hdr!: GPUTexture; private hdrView!: GPUTextureView;
  private accum!: GPUTexture; private accumView!: GPUTextureView;
  private bloom: GPUTexture[] = [];
  private bloomViews: GPUTextureView[] = [];
  private lightBind: GPUBindGroup | null = null;
  private postBinds = new Map<string, GPUBindGroup>();

  // Shadows
  private shadowRes = 0;
  private shadowTex: GPUTexture | null = null;
  private shadowArrayView!: GPUTextureView;
  private shadowLayerViews: GPUTextureView[] = [];
  private shadowUbos: GPUBuffer[] = [];
  private shadowBinds: (GPUBindGroup | null)[] = [];
  private shadowKeys: number[] = [];

  // Timing
  private querySet: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private queryRead: GPUBuffer | null = null;
  private queryBusy = false;

  // Readback
  private readTex: GPUTexture | null = null;
  private lastCam: { view: Mat4; proj: Mat4; w: number; h: number } | null = null;

  static async create(): Promise<Renderer> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const features: GPUFeatureName[] = [];
    if (adapter.features.has('timestamp-query')) features.push('timestamp-query');
    const device = await adapter.requestDevice({
      requiredFeatures: features,
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const r = new Renderer();
    r.device = device;
    r.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    device.lost.then((info) => { r.lost = true; console.error('WebGPU device lost:', info.message); });
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));
    r.init(features.includes('timestamp-query'));
    return r;
  }

  private init(timestamps: boolean) {
    const d = this.device;
    const splatModule = d.createShaderModule({ code: splatShader, label: 'splat' });
    this.splatLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        ...[2, 3, 4, 5, 6, 7].map((binding) => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' as const } })),
      ],
    });
    const splatPL = d.createPipelineLayout({ bindGroupLayouts: [this.splatLayout] });
    const over: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    this.gPipe = d.createRenderPipeline({
      label: 'gbuffer', layout: splatPL,
      vertex: { module: splatModule, entryPoint: 'vs' },
      fragment: { module: splatModule, entryPoint: 'fsG', targets: [0, 1, 2, 3].map(() => ({ format: HDR, blend: over })) },
      primitive: { topology: 'triangle-strip' },
    });
    this.shadowPipe = d.createRenderPipeline({
      label: 'shadow', layout: splatPL,
      vertex: { module: splatModule, entryPoint: 'vs' },
      fragment: { module: splatModule, entryPoint: 'fsShadow', targets: [] },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const lightModule = d.createShaderModule({ code: lightingShader, label: 'lighting' });
    this.lightPipe = d.createRenderPipeline({
      label: 'lighting', layout: 'auto',
      vertex: { module: lightModule, entryPoint: 'vs' },
      fragment: { module: lightModule, entryPoint: 'fs', targets: [{ format: HDR }] },
    });
    this.postModule = d.createShaderModule({ code: postShader, label: 'post' });
    this.postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const postPL = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] });
    const mk = (entry: string, format: GPUTextureFormat, blend?: GPUBlendState) => d.createRenderPipeline({
      label: entry, layout: postPL,
      vertex: { module: this.postModule, entryPoint: 'vs' },
      fragment: { module: this.postModule, entryPoint: entry, targets: [{ format, blend }] },
    });
    this.downPipe = mk('fsDown', HDR);
    this.upPipe = mk('fsUp', HDR, { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } });
    this.accumPipe = mk('fsCopy', HDR, { color: { srcFactor: 'constant', dstFactor: 'one' }, alpha: { srcFactor: 'constant', dstFactor: 'one' } });
    this.lineModule = d.createShaderModule({ code: lineShader, label: 'lines' });
    this.lineLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });

    this.linSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.nearSampler = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const ubo = (size: number) => d.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sceneUbo = ubo(this.sceneData.byteLength);
    this.viewUbo = ubo(144);
    this.lightUbo = ubo(this.lightData.byteLength);
    this.lineUbo = ubo(64);
    for (let i = 0; i < 16; i++) this.postUbos.push(ubo(80));
    for (let i = 0; i < MAX_SHADOW_LAYERS; i++) { this.shadowUbos.push(ubo(144)); this.shadowBinds.push(null); this.shadowKeys.push(-1); }

    if (timestamps) {
      this.querySet = d.createQuerySet({ type: 'timestamp', count: 8 });
      this.queryResolve = d.createBuffer({ size: 64, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.queryRead = d.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    this.setScene([]);
  }

  private finalPipe(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.finalPipes.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        label: 'final', layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
        vertex: { module: this.postModule, entryPoint: 'vs' },
        fragment: { module: this.postModule, entryPoint: 'fsFinal', targets: [{ format }] },
      });
      this.finalPipes.set(format, p);
    }
    return p;
  }

  private linePipe(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.linePipes.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        label: 'lines', layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.lineLayout] }),
        vertex: {
          module: this.lineModule, entryPoint: 'vs',
          buffers: [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }] }],
        },
        fragment: {
          module: this.lineModule, entryPoint: 'fs',
          targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        },
        primitive: { topology: 'line-list' },
      });
      this.linePipes.set(format, p);
    }
    return p;
  }

  // ---- scene -----------------------------------------------------------------------------------

  /** Replace the scene's Gaussians. Parts map to instance slots in order. */
  setScene(parts: ScenePart[]) {
    const d = this.device;
    parts = parts.slice(0, MAX_INSTANCES);
    for (const b of this.gBuffers) b.destroy();
    this.orderBuf?.destroy();
    let total = 0;
    this.parts = parts.map((p, slot) => { const o = { ...p, slot, offset: total }; total += p.data.count; return o; });
    this.count = total;
    const n = Math.max(total, 1);
    const A = new Float32Array(n * 4), B = new Float32Array(n * 4), C = new Float32Array(n * 4), D = new Float32Array(n * 4), E = new Float32Array(n * 4);
    this.localPos = new Float32Array(n * 3);
    this.slotOf = new Uint8Array(n);
    for (const p of this.parts) {
      const s = p.data;
      for (let i = 0; i < s.count; i++) {
        const o = (p.offset + i) * 4;
        A[o] = s.pos[i * 3]; A[o + 1] = s.pos[i * 3 + 1]; A[o + 2] = s.pos[i * 3 + 2]; A[o + 3] = s.opacity[i];
        B[o] = s.scale[i * 3]; B[o + 1] = s.scale[i * 3 + 1]; B[o + 2] = s.scale[i * 3 + 2]; B[o + 3] = s.lowLum[i];
        C[o] = s.quat[i * 4]; C[o + 1] = s.quat[i * 4 + 1]; C[o + 2] = s.quat[i * 4 + 2]; C[o + 3] = s.quat[i * 4 + 3];
        D[o] = s.color[i * 3]; D[o + 1] = s.color[i * 3 + 1]; D[o + 2] = s.color[i * 3 + 2]; D[o + 3] = p.slot;
        E[o] = s.normal[i * 3]; E[o + 1] = s.normal[i * 3 + 1]; E[o + 2] = s.normal[i * 3 + 2];
      }
      this.localPos.set(s.pos, p.offset * 3);
      this.slotOf.fill(p.slot, p.offset, p.offset + s.count);
    }
    this.gBuffers = [A, B, C, D, E].map((arr) => {
      const buf = d.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      new Float32Array(buf.getMappedRange()).set(arr);
      buf.unmap();
      return buf;
    });
    this.orderBuf = d.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.orderCpu = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.orderCpu[i] = i;
    d.queue.writeBuffer(this.orderBuf, 0, this.orderCpu);
    this.worldPos = new Float32Array(n * 3);
    this.sortScratch = makeScratch(n);
    this.worldKey = -1;
    this.sortKey = '';
    this.pendingSortKey = '';
    this.sceneGen++;
    this.mainBind = this.makeSplatBind(this.viewUbo);
    for (let i = 0; i < MAX_SHADOW_LAYERS; i++) { this.shadowBinds[i] = this.makeSplatBind(this.shadowUbos[i]); this.shadowKeys[i] = -1; }
    this.stats.gaussians = total;
  }

  get slotIds(): string[] { return this.parts.map((p) => p.id); }

  private makeSplatBind(viewBuf: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.splatLayout,
      entries: [
        { binding: 0, resource: { buffer: this.sceneUbo } },
        { binding: 1, resource: { buffer: viewBuf } },
        ...this.gBuffers.map((buffer, i) => ({ binding: 2 + i, resource: { buffer } })),
        { binding: 7, resource: { buffer: this.orderBuf! } },
      ],
    });
  }

  private ensureTargets(ow: number, oh: number, ss: number) {
    const rw = ow * ss, rh = oh * ss;
    if (rw === this.rw && rh === this.rh && ow === this.ow && oh === this.oh) return;
    const d = this.device;
    for (const t of [...this.gTex, this.hdr, this.accum, ...this.bloom]) t?.destroy();
    this.rw = rw; this.rh = rh; this.ow = ow; this.oh = oh;
    const tex = (w: number, h: number, extra = 0) => d.createTexture({ size: [Math.max(1, w), Math.max(1, h)], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | extra });
    this.gTex = [0, 1, 2, 3].map((i) => tex(rw, rh, i === 3 ? GPUTextureUsage.COPY_SRC : 0));
    this.gViews = this.gTex.map((t) => t.createView());
    this.hdr = tex(rw, rh); this.hdrView = this.hdr.createView();
    this.accum = tex(rw, rh); this.accumView = this.accum.createView();
    this.bloom = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) this.bloom.push(tex(ow >> (i + 1), oh >> (i + 1)));
    this.bloomViews = this.bloom.map((t) => t.createView());
    this.lightBind = null;
    this.postBinds.clear();
  }

  private ensureShadows(res: number) {
    if (this.shadowTex && this.shadowRes === res) return;
    this.shadowTex?.destroy();
    this.shadowRes = res;
    this.shadowTex = this.device.createTexture({
      size: [res, res, MAX_SHADOW_LAYERS], format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowArrayView = this.shadowTex.createView({ dimension: '2d-array' });
    this.shadowLayerViews = [];
    for (let i = 0; i < MAX_SHADOW_LAYERS; i++) {
      this.shadowLayerViews.push(this.shadowTex.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
      this.shadowKeys[i] = -1;
    }
    this.lightBind = null;
  }

  private postBind(ubo: number, src: GPUTextureView, bloom: GPUTextureView, key: string): GPUBindGroup {
    let b = this.postBinds.get(key);
    if (!b) {
      b = this.device.createBindGroup({
        layout: this.postLayout,
        entries: [
          { binding: 0, resource: { buffer: this.postUbos[ubo] } },
          { binding: 1, resource: src }, { binding: 2, resource: bloom }, { binding: 3, resource: this.linSampler },
        ],
      });
      this.postBinds.set(key, b);
    }
    return b;
  }

  /** World-space bounding sphere of everything visible (for fitting the sun's shadow map). */
  private sceneSphere(state: FrameState): { center: Vec3; radius: number } {
    let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of this.parts) {
      const inst = state.splats.find((s) => s.id === p.id);
      if (!inst || !inst.visible) continue;
      const m = composeTRS(inst.pos, eulerToQuat(...inst.rot), [inst.scale, inst.scale, inst.scale]);
      const lo = inst.crop ? inst.cropMin.map((v, i) => Math.max(v, p.data.boundsMin[i])) : p.data.boundsMin;
      const hi = inst.crop ? inst.cropMax.map((v, i) => Math.min(v, p.data.boundsMax[i])) : p.data.boundsMax;
      for (let c = 0; c < 8; c++) {
        const w = transformPoint(m, [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
        min = [Math.min(min[0], w[0]), Math.min(min[1], w[1]), Math.min(min[2], w[2])];
        max = [Math.max(max[0], w[0]), Math.max(max[1], w[1]), Math.max(max[2], w[2])];
      }
    }
    if (!Number.isFinite(min[0])) return { center: [0, 0, 0], radius: 5 };
    const center = v3.scale(v3.add(min, max), 0.5);
    return { center, radius: Math.max(0.5, v3.dist(min, max) * 0.5 * 1.05) };
  }

  private shadowViews(l: LightState, sphere: { center: Vec3; radius: number }): ShadowView[] {
    const near = 0.05;
    if (l.type === 'sun') {
      const R = sphere.radius;
      const eye = v3.sub(sphere.center, v3.scale(l.dir, R * 2));
      return [{ view: lookAt(eye, sphere.center), proj: ortho(-R, R, -R, R, 0.01, R * 4), ortho: true, near: 0.01, far: R * 4, w: R }];
    }
    const far = Math.max(l.range, near * 2);
    if (l.type === 'spot' || l.type === 'area') {
      const fov = l.type === 'spot' ? Math.min(l.cone + 6, 170) : 130;
      return [{ view: lookAt(l.pos, v3.add(l.pos, l.dir)), proj: perspective(fov * DEG, 1, near, far), ortho: false, near, far, w: Math.tan((fov * DEG) / 2) }];
    }
    const dirs: [Vec3, Vec3][] = [[[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, 1]], [[0, -1, 0], [0, 0, 1]], [[0, 0, 1], [0, 1, 0]], [[0, 0, -1], [0, 1, 0]]];
    const fov = 92 * DEG;
    return dirs.map(([dir, up]) => ({ view: lookAt(l.pos, v3.add(l.pos, dir), up), proj: perspective(fov, 1, near, far), ortho: false, near, far, w: Math.tan(fov / 2) }));
  }

  private fillScene(state: FrameState): { geomKey: number } {
    const sd = this.sceneData;
    sd.fill(0);
    let wk = 2166136261;
    for (const p of this.parts) {
      const inst = state.splats.find((s) => s.id === p.id);
      const o = p.slot * 32;
      if (!inst) continue;
      const m = composeTRS(inst.pos, eulerToQuat(...inst.rot), [inst.scale, inst.scale, inst.scale]);
      sd.set(m, o);
      sd[o + 16] = inst.deLight; sd[o + 17] = inst.bakedMix; sd[o + 18] = inst.opacity;
      sd[o + 19] = inst.normalMode === 'view' ? 0 : inst.normalMode === 'outward' ? 1 : 2;
      sd[o + 20] = p.data.meanLum; sd[o + 21] = inst.normalStrength; sd[o + 22] = inst.crop ? 1 : 0; sd[o + 23] = inst.visible ? 1 : 0;
      sd.set(inst.cropMin, o + 24); sd.set(inst.cropMax, o + 28);
      wk = Math.imul(wk ^ fnv(sd, o, o + 16), 16777619);
    }
    // World positions feed the sorter; recompute only when a transform changed.
    wk >>>= 0;
    if (wk !== this.worldKey) {
      this.worldKey = wk;
      const wp = this.worldPos, lp = this.localPos;
      for (const p of this.parts) {
        const o = p.slot * 32;
        const m0 = sd[o], m1 = sd[o + 1], m2 = sd[o + 2], m4 = sd[o + 4], m5 = sd[o + 5], m6 = sd[o + 6], m8 = sd[o + 8], m9 = sd[o + 9], m10 = sd[o + 10], tx = sd[o + 12], ty = sd[o + 13], tz = sd[o + 14];
        const end = (p.offset + p.data.count) * 3;
        for (let i = p.offset * 3; i < end; i += 3) {
          const x = lp[i], y = lp[i + 1], z = lp[i + 2];
          wp[i] = m0 * x + m4 * y + m8 * z + tx; wp[i + 1] = m1 * x + m5 * y + m9 * z + ty; wp[i + 2] = m2 * x + m6 * y + m10 * z + tz;
        }
      }
      this.sortKey = '';
      this.workerHasGen = -1;
      this.sceneGen++;
    }
    let usesEye = false;
    const anims = state.animators.slice(0, MAX_ANIMATORS);
    anims.forEach((a, i) => {
      const o = 512 + i * 20;
      let mask = 0;
      if (!a.targets.length) mask = 0xffff;
      else for (const p of this.parts) if (a.targets.includes(p.id)) mask |= 1 << p.slot;
      const p = a.p;
      sd[o + 1] = a.fade; sd[o + 2] = a.time; sd[o + 3] = mask;
      if (a.kind === 'anim.disperse') {
        sd[o] = 1;
        sd.set([p.amount, p.noiseScale, p.speed, p.alongNormal, p['bias.x'], p['bias.y'], p['bias.z'], p.opacityFalloff, p.shrink], o + 4);
      } else if (a.kind === 'anim.wobble') {
        sd[o] = 2;
        sd.set([p.amplitude, p.frequency, p.noiseScale, 0, p['axis.x'], p['axis.y'], p['axis.z']], o + 4);
      } else if (a.kind === 'anim.sweep') {
        sd[o] = 3;
        const y = p.yaw * DEG, pt = p.pitch * DEG;
        sd.set([p.pattern, p.effect, p.position, p.width, p['origin.x'], p['origin.y'], p['origin.z'], p.feather,
          -Math.sin(y) * Math.cos(pt), Math.sin(pt), -Math.cos(y) * Math.cos(pt), p.noiseScale, p['tint.r'], p['tint.g'], p['tint.b'], p.gain], o + 4);
        if (p.pattern === 2) usesEye = true;
      } else if (a.kind === 'anim.cutoff') {
        sd[o] = 4;
        sd.set([p.from, p.near, p.far, p.feather, p['origin.x'], p['origin.y'], p['origin.z'], p.invert], o + 4);
        if (p.from === 0) usesEye = true;
      }
    });
    sd[672] = anims.length;
    sd.set(state.camera.pos, 676);
    // Everything that can change shadow-map contents.
    const geomKey = fnv(sd, 0, usesEye ? 680 : 676);
    this.device.queue.writeBuffer(this.sceneUbo, 0, sd);
    return { geomKey };
  }

  private sort(forward: Vec3, sync: boolean) {
    if (!this.count) return;
    const key = forward.map((v) => v.toFixed(3)).join(',');
    if (sync) {
      if (key === this.sortKey) return;
      const t0 = performance.now();
      sortByDepth(this.worldPos, this.count, forward[0], forward[1], forward[2], this.orderCpu, this.sortScratch);
      this.device.queue.writeBuffer(this.orderBuf!, 0, this.orderCpu, 0, this.count);
      this.sortKey = key;
      this.stats.sortMs = performance.now() - t0;
      return;
    }
    if (key === this.sortKey || key === this.pendingSortKey || this.workerBusy) return;
    if (!this.worker) {
      this.worker = new Worker(new URL('./sort.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ order: Uint32Array; gen: number; key: string }>) => {
        this.workerBusy = false;
        this.stats.sortMs = performance.now() - this.sortStart;
        if (e.data.gen !== this.sceneGen || !this.orderBuf || e.data.order.length !== this.count) { this.pendingSortKey = ''; return; }
        this.device.queue.writeBuffer(this.orderBuf, 0, e.data.order);
        this.sortKey = e.data.key;
        this.pendingSortKey = '';
        this.onSorted?.();
      };
    }
    if (this.workerHasGen !== this.sceneGen) {
      this.worker.postMessage({ type: 'positions', pos: this.worldPos.slice(0, this.count * 3), count: this.count });
      this.workerHasGen = this.sceneGen;
    }
    this.workerBusy = true;
    this.pendingSortKey = key;
    this.sortStart = performance.now();
    this.worker.postMessage({ type: 'sort', dir: forward, gen: this.sceneGen, key });
  }
  private sortStart = 0;
  /** Called when a background sort lands, so an idle viewport can redraw. */
  onSorted: (() => void) | null = null;

  // ---- frame -----------------------------------------------------------------------------------

  render(state: FrameState, target: RenderTarget, opts: RenderOptions) {
    if (this.lost) return;
    const t0 = performance.now();
    const d = this.device;
    const ss = Math.max(1, Math.min(4, Math.round(opts.ss ?? 1)));
    const ow = Math.max(2, Math.round(opts.width)), oh = Math.max(2, Math.round(opts.height));
    this.ensureTargets(ow, oh, ss);
    this.ensureShadows(opts.shadowRes ?? 1024);
    const enc = d.createCommandEncoder();
    const states = [state, ...(opts.subFrames ?? [])];
    const aspect = opts.aspect ?? ow / oh;
    this.stats.shadowMapsRendered = 0;
    const ts = this.querySet && !this.queryBusy ? this.querySet : null;

    states.forEach((st, si) => {
      const stamp = si === 0 ? ts : null;
      this.renderLit(enc, st, aspect, opts, stamp);
      if (states.length > 1) {
        // Motion blur: average the sub-frames in linear HDR.
        this.writePost(0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 / this.rw, 1 / this.rh, 0, 0]);
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.accumView, loadOp: si === 0 ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        pass.setPipeline(this.accumPipe);
        const w = 1 / states.length;
        pass.setBlendConstant([w, w, w, w]);
        pass.setBindGroup(0, this.postBind(0, this.hdrView, this.bloomViews[0], 'accum'));
        pass.draw(3);
        pass.end();
      }
    });
    const srcView = states.length > 1 ? this.accumView : this.hdrView;
    const srcKey = states.length > 1 ? 'A' : 'H';

    // Bloom: threshold + downsample chain, then additive upsample back to the first level.
    const post = state.post;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const srcW = i === 0 ? this.rw : Math.max(1, ow >> i), srcH = i === 0 ? this.rh : Math.max(1, oh >> i);
      const r = i === 0 ? ss * 0.5 : 0.5;
      this.writePost(1 + i, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, post.bloomThreshold, i === 0 ? 1 : 0, r / srcW, r / srcH, 0, 0]);
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.bloomViews[i], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      pass.setPipeline(this.downPipe);
      pass.setBindGroup(0, this.postBind(1 + i, i === 0 ? srcView : this.bloomViews[i - 1], this.bloomViews[BLOOM_LEVELS - 1 - (i === BLOOM_LEVELS - 1 ? 1 : 0)], `down${i}${srcKey}`));
      pass.draw(3);
      pass.end();
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const srcW = Math.max(1, ow >> (i + 1)), srcH = Math.max(1, oh >> (i + 1));
      this.writePost(6 + i, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 / srcW, 1 / srcH, 0, 0]);
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.bloomViews[i - 1], loadOp: 'load', storeOp: 'store' }] });
      pass.setPipeline(this.upPipe);
      pass.setBindGroup(0, this.postBind(6 + i, this.bloomViews[i], this.bloomViews[i === 1 ? 2 : 0], `up${i}`));
      pass.draw(3);
      pass.end();
    }

    // Grade, tone map and write the output.
    const srgb = target.format.endsWith('-srgb') ? 0 : 1;
    this.writePost(12, [
      Math.pow(2, post.exposure), post.contrast, post.saturation, post.bloom / (BLOOM_LEVELS - 1),
      post.tint[0], post.tint[1], post.tint[2], post.vignette,
      post.master, ss, 0, 0,
      1 / this.rw, 1 / this.rh, srgb, 0,
      ...(opts.flat ?? [0, 0, 0, 0]),
    ]);
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        timestampWrites: ts ? { querySet: ts, beginningOfPassWriteIndex: 6, endOfPassWriteIndex: 7 } : undefined,
      });
      pass.setPipeline(this.finalPipe(target.format));
      pass.setBindGroup(0, this.postBind(12, srcView, this.bloomViews[0], `final${srcKey}`));
      pass.draw(3);
      pass.end();
    }

    if (opts.overlay && opts.overlay.length) {
      const verts = opts.overlay;
      if (!this.lineVbo || this.lineVboSize < verts.byteLength) {
        this.lineVbo?.destroy();
        this.lineVboSize = Math.max(verts.byteLength * 2, 1 << 16);
        this.lineVbo = d.createBuffer({ size: this.lineVboSize, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      d.queue.writeBuffer(this.lineVbo, 0, verts);
      const cm = this.lastCam!;
      d.queue.writeBuffer(this.lineUbo, 0, mul(cm.proj, cm.view) as Float32Array<ArrayBuffer>);
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }] });
      pass.setPipeline(this.linePipe(target.format));
      pass.setBindGroup(0, d.createBindGroup({ layout: this.lineLayout, entries: [{ binding: 0, resource: { buffer: this.lineUbo } }] }));
      pass.setVertexBuffer(0, this.lineVbo, 0, verts.byteLength);
      pass.draw(verts.length / 7);
      pass.end();
    }

    if (ts) {
      enc.resolveQuerySet(ts, 0, 8, this.queryResolve!, 0);
      enc.copyBufferToBuffer(this.queryResolve!, 0, this.queryRead!, 0, 64);
    }
    d.queue.submit([enc.finish()]);
    if (ts) {
      this.queryBusy = true;
      this.queryRead!.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(this.queryRead!.getMappedRange().slice(0));
        this.queryRead!.unmap();
        this.queryBusy = false;
        const ms = (a: number, b: number) => { const v = Number(t[b] - t[a]) / 1e6; return v > 0 && v < 5000 ? v : 0; };
        this.stats.passMs = { gbuffer: ms(0, 1), shadows: ms(2, 3), lighting: ms(4, 5), post: ms(6, 7) };
      }).catch(() => { this.queryBusy = false; });
    }
    this.stats.cpuMs = performance.now() - t0;
  }

  private writePost(i: number, v: number[]) {
    const f = new Float32Array(20);
    f.set(v);
    this.device.queue.writeBuffer(this.postUbos[i], 0, f);
  }

  /** G-buffer → shadows → lighting for one FrameState, leaving linear HDR in this.hdr. */
  private renderLit(enc: GPUCommandEncoder, state: FrameState, aspect: number, opts: RenderOptions, ts: GPUQuerySet | null) {
    const d = this.device;
    const { geomKey } = this.fillScene(state);
    const cam = cameraMatrices(state.camera, aspect);
    this.lastCam = { view: cam.view, proj: cam.proj, w: this.ow, h: this.oh };
    this.sort(cam.forward, !!opts.sync);

    const vd = new Float32Array(36);
    vd.set(cam.view, 0); vd.set(cam.proj, 16);
    vd[32] = this.rw; vd[33] = this.rh;
    d.queue.writeBuffer(this.viewUbo, 0, vd);

    {
      const pass = enc.beginRenderPass({
        colorAttachments: this.gViews.map((view) => ({ view, loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] })),
        timestampWrites: ts ? { querySet: ts, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
      });
      if (this.count) {
        pass.setPipeline(this.gPipe);
        pass.setBindGroup(0, this.mainBind!);
        pass.draw(4, this.count);
      }
      pass.end();
    }

    // Lights and shadow maps.
    const ld = this.lightData;
    ld.fill(0);
    ld.set(invert(cam.view), 0);
    ld.set([cam.proj[0], cam.proj[5], this.rw, this.rh], 16);
    ld.set([...state.global.sky, state.global.intensity], 20);
    ld.set([...state.global.ground, opts.debugView ?? 0], 24);
    const lights = state.lights.filter((l) => l.intensity > 0).slice(0, MAX_LIGHTS);
    ld.set([...state.global.background, lights.length], 28);
    const sphere = this.sceneSphere(state);
    let layer = 0, shadowLights = 0;
    const maxShadow = opts.maxShadowLights ?? 4;
    const jobs: { layer: number; sv: ShadowView }[] = [];
    lights.forEach((l, i) => {
      const o = 32 + i * 24;
      const type = l.type === 'point' ? 0 : l.type === 'spot' ? 1 : l.type === 'sun' ? 2 : 3;
      ld.set([...l.pos, type, ...l.dir, l.range, l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity, l.specular], o);
      const outer = Math.cos((l.cone * DEG) / 2);
      const inner = Math.max(Math.cos(((l.cone * DEG) / 2) * (1 - l.penumbra)), outer + 1e-4);
      const size = l.type === 'sun' ? Math.tan((l.radius * 0.5 + l.softness * 4) * DEG)
        : l.type === 'area' ? Math.max(l.width, l.height) * 0.5 * (0.3 + l.softness)
        : l.radius + l.softness * 0.4;
      ld.set([outer, inner, size, 0, l.width, l.height, l.disc ? 1 : 0, -1, l.radius, 0, 0, 0], o + 12);
      if (!l.castShadows || !this.count || shadowLights >= maxShadow) return;
      const views = this.shadowViews(l, sphere);
      if (layer + views.length > MAX_SHADOW_LAYERS) return;
      shadowLights++;
      ld[o + 19] = layer;
      for (const sv of views) {
        ld.set(mul(sv.proj, sv.view), 416 + layer * 16);
        ld.set([sv.near, sv.far, sv.ortho ? 1 : 0, sv.w], 608 + layer * 4);
        jobs.push({ layer, sv });
        layer++;
      }
    });
    this.stats.lights = lights.length;
    this.stats.shadowMaps = layer;
    d.queue.writeBuffer(this.lightUbo, 0, ld);

    // Shadow maps are cached: a layer is redrawn only if its view or the scene's geometry changed.
    const dirty = jobs.filter((j) => {
      const key = (fnv(j.sv.view) ^ Math.imul(fnv(j.sv.proj), 31) ^ Math.imul(geomKey, 131) ^ this.sceneGen) >>> 0;
      if (this.shadowKeys[j.layer] === key) return false;
      this.shadowKeys[j.layer] = key;
      return true;
    });
    dirty.forEach((j, n) => {
      const sd = new Float32Array(36);
      sd.set(j.sv.view, 0); sd.set(j.sv.proj, 16);
      sd[32] = this.shadowRes; sd[33] = this.shadowRes; sd[34] = j.sv.ortho ? 1 : 0;
      d.queue.writeBuffer(this.shadowUbos[j.layer], 0, sd);
      const tw: GPURenderPassTimestampWrites | undefined = ts && (n === 0 || n === dirty.length - 1)
        ? { querySet: ts, beginningOfPassWriteIndex: n === 0 ? 2 : undefined, endOfPassWriteIndex: n === dirty.length - 1 ? 3 : undefined }
        : undefined;
      const pass = enc.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowLayerViews[j.layer], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
        timestampWrites: tw,
      });
      pass.setPipeline(this.shadowPipe);
      pass.setBindGroup(0, this.shadowBinds[j.layer]!);
      pass.draw(4, this.count);
      pass.end();
    });
    this.stats.shadowMapsRendered += dirty.length;

    if (!this.lightBind) {
      this.lightBind = d.createBindGroup({
        layout: this.lightPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.lightUbo } },
          ...this.gViews.map((v, i) => ({ binding: 1 + i, resource: v })),
          { binding: 5, resource: this.shadowArrayView },
          { binding: 6, resource: this.nearSampler },
        ],
      });
    }
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.hdrView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: ts ? { querySet: ts, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 } : undefined,
    });
    pass.setPipeline(this.lightPipe);
    pass.setBindGroup(0, this.lightBind);
    pass.draw(3);
    pass.end();
  }

  // ---- readback --------------------------------------------------------------------------------

  /** Render one frame off-screen and return tightly packed RGBA8 (sRGB-encoded). Used by export and golden tests. */
  async renderToPixels(state: FrameState, opts: RenderOptions): Promise<Uint8Array> {
    const d = this.device;
    const w = Math.round(opts.width), h = Math.round(opts.height);
    if (!this.readTex || this.readTex.width !== w || this.readTex.height !== h) {
      this.readTex?.destroy();
      this.readTex = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    }
    this.render(state, { view: this.readTex.createView(), format: 'rgba8unorm' }, { ...opts, sync: true });
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.readTex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap();
    buf.destroy();
    return out;
  }

  /** World position under a pixel of the last rendered frame (u,v in 0..1 of the output), or null on empty space. */
  async pick(u: number, v: number): Promise<Vec3 | null> {
    if (!this.gTex.length || !this.lastCam) return null;
    const d = this.device;
    const x = Math.min(this.rw - 1, Math.max(0, Math.floor(u * this.rw))), y = Math.min(this.rh - 1, Math.max(0, Math.floor(v * this.rh)));
    const buf = d.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.gTex[3], origin: [x, y] }, { buffer: buf, bytesPerRow: 256 }, [1, 1]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = new Uint16Array(buf.getMappedRange().slice(0, 8));
    buf.unmap();
    buf.destroy();
    const cov = halfToFloat(px[3]);
    if (!(cov > 0.3)) return null;
    const depth = halfToFloat(px[0]) / cov;
    const cam = this.lastCam;
    const nx = u * 2 - 1, ny = 1 - v * 2;
    return transformPoint(invert(cam.view), [(nx * depth) / cam.proj[0], (ny * depth) / cam.proj[5], -depth]);
  }

  dispose() {
    this.worker?.terminate();
    this.device.destroy();
  }
}
