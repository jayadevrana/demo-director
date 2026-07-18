// Tool registry: every capability Demo Director exposes over MCP.
import { existsSync } from 'node:fs';
import * as chrome from './chrome.js';
import { ensureHelper, mouse } from './mouse.js';
import { recordingStatus, startRecording, stopRecording } from './recorder.js';
import { composeFinalVideo, muxNarration, renderNarrationAuto, speak } from './narrate.js';
import { listVoices, voiceboxHealth } from './voicebox.js';
import { sleep, which } from './util.js';

const num = (description) => ({ type: 'number', description });
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

export const tools = [
  // ---------- setup ----------
  {
    name: 'check_setup',
    description:
      'Verify the machine is ready to record a demo: native cursor helper, ffmpeg, Chrome, say voices. Run this first in a new session.',
    inputSchema: obj({}),
    handler: async () => {
      const report = { platform: process.platform, node: process.versions.node };
      report.swiftc = !!which('swiftc');
      try {
        await ensureHelper();
        report.cursorHelper = 'built';
        report.displays = await mouse.displays();
      } catch (e) {
        report.cursorHelper = `unavailable: ${e.message}`;
      }
      report.ffmpeg = !!which('ffmpeg');
      report.chrome = existsSync('/Applications/Google Chrome.app');
      const vb = await voiceboxHealth();
      report.voicebox = vb.available
        ? `online (${vb.model_size ?? 'model'} loaded) — natural voice-clone narration enabled`
        : 'offline — narration falls back to macOS say';
      report.notes = [
        'Screen Recording + Accessibility permission must be granted to the host app (System Settings → Privacy & Security).',
        'Keep Chrome page zoom at 100% so element coordinates map 1:1 to screen points.',
      ];
      return report;
    },
  },

  // ---------- recording ----------
  {
    name: 'start_recording',
    description:
      'Start recording the screen to a .mov (macOS native screencapture). Optionally restrict to a display number or a pixel region.',
    inputSchema: obj({
      output: str('Absolute output path (.mov). Default: ~/Movies/demo-director/demo-<ts>.mov'),
      display: num('Display number (1 = main). Omit for main display.'),
      area: obj(
        { x: num('left'), y: num('top'), width: num('width'), height: num('height') },
        ['x', 'y', 'width', 'height']
      ),
    }),
    handler: startRecording,
  },
  {
    name: 'stop_recording',
    description: 'Stop the current screen recording and return the finished file path, duration, and size.',
    inputSchema: obj({}),
    handler: stopRecording,
  },
  {
    name: 'recording_status',
    description: 'Whether a recording is in progress, and for how long.',
    inputSchema: obj({}),
    handler: recordingStatus,
  },

  // ---------- cursor & keyboard (presenter-grade, native) ----------
  {
    name: 'screen_info',
    description: 'List displays (id, bounds, main) and the current mouse position.',
    inputSchema: obj({}),
    handler: async () => ({ displays: await mouse.displays(), mouse: await mouse.position() }),
  },
  {
    name: 'mouse_move',
    description:
      'Glide the real cursor to screen coordinates with a smooth, slightly curved, eased path — like a human presenter. Use 600–1000ms for on-camera moves.',
    inputSchema: obj({ x: num('screen x'), y: num('screen y'), ms: num('travel time in ms (default 600)') }, ['x', 'y']),
    handler: ({ x, y, ms }) => mouse.move(x, y, ms ?? 600),
  },
  {
    name: 'mouse_click',
    description: 'Click at the current cursor position, or glide-free click at x/y. Supports right and double click.',
    inputSchema: obj({
      x: num('optional screen x'),
      y: num('optional screen y'),
      right: bool('right-click'),
      double: bool('double-click'),
    }),
    handler: (a) => mouse.click(a),
  },
  {
    name: 'mouse_drag',
    description: 'Press, drag smoothly from one point to another, release.',
    inputSchema: obj(
      { x1: num('start x'), y1: num('start y'), x2: num('end x'), y2: num('end y'), ms: num('drag duration ms (default 800)') },
      ['x1', 'y1', 'x2', 'y2']
    ),
    handler: ({ x1, y1, x2, y2, ms }) => mouse.drag(x1, y1, x2, y2, ms ?? 800),
  },
  {
    name: 'scroll',
    description:
      'OS-level momentum scroll at the cursor position. dy > 0 scrolls the page DOWN. For scrolling a web page on camera, prefer chrome_scroll (per-pixel cinematic).',
    inputSchema: obj({ dx: num('horizontal px (default 0)'), dy: num('vertical px, positive = down'), ms: num('duration ms (default 900)') }, ['dy']),
    handler: ({ dx, dy, ms }) => mouse.scroll(dx ?? 0, dy, ms ?? 900),
  },
  {
    name: 'type_text',
    description:
      'Type text into the focused control with human rhythm (jittered inter-key timing, slower after punctuation). cps = characters per second (default 12).',
    inputSchema: obj({ text: str('text to type'), cps: num('typing speed, chars/sec (default 12)') }, ['text']),
    handler: ({ text, cps }) => mouse.type(text, cps ?? 12),
  },
  {
    name: 'press_key',
    description:
      'Press a key with optional modifiers. Keys: return, tab, space, escape, delete, arrows, home/end, pageup/pagedown, a–z, 0–9. Modifiers: cmd, shift, alt, ctrl.',
    inputSchema: obj(
      { key: str('key name, e.g. "return"'), modifiers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["cmd"]' } },
      ['key']
    ),
    handler: ({ key, modifiers }) => mouse.key(key, modifiers ?? []),
  },
  {
    name: 'pause',
    description: 'Hold for N seconds — presenter beats between actions so viewers can absorb what they saw.',
    inputSchema: obj({ seconds: num('seconds to wait') }, ['seconds']),
    handler: async ({ seconds }) => {
      await sleep(seconds * 1000);
      return { paused: seconds };
    },
  },

  // ---------- Chrome (CDP) ----------
  {
    name: 'chrome_launch',
    description:
      'Launch (or attach to) Chrome with a dedicated clean demo profile and DevTools control, optionally opening a URL. Never touches the user’s real browser profile.',
    inputSchema: obj({
      url: str('URL to open (e.g. your local app: http://localhost:3000)'),
      port: num('DevTools port (default 9222)'),
      windowSize: obj({ width: num('px'), height: num('px') }),
    }),
    handler: chrome.launchChrome,
  },
  {
    name: 'chrome_connect',
    description: 'Attach to an already-running Chrome that has --remote-debugging-port. Optionally pick the tab by URL substring.',
    inputSchema: obj({ port: num('DevTools port (default 9222)'), urlContains: str('choose the tab whose URL contains this') }),
    handler: chrome.connect,
  },
  {
    name: 'chrome_navigate',
    description: 'Navigate the connected tab and wait for the page to finish loading.',
    inputSchema: obj({ url: str('destination URL') }, ['url']),
    handler: ({ url }) => chrome.navigate(url),
  },
  {
    name: 'chrome_locate',
    description:
      'Resolve a CSS selector to SCREEN coordinates (center point) so the real cursor can glide to it with mouse_move. Also reports size, visible text, and whether it is in the viewport. Page zoom must be 100%.',
    inputSchema: obj({ selector: str('CSS selector'), scrollIntoView: bool('scroll it to center first (instant jump — avoid while recording)') }, ['selector']),
    handler: ({ selector, scrollIntoView }) => chrome.locate(selector, { scrollIntoView }),
  },
  {
    name: 'chrome_scroll',
    description:
      'Cinematic in-page scroll: eased, per-pixel, at reading pace. Scroll to a CSS selector (lands ~1/3 from the top) or an absolute Y. Use 1200–2500ms on camera.',
    inputSchema: obj({
      selector: str('scroll until this element is comfortably in view'),
      y: num('or scroll to absolute document Y'),
      durationMs: num('scroll duration (default 1500)'),
    }),
    handler: chrome.smoothScroll,
  },
  {
    name: 'chrome_highlight',
    description:
      'Keynote-style emphasis on an element: "spotlight" dims the rest of the page around it; "pulse" draws a pulsing outline. Clear with chrome_clear_highlight.',
    inputSchema: obj({ selector: str('CSS selector'), style: { type: 'string', enum: ['spotlight', 'pulse'], description: 'default spotlight' } }, ['selector']),
    handler: ({ selector, style }) => chrome.highlight(selector, { style: style ?? 'spotlight' }),
  },
  {
    name: 'chrome_clear_highlight',
    description: 'Fade out and remove any highlight overlay.',
    inputSchema: obj({}),
    handler: chrome.clearHighlight,
  },
  {
    name: 'chrome_eval',
    description: 'Evaluate JavaScript in the connected tab and return the JSON value. Awaits promises.',
    inputSchema: obj({ expression: str('JS expression') }, ['expression']),
    handler: ({ expression }) => chrome.evaluate(expression),
  },
  {
    name: 'chrome_page_text',
    description: 'Read the visible text of the current page (for understanding the app before scripting the demo).',
    inputSchema: obj({ maxChars: num('truncate after this many chars (default 6000)') }),
    handler: ({ maxChars }) => chrome.pageText(maxChars ?? 6000),
  },

  // ---------- narration ----------
  {
    name: 'narrate',
    description:
      'Speak narration live through the speakers while you drive the demo (macOS `say`). Blocks until finished and returns the spoken duration — useful for pacing. NOTE: live audio is not captured in the recording; use render_narration + mux_narration for the final cut.',
    inputSchema: obj({ text: str('what to say'), voice: str('macOS voice (default Samantha)'), rate: num('words per minute (default ~175)') }, ['text']),
    handler: speak,
  },
  {
    name: 'voicebox_status',
    description:
      'Check the local Voicebox app (natural voice-clone TTS) and list installed voices. Run before rendering final narration to pick a voice with the user.',
    inputSchema: obj({}),
    handler: async () => {
      const health = await voiceboxHealth();
      if (!health.available) return health;
      return { ...health, voices: await listVoices() };
    },
  },
  {
    name: 'render_narration',
    description:
      'Render a narration line to an audio file and return its EXACT duration for muxing/pacing. engine "auto" (default) uses the local Voicebox app for natural human voice-clone VO when running, else falls back to macOS say. Per-sentence generation, jittered pauses, soft in-breaths, -16 LUFS.',
    inputSchema: obj(
      {
        text: str('narration text (good spoken punctuation matters; blank line = paragraph beat)'),
        engine: { type: 'string', enum: ['auto', 'voicebox', 'say'], description: 'default auto' },
        voice: str('Voicebox profile name (see voicebox_status) or macOS say voice'),
        instruct: str('Voicebox delivery style, e.g. "warm, confident keynote narrator"'),
        rate: num('say only: words per minute'),
        output: str('output audio path; default auto'),
      },
      ['text']
    ),
    handler: renderNarrationAuto,
  },
  {
    name: 'mux_narration',
    description:
      'Lay rendered narration segments over a recorded video at precise offsets and produce the final .mp4 (video stream copied, audio loudness-normalized). Requires ffmpeg.',
    inputSchema: obj(
      {
        video: str('path to the recorded .mov'),
        segments: {
          type: 'array',
          description: 'narration clips and where they start',
          items: obj({ file: str('audio file from render_narration'), atSeconds: num('offset into the video') }, ['file', 'atSeconds']),
        },
        output: str('output path (default: <video>-narrated.mp4)'),
      },
      ['video', 'segments']
    ),
    handler: muxNarration,
  },
  {
    name: 'compose_final_video',
    description:
      'ONE-CALL FINAL CUT: render narration for every beat (Voicebox voice-clone when available, else say) and lay it over the recorded video at each offset. Returns the finished narrated .mp4 and each beat’s rendered duration. Tip: render beats first to learn durations, pace the recording to them, then compose.',
    inputSchema: obj(
      {
        video: str('path to the recorded .mov/.mp4'),
        beats: {
          type: 'array',
          description: 'narration beats and where they start in the video',
          items: obj(
            {
              text: str('narration line for this beat'),
              atSeconds: num('offset into the video where this line starts'),
              voice: str('per-beat voice override'),
              instruct: str('per-beat delivery override'),
            },
            ['text', 'atSeconds']
          ),
        },
        voice: str('Voicebox profile name (see voicebox_status) or say voice — applies to all beats'),
        instruct: str('delivery style for all beats, e.g. "warm, confident keynote narrator"'),
        engine: { type: 'string', enum: ['auto', 'voicebox', 'say'], description: 'default auto' },
        output: str('final .mp4 path (default: <video>-narrated.mp4)'),
      },
      ['video', 'beats']
    ),
    handler: composeFinalVideo,
  },
];
