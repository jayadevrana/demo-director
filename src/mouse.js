// Wraps the native Swift cursor driver. Compiles it on first use (needs Xcode
// Command Line Tools) into ~/.demo-director/bin so it runs from any filesystem.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR, ensureDir, run, which } from './util.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'native', 'cursor.swift');
const BIN = process.env.DEMO_DIRECTOR_HELPER ?? path.join(HOME_DIR, 'bin', 'cursor');

let building = null;

export async function ensureHelper() {
  const fresh =
    existsSync(BIN) && (!existsSync(SRC) || statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs);
  if (fresh) return BIN;
  if (!which('swiftc')) {
    throw new Error(
      'The native cursor helper is not built and swiftc was not found. ' +
        'Install Xcode Command Line Tools (`xcode-select --install`) and retry, ' +
        'or point DEMO_DIRECTOR_HELPER at a prebuilt binary.'
    );
  }
  building ??= (async () => {
    ensureDir(path.dirname(BIN));
    await run('swiftc', ['-O', '-o', BIN, SRC]);
    return BIN;
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

async function cursor(...args) {
  const bin = await ensureHelper();
  const { out } = await run(bin, args.map(String));
  try {
    return JSON.parse(out);
  } catch {
    return { ok: true, raw: out };
  }
}

export const mouse = {
  position: () => cursor('position'),
  displays: () => cursor('displays'),
  move: (x, y, ms = 600) => cursor('move', x, y, ms),
  click: ({ x, y, right = false, double = false } = {}) => {
    const args = ['click'];
    if (x !== undefined && y !== undefined) args.push(x, y);
    if (right) args.push('--right');
    if (double) args.push('--double');
    return cursor(...args);
  },
  drag: (x1, y1, x2, y2, ms = 800) => cursor('drag', x1, y1, x2, y2, ms),
  scroll: (dx, dy, ms = 900) => cursor('scroll', dx, dy, ms),
  type: (text, cps = 12) => cursor('type', text, cps),
  key: (name, mods = []) => cursor('key', name, ...mods),
};
