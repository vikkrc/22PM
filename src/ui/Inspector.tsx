// Inspector. Every row here is generated from the parameter registry: nothing is wired per parameter.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KINDS, paramGroups, type ParamDef, type ParamGroup } from '../core/registry';
import { EASE_PRESETS, findClip, type Clip, type Keyframe, type LfoMod, type ModType, type Modulator, type Song, type SplatInstance } from '../core/model';
import { evalParam } from '../core/evaluate';
import { evalModulator, type ModCtx } from '../core/modulators';
import { cubicBezier } from '../core/curves';
import { beatToSec, secToBeat } from '../core/tempo';
import { analysisFor, importAudioFile, latestVersion, splatFor } from '../state/runtime';
import { commit, select, update, useSong, useStore } from '../state/store';
import { transport } from '../state/transport';
import {
  addModulator, clearKeys, copyModulators, deleteClip, duplicateClip, editKeys, hasKeyAt, hasModClipboard, pasteModulators, patchClip, patchModulator, patchSong, patchSplat,
  removeModulator, removeSplat, setParams, setSongLength, staticValue, toggleKeys, addSection,
} from '../state/actions';
import { BBT, ColorField, Menu, Num, Row, Section, Select, Text, Toggle } from './widgets';
import { pickPoint } from './Viewport';

/** Re-render at most `hz` times a second while the playhead moves. */
export function usePlayhead(hz = 12): number {
  const [sec, setSec] = useState(transport.sec);
  useEffect(() => {
    let raf = 0, last = 0, prev = -1;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 1000 / hz) return;
      last = t;
      const s = transport.sec;
      if (s !== prev) { prev = s; setSec(s); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hz]);
  return sec;
}

const MOD_LABEL: Record<ModType, string> = { lfo: 'LFO', band: 'Audio band', onset: 'Onset trigger', beat: 'Beat trigger', section: 'Section' };

function modCtx(song: Song, sec: number): ModCtx {
  return { tempo: song.tempo, beat: secToBeat(song.tempo, sec), sec, analysis: analysisFor(song), sections: song.sections };
}

function Spark({ mod, song, sec }: { mod: Modulator; song: Song; sec: number }) {
  // Two bars around the playhead.
  const bars = 2 * song.tempo.beatsPerBar;
  const b0 = Math.floor(secToBeat(song.tempo, sec) / bars) * bars;
  const N = 120;
  const an = analysisFor(song);
  let d = '';
  const bip = mod.type === 'lfo' && mod.bipolar;
  for (let i = 0; i <= N; i++) {
    const beat = b0 + (i / N) * bars;
    const v = evalModulator(mod, { tempo: song.tempo, beat, sec: beatToSec(song.tempo, beat), analysis: an, sections: song.sections });
    const y = bip ? 0.5 - v * 0.5 : 1 - v;
    d += `${i ? 'L' : 'M'}${((i / N) * 100).toFixed(1)} ${(2 + y * 20).toFixed(1)}`;
  }
  const x = ((secToBeat(song.tempo, sec) - b0) / bars) * 100;
  return (
    <svg className="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-label="Modulator output over two bars">
      {Array.from({ length: bars + 1 }, (_, i) => <line key={i} x1={(i / bars) * 100} x2={(i / bars) * 100} y1="0" y2="24" className={i % song.tempo.beatsPerBar === 0 ? 'bar' : 'beat'} />)}
      <path d={d} />
      <line x1={x} x2={x} y1="0" y2="24" className="now" />
    </svg>
  );
}

function AdsrRows({ env, set }: { env: { a: number; d: number; s: number; hold: number; r: number }; set: (k: string, v: number) => void }) {
  return (
    <>
      <Row label="Attack"><Num value={env.a} step={0.001} min={0} max={5} soft={[0, 0.5]} unit="s" onChange={(v) => set('a', v)} /></Row>
      <Row label="Decay"><Num value={env.d} step={0.001} min={0.001} max={10} soft={[0, 1]} unit="s" onChange={(v) => set('d', v)} /></Row>
      <Row label="Sustain"><Num value={env.s} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => set('s', v)} /></Row>
      <Row label="Hold"><Num value={env.hold} step={0.001} min={0} max={10} soft={[0, 1]} unit="s" onChange={(v) => set('hold', v)} /></Row>
      <Row label="Release"><Num value={env.r} step={0.001} min={0} max={10} soft={[0, 1]} unit="s" onChange={(v) => set('r', v)} /></Row>
    </>
  );
}

function rateOptions(bpb: number) {
  const o = [[1 / 16, '1/16'], [1 / 8, '1/8'], [1 / 4, '1/4'], [1 / 2, '1/2'], [1, '1 beat'], [2, '2 beats'], [bpb, '1 bar'], [bpb * 2, '2 bars'], [bpb * 4, '4 bars'], [bpb * 8, '8 bars'], [bpb * 16, '16 bars']] as [number, string][];
  return o.map(([value, label]) => ({ value, label }));
}

function ModCard({ clip, def, mod, song, sec }: { clip: Clip; def: ParamDef; mod: Modulator; song: Song; sec: number }) {
  const patch = (p: Partial<Modulator> | ((m: any) => void)) => patchModulator(clip.id, def.id, mod.id, p);
  const range = (def.softMax ?? def.max) - (def.softMin ?? def.min);
  const bpb = song.tempo.beatsPerBar;
  const noAudio = (mod.type === 'band' || mod.type === 'onset') && !analysisFor(song);
  return (
    <div className={`mod-card ${mod.enabled ? '' : 'off'}`}>
      <div className="mod-head">
        <Toggle value={mod.enabled} onChange={(v) => patch({ enabled: v })} title="Enable" />
        <span className="mod-name">{MOD_LABEL[mod.type]}</span>
        <span className="spacer" />
        <Select value={mod.blend} options={[{ value: 'add', label: 'Add' }, { value: 'multiply', label: 'Multiply' }, { value: 'replace', label: 'Replace' }]} onChange={(v) => patch({ blend: v })} title="How this modulator combines with the value" />
        <button className="mini" title="Remove modulator" onClick={() => removeModulator(clip.id, def.id, mod.id)}>×</button>
      </div>
      <Spark mod={mod} song={song} sec={sec} />
      {noAudio && <div className="hint warn">Import the song's audio to drive this.</div>}
      <Row label="Depth" title={mod.blend === 'add' ? 'In the parameter’s own units' : '0–1 mix'}>
        {mod.blend === 'add'
          ? <Num value={mod.depth} step={def.step ?? 0.01} soft={[-range, range]} unit={def.unit} onChange={(v) => patch({ depth: v })} />
          : <Num value={mod.depth} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => patch({ depth: v })} />}
      </Row>
      {mod.type === 'lfo' && (
        <>
          <Row label="Shape">
            <Select value={mod.waveform} onChange={(v) => patch({ waveform: v })} options={[
              { value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'sawUp', label: 'Saw up' }, { value: 'sawDown', label: 'Saw down' },
              { value: 'square', label: 'Square' }, { value: 'random', label: 'Random (S&H)' }, { value: 'smoothRandom', label: 'Smooth random' }]} />
          </Row>
          <Row label="Rate" title="Length of one cycle, locked to the beat grid">
            <Select value={rateOptions(bpb).some((o) => o.value === mod.rateBeats) ? mod.rateBeats : -1} onChange={(v) => { if (v > 0) patch({ rateBeats: v }); }}
              options={[...rateOptions(bpb), ...(rateOptions(bpb).some((o) => o.value === mod.rateBeats) ? [] : [{ value: -1, label: `${+mod.rateBeats.toFixed(4)} beats` }])]} />
            <button className="mini wide" title="Twice as fast" onClick={() => patch({ rateBeats: Math.max(1 / 64, mod.rateBeats / 2) })}>×2</button>
            <button className="mini wide" title="Half as fast" onClick={() => patch({ rateBeats: Math.min(1024, mod.rateBeats * 2) })}>÷2</button>
          </Row>
          <Row label="Feel">
            <div className="seg small">
              {(['straight', 'dotted', 'triplet'] as const).map((f) => <button key={f} className={mod.feel === f ? 'on' : ''} onClick={() => patch({ feel: f })}>{f === 'straight' ? 'Straight' : f === 'dotted' ? 'Dotted' : 'Triplet'}</button>)}
            </div>
          </Row>
          <Row label="Phase"><Num value={mod.phase} step={0.01} min={-1} max={1} soft={[0, 1]} onChange={(v) => patch({ phase: v })} /></Row>
          {mod.waveform === 'square' && <Row label="Pulse width"><Num value={mod.pulseWidth} step={0.01} min={0.01} max={0.99} soft={[0, 1]} onChange={(v) => patch({ pulseWidth: v })} /></Row>}
          {(mod.waveform === 'random' || mod.waveform === 'smoothRandom') && <Row label="Seed"><Num value={mod.seed} step={1} min={0} max={9999} onChange={(v) => patch({ seed: Math.round(v) })} /></Row>}
          <Row label="Bipolar" title="On: swings −1…+1 around the value. Off: 0…1 above it"><Toggle value={mod.bipolar} onChange={(v) => patch({ bipolar: v })} /></Row>
        </>
      )}
      {mod.type === 'band' && (
        <>
          <Row label="Band">
            <Select value={mod.band} onChange={(v) => patch({ band: v })} options={[{ value: 'low', label: 'Low (30–150 Hz)' }, { value: 'mid', label: 'Mid (150 Hz–2.5 k)' }, { value: 'high', label: 'High (2.5 k+)' }, { value: 'custom', label: 'Custom range' }]} />
          </Row>
          {mod.band === 'custom' && (
            <Row label="Range">
              <Num value={mod.loHz} step={1} min={30} max={16000} unit="Hz" onChange={(v) => patch({ loHz: v })} />
              <Num value={mod.hiHz} step={1} min={30} max={16000} unit="Hz" onChange={(v) => patch({ hiHz: v })} />
            </Row>
          )}
          <Row label="Gain"><Num value={mod.gain} step={0.01} min={0} max={20} soft={[0, 4]} onChange={(v) => patch({ gain: v })} /></Row>
          <Row label="Threshold"><Num value={mod.threshold} step={0.01} min={0} max={0.99} soft={[0, 1]} onChange={(v) => patch({ threshold: v })} /></Row>
          <Row label="Attack"><Num value={mod.attack} step={0.001} min={0} max={2} soft={[0, 0.3]} unit="s" onChange={(v) => patch({ attack: v })} /></Row>
          <Row label="Release"><Num value={mod.release} step={0.001} min={0} max={5} soft={[0, 1]} unit="s" onChange={(v) => patch({ release: v })} /></Row>
          <Row label="Smoothing"><Num value={mod.smoothing} step={0.001} min={0} max={2} soft={[0, 0.5]} unit="s" onChange={(v) => patch({ smoothing: v })} /></Row>
        </>
      )}
      {mod.type === 'onset' && (
        <>
          <Row label="Detector"><Select value={mod.detector} onChange={(v) => patch({ detector: v })} options={[{ value: 'kick', label: 'Kick' }, { value: 'snare', label: 'Snare' }, { value: 'other', label: 'Other (hats, highs)' }, { value: 'all', label: 'All onsets' }]} /></Row>
          <Row label="Sensitivity"><Num value={mod.sensitivity} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => patch({ sensitivity: v })} /></Row>
          <AdsrRows env={mod.env} set={(k, v) => patch((m) => { m.env[k] = v; })} />
          <Row label="Retrigger" title="On: every hit restarts the envelope. Off: hits during an envelope are ignored"><Toggle value={mod.retrigger} onChange={(v) => patch({ retrigger: v })} /></Row>
        </>
      )}
      {mod.type === 'beat' && (
        <>
          <Row label="Every">
            <Select value={rateOptions(bpb).some((o) => o.value === mod.every) ? mod.every : -1} onChange={(v) => { if (v > 0) patch({ every: v }); }}
              options={[...rateOptions(bpb), ...(rateOptions(bpb).some((o) => o.value === mod.every) ? [] : [{ value: -1, label: `${+mod.every.toFixed(4)} beats` }])]} />
            <button className="mini wide" title="Twice as often" onClick={() => patch({ every: Math.max(1 / 16, mod.every / 2) })}>×2</button>
            <button className="mini wide" title="Half as often" onClick={() => patch({ every: mod.every * 2 })}>÷2</button>
          </Row>
          <Row label="Offset"><Num value={mod.offset} step={0.125} min={-64} max={64} unit="beats" onChange={(v) => patch({ offset: v })} /></Row>
          <AdsrRows env={mod.env} set={(k, v) => patch((m) => { m.env[k] = v; })} />
          <Row label="Probability"><Num value={mod.probability} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => patch({ probability: v })} /></Row>
          {mod.probability < 1 && <Row label="Seed"><Num value={mod.seed} step={1} min={0} max={9999} onChange={(v) => patch({ seed: Math.round(v) })} /></Row>}
        </>
      )}
      {mod.type === 'section' && (
        <>
          {song.sections.length === 0 && <div className="hint">This song has no sections yet. Add them in Song settings.</div>}
          {song.sections.map((s) => (
            <Row key={s.id} label={s.name}><Num value={mod.values[s.id] ?? 0} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => patch((m) => { m.values[s.id] = v; })} /></Row>
          ))}
          <Row label="Crossfade"><Num value={mod.crossfade} step={0.25} min={0} max={64} unit="beats" onChange={(v) => patch({ crossfade: v })} /></Row>
        </>
      )}
    </div>
  );
}

function ModStack({ clip, def, song, sec }: { clip: Clip; def: ParamDef; song: Song; sec: number }) {
  const mods = clip.params[def.id]?.mods ?? [];
  return (
    <div className="mod-stack">
      {mods.map((m) => <ModCard key={m.id} clip={clip} def={def} mod={m} song={song} sec={sec} />)}
      <div className="mod-foot">
        <Menu trigger="+ Modulator" title="Add a modulator to this parameter" items={(Object.keys(MOD_LABEL) as ModType[]).map((t) => ({ label: MOD_LABEL[t], onClick: () => addModulator(clip.id, def.id, t) }))} />
        <span className="spacer" />
        <button className="btn ghost" disabled={!mods.length} onClick={() => copyModulators(clip.id, def.id)}>Copy</button>
        <button className="btn ghost" disabled={!hasModClipboard()} onClick={() => pasteModulators(clip.id, def.id)}>Paste</button>
      </div>
    </div>
  );
}

function KeyButton({ clip, ids, beat }: { clip: Clip; ids: string[]; beat: number }) {
  const keyed = ids.some((id) => clip.params[id]?.keys?.length);
  const onKey = ids.every((id) => hasKeyAt(clip, id, beat));
  return (
    <button className={`key-btn ${onKey ? 'on' : keyed ? 'keyed' : ''}`}
      title={onKey ? 'Remove keyframe at playhead (Alt-click: clear all keyframes)' : keyed ? 'Add keyframe at playhead (Alt-click: clear all keyframes)' : 'Add keyframe at playhead'}
      onClick={(e) => (e.altKey ? clearKeys(clip.id, ids) : toggleKeys(clip.id, ids))}>
      <svg viewBox="0 0 10 10" width="10" height="10"><path d="M5 0.8 9.2 5 5 9.2 0.8 5Z" /></svg>
    </button>
  );
}

function ParamRow({ clip, group, song, sec, beat }: { clip: Clip; group: ParamGroup; song: Song; sec: number; beat: number }) {
  const [openMod, setOpenMod] = useState<string | null>(null);
  const ctx = modCtx(song, sec);
  const ids = group.defs.map((d) => d.id);
  const vals = group.defs.map((d) => staticValue(clip, d.id, beat));
  const modCount = group.defs.reduce((n, d) => n + (clip.params[d.id]?.mods?.length ?? 0), 0);
  const modDef = group.defs.find((d) => d.id === openMod) ?? null;
  const canMod = group.defs.some((d) => d.mod);
  const d0 = group.defs[0];
  let body: ReactNode;
  if (group.widget === 'color') {
    body = <ColorField rgb={vals as [number, number, number]} onChange={(c) => setParams(clip.id, { [ids[0]]: c[0], [ids[1]]: c[1], [ids[2]]: c[2] }, group.id)} />;
  } else if (group.widget === 'vec3') {
    body = group.defs.map((d, i) => (
      <Num key={d.id} label={'XYZ'[i]} className={`axis-${'xyz'[i]}`} value={vals[i]} step={d.step} min={d.min} max={d.max}
        onChange={(v) => setParams(clip.id, { [d.id]: v }, d.id)} />
    ));
  } else if (d0.type === 'bool') {
    body = <Toggle value={vals[0] > 0.5} onChange={(v) => setParams(clip.id, { [d0.id]: v ? 1 : 0 })} />;
  } else if (d0.type === 'enum') {
    body = <Select value={Math.round(vals[0])} options={d0.options!.map((label, value) => ({ value, label }))} onChange={(v) => setParams(clip.id, { [d0.id]: v })} />;
  } else {
    const hasMods = !!clip.params[d0.id]?.mods?.length;
    body = <Num value={vals[0]} step={d0.step} min={d0.min} max={d0.max} soft={[d0.softMin ?? d0.min, d0.softMax ?? d0.max]} unit={d0.unit}
      live={hasMods ? evalParam(d0, clip.params[d0.id], clip.start, ctx) : undefined} onChange={(v) => setParams(clip.id, { [d0.id]: v }, d0.id)} />;
  }
  const pickable = group.widget === 'vec3' && ['pos', 'target', 'origin'].includes(group.id);
  return (
    <>
      <Row label={group.label} actions={
        <>
          {pickable && <button className="mini" title="Click a point in the viewport to place this there" onClick={async () => {
            const p = await pickPoint();
            if (p) setParams(clip.id, { [ids[0]]: p[0], [ids[1]]: p[1], [ids[2]]: p[2] });
          }}>⌖</button>}
          {canMod && <button className={`mini mod-btn ${modCount ? 'has' : ''} ${openMod ? 'on' : ''}`} title="Modulators: LFO, audio, triggers" onClick={() => setOpenMod(openMod ? null : group.defs.find((d) => d.mod)!.id)}>∿{modCount ? <sup>{modCount}</sup> : null}</button>}
          <KeyButton clip={clip} ids={ids} beat={beat} />
        </>
      }>{body}</Row>
      {modDef && (
        <div className="mod-wrap">
          {group.defs.length > 1 && (
            <div className="seg small comp">
              {group.defs.map((d, i) => <button key={d.id} className={d.id === openMod ? 'on' : ''} onClick={() => setOpenMod(d.id)}>{(group.widget === 'color' ? 'RGB' : 'XYZ')[i]}{clip.params[d.id]?.mods?.length ? ' •' : ''}</button>)}
            </div>
          )}
          <ModStack clip={clip} def={modDef} song={song} sec={sec} />
        </div>
      )}
    </>
  );
}

function EaseEditor({ k, onChange }: { k: Keyframe; onChange: (e: [number, number, number, number]) => void }) {
  const e = k.ease ?? EASE_PRESETS['Ease in-out'];
  const ref = useRef<SVGSVGElement>(null);
  const S = 120, P = 14;
  const X = (x: number) => P + x * (S - 2 * P), Y = (y: number) => S - P - y * (S - 2 * P);
  let path = '';
  for (let i = 0; i <= 40; i++) path += `${i ? 'L' : 'M'}${X(i / 40).toFixed(1)} ${Y(cubicBezier(e, i / 40)).toFixed(1)}`;
  const dragPt = (idx: 0 | 1) => (ev: React.PointerEvent) => {
    const svg = ref.current!;
    (ev.target as Element).setPointerCapture(ev.pointerId);
    const move = (m: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, ((m.clientX - r.left) / r.width * S - P) / (S - 2 * P)));
      const y = Math.min(2, Math.max(-1, (S - P - (m.clientY - r.top) / r.height * S) / (S - 2 * P)));
      const n = [...e] as [number, number, number, number];
      n[idx * 2] = Math.round(x * 100) / 100; n[idx * 2 + 1] = Math.round(y * 100) / 100;
      onChange(n);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); commit(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <div className="ease">
      <svg ref={ref} viewBox={`0 0 ${S} ${S}`} width={S} height={S}>
        <rect x={P} y={P} width={S - 2 * P} height={S - 2 * P} className="ease-box" />
        <line x1={X(0)} y1={Y(0)} x2={X(e[0])} y2={Y(e[1])} className="ease-arm" />
        <line x1={X(1)} y1={Y(1)} x2={X(e[2])} y2={Y(e[3])} className="ease-arm" />
        <path d={path} className="ease-curve" />
        <circle cx={X(e[0])} cy={Y(e[1])} r="5" className="ease-pt" onPointerDown={dragPt(0)} />
        <circle cx={X(e[2])} cy={Y(e[3])} r="5" className="ease-pt" onPointerDown={dragPt(1)} />
      </svg>
      <div className="ease-side">
        <Select value={Object.entries(EASE_PRESETS).find(([, v]) => v.every((x, i) => Math.abs(x - e[i]) < 0.005))?.[0] ?? 'Custom'}
          options={[...Object.keys(EASE_PRESETS), 'Custom'].map((n) => ({ value: n, label: n }))} onChange={(n) => { if (EASE_PRESETS[n]) onChange(EASE_PRESETS[n]); }} />
        <div className="ease-nums">
          {e.map((v, i) => <Num key={i} value={v} step={0.01} min={i % 2 ? -1 : 0} max={i % 2 ? 2 : 1} onChange={(x) => { const n = [...e] as [number, number, number, number]; n[i] = x; onChange(n); }} />)}
        </div>
      </div>
    </div>
  );
}

function KeyEditor({ clip, song }: { clip: Clip; song: Song }) {
  const refs = useStore((s) => s.ui.selectedKeys);
  const found = refs.map((r) => ({ r, k: clip.params[r.param]?.keys?.find((k) => k.id === r.keyId), def: KINDS[clip.kind].params.find((p) => p.id === r.param) })).filter((x) => x.k && x.def);
  if (!found.length) return null;
  const k = found[0].k!, def = found[0].def!;
  const single = found.length === 1;
  const sameInterp = found.every((x) => x.k!.interp === k.interp);
  return (
    <Section title={single ? `Keyframe · ${def.label}` : `${found.length} keyframes`}>
      {single && (
        <>
          <Row label="Time"><BBT tempo={song.tempo} beat={clip.start + k.t} onChange={(b) => editKeys(clip.id, refs, { t: b - clip.start })} /></Row>
          <Row label="Value"><Num value={k.v} step={def.step} min={def.min} max={def.max} unit={def.unit} onChange={(v) => editKeys(clip.id, refs, { v })} /></Row>
        </>
      )}
      <Row label="To next key" title="Shape of the segment after this keyframe">
        <div className="seg small">
          {(['hold', 'linear', 'bezier'] as const).map((m) => <button key={m} className={sameInterp && k.interp === m ? 'on' : ''} onClick={() => editKeys(clip.id, refs, { interp: m })}>{m === 'hold' ? 'Hold' : m === 'linear' ? 'Linear' : 'Curve'}</button>)}
        </div>
      </Row>
      {k.interp === 'bezier' && <EaseEditor k={k} onChange={(ease) => editKeys(clip.id, refs, { ease })} />}
    </Section>
  );
}

function ClipInspector({ clip, isBase, song }: { clip: Clip; isBase: boolean; song: Song }) {
  const sec = usePlayhead();
  const beat = secToBeat(song.tempo, sec);
  const kind = KINDS[clip.kind];
  const groups = paramGroups(clip.kind);
  const sections = [...new Set(groups.map((g) => g.section))];
  return (
    <div className="inspector-scroll">
      <div className={`insp-head track-${kind.track}`}>
        <span className="kind-chip">{kind.label}</span>
        {isBase ? <span className="insp-title">Base layer</span> : <Text className="insp-name" value={clip.name} onChange={(name) => patchClip(clip.id, { name })} />}
        {!isBase && (
          <Menu trigger="⋯" title="Clip actions" items={[
            { label: 'Duplicate', onClick: () => duplicateClip(clip.id) },
            { label: clip.muted ? 'Unmute' : 'Mute', onClick: () => patchClip(clip.id, { muted: !clip.muted }) },
            'sep', { label: 'Delete clip', danger: true, onClick: () => deleteClip(clip.id) },
          ]} />
        )}
      </div>
      {isBase ? (
        <div className="hint pad">Always on for the whole song. Clips on the {kind.track} track override it while they play, crossfading with their fades.</div>
      ) : (
        <Section title="Clip">
          <Row label="Start"><BBT tempo={song.tempo} beat={clip.start} onChange={(b) => patchClip(clip.id, { start: b })} /></Row>
          <Row label="Length"><BBT tempo={song.tempo} beat={clip.length} length onChange={(b) => patchClip(clip.id, { length: b })} /></Row>
          <Row label="Fade in"><Num value={clip.fadeIn} step={0.25} min={0} max={clip.length} soft={[0, clip.length]} unit="beats" onChange={(v) => patchClip(clip.id, { fadeIn: v }, 'fi')} /></Row>
          <Row label="Fade out"><Num value={clip.fadeOut} step={0.25} min={0} max={clip.length} soft={[0, clip.length]} unit="beats" onChange={(v) => patchClip(clip.id, { fadeOut: v }, 'fo')} /></Row>
          {kind.hasTargets && (
            <Row label="Applies to" title="Which splats this animator moves. None ticked = all">
              <div className="chips">
                {song.scene.splats.length === 0 && <span className="hint">No splats in the scene</span>}
                {song.scene.splats.map((s) => {
                  const on = clip.targets?.includes(s.id) ?? false;
                  return <button key={s.id} className={`chip ${on ? 'on' : ''}`} onClick={() => patchClip(clip.id, { targets: on ? clip.targets!.filter((x) => x !== s.id) : [...(clip.targets ?? []), s.id] })}>{s.name}</button>;
                })}
                {!clip.targets?.length && song.scene.splats.length > 0 && <span className="hint">all</span>}
              </div>
            </Row>
          )}
        </Section>
      )}
      <KeyEditor clip={clip} song={song} />
      {sections.map((sn) => (
        <Section key={sn} title={sn || 'Parameters'}>
          {groups.filter((g) => g.section === sn).map((g) => <ParamRow key={g.id} clip={clip} group={g} song={song} sec={sec} beat={beat} />)}
        </Section>
      ))}
    </div>
  );
}

function Vec3Row({ label, value, onChange, step = 0.01, unit, title }: { label: string; value: [number, number, number]; onChange: (v: [number, number, number]) => void; step?: number; unit?: string; title?: string }) {
  return (
    <Row label={label} title={title}>
      {[0, 1, 2].map((i) => <Num key={i} label={'XYZ'[i]} className={`axis-${'xyz'[i]}`} value={value[i]} step={step} title={unit ? `${label} ${'XYZ'[i]} (${unit})` : undefined} onChange={(v) => { const n = [...value] as [number, number, number]; n[i] = v; onChange(n); }} />)}
    </Row>
  );
}

function SplatInspector({ inst }: { inst: SplatInstance }) {
  const show = useStore((s) => s.show);
  useStore((s) => s.assetGen);
  const asset = show.assets.find((a) => a.id === inst.assetId);
  const data = splatFor(show, inst.assetId, inst.version);
  const p = (patch: Partial<SplatInstance>, merge?: string) => patchSplat(inst.id, patch, merge);
  return (
    <div className="inspector-scroll">
      <div className="insp-head track-splat">
        <span className="kind-chip">Splat</span>
        <Text className="insp-name" value={inst.name} onChange={(name) => p({ name })} />
        <Menu trigger="⋯" title="Splat actions" items={[{ label: 'Remove from scene', danger: true, onClick: () => removeSplat(inst.id) }]} />
      </div>
      <Section title="Source">
        <Row label="Asset"><span className="value-text">{asset?.name ?? 'Missing asset'}</span></Row>
        <Row label="Version" title="A newer clean from Edit can replace the old one; lights and cameras stay in place">
          <Select value={inst.version ?? ''} options={[{ value: '', label: `Latest (${asset ? latestVersion(asset).label : '–'})` }, ...(asset?.versions ?? []).map((v) => ({ value: v.id, label: v.label }))]} onChange={(v) => p({ version: v || undefined })} />
        </Row>
        <Row label="Gaussians"><span className="value-text mono">{data ? data.count.toLocaleString() : 'loading…'}</span></Row>
        <Row label="Visible"><Toggle value={inst.visible} onChange={(v) => p({ visible: v })} /></Row>
      </Section>
      <Section title="Transform">
        <Vec3Row label="Position" value={inst.pos} unit="m" onChange={(v) => p({ pos: v }, 'pos')} />
        <Vec3Row label="Rotation" value={inst.rot} step={0.1} unit="°" onChange={(v) => p({ rot: v }, 'rot')} />
        <Row label="Scale"><Num value={inst.scale} step={0.001} min={0.001} max={1000} soft={[0, 4]} onChange={(v) => p({ scale: v }, 'scale')} /></Row>
        <Row label=""><button className="btn" title="Scans from COLMAP-style tools are Y-down; this turns them the right way up" onClick={() => p({ rot: [inst.rot[0], inst.rot[1], (inst.rot[2] + 180) % 360] })}>Flip upright</button></Row>
      </Section>
      <Section title="Relighting">
        <Row label="De-light" title="Divides out the scan's low-frequency baked brightness to get a flatter albedo"><Num value={inst.deLight} step={0.01} min={0} max={1.5} soft={[0, 1]} onChange={(v) => p({ deLight: v }, 'dl')} /></Row>
        <Row label="Baked colour" title="Surface colour from 0 = de-lit to 1 = the scan's original colours (with its baked shading). Either way only the virtual lights show it, so with no light the splat stays black."><Num value={inst.bakedMix} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => p({ bakedMix: v }, 'bm')} /></Row>
        <Row label="Opacity"><Num value={inst.opacity} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => p({ opacity: v }, 'op')} /></Row>
        <Row label="Normals" title="Which way surfaces face. 'Face viewer' is the safe default for scans without camera poses">
          <Select value={inst.normalMode} options={[{ value: 'view', label: 'Face viewer' }, { value: 'outward', label: 'Outward (objects)' }, { value: 'inward', label: 'Inward (rooms)' }]} onChange={(v) => p({ normalMode: v })} />
        </Row>
        <Row label="Normal strength" title="Lower this if shading looks blotchy; lean on shadows and colour instead"><Num value={inst.normalStrength} step={0.01} min={0} max={1} soft={[0, 1]} onChange={(v) => p({ normalStrength: v }, 'ns')} /></Row>
      </Section>
      <Section title="Crop box" right={<Toggle value={inst.crop} onChange={(v) => p({ crop: v })} />}>
        <Vec3Row label="Min" value={inst.cropMin} unit="m" onChange={(v) => p({ cropMin: v, crop: true }, 'cmin')} />
        <Vec3Row label="Max" value={inst.cropMax} unit="m" onChange={(v) => p({ cropMax: v, crop: true }, 'cmax')} />
        <Row label=""><button className="btn" disabled={!data} onClick={() => data && p({ cropMin: [...data.boundsMin], cropMax: [...data.boundsMax], crop: true })}>Fit to scan</button></Row>
        <div className="hint pad">In the scan's own coordinates, so it follows the splat when you move it.</div>
      </Section>
    </div>
  );
}

function TapTempo() {
  const taps = useRef<number[]>([]);
  return (
    <button className="btn" title="Tap in time with the click" onClick={() => {
      const now = performance.now();
      const t = taps.current.filter((x) => now - x < 2500);
      t.push(now);
      taps.current = t;
      if (t.length >= 4) {
        const bpm = 60000 / ((t[t.length - 1] - t[0]) / (t.length - 1));
        patchSong((s) => { s.tempo.bpm = Math.round(bpm * 10) / 10; }, 'tap');
      }
    }}>Tap</button>
  );
}

const RES_PRESETS: [string, number, number][] = [['1920×1080', 1920, 1080], ['3840×2160', 3840, 2160], ['1280×720', 1280, 720], ['2560×1080', 2560, 1080], ['3840×1080', 3840, 1080], ['1080×1920', 1080, 1920]];

function SongInspector({ song }: { song: Song }) {
  const show = useStore((s) => s.show);
  useStore((s) => s.assetGen);
  const audio = show.assets.find((a) => a.id === song.audioAssetId);
  const an = analysisFor(song);
  const fileRef = useRef<HTMLInputElement>(null);
  const tm = song.tempo;
  const out = show.output;
  return (
    <div className="inspector-scroll">
      <div className="insp-head track-song">
        <span className="kind-chip">Song</span>
        <Text className="insp-name" value={song.title} onChange={(title) => patchSong((s) => { s.title = title; })} />
      </div>
      <Section title="Audio">
        <Row label="File">
          <span className="value-text" title={audio?.name}>{audio?.name ?? 'No audio'}</span>
          <button className="btn" onClick={() => fileRef.current?.click()}>{audio ? 'Replace…' : 'Import…'}</button>
          <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.m4a" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importAudioFile(f); e.target.value = ''; }} />
        </Row>
        {an && <div className="hint pad">Analysed: {an.bpm} BPM, {an.onsets.kick.times.length} kicks, {an.onsets.snare.times.length} snares, {(an.duration / 60) | 0}:{String(Math.round(an.duration % 60)).padStart(2, '0')} long.{' '}
          <button className="link" onClick={() => patchSong((s) => { s.tempo.bpm = an.bpm; s.tempo.firstDownbeatSec = an.firstDownbeatSec; })}>Use detected grid</button></div>}
      </Section>
      <Section title="Tempo and grid">
        <Row label="BPM" title="Changing the BPM moves every clip and keyframe with it">
          <Num value={tm.bpm} step={0.01} min={20} max={400} onChange={(v) => patchSong((s) => { s.tempo.bpm = v; }, 'bpm')} />
          <button className="mini wide" onClick={() => patchSong((s) => { s.tempo.bpm = Math.min(400, s.tempo.bpm * 2); })}>×2</button>
          <button className="mini wide" onClick={() => patchSong((s) => { s.tempo.bpm = Math.max(20, s.tempo.bpm / 2); })}>÷2</button>
          <TapTempo />
        </Row>
        <Row label="Time signature">
          <Num value={tm.beatsPerBar} step={1} min={1} max={16} onChange={(v) => patchSong((s) => { s.tempo.beatsPerBar = Math.round(v); }, 'ts')} />
          <span className="slash">/</span>
          <Select value={tm.beatUnit} options={[2, 4, 8, 16].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => patchSong((s) => { s.tempo.beatUnit = v; })} />
        </Row>
        <Row label="First downbeat" title="Where bar 1 starts in the audio file">
          <Num value={tm.firstDownbeatSec} step={0.001} min={-60} max={600} unit="s" onChange={(v) => patchSong((s) => { s.tempo.firstDownbeatSec = v; }, 'fd')} />
          <button className="mini wide" title="Nudge grid one beat earlier" onClick={() => patchSong((s) => { s.tempo.firstDownbeatSec -= 60 / s.tempo.bpm; })}>−1</button>
          <button className="mini wide" title="Nudge grid one beat later" onClick={() => patchSong((s) => { s.tempo.firstDownbeatSec += 60 / s.tempo.bpm; })}>+1</button>
          <button className="btn" title="Put bar 1 at the playhead" onClick={() => patchSong((s) => { s.tempo.firstDownbeatSec = Math.round(transport.sec * 1000) / 1000; })}>Set here</button>
        </Row>
        <Row label="Length"><Num value={song.lengthBeats / tm.beatsPerBar} step={1} min={1} max={2000} unit="bars" onChange={(v) => setSongLength(v * tm.beatsPerBar)} /></Row>
        <Row label="Start timecode" title="The timecode the click rig sends at the top of this song (hh:mm:ss:ff)">
          <Text className="mono" value={song.startTimecode} onChange={(v) => { if (/^\d{1,2}:\d{1,2}:\d{1,2}:\d{1,2}$/.test(v.trim())) patchSong((s) => { s.startTimecode = v.trim(); }); }} />
        </Row>
      </Section>
      <Section title="Sections" right={<button className="mini wide" title="Add a section at the playhead" onClick={() => addSection(secToBeat(tm, transport.sec))}>+</button>}>
        {song.sections.length === 0 && <div className="hint pad">Mark verse, chorus and so on. The Section modulator can then set a value per section.</div>}
        {song.sections.map((sc) => (
          <Row key={sc.id} label={<Text value={sc.name} onChange={(name) => patchSong((s) => { s.sections.find((x) => x.id === sc.id)!.name = name; })} />}
            actions={<button className="mini" title="Remove section" onClick={() => patchSong((s) => { s.sections = s.sections.filter((x) => x.id !== sc.id); })}>×</button>}>
            <BBT tempo={tm} beat={sc.start} onChange={(b) => patchSong((s) => { s.sections.find((x) => x.id === sc.id)!.start = Math.max(0, b); s.sections.sort((a, c) => a.start - c.start); })} />
          </Row>
        ))}
      </Section>
      <Section title="Base layer">
        <div className="hint pad">The always-on camera, global light and grade under this song's clips.</div>
        <div className="btn-row pad">
          {(['camera', 'global', 'post'] as const).map((k) => <button key={k} className="btn" onClick={() => select({ type: 'clip', id: song.scene.base[k].id })}>{KINDS[k].label}</button>)}
        </div>
      </Section>
      <Section title="Shadows">
        <Row label="Shadow lights" title="Cap on shadow-casting lights for this song. More lights still light the scene, without shadows">
          <Num value={song.scene.maxShadowLights} step={1} min={0} max={12} onChange={(v) => patchSong((s) => { s.scene.maxShadowLights = Math.round(v); }, 'msl')} />
        </Row>
        <Row label="Map size"><Select value={song.scene.shadowResolution} options={[512, 1024, 2048, 4096].map((v) => ({ value: v, label: `${v} px` }))} onChange={(v) => patchSong((s) => { s.scene.shadowResolution = v; })} /></Row>
      </Section>
      <Section title="Show output">
        <Row label="Resolution">
          <Select value={RES_PRESETS.find((r) => r[1] === out.width && r[2] === out.height)?.[0] ?? 'Custom'} options={[...RES_PRESETS.map((r) => ({ value: r[0], label: r[0] })), { value: 'Custom', label: 'Custom' }]}
            onChange={(v) => { const r = RES_PRESETS.find((x) => x[0] === v); if (r) update((s) => { s.output.width = r[1]; s.output.height = r[2]; }); }} />
        </Row>
        <Row label="Size">
          <Num value={out.width} step={2} min={64} max={8192} unit="px" onChange={(v) => update((s) => { s.output.width = Math.round(v / 2) * 2; }, 'ow')} />
          <Num value={out.height} step={2} min={64} max={8192} unit="px" onChange={(v) => update((s) => { s.output.height = Math.round(v / 2) * 2; }, 'oh')} />
        </Row>
        <Row label="Timecode rate"><Select value={out.timecodeFps} options={[24, 25, 30].map((v) => ({ value: v, label: `${v} fps` }))} onChange={(v) => update((s) => { s.output.timecodeFps = v; })} /></Row>
      </Section>
    </div>
  );
}

export function Inspector() {
  const song = useSong();
  const sel = useStore((s) => s.ui.selection);
  if (sel.type === 'clip') {
    const f = findClip(song, sel.id);
    if (f) return <ClipInspector key={f.clip.id} clip={f.clip} isBase={!f.track} song={song} />;
  }
  if (sel.type === 'splat') {
    const inst = song.scene.splats.find((s) => s.id === sel.id);
    if (inst) return <SplatInspector key={inst.id} inst={inst} />;
  }
  return <SongInspector song={song} />;
}

