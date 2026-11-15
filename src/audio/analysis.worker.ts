import { analyze } from './analysis';

self.onmessage = (e: MessageEvent<{ pcm: Float32Array; sampleRate: number }>) => {
  const { pcm, sampleRate } = e.data;
  const result = analyze(pcm, sampleRate, (f) => (self as any).postMessage({ progress: f }));
  (self as any).postMessage({ result }, [result.bands.buffer, result.peaks.buffer]);
};
