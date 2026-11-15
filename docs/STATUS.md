# 22PM – status, changelog and demo notes

Read this after `docs/BRIEF.md`. It says what exists, what does not, where the build departs from the brief, and what to try.

## Where this build stands

The brief says to start with M0 only and to decide the stack at gate G0. This first pass was asked to go further and build the tool with its UI, Animate first. It is written in **TypeScript + WebGPU** (the brief's recommended spike stack; option B without the Tauri shell yet). **Gates G0, G1 and G2 are still open**: nothing here has been judged on real scans or measured on the M4 Max.

Everything was developed and tested on Linux against a software GPU. That proves the code is correct, not that it is fast or that the look holds up on real captures.

| Area (brief §2 MVP) | State |
| --- | --- |
| Splats: load .ply / .spz, several per scene, transform, crop box | Built. `.ply` round-trip and `.spz` v2 are unit-tested; `.spz` v3 and real-world files are untested |
| Import preprocessing: normals, de-light | Built. Normals are oriented without capture cameras (see deviations). No compression or LOD |
| Explore / camera: orbit + fly, camera mode, keyframed camera with easing | Built |
| Lights: point, spot, sun, area, global; shadows; per-song shadow cap; shadow caching | Built. Area light is a spot approximation with PCSS, as the brief describes |
| Splat animators: disperse, wobble, depth sweep, depth cut-off | Built, in the vertex stage rather than a compute pass |
| Timeline: tracks, clips, fades, keyframes (hold / linear / bezier), beat snapping, undo/redo, save/load | Built |
| Modulation: LFO (×2 / ÷2, dotted, triplet), audio band, onset trigger, beat trigger, section; blend modes; copy/paste stacks | Built |
| Audio: import, offline BPM / beat / onset / band analysis, manual override, tap tempo | Built. Verified on synthetic clicks only; check every real song's grid by ear |
| Show: setlist, MTC chase with freewheel-then-hold, output window, blackout / freeze / fade to colour / skip | Built. MTC parsing and chase logic are unit-tested; **never tested against a real rig** |
| Render: frame-stepped, resolution / fps, supersampling, motion-blur sub-frames, shadow resolution, audio embed | Built for H.264 / HEVC / VP9 / AV1 (whatever the browser encodes) and PNG sequence |
| Performance HUD | Built: frame time, per-pass GPU time, Gaussian count, shadow maps |

### Not built

- **ProRes export.** Browsers cannot encode it. The render dialog gives the `ffmpeg` command to turn a PNG sequence into ProRes 422 HQ. Native ProRes needs the desktop shell.
- **Train tab (M1b).** The tab explains this and takes imports; `src/train/solver.ts` defines the `SplatSolver` interface with stub backends. Spawning Vauss or COLMAP + Brush needs the desktop shell. No Vauss flags were guessed.
- **Edit tab (M1c).** SuperSplat is not vendored or embedded. The versioning half is built: add a cleaned file as a new version of an asset and scenes on "Latest" update in place, lights and cameras untouched. The round trip is manual (download, clean in SuperSplat, add version).
- **LTC, Ableton Link, MIDI clock + song select.** Only MTC and manual GO.
- **GPU radix sort.** Sorting is a CPU counting sort in a worker (on the render thread for export). Fine for hundreds of thousands of Gaussians; the 3–5M target needs measuring and probably the GPU sort.
- **LOD, culling hierarchy, attribute compression.**
- **Mesh proxy for shadows and normals** (depends on Train).
- **Desktop shell (Tauri or native).** Runs in the browser. The project lives in the browser's private file system; "Export project file" saves the JSON only, not the splat and audio files.
- Everything in the brief's "Later" column.

## Deviations from the brief worth knowing

1. **Keyframes replace the base value rather than add to it.** The brief's formula is `base + K(t) + modulators`. Here a keyed parameter's value is `K(t) + modulators`; the base is used only when there are no keys. Absolute keyframes are what you expect when you type a value. Editing a keyed parameter writes a key at the playhead.
2. **Modulator depth is in the parameter's own units** for Add (a depth of 5 on intensity swings it by 5), and a 0–1 mix for Multiply and Replace.
3. **The base layer.** Each song has an always-on camera, global light and post grade. Clips on the camera and global tracks override it and crossfade with their fade times. Lights and animators exist only inside their clips, as the brief says.
4. **Normals without capture cameras.** They are the shortest covariance axis, pointed away from the scan's centre and smoothed in a voxel grid. Per splat you choose Face viewer (default), Outward or Inward. "Normal strength" also falls automatically where neighbouring normals disagree, which softens blotches.
5. **Shadows use a stochastic alpha test**, so translucent Gaussians cast lighter shadows. The pattern is a hash of pixel and Gaussian index, so it is stable from frame to frame.
6. **Animators act on unsorted positions.** Draw order comes from each Gaussian's rest position, so a strong disperse can blend slightly out of order.
7. **Supersampled or motion-blurred renders are not bit-identical to live playback**; they are the same frames at higher quality. At 1× / no blur the paths are identical.
8. **`.ply` imports are rotated 180° about Z** on the assumption they are Y-down (COLMAP convention, as SuperSplat does). `.spz` is taken as Y-up. "Flip upright" in the splat inspector fixes a wrong guess.

## Changelog

### 0.1.0 – first pass (M0–M7 in software, unverified on target hardware)

- Core: parameter registry, data model, tempo maths, keyframe curves, modulators, pure `evaluate()`, SMPTE / MTC / chase.
- Renderer: WebGPU deferred splatting (albedo, normal, depth, baked), shadow maps per light (spot, sun ortho, point cube, area), PCSS, lighting with baked ↔ relit mix, bloom, grade, tone map, supersampling and sub-frame accumulation.
- Splat IO and preprocessing; procedural demo scans.
- Offline audio analysis in a worker, cached per asset.
- UI: Animate (viewport with gizmos, registry-driven inspector, timeline with keyframe lanes), Show, render dialog; Train and Edit as honest placeholders with asset versioning.
- Tests: 32 unit tests, golden-frame render tests, end-to-end UI test.

## Demo note – what to try

1. `npm run dev`, open in Chrome. The demo courtyard loads with a camera push, a warm spot, a cool point light pulsing on the beat, a low sun in the chorus, a depth sweep and a disperse at the end. Press **Space**.
2. Switch the viewport to **Explore** (key `2`). Click the *Key spot* clip. Drag the axis handles to move where it aims; watch the shadows. Press `1` to go back to the camera.
3. In the inspector, drag a number to scrub it (Shift = fine), or click and type (`*2`, `+0.5` work). Click **◆** to key it, move the playhead, change it again.
4. Click **∿** on *Intensity*, add an **LFO**, try ×2 / ÷2 and Triplet. The purple tick in the field is the live modulated value.
5. Double-click an empty lane to add a clip. Drag clips, their edges and the fade handles. Alt ignores snapping. `S` splits at the playhead.
6. Select *Courtyard* in the Scene list: de-light, baked mix, normal mode, crop box.
7. Drop a song's audio file on the window. Check the detected grid against the waveform, then try an **Audio band** or **Onset trigger** modulator.
8. **Render** (top right): start with a short range at 1× to see the path work.
9. **Show** tab: *Open output window*, then *MIDI Timecode* → *Send test timecode* to watch the chase lock; stop it to see freewheel, then hold.

## Before G0 (on the M4 Max, with real scans)

- Load 2–3 real captures and judge the relighting look: de-light, normal modes, shadow quality.
- Read the HUD at 1920×1080 with 3–5M Gaussians and 4 shadow lights against the 60 fps target.
- Decide the stack (stay WebGPU in a shell, or hybrid with a native Metal Animate) and standalone vs Afterglow module.
