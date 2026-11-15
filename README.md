# 22PM

Gaussian-splat concert visuals for jóvilágvan's Délután 10 tour. Splats are the set; virtual lights are the performers; every song is a deterministic timeline locked to the click.

## Mac app

Download the latest `22PM-…-mac-arm64.dmg` from the repository's **Actions** tab (the newest green *Mac app* run → *Artifacts*), or from **Releases** once a version is tagged. Open the `.dmg` and drag 22PM to Applications.

The app is not signed with an Apple Developer certificate, so macOS blocks the first launch. Double-click 22PM once, click **Done**, then open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to “22PM was blocked”. After that it opens normally. Requires Apple Silicon and macOS 13 or later.

Projects are folders on disk, by default `~/Documents/22PM/Délután 10`. Use **File → Open Project Folder…** to switch.

## Developing

```bash
npm install
npm run app:dev     # desktop app with hot reload
npm run dev         # or just the browser version at http://127.0.0.1:5173
npm run dist:mac    # build release/22PM-…-mac-arm64.dmg (on a Mac)
```

The app starts with a procedural demo scene so the lighting tools can be tried before a real scan exists. Drop `.ply` / `.spz` scans or a song's audio file anywhere in the window.

![Animate tab](docs/img/animate.png)

- Brief and build guide: [`docs/BRIEF.md`](docs/BRIEF.md)
- What is built, what is not, and what to try: [`docs/STATUS.md`](docs/STATUS.md)
