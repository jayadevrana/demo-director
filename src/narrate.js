// Narration: live voiceover through macOS `say` while recording, or rendered
// to audio files and muxed over the finished video with ffmpeg for clean audio.
import path from 'node:path';
import { renderVoiceboxNarration, voiceboxHealth } from './voicebox.js';
import { HOME_DIR, ensureDir, run, timestamp, which } from './util.js';

const AUDIO_DIR = path.join(HOME_DIR, 'narration');

/** Speak live through the speakers (screencapture does not capture it — use mux for the final cut). */
export async function speak({ text, voice = 'Samantha', rate }) {
  const args = ['-v', voice];
  if (rate) args.push('-r', String(rate));
  args.push(text);
  const t0 = Date.now();
  await run('say', args);
  return { spoke: true, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

/**
 * Render narration with the best engine available:
 * - "voicebox" — natural voice-clone VO via the local Voicebox app
 * - "say"      — macOS built-in TTS (robotic, but always available)
 * - "auto"     — Voicebox when its server is up, otherwise say
 */
export async function renderNarrationAuto({ text, voice, instruct, engine = 'auto', rate, output }) {
  if (engine === 'voicebox' || engine === 'auto') {
    const health = await voiceboxHealth();
    if (health.available) {
      return renderVoiceboxNarration({ text, voice, instruct, output });
    }
    if (engine === 'voicebox') {
      throw new Error(`Voicebox requested but unavailable: ${health.error}`);
    }
  }
  return renderNarration({ text, voice: voice ?? 'Samantha', rate, output });
}

/** Render narration to an audio file with macOS `say` and return its duration. */
export async function renderNarration({ text, voice = 'Samantha', rate, output }) {
  const file = output ?? path.join(ensureDir(AUDIO_DIR), `vo-${timestamp()}.aiff`);
  const args = ['-v', voice, '-o', file];
  if (rate) args.push('-r', String(rate));
  args.push(text);
  await run('say', args);
  const { out } = await run('afinfo', [file]);
  const match = out.match(/estimated duration:\s*([\d.]+)/);
  return { file, seconds: match ? Math.round(parseFloat(match[1]) * 10) / 10 : null };
}

/**
 * Lay narration segments over a recorded video at given offsets.
 * segments: [{ file, atSeconds }]
 */
export async function muxNarration({ video, segments, output }) {
  if (!which('ffmpeg')) throw new Error('ffmpeg not found — `brew install ffmpeg` to mux narration');
  if (!segments?.length) throw new Error('segments is required: [{ file, atSeconds }]');
  const out =
    output ?? path.join(path.dirname(video), path.basename(video).replace(/\.\w+$/, '') + '-narrated.mp4');

  const args = ['-y', '-i', video];
  for (const s of segments) args.push('-i', s.file);

  const delayed = segments
    .map((s, i) => `[${i + 1}:a]adelay=${Math.round((s.atSeconds ?? 0) * 1000)}:all=1[a${i}]`)
    .join(';');
  const mixInputs = segments.map((_, i) => `[a${i}]`).join('');
  // apad + -shortest: pad narration with silence so the cut always matches the video length.
  const filter = `${delayed};${mixInputs}amix=inputs=${segments.length}:normalize=0,loudnorm=I=-16:TP=-1.5,apad[aout]`;

  args.push(
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', out
  );
  await run('ffmpeg', args);
  return { file: out, segments: segments.length };
}

/**
 * One-call final cut: render every beat's narration (Voicebox-first) and lay
 * it over the recorded video at its offset. Returns the finished .mp4 plus the
 * rendered duration of every beat.
 */
export async function composeFinalVideo({ video, beats, voice, instruct, engine = 'auto', output }) {
  if (!beats?.length) throw new Error('beats is required: [{ text, atSeconds }]');
  const segments = [];
  for (const beat of beats) {
    const vo = await renderNarrationAuto({
      text: beat.text,
      voice: beat.voice ?? voice,
      instruct: beat.instruct ?? instruct,
      engine,
    });
    segments.push({ file: vo.file, atSeconds: beat.atSeconds, seconds: vo.seconds, voice: vo.voice });
  }
  const muxed = await muxNarration({ video, segments, output });
  return { ...muxed, beats: segments };
}
