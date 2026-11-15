// The viewport: render loop, camera navigation, light gizmos and handles.
import { useEffect, useRef } from 'react';
import { evaluate, type CameraState, type FrameState } from '../core/evaluate';
import { cameraMatrices, type Renderer } from '../render/renderer';
import { cameraFrustum, grid, instanceMatrix, lightGizmo, LineBuf, sunGizmoPos } from '../render/lines';
import { clamp, invert, mul, transformPoint, v3, type Mat4, type Vec3 } from '../core/math';
import { clipActive } from '../core/evaluate';
import { secToBeat } from '../core/tempo';
import { findClip, type Clip, type Song } from '../core/model';
import { KINDS } from '../core/registry';
import { analysisFor, getRenderer, splatFor } from '../state/runtime';
import { currentSong, getState, select, setUi, useStore, commit } from '../state/store';
import { transport } from '../state/transport';
import { patchSplat, setParams, staticValue } from '../state/actions';
import { showControl } from '../state/showControl';
import { Select } from './widgets';

/** Things other panels can ask the viewport to do. */
export const viewportBus = {
  /** Next click on the scene resolves with the world position under the cursor. */
  pick: null as null | ((p: Vec3 | null) => void),
  frameAll: () => {},
  redraw: () => {},
  /** Latest evaluated frame, for panels that show live values. */
  lastState: null as FrameState | null,
  /** The main canvas (show output mirrors it). */
  canvas: null as HTMLCanvasElement | null,
  /** Set while a video render owns the renderer. */
  paused: false,
};

const explore: CameraState = { pos: [4.5, 3, 7], target: [0, 0.8, 0], fov: 50, roll: 0 };

/** The camera clip that is in charge at a beat: top-most active camera clip, else the base camera. */
export function activeCameraClip(song: Song, beat: number): Clip {
  for (const t of song.tracks) {
    if (t.muted || t.type !== 'camera') continue;
    const c = t.clips.find((x) => x.kind === 'camera' && clipActive(x, beat));
    if (c) return c;
  }
  return song.scene.base.camera;
}

interface HandleSpec { key: string; pos: Vec3; label: string; set: (p: Vec3) => void }

function handleSpecs(song: Song, beat: number, viewMode: string): HandleSpec[] {
  const { ui } = getState();
  const out: HandleSpec[] = [];
  if (ui.selection.type === 'clip') {
    const f = findClip(song, ui.selection.id);
    if (!f) return out;
    const c = f.clip;
    if (c.kind === 'camera' && viewMode === 'camera') return out;
    const groups = new Set(KINDS[c.kind].params.filter((p) => p.widget === 'vec3').map((p) => p.group!));
    for (const [g, label] of [['pos', 'Position'], ['target', 'Aim'], ['origin', 'Origin']] as const) {
      if (!groups.has(g)) continue;
      out.push({
        key: g, label,
        pos: [staticValue(c, `${g}.x`, beat), staticValue(c, `${g}.y`, beat), staticValue(c, `${g}.z`, beat)],
        set: (p) => setParams(c.id, { [`${g}.x`]: p[0], [`${g}.y`]: p[1], [`${g}.z`]: p[2] }, `gizmo-${g}`),
      });
    }
  } else if (ui.selection.type === 'splat') {
    const id = ui.selection.id;
    const s = song.scene.splats.find((x) => x.id === id);
    if (s) out.push({ key: 'splat', label: s.name, pos: s.pos, set: (p) => patchSplat(id, { pos: p }, 'gizmo') });
  }
  return out;
}

const AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const MAX_HANDLES = 3;
const MAX_DOTS = 24;
const DEBUG_VIEWS = [
  { value: 0, label: 'Final' }, { value: 5, label: 'Lighting only' }, { value: 1, label: 'Albedo (de-lit)' },
  { value: 3, label: 'Baked' }, { value: 2, label: 'Normals' }, { value: 4, label: 'Depth' },
];

export function Viewport({ hidden }: { hidden: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLPreElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  const ui = useStore((s) => s.ui);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  useEffect(() => {
    const canvas = canvasRef.current!, wrap = wrapRef.current!, overlay = overlayRef.current!;
    viewportBus.canvas = canvas;
    let renderer: Renderer | null = null;
    let ctx: GPUCanvasContext | null = null;
    let raf = 0;
    let disposed = false;
    let dirtyUntil = performance.now() + 500;
    let lastSig = '';
    let lastT = performance.now();
    let frameMs = 16;
    let hudT = 0;
    let frozen: FrameState | null = null;
    let viewProj: Mat4 | null = null;
    let camNow: CameraState = explore;
    let handles: HandleSpec[] = [];
    let dotClips: string[] = [];
    const keys = new Set<string>();
    const poke = () => { dirtyUntil = performance.now() + 250; };
    viewportBus.redraw = poke;

    // Handle / dot DOM pool, positioned every frame without going through React.
    const handleEls: HTMLElement[][] = [];
    for (let h = 0; h < MAX_HANDLES; h++) {
      const group: HTMLElement[] = [];
      for (let a = -1; a < 3; a++) {
        const el = document.createElement('div');
        el.className = a < 0 ? 'gz gz-center' : `gz gz-axis gz-${'xyz'[a]}`;
        el.textContent = a < 0 ? '' : 'XYZ'[a];
        el.dataset.h = String(h); el.dataset.a = String(a);
        overlay.appendChild(el);
        group.push(el);
      }
      const lab = document.createElement('div');
      lab.className = 'gz-label';
      overlay.appendChild(lab);
      group.push(lab);
      handleEls.push(group);
    }
    const dotEls: HTMLElement[] = [];
    for (let i = 0; i < MAX_DOTS; i++) {
      const el = document.createElement('div');
      el.className = 'light-dot';
      el.dataset.dot = String(i);
      overlay.appendChild(el);
      dotEls.push(el);
    }

    const project = (p: Vec3): [number, number, boolean] => {
      if (!viewProj) return [0, 0, false];
      const m = viewProj;
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      const x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w, y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
      return [(x * 0.5 + 0.5) * canvas.clientWidth, (0.5 - y * 0.5) * canvas.clientHeight, w > 0.05];
    };
    const rayAt = (clientX: number, clientY: number): { o: Vec3; d: Vec3 } | null => {
      if (!viewProj) return null;
      const r = canvas.getBoundingClientRect();
      const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = 1 - ((clientY - r.top) / r.height) * 2;
      const inv = invert(viewProj);
      const a = transformPoint(inv, [nx, ny, 0]), b = transformPoint(inv, [nx, ny, 1]);
      return { o: a, d: v3.norm(v3.sub(b, a)) };
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!renderer || !ctx || hiddenRef.current || renderer.lost || viewportBus.paused) return;
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      const s = getState();
      const show = s.show, song = currentSong(s), u = s.ui;
      const live = u.tab === 'show';
      showControl.follow();
      const sec = transport.now();

      // Fly keys move the view camera.
      if (keys.size && !live) {
        const f = v3.norm(v3.sub(camNow.target, camNow.pos));
        let r = v3.cross(f, [0, 1, 0]); r = v3.len(r) < 1e-5 ? [1, 0, 0] : v3.norm(r);
        const sp = (keys.has('shift') ? 6 : 2) * Math.min(dt, 0.05);
        let mv: Vec3 = [0, 0, 0];
        if (keys.has('w')) mv = v3.add(mv, v3.scale(f, sp));
        if (keys.has('s')) mv = v3.add(mv, v3.scale(f, -sp));
        if (keys.has('d')) mv = v3.add(mv, v3.scale(r, sp));
        if (keys.has('a')) mv = v3.add(mv, v3.scale(r, -sp));
        if (keys.has('e')) mv = v3.add(mv, [0, sp, 0]);
        if (keys.has('q')) mv = v3.add(mv, [0, -sp, 0]);
        if (v3.len(mv) > 0) applyCam(v3.add(camNow.pos, mv), v3.add(camNow.target, mv));
      }

      // Size the canvas to the output aspect inside the panel.
      const out = show.output;
      const pw = wrap.clientWidth, ph = wrap.clientHeight;
      if (pw < 8 || ph < 8) return;
      const aspect = out.width / out.height;
      let cw = pw, chh = pw / aspect;
      if (chh > ph) { chh = ph; cw = ph * aspect; }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = live ? Infinity : u.previewScale;
      const pxW = Math.max(2, Math.round(Math.min(out.width, cw * dpr * scale))), pxH = Math.max(2, Math.round(pxW / aspect));
      if (canvas.width !== pxW || canvas.height !== pxH) { canvas.width = pxW; canvas.height = pxH; poke(); }
      canvas.style.width = `${Math.floor(cw)}px`; canvas.style.height = `${Math.floor(chh)}px`;

      showControl.tick(dt);
      const sig = `${sec}|${s.assetGen}|${u.viewMode}|${u.debugView}|${u.showGizmos}|${u.tab}|${JSON.stringify(u.selection)}|${explore.pos}|${explore.target}|${showControl.blackMix}|${showControl.colorMix}|${showControl.freeze}`;
      if (sig !== lastSig || show !== lastShow) { lastSig = sig; lastShow = show; poke(); }
      lastT = now;
      if (now > dirtyUntil && !transport.playing) return;
      frameMs += (now - lastFrameT - frameMs) * 0.1;
      lastFrameT = now;

      let state = evaluate(show, song, sec, analysisFor(song));
      if (live && showControl.freeze && frozen) state = frozen; else frozen = state;
      viewportBus.lastState = state;
      const useExplore = u.viewMode === 'explore' && !live;
      const evalCam = state.camera;
      if (useExplore) state = { ...state, camera: explore };
      camNow = state.camera;
      const cm = cameraMatrices(state.camera, aspect);
      viewProj = mul(cm.proj, cm.view);

      // Overlay.
      const beat = secToBeat(song.tempo, sec);
      let lines: Float32Array | undefined;
      const gizmos = u.showGizmos && !live;
      const center = sceneCenter(song);
      if (gizmos) {
        const buf = new LineBuf();
        if (useExplore) { grid(buf); cameraFrustum(buf, evalCam, aspect, [0.42, 0.66, 1, 0.9]); }
        const selId = u.selection.type === 'clip' ? u.selection.id : '';
        for (const l of state.lights) lightGizmo(buf, l, l.id === selId, center);
        if (u.selection.type === 'splat') {
          const inst = song.scene.splats.find((x) => x.id === (u.selection as any).id);
          const data = inst && splatFor(show, inst.assetId, inst.version);
          if (inst && data) {
            const m = instanceMatrix(inst);
            buf.box(data.boundsMin, data.boundsMax, m, [1, 0.7, 0.14, 0.5]);
            if (inst.crop) buf.box(inst.cropMin, inst.cropMax, m, [1, 0.35, 0.3, 0.9]);
          }
        }
        if (selId) {
          const an = state.animators.find((a) => a.id === selId);
          if (an?.kind === 'anim.sweep' && an.p.pattern === 1) buf.sphere([an.p['origin.x'], an.p['origin.y'], an.p['origin.z']], Math.max(0.01, an.p.position), [0.75, 0.55, 1, 0.6]);
          if (an?.kind === 'anim.cutoff') {
            const o: Vec3 = an.p.from > 0.5 ? [an.p['origin.x'], an.p['origin.y'], an.p['origin.z']] : evalCam.pos;
            if (an.p.from > 0.5 || useExplore) { buf.sphere(o, Math.max(0.01, an.p.near), [0.75, 0.55, 1, 0.35]); buf.sphere(o, an.p.far, [0.75, 0.55, 1, 0.7]); }
          }
        }
        lines = buf.build();
      }

      const flatC = state.global.sky.map((c) => Math.min(1, c * Math.max(state.global.intensity, 0.25) * 2)) as Vec3;
      const st = showControl.blackMix > 0 ? { ...state, post: { ...state.post, master: state.post.master * (1 - showControl.blackMix) } } : state;
      renderer.render(st, { view: ctx.getCurrentTexture().createView(), format: renderer.canvasFormat }, {
        width: pxW, height: pxH, debugView: live ? 0 : u.debugView, overlay: lines,
        shadowRes: song.scene.shadowResolution, maxShadowLights: song.scene.maxShadowLights,
        flat: live && showControl.colorMix > 0 ? [flatC[0], flatC[1], flatC[2], showControl.colorMix] : undefined,
      });

      // Mirror to the LED output window.
      const ow = showControl.output;
      if (ow && !ow.closed) {
        const oc = ow.document.getElementById('out') as HTMLCanvasElement | null;
        if (oc) {
          if (oc.width !== pxW || oc.height !== pxH) { oc.width = pxW; oc.height = pxH; }
          oc.getContext('2d')!.drawImage(canvas, 0, 0);
        }
      }

      // Handles and light dots.
      handles = gizmos ? handleSpecs(song, beat, u.viewMode).slice(0, MAX_HANDLES) : [];
      for (let h = 0; h < MAX_HANDLES; h++) {
        const spec = handles[h];
        const els = handleEls[h];
        if (!spec) { els.forEach((e) => (e.style.display = 'none')); continue; }
        const [cx, cy, ok] = project(spec.pos);
        const len = v3.dist(spec.pos, camNow.pos) * Math.tan((camNow.fov * Math.PI) / 360) * 0.2;
        els.forEach((e, i) => {
          if (!ok) { e.style.display = 'none'; return; }
          e.style.display = '';
          if (i === 0) e.style.transform = `translate(${cx}px, ${cy}px)`;
          else if (i === 4) { e.style.transform = `translate(${cx + 12}px, ${cy + 10}px)`; e.textContent = spec.label; }
          else {
            const [tx, ty, tok] = project(v3.add(spec.pos, v3.scale(AXES[i - 1], len)));
            e.style.display = tok ? '' : 'none';
            e.style.transform = `translate(${tx}px, ${ty}px)`;
            e.style.setProperty('--len', `${Math.hypot(cx - tx, cy - ty)}px`); e.style.setProperty('--ang', `${Math.atan2(cy - ty, cx - tx)}rad`);
          }
        });
      }
      dotClips = [];
      if (gizmos) for (const l of state.lights) {
        if (dotClips.length >= MAX_DOTS) break;
        const p = l.type === 'sun' ? sunGizmoPos(l, center) : l.pos;
        const [x, y, ok] = project(p);
        const el = dotEls[dotClips.length];
        if (!ok) continue;
        el.style.display = '';
        el.style.transform = `translate(${x}px, ${y}px)`;
        const m = Math.max(l.color[0], l.color[1], l.color[2], 1e-3);
        el.style.background = `rgb(${l.color.map((c) => Math.round(Math.sqrt(c / m) * 255)).join(',')})`;
        el.classList.toggle('sel', u.selection.type === 'clip' && u.selection.id === l.id);
        el.title = findClip(song, l.id)?.clip.name ?? '';
        dotClips.push(l.id);
      }
      for (let i = dotClips.length; i < MAX_DOTS; i++) dotEls[i].style.display = 'none';

      if (hudRef.current && now - hudT > 250) {
        hudT = now;
        const st2 = renderer.stats;
        const p = st2.passMs;
        hudRef.current.textContent =
          `${(1000 / Math.max(frameMs, 0.1)).toFixed(0).padStart(3)} fps  ${frameMs.toFixed(1)} ms   ${pxW}×${pxH}\n` +
          (p ? `g-buffer ${p.gbuffer.toFixed(2)}  shadows ${p.shadows.toFixed(2)}  light ${p.lighting.toFixed(2)}  post ${p.post.toFixed(2)} ms\n` : `cpu ${st2.cpuMs.toFixed(2)} ms\n`) +
          `${(st2.gaussians / 1e6).toFixed(2)}M gaussians   sort ${st2.sortMs.toFixed(0)} ms\n` +
          `${st2.lights} lights   ${st2.shadowMaps} shadow maps (${st2.shadowMapsRendered} redrawn)`;
      }
    };
    let lastShow = getState().show;
    let lastFrameT = performance.now();

    function sceneCenter(song: Song): Vec3 {
      const { show } = getState();
      let c: Vec3 = [0, 0, 0], n = 0;
      for (const inst of song.scene.splats) {
        const d = splatFor(show, inst.assetId, inst.version);
        if (!d || !inst.visible) continue;
        c = v3.add(c, transformPoint(instanceMatrix(inst), d.center)); n++;
      }
      return n ? v3.scale(c, 1 / n) : [0, 1, 0];
    }

    function applyCam(pos: Vec3, target: Vec3) {
      const u = getState().ui;
      if (u.viewMode === 'explore' || u.tab !== 'animate') { explore.pos = pos; explore.target = target; poke(); return; }
      // Camera mode: navigating edits the camera that is in charge (auto-keys if it is keyframed).
      const song = currentSong();
      const clip = activeCameraClip(song, secToBeat(song.tempo, transport.sec));
      setParams(clip.id, { 'pos.x': pos[0], 'pos.y': pos[1], 'pos.z': pos[2], 'target.x': target[0], 'target.y': target[1], 'target.z': target[2] }, 'nav');
    }

    viewportBus.frameAll = () => {
      const song = currentSong();
      const c = sceneCenter(song);
      let r = 3;
      for (const inst of song.scene.splats) {
        const d = splatFor(getState().show, inst.assetId, inst.version);
        if (d) r = Math.max(r, v3.dist(d.boundsMin, d.boundsMax) * 0.5 * inst.scale);
      }
      const dir = v3.norm(v3.sub(explore.pos, explore.target));
      explore.target = c;
      explore.pos = v3.add(c, v3.scale(dir, r * 1.6));
      setUi({ viewMode: 'explore' });
      poke();
    };

    // ---- pointer interaction ----
    type Drag =
      | { kind: 'orbit' | 'pan'; x: number; y: number; pos: Vec3; target: Vec3 }
      | { kind: 'handle'; spec: HandleSpec; axis: number; p0: Vec3; t0: number; off: Vec3 };
    let drag: Drag | null = null;
    let downAt: [number, number] | null = null;

    const axisParam = (ray: { o: Vec3; d: Vec3 }, p0: Vec3, a: Vec3) => {
      // Closest point on the axis line to the mouse ray.
      const w = v3.sub(p0, ray.o);
      const b = v3.dot(a, ray.d), d = v3.dot(a, w), e = v3.dot(ray.d, w);
      const den = 1 - b * b;
      return Math.abs(den) < 1e-5 ? 0 : (b * e - d) / den;
    };
    const planeHit = (ray: { o: Vec3; d: Vec3 }, p0: Vec3, n: Vec3): Vec3 | null => {
      const den = v3.dot(ray.d, n);
      if (Math.abs(den) < 1e-6) return null;
      return v3.add(ray.o, v3.scale(ray.d, v3.dot(v3.sub(p0, ray.o), n) / den));
    };

    const onDown = (e: PointerEvent) => {
      if (getState().ui.tab === 'show') return;
      const t = e.target as HTMLElement;
      wrap.focus();
      if (t.dataset.dot != null) { const id = dotClips[+t.dataset.dot]; if (id) select({ type: 'clip', id }); e.preventDefault(); return; }
      if (t.dataset.h != null) {
        const spec = handles[+t.dataset.h!];
        const axis = +t.dataset.a!;
        const ray = rayAt(e.clientX, e.clientY);
        if (!spec || !ray) return;
        const fwd = v3.norm(v3.sub(camNow.target, camNow.pos));
        const hit = axis < 0 ? planeHit(ray, spec.pos, fwd) : null;
        drag = { kind: 'handle', spec, axis, p0: spec.pos, t0: axis >= 0 ? axisParam(ray, spec.pos, AXES[axis]) : 0, off: hit ? v3.sub(spec.pos, hit) : [0, 0, 0] };
        wrap.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (t !== canvas) return;
      downAt = [e.clientX, e.clientY];
      const pan = e.button === 1 || e.button === 2 || e.shiftKey;
      drag = { kind: pan ? 'pan' : 'orbit', x: e.clientX, y: e.clientY, pos: camNow.pos, target: camNow.target };
      wrap.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      if (drag.kind === 'handle') {
        const ray = rayAt(e.clientX, e.clientY);
        if (!ray) return;
        let p: Vec3 | null;
        if (drag.axis >= 0) {
          const a = AXES[drag.axis];
          p = v3.add(drag.p0, v3.scale(a, axisParam(ray, drag.p0, a) - drag.t0));
        } else {
          const hit = planeHit(ray, drag.p0, v3.norm(v3.sub(camNow.target, camNow.pos)));
          p = hit ? v3.add(hit, drag.off) : null;
        }
        if (p) {
          const q = e.ctrlKey || e.metaKey ? 0.1 : 0.001;
          drag.spec.set(p.map((v) => Math.round(v / q) * q) as Vec3);
        }
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      const off = v3.sub(drag.pos, drag.target);
      const dist = v3.len(off);
      if (drag.kind === 'orbit') {
        let yaw = Math.atan2(off[0], off[2]) - dx * 0.006;
        const pitch = clamp(Math.asin(clamp(off[1] / dist, -1, 1)) + dy * 0.006, -1.5, 1.5);
        const n: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
        applyCam(v3.add(drag.target, v3.scale(n, dist)), drag.target);
      } else {
        const f = v3.norm(v3.scale(off, -1));
        let r = v3.cross(f, [0, 1, 0]); r = v3.len(r) < 1e-5 ? [1, 0, 0] : v3.norm(r);
        const up = v3.cross(r, f);
        const k = (dist * Math.tan((camNow.fov * Math.PI) / 360) * 2) / canvas.clientHeight;
        const mv = v3.add(v3.scale(r, -dx * k), v3.scale(up, dy * k));
        applyCam(v3.add(drag.pos, mv), v3.add(drag.target, mv));
      }
    };
    const onUp = async (e: PointerEvent) => {
      const wasClick = downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 4;
      if (drag) { try { wrap.releasePointerCapture(e.pointerId); } catch { /* not captured */ } commit(); }
      drag = null; downAt = null;
      if (wasClick && renderer) {
        const r = canvas.getBoundingClientRect();
        if (viewportBus.pick) {
          const cb = viewportBus.pick;
          viewportBus.pick = null;
          wrap.classList.remove('picking');
          cb(await renderer.pick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
        } else if (getState().ui.selection.type !== 'none' && !e.shiftKey) select({ type: 'none' });
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (getState().ui.tab === 'show') return;
      e.preventDefault();
      const off = v3.sub(camNow.pos, camNow.target);
      const k = Math.exp(e.deltaY * 0.0012);
      const dist = Math.max(0.05, v3.len(off) * k);
      applyCam(v3.add(camNow.target, v3.scale(v3.norm(off), dist)), camNow.target);
      commit();
    };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) return;
      if ('wasdqe'.includes(k) && k.length === 1) { if (e.type === 'keydown') keys.add(k); else { keys.delete(k); commit(); } e.stopPropagation(); if (e.type === 'keydown') e.preventDefault(); }
      if (k === 'shift') { if (e.type === 'keydown') keys.add('shift'); else keys.delete('shift'); }
    };
    const onBlur = () => keys.clear();
    wrap.addEventListener('pointerdown', onDown);
    wrap.addEventListener('pointermove', onMove);
    wrap.addEventListener('pointerup', onUp);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('keydown', onKey);
    wrap.addEventListener('keyup', onKey);
    wrap.addEventListener('blur', onBlur);
    wrap.addEventListener('contextmenu', (e) => e.preventDefault());
    const unsubT = transport.subscribe(poke);
    const ro = new ResizeObserver(poke);
    ro.observe(wrap);

    getRenderer().then((r) => {
      if (disposed) return;
      renderer = r;
      r.onSorted = poke;
      ctx = canvas.getContext('webgpu') as GPUCanvasContext;
      ctx.configure({ device: r.device, format: r.canvasFormat, alphaMode: 'opaque' });
      raf = requestAnimationFrame(frame);
    }).catch((err) => {
      if (msgRef.current) { msgRef.current.style.display = ''; msgRef.current.textContent = `${err.message} 22PM needs a WebGPU browser (Chrome, Edge or Safari 26+).`; }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unsubT(); ro.disconnect();
      wrap.removeEventListener('pointerdown', onDown); wrap.removeEventListener('pointermove', onMove); wrap.removeEventListener('pointerup', onUp);
      wrap.removeEventListener('wheel', onWheel); wrap.removeEventListener('keydown', onKey); wrap.removeEventListener('keyup', onKey); wrap.removeEventListener('blur', onBlur);
      overlay.replaceChildren();
    };
  }, []);

  const live = ui.tab === 'show';
  return (
    <div className="viewport" style={{ display: hidden ? 'none' : undefined }}>
      {!live && (
        <div className="vp-bar">
          <div className="seg" role="tablist" aria-label="View">
            <button className={ui.viewMode === 'camera' ? 'on' : ''} title="Look through the song's camera. Navigating edits the camera (1)" onClick={() => setUi({ viewMode: 'camera' })}>Camera</button>
            <button className={ui.viewMode === 'explore' ? 'on' : ''} title="Free view for placing lights; does not change the song (2)" onClick={() => setUi({ viewMode: 'explore' })}>Explore</button>
          </div>
          <button className="btn" title="Frame the whole scene in Explore (F)" onClick={() => viewportBus.frameAll()}>Frame</button>
          <span className="spacer" />
          <Select value={ui.debugView} options={DEBUG_VIEWS} onChange={(v) => setUi({ debugView: v })} title="What the viewport shows" />
          <Select value={ui.previewScale} options={[{ value: 1, label: 'Full res' }, { value: 0.5, label: '1/2 res' }, { value: 0.25, label: '1/4 res' }]} onChange={(v) => setUi({ previewScale: v })} title="Preview resolution (does not affect output or render)" />
          <button className={`btn ${ui.showGizmos ? 'on' : ''}`} title="Show light gizmos and handles (G)" onClick={() => setUi({ showGizmos: !ui.showGizmos })}>Gizmos</button>
          <button className={`btn ${ui.showHud ? 'on' : ''}`} title="Performance HUD (H)" onClick={() => setUi({ showHud: !ui.showHud })}>HUD</button>
        </div>
      )}
      <div className="vp-stage" ref={wrapRef} tabIndex={0}>
        <div className="vp-frame">
          <canvas ref={canvasRef} />
          <div className="vp-overlay" ref={overlayRef} />
        </div>
        <pre className="hud" ref={hudRef} style={{ display: ui.showHud ? undefined : 'none' }} />
        {ui.viewMode === 'camera' && !live && <div className="vp-tag">Camera · drag to orbit, Shift-drag to pan, scroll to dolly, WASD/QE to move</div>}
        {ui.viewMode === 'explore' && !live && <div className="vp-tag explore">Explore · not what the audience sees</div>}
        <div className="vp-msg" ref={msgRef} style={{ display: 'none' }} />
      </div>
    </div>
  );
}

/** Ask the user to click a point in the scene. */
export function pickPoint(): Promise<Vec3 | null> {
  return new Promise((resolve) => {
    viewportBus.pick = resolve;
    document.querySelector('.vp-stage')?.classList.add('picking');
  });
}
