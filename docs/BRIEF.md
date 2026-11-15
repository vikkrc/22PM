# 22PM — Brief & Build Guide

Nov 14, 2026 · @Viktor Krč

## 1. Purpose and principles

22PM is a bespoke Mac app for building and playing the LED visuals of jóvilágvan's Délután 10 tour. Each song's world is one or more gaussian splats (scanned locations, collages and close-ups of objects). They stay almost still, with minimal keyframed camera moves. The performers are virtual lights that relight the splats and cast shadows, animated by hand or locked to the music.

It has three tabs over one shared project: **Train** (make splats from video), **Edit** (clean them up) and **Animate** (light, animate, play and render). Animate is the bespoke core. Train and Edit wrap proven open tools.

The band plays to a click, so every song's visuals are a deterministic timeline locked to the song's timecode. The same timeline either plays live or renders to video.

Design principles:

1. **Lights are the performers, splats are the set.** Splat animation stays subtle and serves the lights.
2. **Readable without explanation.** It must sit next to the stage concept (hanging empty frames, horizon line) without needing a story to decode.
3. **Deterministic.** A frame is a pure function of project + time. Live playback and the rendered video match frame for frame.
4. **Art-directed over physically correct.** Relighting has to look good; it does not have to be accurate.
5. **Show-safe.** No unintended black frames, no crashes. There is always a fallback.

## 2. Scope

The MVP is everything needed to build one song end to end, play it in sync and render it.

| Area | MVP | Later | Out of scope |
| --- | --- | --- | --- |
| Splats | Load .ply/.spz, several per scene with transforms, crop box | In-app creation from video (Vauss, section 3b), streaming LOD | Writing our own trainer |
| Explore / camera | Orbit + fly explore, camera mode, keyframed camera with easing | Camera shake / handheld modulator, dolly-zoom | Physical camera sim |
| Lights | Point, spot, sun, area, global; colour, intensity, transform, size; shadows | Light rigs (arrays with spread/phase), gobos, volumetric shafts | Full GI / path tracing |
| Splat animators | Disperse, wobble, depth sweep, depth cut-off | Masks per region, dissolve/reveal, scale pulse | Physics |
| Timeline | Tracks, clips with length, keyframes, snapping to beat grid, undo/redo | Clip presets library, copy between songs | Collaborative editing |
| Modulation | LFOs, beat sync with ×2/÷2, audio band envelopes, onset triggers | Custom curve LFOs, macros | Scripting language |
| Audio | Import, offline BPM/beat/onset/band analysis, manual BPM and grid override | Section auto-detection | Stem separation |
| Show | Setlist, timecode chase, fullscreen output, blackout/freeze | Fallback video per song, OSC/MIDI control | Multi-machine sync |
| Render | ProRes/H.264/PNG sequence, resolution and fps presets, quality settings | Batch render whole set, EXR | Cloud rendering |

## 2b. App structure: Train, Edit, Animate

Feasible. Train runs Vauss as a separate process, Edit embeds a fork of SuperSplat, and Animate is built from scratch. All three share one project folder and one asset library.

| Tab | What it does | Built from | Effort |
| --- | --- | --- | --- |
| Train | Video (or photos) → splat + camera poses + mesh proxy | [Vauss](https://github.com/voyager-so/vauss) CLI as a subprocess; COLMAP + Brush for photos (section 3b) | Low–medium: a job UI around an existing tool |
| Edit | Remove floaters, crop, delete, recolour, compress | Pinned fork of [SuperSplat](https://github.com/playcanvas/supersplat) in an embedded web view (section 3c) | Medium: mostly the bridge to 22PM |
| Animate | Scene, lights, splat animators, timeline, modulation, show mode, render | Bespoke (sections 4–10) | High: this is the product |

### How the tabs work together

- **One asset library**, docked in all three tabs. Each splat asset has versions: `raw` (from Train) → `clean v1, v2…` (from Edit) → `prepared` (normals, de-light and LOD caches for Animate).
- **Hand-off actions** on any asset: Train → "Clean in Edit", Edit → "Save to 22PM", any → "Use in Animate". A scene in Animate points to an asset *and* a version, so it can be updated to a newer clean.
- **Edit is non-destructive** towards Animate. Saving from Edit creates a new version; Animate asks to update, then re-runs preprocessing in the background.
- **Coordinates stay stable.** Edit only removes or recolours Gaussians. It never moves the whole splat; placement, scale and rotation in the scene happen in Animate. That way lights and cameras don't drift when a cleaned version replaces the old one.
- **One job queue** visible in every tab: training, exports, preprocessing. All jobs pause in show mode.
- **Masks from Edit:** a selection made in Edit can be saved as a named region that Animate's splat animators can target (later).

## 3. Splat capture pipeline (free, on the M4 Max Mac)

The best free route on a Mac is: photos or video → COLMAP alignment → Brush training → SuperSplat cleanup → .ply into the app. CorbeauSplat wraps the first three steps in one Mac app.

| Step | Tool | Why | Licence / cost |
| --- | --- | --- | --- |
| Quick test scans | [Scaniverse](https://medium.com/@Jamesroha/gaussian-splatting-a-complete-student-guide-to-3d-capture-in-2026-1195a6265870) (phone) | Trains on the phone in about a minute, exports PLY. Good for scouting locations | Free |
| Camera alignment | COLMAP / GLOMAP | The standard way to solve camera poses from photos; runs on Mac | Free, open source |
| Training | [Brush](https://radiancefields.com/platforms/brush) | Native trainer that runs on macOS (no NVIDIA needed) | Free, Apache 2.0 |
| All-in-one wrapper | [CorbeauSplat](https://radiancefields.com/platforms/corbeausplat) | Mac app that drives COLMAP, Brush and SuperSplat from one interface | Free, MIT |
| Cleanup and crop | [SuperSplat](https://www.thefuture3d.com/software/supersplat/) | Browser editor: remove floaters, crop, compress | Free, MIT |
| Not for this Mac | [LichtFeld Studio](https://radiancefields.com/platforms/lichtfeld-studio) (NVIDIA, no macOS build), [Postshot](https://radiancefields.com/best-gaussian-splatting-editors) (Windows, .ply export paid) | — | — |

### Capture rules for relighting

The lighting in a scan is baked in and cannot be fully removed, so capture for relighting from day one:

- **Flat, even light.** Overcast days, shade or big soft boxes. No hard sun shadows or strong specular highlights.
- **Lock exposure, white balance and focus** for the whole capture. Shoot RAW or a flat profile if you can.
- **Coverage and sharpness.** 70–80% overlap, several heights, no motion blur. 150–400 photos per location is a good target.
- **Close-ups of objects.** Walk around the object rather than spinning it on a turntable. Use a matte, neutral background so it crops cleanly.
- **Collages.** Scan the pieces separately and assemble them in the app (several splats per scene with transforms), not in the trainer.
- **Keep the raw photos.** You can retrain later as the tools improve.

The app takes .ply (and .spz) as master files and converts them to its own cached format on import.

## 3b. Train tab: in-app splat creation with Vauss

22PM can make splats itself by running [Vauss](https://github.com/voyager-so/vauss) as a separate process, without merging its code. Vauss is a Rust command-line tool built on Brush. It takes a video, picks frames, solves the cameras, trains and exports, so phone or camera video goes straight to a lit scene inside 22PM.

### Why it fits

- **Video in, no separate COLMAP step:** Vauss solves the camera positions itself.
- **Runs on this Mac:** it has a macOS arm64 install and trains on Metal (no CUDA).
- **Fast:** about 3–6 minutes of training per scene on one GPU, plus time for frame prep, camera solving and export.
- **Useful outputs:** `scene.spz` + `scene.json`, a full splat PLY and a **textured mesh** (in the Blender pack), and camera orbits.
- **Agent-friendly:** it has an MCP server (`vauss serve`) and drivers for Claude Code.

### Caveats and how 22PM handles them

| Caveat | Handling |
| --- | --- |
| Source-available Preview License: free during the research preview (commercial use included), but it limits modified distribution and hosted services | Never fork or modify it. 22PM calls the unmodified `vauss` binary that Viktor installs separately. The solver stays swappable |
| Mac is barely tested: Apple M4 has only a smoke test, and performance numbers are NVIDIA-only | Benchmark 2–3 real captures on the M4 Max during M0 |
| Video input only | Photo captures go through the second backend (COLMAP + Brush) |
| Research preview (0.1.21-rc) | Pin the version and record it in every asset's recipe |
| Quality drops away from captured views (unseen surfaces, mirrors, thin parts) | Capture rules above, plus camera moves that stay near the captured path |

### Integration design

1. **Capture panel:** drop video(s), pick a preset (quick preview / show quality), set the splat cap and an optional crop region.
2. **Job runner:** spawns `vauss` as a subprocess with a job folder in the project cache. It shows progress, supports cancel and retry, and runs one job at a time. Jobs are disabled in show mode.
3. **Import:** the `.spz` becomes a splat asset. Solved camera poses feed normal orientation (section 4). The textured mesh becomes a **shadow and normal proxy**: cleaner normals and cheaper, crisper shadow maps than splat-only shadows. This is a real win for relighting.
4. **Recipe:** store the source video hash, Vauss version and settings with each asset, so any scan can be retrained later.
5. **Solver interface:** `SplatSolver` with two backends: Vauss (video) and COLMAP + Brush (photos). Brush is Apache 2.0, so it can be embedded directly if the Vauss licence becomes a problem.

Note for Claude Code: take the exact commands and flags from the Vauss README and `vauss --help`. Never guess them.

## 3c. Edit tab: SuperSplat inside 22PM

Feasible and low-risk on licensing. [SuperSplat](https://github.com/playcanvas/supersplat) is MIT-licensed TypeScript on the PlayCanvas engine (WebGL / WebGPU), so 22PM can ship a modified fork. It already has rect, brush and picker selection, compression on export and undo ([overview](https://radiancefields.com/best-gaussian-splatting-editors)).

### Integration design

1. **Pinned fork** in its own folder (`vendor/supersplat`), built with its normal `npm install` / build and bundled as local static files. No network needed at the show.
2. **Embedded web view** in the Edit tab (WKWebView in a native app, or the shell's own web view under Option B).
3. **Bridge module** added to the fork, as small as possible:
   - *Open from 22PM:* the host passes an asset version (file path or local URL) and the editor loads it.
   - *Save to 22PM:* replaces publish/download with a button that hands the edited PLY back to the host, which stores it as a new version.
   - *Selection → region:* exports the current selection as a named mask (later).
   - Hide or remove publishing, sign-in and cloud features.
4. **Automation:** SuperSplat exposes WebMCP tools for scene inspection, selection, editing, camera control and import/export (`docs/webmcp.md`). The bridge can reuse that contract instead of reaching into internals, and Claude Code can use it in tests.
5. **Format work** (conversion, compression) uses PlayCanvas's SplatTransform CLI as a subprocess, the same pattern as Vauss.

### Caveats

| Caveat | Handling |
| --- | --- |
| Edit shows baked colours, not 22PM's relighting (a different renderer) | Expected: Edit is for cleanup. A "preview in Animate" button opens the asset there |
| Upstream changes often (about 790 commits, active issues) | Pin a commit and keep bridge changes in a few files, so rebasing stays cheap |
| WebGPU in WKWebView may vary by macOS version | Force SuperSplat's WebGL path inside the embedded view if needed; verify in M1c |
| Very large splats in a web view (memory) | Edit at a capped count, or crop in Train first; test with the biggest real scan |
| Edits that move the whole splat would shift lights and cameras in Animate | Disable whole-splat transform in the fork, or store it separately as an offset |

## 4. Rendering and relighting architecture

Splats are rendered as layers (deferred) and lit like a game engine. Shadows come from splatting the scene from each light's point of view, the same trick [GS3](https://radiancefields.com/papers/gs3-efficient-relighting-with-triple-gaussian-splatting) uses for self-shadowing.

### Import-time preprocessing (cached per splat)

1. **Normals:** take each Gaussian's shortest covariance axis, orient it towards the capture cameras, then smooth it against its neighbours.
2. **De-lighting:** estimate a flatter albedo by dividing out low-frequency luminance. Strength is adjustable per splat.
3. **Compression + LOD:** quantise attributes, build a spatial hierarchy for culling and LOD.

### Per-frame passes

1. **Animator pass (compute):** apply splat animators to position, scale and opacity.
2. **Sort:** GPU radix sort by view depth.
3. **G-buffer splat pass:** albedo, normal, depth, opacity and the original baked colour.
4. **Shadow passes:** splat depth (opacity-weighted) from each shadow-casting light. Spot = 1 map, sun = 1 orthographic map fitted to the scene, point = cube map (6 faces), area = spot approximation with softness filtering (PCSS).
5. **Lighting pass:** sum of lights × (diffuse + simple specular) × shadow, plus the global/ambient term. Then the **baked ↔ relit mix** per splat.
6. **Post:** bloom, colour grade, exposure, output scaling to the LED canvas.
7. **Later:** volumetric fog with light shafts (raymarch using the shadow maps). This adds a lot to the concert look.

### Performance targets (to verify in M0)

- 60 fps at 1920×1080 on the M4 Max, with about 3–5M Gaussians and 4 shadow-casting lights.
- Cache shadow maps for lights that don't move that frame.
- Per-song cap on shadow-casting lights; unlimited unshadowed lights.

## 5. Lights

Five light types share one set of common parameters. Every parameter can be keyframed and modulated.

**Common to all:** colour (RGB or Kelvin), intensity, enabled, cast shadows, shadow softness, specular amount, volumetric amount (later).

| Type | Extra parameters | Notes |
| --- | --- | --- |
| Point | Position, radius (size), range / falloff | Cube shadow map, the most expensive |
| Spot | Position, rotation (aim / target), cone angle, penumbra, range | Gobo texture later |
| Sun (directional) | Direction (azimuth / elevation), angular size | One orthographic shadow map fitted to the scene |
| Area | Position, rotation, width, height, shape (rect / disc) | Soft shadows approximated with PCSS |
| Global | Colour, intensity, sky/ground gradient | No shadows; sets the base darkness of the world |

**Light clips:** a light exists only for the length of its clip. Optional fade-in/out times on the clip edges.

**Gizmos:** move, rotate and scale handles in the viewport. Light cones and ranges are drawn as wireframes. "Aim at" picks a point on the splat.

**Later – light rigs:** an array of N lights (line, arc, grid, circle) with spread and per-light phase offset. This gives Resolume-style chases with one set of parameters.

## 6. Splat animators

Animators are clips on a modifier track. Each one targets one or more splats and runs on the GPU as an offset to Gaussian position, scale and opacity. All parameters can be modulated.

| Animator | What it does | Key parameters |
| --- | --- | --- |
| Disperse | Pushes Gaussians outward along a noise field or their normals, like the scene coming apart into dust | Amount, noise scale, speed, direction bias, opacity falloff |
| Wobble | Gentle positional drift / breathing | Amplitude, frequency, noise scale, axis weights |
| Depth sweep | A band moves through the scene and brightens, reveals or hides what it passes | Pattern (plane, sphere from point, radial from camera, noise), position, width, feather, effect (reveal / hide / brighten / tint) |
| Depth cut-off | Near and far clipping planes measured from the camera or a chosen origin | Near, far, feather, invert |

**Later:** region masks (box / sphere) to limit any animator, dissolve/reveal by noise, scale pulse.

The depth tools tie into the stage concept: a world can appear only inside a slab, or only where the light passes, echoing the empty frames and the horizon line.

## 7. Data model

Time is stored in musical units (bars:beats:ticks) against each song's tempo map. Changing a song's BPM or grid moves everything with it; seconds are derived.

1. **Show** (project folder: JSON + assets + caches)
   1. Output settings (resolution, fps, colour space)
   2. Asset library (splats, audio)
   3. **Setlist** → ordered list of Songs
2. **Song**: title, audio file, tempo map (BPM, time signature, first downbeat), beat grid, section markers, start timecode, length
3. **Scene** (per song): splat instances (asset + transform + crop + de-light amount + baked mix), lights, post settings
4. **Timeline** → **Tracks** by type: camera, light, modifier, global
5. **Clip**: start, length, target object, parameter set, fade in/out
6. **Parameter**: base value → keyframe curve → modulator stack (section 8)

**Parameter registry:** every animatable parameter is declared once with id, type, unit, range, default and whether it can be modulated. The inspector, timeline lanes, modulators and the file format are all generated from this registry. Nothing is hand-wired per parameter.

**Evaluation:** `evaluate(show, song, t) → FrameState` is a pure function with no hidden state. Live and render both call it, which keeps them identical.

## 8. Modulation system

Each parameter's value is base + keyframes + the sum of its modulators, then clamped to the parameter's range.

```latex
v(t) = \mathrm{clamp}\Big(b + K(t) + \sum_i d_i \, m_i(t)\Big)
```

b = base value, K(t) = keyframe curve, m\_i = modulator output (−1…1 or 0…1), d\_i = depth. Each modulator also has a blend mode (add, multiply, replace).

| Modulator | Source | Settings |
| --- | --- | --- |
| LFO | Internal clock locked to the beat grid | Waveform (sine, triangle, saw up/down, square, random S&H, smooth random), rate in beats (1/16…16 bars), ×2 / ÷2 buttons, dotted / triplet, phase, pulse width |
| Audio band | Pre-analysed band envelope | Band (low / mid / high / custom Hz range), gain, threshold, attack, release, smoothing |
| Onset trigger | Detected kicks / snares / onsets | Which detector, sensitivity, envelope (ADSR), retrigger |
| Beat trigger | Every N beats or bars | N, offset, envelope (ADSR), probability |
| Section | Song section markers | Value per section, crossfade length |

**Keyframes:** hold, linear and bezier with ease presets. Snap to beat grid; free placement with a modifier key.

**Copy and paste** of modulator stacks between parameters and clips. Presets come later.

## 9. Audio analysis and click sync

The band plays to a click, so the app follows the click rig's timecode and reads pre-analysed music curves. Nothing depends on live audio.

### Offline analysis (on import, cached)

- BPM and beat grid (beat tracking), downbeats, time signature.
- Onsets, split into kick / snare / other.
- Band energy envelopes at about 200 Hz resolution (low, mid, high + custom bands computed on demand).
- Manual override for all of it: type the BPM, tap tempo, set the first downbeat, nudge the grid, or import the exact BPM from the click session.

### Sync sources, in priority order

1. **MIDI Timecode (MTC) or LTC** from the click / backing-track rig. Each song has a start timecode, so the app knows which song and where.
2. **Ableton Link** for tempo and beat phase, if the rig runs Ableton.
3. **MIDI clock + song select / program change.**
4. **Manual:** GO button with the internal clock (rehearsal and emergencies).

**Chase behaviour:** lock within 1 frame. On timecode dropout, freewheel for N seconds, then hold the last frame (never black). Jumps in timecode trigger an instant relocate.

Live audio input stays optional, for extra reactivity on top. Rendered video never uses it.

## 10. Show mode and render to video

### Show mode (real time)

- Setlist view: current / next song, timecode readout, sync status, frame-time HUD.
- Fullscreen output on a chosen display (to the LED processor). Output resolution is independent of the UI.
- Preload the next song's splats and shadow caches while the current one plays.
- Safety keys: blackout, freeze frame, fade to global colour, skip song.
- Later: a pre-rendered fallback video per song, played in sync if a scene can't hold frame rate.

### Render to video

| Setting | Options | Default |
| --- | --- | --- |
| Resolution | Presets + custom W×H for each LED wall | 1920×1080 |
| Frame rate | 30, 60, custom | 60 (30 preset one click away) |
| Codec | ProRes 422 HQ, ProRes 4444, H.264 / HEVC preview, PNG sequence (EXR later) | ProRes 422 HQ |
| Range | Whole song, selection, whole set (batch, later) | Whole song |
| Quality | Supersampling 1–4×, motion-blur sub-frames, shadow map resolution, Gaussian LOD off | 2×, 4 sub-frames |
| Audio | Embed song audio or not | Embed |

Rendering runs the same evaluate + render path, stepped frame by frame and not tied to real time.

## 11. Tech stack (decision at gate G0)

Recommendation: do the M0 look-dev spike in WebGPU for speed, then build the real app native on Metal. The final call is made after the spike.

|  | Option A: native (C++20 + Metal, JUCE UI) | Option B: WebGPU (TypeScript) in a Tauri shell |
| --- | --- | --- |
| Fit with existing work | Same stack and workflow as Afterglow; engine pieces (tempo, output, show control) could be shared | Same stack as the browser VJ tools |
| GPU features | Full Metal: compute, large buffers, fast sorting | Good, with some WebGPU limits on buffer sizes and subgroup ops |
| Show reliability, timecode I/O | Strongest (CoreMIDI, CoreAudio for LTC, Ableton Link SDK) | Workable (Web MIDI, LTC via audio input), more moving parts |
| Video export | AVFoundation, ProRes native | WebCodecs or ffmpeg sidecar |
| Iteration speed | Slower | Fastest, ideal for the spike |

**The Edit tab changes the weighting.** SuperSplat is a web app, so it embeds most naturally in Option B. A third option is now the strongest: **Option C, hybrid.** A native Mac shell with Animate on Metal (performance, timecode, ProRes), and Edit as a WKWebView running the SuperSplat fork. Train is a subprocess in every option. Decide between B and C at G0, after testing SuperSplat inside WKWebView.

Also decide at G0: standalone app, or a module inside Afterglow sharing its show/setlist layer.

## 12. Milestones

Nine milestones in order. Each one ends with something Viktor can run and judge. Rendering comes before show mode so rendered videos can serve as fallbacks early.

0. **M0 – Look-dev spike.** 2–3 real splats, 1 point + 1 spot + 1 sun, shadows, baked/relit mix, normals and de-light from import. **Gate G0:** Viktor approves the look; stack decided.
1. **M1 – Viewer.** Load .ply/.spz, several splats with transforms and crop, explore and camera modes, LED output window, performance HUD.
2. **M2 – Timeline core.** Song import, transport, tempo map and beat grid, tracks/clips, keyframes with curves, camera keyframes, undo/redo, save/load.
3. **M3 – Lights.** All five types, gizmos, light clips, shadow caching, parameter registry wired to the inspector.
4. **M4 – Music.** Offline analysis, LFOs with ×2/÷2, band envelopes, onset and beat triggers, section modulator.
5. **M5 – Splat animators.** Disperse, wobble, depth sweep, depth cut-off.
6. **M6 – Render.** Frame-stepped export with every setting in section 10. **Gate G1:** one full song rendered and approved.
7. **M7 – Show mode.** Setlist, MTC/LTC chase, Link, safety keys, preloading.
8. **M8 – Rehearsal hardening.** Full set at rehearsal with the band's click rig, a performance pass, fallback videos. **Gate G2:** a full run with no dropped frames.

**M1b – In-app capture** (runs alongside M2, since it barely touches the timeline): Vauss sidecar, capture panel, job runner, recipes, mesh proxy for shadows and normals, COLMAP + Brush backend for photos. **Gate:** one location goes from phone video to a lit scene without leaving 22PM.

**M1c – Edit tab** (alongside M2): pinned SuperSplat fork, embedded web view, bridge (open from / save to 22PM), asset versioning, publishing removed. **Gate:** clean a Train output in Edit, update it in Animate, and the lights and camera stay in place.

## 13. Risks and open questions

The biggest risk is the relighting look. Everything else is known engineering.

| Risk | Mitigation |
| --- | --- |
| Baked lighting in scans fights the virtual lights | Flat-light capture rules, de-light slider, baked/relit mix, dark global light as the default look |
| Noisy splat normals give blotchy shading | Neighbour smoothing at import, normal-strength parameter, lean on shadows and colour rather than specular |
| Frame rate with many shadow-casting lights | Cap per song, cache static shadow maps, lower shadow resolution live, fallback video |
| Sorting and overdraw for big splats at 60 fps | LOD + culling, crop at import, splat-count budget per song |
| Different LED walls at every venue | Output resolution independent of authoring; preview overlays for the wall shape |

### Open questions

- [ ] What does the click rig run (Ableton Live, QLab, a multitrack player), and can it send MTC, LTC or Link?
- [ ] Which machine runs the show: the M4 Max MacBook Pro or a dedicated show Mac? Is there a backup machine?
- [ ] How many songs are in the set, and how many get a splat world vs simpler looks?
- [ ] What are Vauss's licence terms once the research preview ends?
- [ ] Standalone app or an Afterglow module (decided at G0).

## 14. Working notes for Claude Code

Export this doc as Markdown into the repo as `docs/BRIEF.md` and point `CLAUDE.md` at it. Then work one milestone at a time.

- **Start with M0 only.** Don't scaffold the timeline or UI before the look is approved at G0.
- **Conventions:** metres, seconds, beats; right-handed, Y-up; colours in linear space internally, sRGB / Rec.709 on output.
- **Determinism is a hard rule:** all animation goes through `evaluate(show, song, t)`. No wall-clock time, no unseeded randomness in the evaluate path.
- **Parameter registry first:** add new parameters only through the registry, never as one-off UI wiring.
- **Tests:** unit tests for curves, modulators and tempo maths. Golden-frame render tests for the renderer (a fixed scene and time must give the same image within a tolerance).
- **Performance HUD always on in dev:** frame time per pass, Gaussian count, shadow-map count.
- **Build and test on the M4 Max MacBook Pro (64 GB).** Ask before big architecture changes or new heavy dependencies.
- **Each milestone ends with** a short changelog entry and a demo note on what to try.

## Sources

- [Brush – radiancefields.com](https://radiancefields.com/platforms/brush)
- [CorbeauSplat – radiancefields.com](https://radiancefields.com/platforms/corbeausplat)
- [SuperSplat review – thefuture3d.com](https://www.thefuture3d.com/software/supersplat/)
- [LichtFeld Studio – radiancefields.com](https://radiancefields.com/platforms/lichtfeld-studio)
- [Best Gaussian splatting editors (Postshot) – radiancefields.com](https://radiancefields.com/best-gaussian-splatting-editors)
- [Gaussian splatting student guide 2026 (Scaniverse) – Medium](https://medium.com/@Jamesroha/gaussian-splatting-a-complete-student-guide-to-3d-capture-in-2026-1195a6265870)
- [GS3: Efficient Relighting with Triple Gaussian Splatting](https://radiancefields.com/papers/gs3-efficient-relighting-with-triple-gaussian-splatting)

* [Vauss – GitHub (voyager-so)](https://github.com/voyager-so/vauss)

- [SuperSplat – GitHub (PlayCanvas)](https://github.com/playcanvas/supersplat)
