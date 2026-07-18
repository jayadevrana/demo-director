import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(os.homedir(), '.demo-director');

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command to completion, capturing stdout/stderr. Rejects on non-zero exit. */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ out: out.trim(), err: err.trim() });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

export function which(bin) {
  for (const dir of (process.env.PATH ?? '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
