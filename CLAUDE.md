# 22PM

Bespoke tool for building and playing the LED visuals of jóvilágvan's Délután 10 tour: gaussian splats as the set, virtual lights as the performers, on a deterministic timeline locked to the song's timecode.

**Read `docs/BRIEF.md` first** (the brief and build guide), then `docs/STATUS.md` (what exists, what does not, and where the build deviates from the brief).

## Commands

```bash
npm install
npm run app:dev    # desktop app (Electron) with hot reload
npm run dev        # browser version at http://127.0.0.1:5173  (needs a WebGPU browser)
npm run dist:mac   # package release/22PM-…-mac-arm64.dmg (macOS only; CI does this on every push)
npm test           # unit tests: tempo, curves, modulators, evaluate, timecode, file IO, audio analysis
npm run typecheck
node tests/golden.mjs   # golden-frame render tests (dev server must be running)
node tests/ui.mjs       # end-to-end UI test (dev server must be running)
node tests/electron.mjs # desktop app test on the built app (run `npx vite build` first; `xvfb-run -a` on Linux)
```

`?lite` on the URL shrinks the demo scene for slow GPUs. `harness.html` is the headless render harness the golden tests use.

## Layout

- `src/core/` – pure, no DOM: `registry.ts` (every parameter), `model.ts` (data model), `evaluate.ts`, `modulators.ts`, `curves.ts`, `tempo.ts`, `timecode.ts`.
- `src/render/` – WebGPU deferred splat renderer (`renderer.ts`, WGSL in `shaders.ts`), depth sort, editor overlay lines.
- `src/splat/` – `.ply` / `.spz` readers, import preprocessing (normals, de-light), procedural demo scans.
- `src/audio/` – offline analysis (bands, onsets, BPM/grid).
- `src/state/` – project store with undo (`store.ts`), edit operations (`actions.ts`), assets/persistence (`runtime.ts`), transport, show control.
- `src/export/` – frame-stepped render to video.
- `src/ui/` – React UI. `src/train/` – solver interface (stubs).
- `electron/` – desktop shell: `main.cjs` (window, menu, project folder on disk, output display, render file writes), `preload.cjs` (exposed to the page as `window.native`, typed in `src/state/native.ts`).
- `.github/workflows/mac-app.yml` – builds the ad-hoc-signed `.dmg` on GitHub's Mac runners.

## Hard rules (from the brief)

- **Determinism.** All animation goes through `evaluate(show, song, sec)`. No wall clock and no unseeded randomness in the evaluate or render path. The only clock reads are in `state/transport.ts` and the live safety fades in `state/showControl.ts`.
- **Parameter registry first.** Add parameters only in `core/registry.ts`. The inspector, timeline lanes, modulators, evaluate and the file format follow from it. No one-off UI wiring.
- **Conventions.** Metres, seconds, beats. Right-handed, Y-up. Linear colour internally, sRGB / Rec.709 on output. Timeline time is stored in beats; seconds are derived from the song's tempo map.
- **Edits go through `state/actions.ts`** (which calls `update()`), so everything is undoable.
- **Show-safe.** Never an unintended black frame; on timecode dropout freewheel, then hold.
- **Two runtimes.** The page must keep working in a plain browser too: guard every desktop feature with `native` / `isDesktop` from `src/state/native.ts`. The shell only serves files, touches disk inside the project folder (or paths the user picked in a dialog), and places windows.
- Ask before big architecture changes or new heavy dependencies.
- Vauss: never fork or modify it, and take commands/flags from its README and `--help`. Never guess them.
- Each milestone ends with a changelog entry and a demo note in `docs/STATUS.md`.
