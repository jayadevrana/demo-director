// Screen recording via macOS's built-in `screencapture -v`.
// Native, always installed, records H.264 .mov; stopped with SIGINT.
// Requires Screen Recording permission for the host app (terminal / Claude).
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, run, sleep, timestamp, which } from './util.js';

const DEFAULT_DIR = path.join(os.homedir(), 'Movies', 'demo-director');

let current = null; // { proc, file, startedAt }

export async function startRecording({ output, display, area } = {}) {
  if (current) throw new Error(`already recording to ${current.file} — call stop_recording first`);
  const file = output ?? path.join(ensureDir(DEFAULT_DIR), `demo-${timestamp()}.mov`);
  ensureDir(path.dirname(file));

  const args = ['-v', '-x']; // video, no UI sounds
  if (area) {
    const { x, y, width, height } = area;
    if ([x, y, width, height].some((v) => typeof v !== 'number')) {
      throw new Error('area requires numeric x, y, width, height');
    }
    args.push(`-R${x},${y},${width},${height}`);
  } else if (display !== undefined) {
    args.push('-D', String(display));
  }
  args.push(file);

  const proc = spawn('screencapture', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  current = { proc, file, startedAt: Date.now() };
  proc.on('close', () => {
    if (current?.proc === proc) current = null;
  });

  // Give it a beat to fail fast (e.g. missing Screen Recording permission).
  await sleep(700);
  if (proc.exitCode !== null) {
    current = null;
    throw new Error(
      `screencapture exited immediately (code ${proc.exitCode}). ${stderr.trim() || 'Most likely the host app lacks Screen Recording permission: System Settings → Privacy & Security → Screen Recording.'}`
    );
  }
  return {
    recording: true,
    file,
    startedAt: new Date(current.startedAt).toISOString(),
    note: 'capture typically begins ~1-2s after this call — pause before acting on camera',
  };
}

export async function stopRecording() {
  if (!current) throw new Error('not recording');
  const { proc, file, startedAt } = current;
  // screencapture finalizes and writes the .mov only after SIGINT. A multi-minute
  // recording can take tens of seconds to flush — SIGKILL before then loses the
  // whole file, so give it a long grace and only force-kill as a last resort.
  proc.kill('SIGINT');
  const closed = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    proc.on('close', () => finish(true));
    setTimeout(() => { if (!done) { proc.kill('SIGKILL'); finish(false); } }, 180_000);
  });
  current = null;
  // Wait for the container to appear and stop growing (fully flushed to disk).
  for (let i = 0; i < 360 && !existsSync(file); i++) await sleep(500); // up to 180s
  if (!existsSync(file)) {
    throw new Error(`recording stopped but ${file} was never written (screencapture closed=${closed})`);
  }
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const size = statSync(file).size;
    if (size === last && size > 0) break;
    last = size;
    await sleep(500);
  }
  const wallSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  const bytes = statSync(file).size;
  const result = { file, wallSeconds, megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10 };
  // Wall clock overstates length: screencapture takes ~1-2s to actually start.
  // Report the true container duration when ffprobe is around.
  if (which('ffprobe')) {
    const probed = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]).catch(() => null);
    const dur = parseFloat(probed?.out ?? '');
    if (!Number.isNaN(dur)) result.videoSeconds = Math.round(dur * 10) / 10;
  }
  return result;
}

export function recordingStatus() {
  if (!current) return { recording: false };
  return {
    recording: true,
    file: current.file,
    seconds: Math.round((Date.now() - current.startedAt) / 100) / 10,
  };
}
