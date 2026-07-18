// Natural voice-clone narration via the local Voicebox app (https://voicebox.sh).
// Drives its REST API only — no UI automation. Falls back to `say` upstream
// when Voicebox isn't running.
//
// Why it sounds human vs. one-shot TTS: each sentence is generated separately
// with a drifting seed (prosody varies take to take), inter-sentence pauses are
// derived from punctuation and jittered, and soft band-limited in-breaths are
// synthesized at paragraph starts — then everything is joined click-free and
// loudness-normalized to -16 LUFS.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR, ensureDir, run, sleep, timestamp, which } from './util.js';

const BASE = process.env.VOICEBOX_URL ?? 'http://127.0.0.1:17493';
const AUDIO_DIR = path.join(HOME_DIR, 'narration');

async function api(pathName, init) {
  const res = await fetch(`${BASE}${pathName}`, init).catch((e) => {
    throw new Error(`Voicebox unreachable at ${BASE} (${e.message}) — is the app running and its server Online?`);
  });
  if (!res.ok) throw new Error(`Voicebox ${init?.method ?? 'GET'} ${pathName} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function voiceboxHealth() {
  try {
    const res = await api('/health');
    return { available: true, ...(await res.json()) };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

export async function listVoices() {
  const res = await api('/profiles');
  const profiles = await res.json();
  return profiles.map(({ id, name, language, voice_type, description }) => ({
    id, name, language, voice_type, description,
  }));
}

async function resolveProfile(voice) {
  const profiles = await listVoices();
  if (!voice) return profiles[0];
  const needle = voice.toLowerCase();
  const hit =
    profiles.find((p) => p.id === voice) ??
    profiles.find((p) => p.name.toLowerCase() === needle) ??
    profiles.find((p) => p.name.toLowerCase().includes(needle));
  if (!hit) {
    throw new Error(`no Voicebox voice matches "${voice}". Installed: ${profiles.map((p) => p.name).join(', ')}`);
  }
  return hit;
}

/** Split into paragraphs of sentences. Handles ., !, ?, … and Hindi danda (।). */
function splitScript(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => p.match(/[^.!?…।]+[.!?…।]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [p]);
}

const jitter = (v, pct = 0.18) => v * (1 + (Math.random() * 2 - 1) * pct);

function pauseAfter(sentence, isParagraphEnd) {
  if (isParagraphEnd) return jitter(1.05);
  const last = sentence.trim().slice(-1);
  if (last === '?' || last === '!') return jitter(0.6);
  if (last === '…') return jitter(0.8);
  return jitter(0.45);
}

/**
 * Render a narration script to a single polished WAV via Voicebox.
 * Returns { file, seconds, voice, sentences }.
 */
/** Generation is async: POST /generate returns immediately, then we poll status. */
async function awaitGeneration(id, timeoutSec = 300) {
  for (let waited = 0; waited < timeoutSec; waited += 1) {
    await sleep(1000);
    const raw = await (await api(`/generate/${id}/status`)).text();
    // Endpoint answers in SSE framing: `data: {...}`
    const json = raw.slice(raw.indexOf('{'));
    let status;
    try {
      status = JSON.parse(json);
    } catch {
      continue;
    }
    if (status.status === 'completed') return status;
    if (status.status === 'failed' || status.error) {
      throw new Error(`Voicebox generation failed: ${status.error ?? 'unknown error'}`);
    }
  }
  throw new Error(`Voicebox generation ${id} timed out after ${timeoutSec}s`);
}

export async function renderVoiceboxNarration({
  text,
  voice,
  instruct = 'warm, confident, unhurried — product keynote narrator',
  engine, // omit by default: the server picks the right engine for the profile
  modelSize = '1.7B',
  seed = 1000 + Math.floor(Math.random() * 100000),
  output,
} = {}) {
  if (!which('ffmpeg')) throw new Error('ffmpeg is required for Voicebox narration assembly');
  const profile = await resolveProfile(voice);
  const paragraphs = splitScript(text);
  if (!paragraphs.length) throw new Error('empty narration text');

  const work = mkdtempSync(path.join(os.tmpdir(), 'dd-vo-'));
  const pieces = []; // uniform 48k stereo wav segments, in order
  let idx = 0;
  let sentenceCount = 0;

  const silence = async (seconds) => {
    const f = path.join(work, `sil-${idx++}.wav`);
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i',
      `anullsrc=r=48000:cl=stereo:d=${seconds.toFixed(2)}`, '-c:a', 'pcm_s16le', f]);
    pieces.push(f);
  };
  // Procedural in-breath: band-limited pink noise swell, quiet (~-25 dB).
  const breath = async () => {
    const d = jitter(0.42, 0.25).toFixed(2);
    const f = path.join(work, `breath-${idx++}.wav`);
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i',
      `anoisesrc=color=pink:r=48000:d=${d}`, '-af',
      `highpass=f=500,lowpass=f=2200,afade=t=in:d=${(d * 0.55).toFixed(2)},afade=t=out:st=${(d * 0.55).toFixed(2)}:d=${(d * 0.45).toFixed(2)},volume=-25dB,aformat=channel_layouts=stereo`,
      '-c:a', 'pcm_s16le', f]);
    pieces.push(f);
  };

  try {
    for (const [pi, sentences] of paragraphs.entries()) {
      if (pi > 0 || paragraphs.length > 1) await breath();
      for (const [si, sentence] of sentences.entries()) {
        const body = {
          profile_id: profile.id,
          text: sentence,
          language: profile.language ?? 'en',
          seed: seed + sentenceCount, // drift the take per sentence
          model_size: modelSize,
          instruct,
        };
        if (engine) body.engine = engine;
        const res = await api('/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const gen = await res.json();
        if (gen.status && gen.status !== 'completed') await awaitGeneration(gen.id);
        const raw = path.join(work, `raw-${idx}.wav`);
        const bytes = await (await api(`/audio/${gen.id}`)).arrayBuffer();
        writeFileSync(raw, Buffer.from(bytes));
        // Uniform format + 6ms edge fades so every join is click-free.
        const clip = path.join(work, `clip-${idx++}.wav`);
        await run('ffmpeg', ['-y', '-i', raw, '-af',
          'aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=0.006,areverse,afade=t=in:d=0.006,areverse',
          '-c:a', 'pcm_s16le', clip]);
        pieces.push(clip);
        sentenceCount++;
        const isLast = pi === paragraphs.length - 1 && si === sentences.length - 1;
        if (!isLast) await silence(pauseAfter(sentence, si === sentences.length - 1));
      }
    }

    const list = path.join(work, 'list.txt');
    writeFileSync(list, pieces.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const file = output ?? path.join(ensureDir(AUDIO_DIR), `vo-${timestamp()}.wav`);
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-af',
      'acompressor=threshold=-18dB:ratio=2.5:attack=12:release=180,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:a', 'pcm_s16le', file]);

    const { out } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    return {
      file,
      seconds: Math.round(parseFloat(out) * 10) / 10,
      voice: profile.name,
      engine,
      sentences: sentenceCount,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
