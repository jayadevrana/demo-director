# 🎬 Demo Director

**Turn an AI agent into a product presenter.** Demo Director is an MCP server that
gives Claude (or any MCP client) everything it needs to *record a keynote-quality
demo video of your app* — completely hands-free:

- 📹 **Native screen recording** — macOS `screencapture`, full screen / display / region
- 🖱️ **Presenter-grade cursor** — a native Swift CGEvent driver that *glides* the real
  mouse along smooth, eased, slightly-curved paths; human-rhythm typing; momentum scrolling
- 🌐 **Chrome direction** — DevTools Protocol control with a clean demo profile:
  navigate, cinematic in-page scrolling, and the killer feature — **resolve any CSS
  selector to screen coordinates** so the real cursor glides to real UI
- 💡 **Keynote effects** — spotlight (dim everything but the feature) and pulse highlights
- 🗣️ **Natural voiceover** — first-class [Voicebox](https://voicebox.sh) integration:
  voice-clone narration generated sentence-by-sentence with drifting seeds, jittered
  punctuation-based pauses, soft procedural in-breaths, and −16 LUFS loudness — then
  `compose_final_video` muxes it into the finished MP4 in one call. Falls back to
  macOS `say` when Voicebox isn't running; live `say` narration for real-time pacing
- 🧠 **A master-presenter skill** — a playbook that teaches the agent to *understand
  your app first*, write an Apple-style beat sheet, rehearse off camera, then roll

Tell Claude *“record a demo of my app”* — it reads your codebase, learns what the app
does, writes the story, and presents it feature by feature like it's on stage.

**Zero npm dependencies.** Pure Node 22+ (built-in `fetch` + `WebSocket`), one small
Swift file compiled on first run.

> macOS only for now. Linux/Windows drivers are welcome — see [Contributing](#contributing).

## Quick start

```bash
git clone https://github.com/jayadevrana/demo-director
cd demo-director
npm run check          # doctor: builds the cursor helper, verifies ffmpeg/Chrome
```

Requirements:

- macOS, Node ≥ 22, Xcode Command Line Tools (`xcode-select --install`)
- `ffmpeg` (narration assembly + muxing): `brew install ffmpeg`
- **Permissions** for your terminal / Claude app in *System Settings → Privacy & Security*:
  **Screen Recording** and **Accessibility**
- Optional but recommended: the [Voicebox](https://voicebox.sh) app running locally
  (server **Online**, default `http://127.0.0.1:17493`, override with `VOICEBOX_URL`)
  for natural voice-clone narration — without it, narration falls back to macOS `say`

### Register with Claude Code

```bash
claude mcp add demo-director -- node /absolute/path/to/demo-director/server.js
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "demo-director": {
      "command": "node",
      "args": ["/absolute/path/to/demo-director/server.js"]
    }
  }
}
```

### Install the presenter skill

```bash
cp -r skills/demo-director ~/.claude/skills/
```

The skill is what turns raw tools into a *performance*: product research → beat
sheet → rehearsal → recording → final cut.

## Try it

Ask Claude:

> Record a 60-second demo of my app at http://localhost:3000. Present it like an
> Apple keynote — feature by feature, with narration.

What happens:

1. Claude reads your app's code and explores it in a throwaway Chrome profile.
2. It writes a **beat sheet** — hook, 3–6 feature beats with narration lines, finale
   (see [examples/beat-sheet.example.json](examples/beat-sheet.example.json)).
3. It rehearses every selector and action off camera.
4. `start_recording` → for each beat: glide the cursor to the real element, click,
   type at human speed, scroll at reading pace, spotlight the moment. →
   `stop_recording`.
5. `compose_final_video` — every beat's narration is rendered in your chosen
   Voicebox voice (humanized: varied takes, pauses, breaths) and muxed over the
   recording. **The deliverable is a finished MP4 with voiceover.**

## Tools

| Tool | What it does |
| --- | --- |
| `check_setup` | Doctor: helper build, ffmpeg, Chrome, permission notes |
| `start_recording` / `stop_recording` / `recording_status` | Native screen capture (full / display / region) |
| `screen_info` | Displays + current mouse position |
| `mouse_move` | Smooth eased glide of the real cursor (600–1000 ms looks human) |
| `mouse_click` / `mouse_drag` | Clicks (left/right/double) and smooth drags |
| `scroll` | OS-level momentum scroll at the cursor |
| `type_text` | Human-rhythm typing (jittered timing, slower after punctuation) |
| `press_key` | Named keys with cmd/shift/alt/ctrl modifiers |
| `pause` | Presenter beats between actions |
| `chrome_launch` / `chrome_connect` | Chrome with DevTools control + a clean demo profile |
| `chrome_navigate` | Navigate and wait for load |
| `chrome_locate` | **CSS selector → screen coordinates** for real-cursor interaction |
| `chrome_scroll` | Cinematic eased in-page scrolling to a selector or Y |
| `chrome_highlight` / `chrome_clear_highlight` | Spotlight / pulse emphasis |
| `chrome_eval` / `chrome_page_text` | Page scripting and reading |
| `narrate` | Live voiceover via `say` (blocks — natural pacing) |
| `voicebox_status` | Voicebox health + installed voice-clone profiles |
| `render_narration` | Narration to file with exact duration — Voicebox (natural, humanized) or `say` fallback |
| `mux_narration` | Lay rendered audio over the video at precise offsets (ffmpeg) |
| `compose_final_video` | **One call: beats in → finished narrated .mp4 out** |

## How it works

```
Claude (MCP client)
   │  stdio JSON-RPC
   ▼
server.js ── src/rpc.js          minimal MCP implementation, no SDK
   ├─ src/recorder.js            screencapture -v (SIGINT to stop)
   ├─ src/mouse.js ─▶ native/cursor  Swift CGEvent driver (compiled on first use
   │                                 to ~/.demo-director/bin — smooth bezier moves,
   │                                 pixel momentum scroll, unicode typing)
   ├─ src/chrome.js              CDP over built-in WebSocket; dedicated profile in
   │                             ~/.demo-director/chrome-profile
   ├─ src/narrate.js             say + ffmpeg adelay/amix/loudnorm + compose_final_video
   └─ src/voicebox.js            Voicebox REST client: per-sentence generation with
                                 drifting seeds, jittered pauses, synthesized breaths,
                                 click-free joins, -16 LUFS master
```

The trick that makes demos feel human: the agent asks Chrome *where an element is on
the physical screen* (`chrome_locate` accounts for window position and browser chrome),
then drives the **real macOS cursor** to it. Viewers see an actual hand at work, not
DOM events firing invisibly.

## Troubleshooting

- **`screencapture exited immediately`** → grant Screen Recording to your terminal /
  Claude app, then restart it.
- **Cursor doesn't move / clicks ignored** → grant Accessibility permission.
- **`chrome_locate` clicks land off-target** → set Chrome page zoom to 100 %
  (⌘0) and don't move the window mid-demo; re-`chrome_locate` after any scroll.
- **Node < 22** → upgrade; the server needs the built-in `WebSocket` client.
- **Recording is black / clicks do nothing mid-shoot** → the display went to sleep.
  Keep it awake for long takes by driving under `caffeinate -dims …`.
- **Clicks land on the wrong window** → the app window must be the *frontmost
  application*, not just visible; a real click hits whatever owns that pixel. Raise
  the target window first (`osascript -e 'tell application "Google Chrome" to
  activate'`).
- **Long recording never saved** → fixed: `stop_recording` now waits up to 3 min for
  `screencapture` to finalize a multi-minute file before giving up.
- **Narration missing from the video** → by design: live `say` audio isn't captured.
  Use `render_narration` + `mux_narration` for the final cut.

## Contributing

PRs welcome — especially:

- Linux driver (`xdotool`/`ydotool` + `wf-recorder`/ffmpeg x11grab)
- Windows driver (SendInput + Windows.Graphics.Capture)
- Webcam picture-in-picture, click-ripple overlays, auto-zoom on click
- Firefox/Safari support (WebDriver BiDi)

## License

[MIT](LICENSE)

## Author

Built by [Jayadev Rana](https://jayadevrana.in) — @bluealgocapital · [YouTube](https://www.youtube.com/@jayadevrana3657) · [GitHub](https://github.com/jayadevrana)
