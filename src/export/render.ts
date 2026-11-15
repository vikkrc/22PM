// Frame-stepped render to video (brief section 10). Uses the same evaluate() + renderer as live playback,
// stepped by frame index and never tied to real time.
import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from 'mp4-muxer';
import { Zip, ZipPassThrough } from 'fflate';
import { evaluate } from '../core/evaluate';
import type { Show, Song } from '../core/model';
import { beatToSec } from '../core/tempo';
import type { Renderer } from '../render/renderer';
import type { Analysis } from '../core/analysisTypes';

export type Codec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'png';

export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
  codec: Codec;
  /** Range in beats. */
  fromBeat: number;
  toBeat: number;
  supersample: number;
  /** Motion-blur sub-frames (1 = off). */
  subFrames: number;
  /** Fraction of the frame interval the shutter is open. */
  shutter: number;
  shadowRes: number;
  embedAudio: boolean;
  bitrateMbps: number;
}

export const CODEC_LABEL: Record<Codec, string> = { h264: 'H.264 (MP4)', hevc: 'HEVC (MP4)', vp9: 'VP9 (MP4)', av1: 'AV1 (MP4)', png: 'PNG sequence' };
const CODEC_STRING: Record<Exclude<Codec, 'png'>, string> = { h264: 'avc1.640034', hevc: 'hvc1.1.6.L156.B0', vp9: 'vp09.00.51.08', av1: 'av01.0.13M.08' };
const MUX_CODEC: Record<Exclude<Codec, 'png'>, 'avc' | 'hevc' | 'vp9' | 'av1'> = { h264: 'avc', hevc: 'hevc', vp9: 'vp9', av1: 'av1' };

export async function supportedCodecs(width: number, height: number, fps: number): Promise<Codec[]> {
  const out: Codec[] = [];
  if (typeof VideoEncoder !== 'undefined') {
    for (const c of ['h264', 'hevc', 'vp9', 'av1'] as const) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec: CODEC_STRING[c], width, height, framerate: fps, bitrate: 20e6 });
        if (r.supported) out.push(c);
      } catch { /* not supported */ }
    }
  }
  out.push('png');
  return out;
}

export interface RenderJob { cancel: () => void; done: Promise<{ blob: Blob | null; frames: number; note: string }> }

type Sink = { kind: 'file'; handle: FileSystemFileHandle } | { kind: 'dir'; handle: FileSystemDirectoryHandle } | { kind: 'memory' };

/** Ask where to write before rendering starts (needs a user gesture). Falls back to memory + download. */
export async function chooseSink(codec: Codec, name: string): Promise<Sink> {
  const w = window as any;
  try {
    if (codec === 'png' && w.showDirectoryPicker) return { kind: 'dir', handle: await w.showDirectoryPicker({ mode: 'readwrite' }) };
    if (codec !== 'png' && w.showSaveFilePicker) return { kind: 'file', handle: await w.showSaveFilePicker({ suggestedName: `${name}.mp4`, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] }) };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
  }
  return { kind: 'memory' };
}

export function startRender(renderer: Renderer, show: Show, song: Song, analysis: Analysis | null, audio: AudioBuffer | null, s: RenderSettings, sink: Sink, onProgress: (done: number, total: number, preview: Uint8Array | null) => void): RenderJob {
  let cancelled = false;
  const done = (async () => {
    const t0 = beatToSec(song.tempo, s.fromBeat), t1 = beatToSec(song.tempo, s.toBeat);
    const total = Math.max(1, Math.round((t1 - t0) * s.fps));
    const opts = { width: s.width, height: s.height, ss: s.supersample, shadowRes: s.shadowRes, maxShadowLights: song.scene.maxShadowLights };
    const frameAt = async (i: number) => {
      const t = t0 + i / s.fps;
      const state = evaluate(show, song, t, analysis);
      const sub = [];
      for (let k = 1; k < s.subFrames; k++) sub.push(evaluate(show, song, t + ((k / s.subFrames) * s.shutter) / s.fps, analysis));
      return renderer.renderToPixels(state, { ...opts, subFrames: sub.length ? sub : undefined });
    };

    if (s.codec === 'png') {
      const canvas = new OffscreenCanvas(s.width, s.height);
      const g = canvas.getContext('2d')!;
      const chunks: Uint8Array[] = [];
      const zip = sink.kind === 'memory' ? new Zip((_e, data) => { chunks.push(data); }) : null;
      let i = 0;
      for (; i < total && !cancelled; i++) {
        const px = await frameAt(i);
        g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), s.width, s.height), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const name = `frame_${String(i + 1).padStart(6, '0')}.png`;
        if (sink.kind === 'dir') {
          const w = await (await sink.handle.getFileHandle(name, { create: true })).createWritable();
          await w.write(blob); await w.close();
        } else if (zip) {
          const f = new ZipPassThrough(name);
          zip.add(f);
          f.push(new Uint8Array(await blob.arrayBuffer()), true);
        }
        onProgress(i + 1, total, i % 4 === 0 ? px : null);
      }
      zip?.end();
      return { blob: zip ? new Blob(chunks as BlobPart[], { type: 'application/zip' }) : null, frames: i, note: cancelled ? 'Cancelled' : 'PNG sequence written' };
    }

    const stream = sink.kind === 'file' ? await sink.handle.createWritable() : null;
    const target = stream ? new FileSystemWritableFileStreamTarget(stream) : new ArrayBufferTarget();
    const wantAudio = s.embedAudio && !!audio && typeof AudioEncoder !== 'undefined';
    const muxer = new Muxer({
      target: target as any,
      video: { codec: MUX_CODEC[s.codec], width: s.width, height: s.height, frameRate: s.fps },
      audio: wantAudio ? { codec: 'aac', numberOfChannels: Math.min(2, audio!.numberOfChannels), sampleRate: audio!.sampleRate } : undefined,
      fastStart: stream ? false : 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let encError: Error | null = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encError = e; } });
    enc.configure({ codec: CODEC_STRING[s.codec], width: s.width, height: s.height, framerate: s.fps, bitrate: s.bitrateMbps * 1e6, latencyMode: 'quality' });
    let i = 0;
    for (; i < total && !cancelled && !encError; i++) {
      const px = await frameAt(i);
      const frame = new VideoFrame(px, {
        format: 'RGBA', codedWidth: s.width, codedHeight: s.height,
        timestamp: Math.round((i / s.fps) * 1e6), duration: Math.round(1e6 / s.fps),
        colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
      });
      enc.encode(frame, { keyFrame: i % Math.round(s.fps * 2) === 0 });
      frame.close();
      // Keep memory flat: wait if the encoder is falling behind.
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
      onProgress(i + 1, total, i % 4 === 0 ? px : null);
    }
    if (encError) throw encError;
    await enc.flush();
    enc.close();

    if (wantAudio && !cancelled) {
      const ch = Math.min(2, audio!.numberOfChannels), sr = audio!.sampleRate;
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encError = e; } });
      aenc.configure({ codec: 'mp4a.40.2', numberOfChannels: ch, sampleRate: sr, bitrate: 256000 });
      const startS = Math.round(t0 * sr), endS = Math.round((t0 + i / s.fps) * sr);
      const block = 4096;
      for (let p = startS; p < endS; p += block) {
        const n = Math.min(block, endS - p);
        const data = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) {
          const src = audio!.getChannelData(c);
          for (let k = 0; k < n; k++) { const idx = p + k; data[c * n + k] = idx >= 0 && idx < src.length ? src[idx] : 0; }
        }
        const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(((p - startS) / sr) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
      aenc.close();
    }
    muxer.finalize();
    if (stream) { await stream.close(); return { blob: null, frames: i, note: cancelled ? 'Cancelled (partial file written)' : 'Saved' }; }
    return { blob: new Blob([(target as ArrayBufferTarget).buffer], { type: 'video/mp4' }), frames: i, note: cancelled ? 'Cancelled' : 'Done' };
  })();
  return { cancel: () => { cancelled = true; }, done };
}
