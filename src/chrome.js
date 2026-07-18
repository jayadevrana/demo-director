// Chrome control over the DevTools Protocol (CDP) using Node's built-in
// WebSocket and fetch — no dependencies. Launches a dedicated demo profile so
// the user's real browser session is never touched.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { HOME_DIR, ensureDir, sleep } from './util.js';

const CHROME_BINS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const state = {
  port: 9222,
  ws: null,
  nextId: 1,
  pending: new Map(),
};

async function httpJson(pathName) {
  const res = await fetch(`http://127.0.0.1:${state.port}${pathName}`);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} on ${pathName}`);
  return res.json();
}

export async function launchChrome({ url = 'about:blank', port = 9222, windowSize } = {}) {
  state.port = port;
  const alive = await httpJson('/json/version').catch(() => null);
  if (!alive) {
    const bin = CHROME_BINS.find((b) => existsSync(b));
    if (!bin) throw new Error('no Chrome/Chromium/Brave/Edge found in /Applications');
    const profile = ensureDir(path.join(HOME_DIR, 'chrome-profile'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-features=TranslateUI',
    ];
    if (windowSize) args.push(`--window-size=${windowSize.width},${windowSize.height}`);
    args.push(url);
    spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if (await httpJson('/json/version').catch(() => null)) break;
      if (i === 59) throw new Error('Chrome did not expose the DevTools port within 15s');
    }
  }
  await connect({ port });
  if (alive && url !== 'about:blank') await navigate(url);
  const version = await httpJson('/json/version');
  return { connected: true, port, browser: version.Browser, launched: !alive };
}

export async function connect({ port = state.port, urlContains } = {}) {
  state.port = port;
  const targets = await httpJson('/json/list');
  const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  const target = urlContains ? pages.find((t) => t.url.includes(urlContains)) : pages[0];
  if (!target) {
    throw new Error(
      `no page target found${urlContains ? ` matching "${urlContains}"` : ''} — is Chrome running with --remote-debugging-port=${port}?`
    );
  }
  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket connection to Chrome failed'));
  });
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const waiter = state.pending.get(msg.id);
    if (waiter) {
      state.pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
    }
  };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
  };
  state.ws = ws;
  await cmd('Page.enable');
  await cmd('Runtime.enable');
  return { connected: true, url: target.url, title: target.title };
}

export function cmd(method, params = {}) {
  if (!state.ws) throw new Error('not connected to Chrome — call chrome_launch or chrome_connect first');
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (state.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
    }, 30_000);
  });
}

export async function evaluate(expression, { awaitPromise = true } = {}) {
  const res = await cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`page JS threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

export async function navigate(url) {
  await cmd('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const ready = await evaluate('document.readyState').catch(() => 'loading');
    if (ready === 'complete') break;
  }
  const title = await evaluate('document.title').catch(() => '');
  return { url: await evaluate('location.href'), title };
}

const sel = (s) => JSON.stringify(s);

/**
 * Resolve a CSS selector to SCREEN coordinates so the real cursor can glide to
 * it. Assumes page zoom is 100% (CSS px == macOS points on any Mac display).
 */
export async function locate(selector, { scrollIntoView = false } = {}) {
  const info = await evaluate(`(() => {
    const el = document.querySelector(${sel(selector)});
    if (!el) return null;
    ${scrollIntoView ? `el.scrollIntoView({ block: 'center', behavior: 'instant' });` : ''}
    const r = el.getBoundingClientRect();
    const chromeTop = window.outerHeight - window.innerHeight;
    const chromeLeft = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    return {
      x: Math.round(window.screenX + chromeLeft + r.left + r.width / 2),
      y: Math.round(window.screenY + chromeTop + r.top + r.height / 2),
      width: Math.round(r.width),
      height: Math.round(r.height),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0,
      text: (el.innerText || el.value || '').slice(0, 120),
    };
  })()`);
  if (!info) throw new Error(`no element matches selector: ${selector}`);
  return info;
}

/** Cinematic in-page scroll: requestAnimationFrame + ease-in-out, at reading pace. */
export async function smoothScroll({ selector, y, durationMs = 1500 } = {}) {
  return evaluate(`new Promise((resolve) => {
    const el = ${selector ? `document.querySelector(${sel(selector)})` : 'null'};
    ${selector ? `if (!el) return resolve({ error: 'no element matches ' + ${sel(selector)} });` : ''}
    const startY = window.scrollY;
    const targetY = el
      ? el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.28
      : ${y ?? 0};
    const dur = ${durationMs};
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const t0 = performance.now();
    (function frame(now) {
      const t = Math.min((now - t0) / dur, 1);
      window.scrollTo(0, startY + (targetY - startY) * ease(t));
      t < 1 ? requestAnimationFrame(frame) : resolve({ scrolledTo: Math.round(window.scrollY) });
    })(t0);
  })`);
}

/** Keynote-style visual emphasis: spotlight dims everything but the element, outline pulses. */
export async function highlight(selector, { style = 'spotlight' } = {}) {
  return evaluate(`(() => {
    const el = document.querySelector(${sel(selector)});
    if (!el) return { error: 'no element matches ' + ${sel(selector)} };
    document.getElementById('__dd_overlay')?.remove();
    document.getElementById('__dd_style')?.remove();
    const r = el.getBoundingClientRect();
    const pad = 10;
    const box = document.createElement('div');
    box.id = '__dd_overlay';
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border-radius:12px;' +
      'left:' + (r.left - pad) + 'px;top:' + (r.top - pad) + 'px;' +
      'width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px;' +
      'transition:opacity .45s ease;opacity:0;';
    const css = document.createElement('style');
    css.id = '__dd_style';
    if (${sel(style)} === 'spotlight') {
      box.style.boxShadow = '0 0 0 200vmax rgba(8, 10, 20, 0.55)';
      box.style.border = '2px solid rgba(255,255,255,0.9)';
    } else {
      css.textContent = '@keyframes __dd_pulse { 0%,100% { box-shadow: 0 0 0 3px rgba(79,142,247,.9), 0 0 24px 6px rgba(79,142,247,.45); } 50% { box-shadow: 0 0 0 5px rgba(79,142,247,.6), 0 0 36px 10px rgba(79,142,247,.25); } }';
      box.style.animation = '__dd_pulse 1.4s ease-in-out infinite';
      box.style.border = '3px solid #4f8ef7';
    }
    document.head.appendChild(css);
    document.body.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = '1'; });
    return { highlighted: true, style: ${sel(style)} };
  })()`);
}

export async function clearHighlight() {
  return evaluate(`(() => {
    const box = document.getElementById('__dd_overlay');
    if (box) { box.style.opacity = '0'; setTimeout(() => box.remove(), 500); }
    document.getElementById('__dd_style')?.remove();
    return { cleared: !!box };
  })()`);
}

export async function pageText(maxChars = 6000) {
  const text = await evaluate('document.body ? document.body.innerText : ""');
  return {
    url: await evaluate('location.href'),
    title: await evaluate('document.title'),
    text: String(text ?? '').slice(0, maxChars),
  };
}
