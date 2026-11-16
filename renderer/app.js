(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const hasApi = !!window.api;
const api = window.api || { onState() {}, onSettings() {}, ready() {}, cmd() {}, set() {}, settingsMenu() {}, hide() {}, lights() {}, openLights() {}, lightsStatus() {} };

const FONT_STACKS = {
  'SF Pro': '-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI Variable Display","Segoe UI","Helvetica Neue",sans-serif',
  'SF Rounded': 'ui-rounded,"SF Pro Rounded","Nunito","Segoe UI Variable Display","Segoe UI",-apple-system,sans-serif',
  'New York': 'ui-serif,"New York",Georgia,Cambria,serif',
  'Helvetica Neue': '"Helvetica Neue",Helvetica,Arial,sans-serif',
  'Avenir Next': '"Avenir Next",Avenir,"Segoe UI Variable Display","Segoe UI","Helvetica Neue",sans-serif',
  'Futura': 'Futura,"Century Gothic","Trebuchet MS","Helvetica Neue",sans-serif',
  'Didot': 'Didot,"Bodoni 72","Bodoni MT","Times New Roman",serif',
};

let S = {
  style: 'Fisheye Visual', font: 'SF Pro', size: 1, autoSync: true, dim: true, showArt: true,
  offset: 0, fullscreen: true, colors: { lyric: '#ffd2a6', highlight: '#ffffff', secondary: '#ff944d' },
};
let autoColors = null;

// ───────── playback state ─────────
const P = { track: null, playing: false, pos: 0, at: performance.now(), lines: [], words: [], key: '', demo: false };
const now = () => Math.max(0, P.pos + (P.playing ? (performance.now() - P.at) / 1000 : 0) + (S.offset || 0));

// ───────── demo content (original text, shown when nothing is playing) ─────────
const DEMO = {
  title: 'Golden Hour Drive', artist: 'Demo Artist', album: 'Demo', duration: 64,
  lines: [
    [2, 'Wake up in the morning, sunlight on the road'],
    [6.5, 'Every little worry fades away like snow'],
    [11, 'Hold on to the story, dream another night'],
    [15.5, 'Dance until the stars begin to light the sky'],
    [20, 'Time keeps moving slowly, love is in my heart'],
    [24.5, 'Fly across the ocean, never miss the start'],
    [29, 'Close your eyes and listen to the rain'],
    [33.5, 'Sing it one more time, sing it once again'],
    [38, 'Burning like a fire, shining like the moon'],
    [42.5, 'We were always free, and we will be soon'],
    [47, 'Drive into the sunset, take me home'],
    [52, 'Nobody has to be alone'],
  ].map(([t, text]) => ({ t, text })),
};

function demoArt() {
  const c = document.createElement('canvas'); c.width = c.height = 600;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 600, 600);
  grd.addColorStop(0, '#2a0d06'); grd.addColorStop(.45, '#b4501c'); grd.addColorStop(1, '#f2b56a');
  g.fillStyle = grd; g.fillRect(0, 0, 600, 600);
  const rg = g.createRadialGradient(400, 180, 10, 400, 180, 260);
  rg.addColorStop(0, 'rgba(255,230,170,.9)'); rg.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 600, 600);
  return c.toDataURL('image/jpeg', .9);
}

// ───────── word timing ─────────
function iconFor(word) {
  const k = word.toLowerCase().replace(/[^a-z']/g, '').replace(/'s$/, '');
  return window.ICON_MAP[k] || window.ICON_MAP[k.replace(/in'$/, 'ing')] || '';
}
function buildTimeline(lyrics, duration) {
  let lines = (lyrics && lyrics.lines || []).map((l) => ({ t: l.t, text: l.text }));
  if (lyrics && !lyrics.synced && lines.length) {           // unsynced: spread across the song
    const real = lines.filter((l) => l.text.trim());
    const step = (duration || real.length * 3) / (real.length + 1);
    let n = 0; lines = lines.map((l) => ({ t: l.text.trim() ? (++n) * step * .9 : 0, text: l.text }));
    lines = lines.filter((l) => l.text.trim());
  }
  lines = lines.filter((l) => l.text.trim());
  const words = [];
  lines.forEach((l, li) => {
    const next = lines[li + 1] ? lines[li + 1].t : l.t + 4;
    const span = Math.max(0.6, Math.min(next - l.t, 9)) * 0.92;
    const toks = l.text.split(/\s+/).filter(Boolean);
    const wts = toks.map((w) => w.length + 2);
    const sum = wts.reduce((a, b) => a + b, 0);
    let acc = 0;
    l.words = toks.map((text, i) => {
      const w = { text, t: l.t + (acc / sum) * span, line: li, i, gi: words.length, icon: iconFor(text) };
      acc += wts[i]; words.push(w); return w;
    });
  });
  return { lines, words };
}
function setLyrics(lyrics, duration) {
  const { lines, words } = buildTimeline(lyrics, duration);
  P.lines = lines; P.words = words; buildLayout();
  clearStage();
}

// ───────── helpers ─────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
function curIndex(arr, t, get) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (get(arr[m]) <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const styleKey = () => S.style;
const isVisual = () => /Visual/.test(S.style);
const mode = () => ({
  'Ship': 'ship', 'Fisheye': 'fish', 'Fisheye Visual': 'fish', 'Visual': 'visual',
  'Codestyle': 'code', 'Codestyle Visual': 'code', 'Branches': 'branch', 'Web': 'web', 'Constellation': 'const',
}[S.style]);

let els = new Map();           // key -> element
let layoutCache = null;
function clearStage() {
  stage.innerHTML = ''; els = new Map(); lastLine = -2; lastWord = -2;
  stage.className = 's-' + ({ ship: 'ship', fish: 'fish', visual: 'visual', code: 'code', branch: 'branch', web: 'web', const: 'const' }[mode()]);
  buildLayout();
  if (mode() === 'branch') {
    stage.insertAdjacentHTML('beforeend', '<svg id="rail"></svg>');
  }
  if (mode() === 'web' || mode() === 'const') {
    stage.insertAdjacentHTML('beforeend', '<svg class="web"></svg>');
  }
}

// graph positions for web / constellation (fixed per word, deterministic)
function buildLayout() {
  layoutCache = [];
  let x = 0, y = 0, ang = 0;
  for (let i = 0; i < P.words.length; i++) {
    ang += (hash(i + 3) - .5) * 2.4;
    const d = 22 + hash(i + 9) * 18;
    x += Math.cos(ang) * d * 1.25; y += Math.sin(ang) * d * .85;
    // soft pull to origin so the graph doesn't run away
    x *= .93; y *= .93;
    layoutCache.push({ x, y });
  }
}

// ───────── renderers ─────────
let lastLine = -2, lastWord = -2;

function wordEl(w, key) {
  let el = els.get(key);
  if (!el) {
    el = document.createElement('div'); el.className = 'w';
    el.innerHTML = `<span class="t">${esc(w.text)}</span>`;
    if (isVisual() && w.icon) {
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = w.icon;
      if (hash(w.gi * 7) > .5) el.prepend(ic); else el.append(ic);
    }
    el.style.opacity = 0;
    stage.append(el); els.set(key, el);
    el.getBoundingClientRect();                         // commit initial style for transitions
  }
  return el;
}

function renderWords(m, c) {
  const vh = innerHeight / 100, vw = innerWidth / 100;
  const base = vh * 17 * S.size;
  const keep = new Set();
  const range = m === 'web' || m === 'const' ? 7 : 3;
  for (let i = c - range; i <= c + range; i++) {
    const w = P.words[i]; if (!w) continue;
    const d = i - c, a = Math.abs(d);
    const el = wordEl(w, i); keep.add(i);
    let x = 0, y = 0, s = 1, o = 1, blur = 0, col = 'var(--lyric)', wt = 800, fs = base;
    if (m === 'fish') {
      const sc = [1, .4, .29, .22, .17][a] || .15;
      y = (d === 0 ? 0 : Math.sign(d) * [0, 15, 23, 29, 34][a] * vh) - 4 * vh;
      x = d === 0 ? 0 : (hash(i) - .5) * 9 * vw;
      s = sc; o = d === 0 ? 1 : d > 0 ? [0, .9, .6, .35, .18][a] : [0, .55, .32, .18, .08][a];
      blur = a > 1 ? a - 1 : 0;
      col = d === 0 ? 'var(--hi)' : d > 0 ? 'var(--lyric)' : 'var(--sec)';
      wt = d === 0 ? 800 : 700;
      el.style.fontStyle = d !== 0 && hash(i + 1) > .6 ? 'italic' : 'normal';
    } else if (m === 'ship') {
      fs = base * .8; x = d * 26 * vw; y = Math.sin(i * 1.3) * 3 * vh;
      s = d === 0 ? 1 : .5; o = d === 0 ? 1 : clamp(.6 - a * .15, 0, .6);
      col = d === 0 ? 'var(--hi)' : d > 0 ? 'var(--lyric)' : 'var(--sec)';
    } else {                                              // web + constellation
      const p = layoutCache[i], q = layoutCache[c] || { x: 0, y: 0 };
      x = (p.x - q.x) * 1.35 * vw; y = (p.y - q.y) * 1.35 * vh;
      fs = vh * (m === 'const' ? 6.2 : 6.8) * S.size;
      s = d === 0 ? 1.9 : 1; o = d === 0 ? 1 : clamp(.85 - a * .1, .15, .85);
      col = d === 0 ? 'var(--hi)' : d > 0 ? 'var(--lyric)' : 'var(--sec)';
      wt = d === 0 ? 800 : 600;
    }
    el.style.fontSize = fs + 'px';
    el.style.fontWeight = wt;
    el.style.color = col;
    el.style.opacity = o;
    el.style.filter = blur ? `blur(${blur * .06 * vh}px)` : 'none';
    el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px) scale(${s})`;
    el.dataset.x = x; el.dataset.y = y;
  }
  for (const [k, el] of els) if (!keep.has(k)) {
    els.delete(k); el.style.opacity = 0; setTimeout(() => el.remove(), 450);
  }
  if (m === 'web' || m === 'const') drawGraph(m, c, keep);
}

function drawGraph(m, c, keep) {
  const svg = stage.querySelector('svg.web'); if (!svg) return;
  const W = innerWidth, H = innerHeight, cx = W / 2, cy = H * .46;
  let html = '';
  if (m === 'web') for (let r = 1; r <= 5; r++) html += `<circle class="ring" cx="${cx}" cy="${cy}" r="${r * H * .13}"/>`;
  const pts = [];
  for (const i of keep) { const el = els.get(i); if (el) pts.push([i, cx + +el.dataset.x, cy + +el.dataset.y]); }
  pts.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < pts.length; k++) {
    const [ia, xa, ya] = pts[k - 1], [ib, xb, yb] = pts[k];
    if (ib - ia !== 1) continue;
    html += `<line x1="${xa}" y1="${ya}" x2="${xb}" y2="${yb}" style="opacity:${m === 'const' ? .55 : .4}"/>`;
    if (m === 'web') {                                    // extra strands to the current node
      if (ib !== c && ia !== c) html += `<line x1="${xb}" y1="${yb}" x2="${cx}" y2="${cy}" style="opacity:.12"/>`;
    }
  }
  if (m === 'const') for (const [i, x, y] of pts) {
    html += `<circle cx="${x}" cy="${y - 0}" r="${i === c ? 5 : 2.4}" fill="#fff" opacity="${i === c ? 1 : .8}" style="filter:drop-shadow(0 0 6px var(--sec))"/>`;
  }
  svg.innerHTML = html;
}

// line based
function lineEl(li) {
  let el = els.get(li);
  if (!el) {
    const l = P.lines[li];
    el = document.createElement('div'); el.className = 'l'; el.dataset.n = li + 1;
    const toks = l.words.map((w) => {
      const ic = isVisual() && w.icon ? `<span class="ic">${w.icon}</span>` : '';
      return `<span class="k next" data-g="${w.gi}">${esc(w.text)}</span>${ic} `;
    }).join('');
    el.innerHTML = toks;
    if (mode() === 'code') {
      const first = l.words.find((w) => w.icon);
      el.innerHTML = '<span class="k" style="color:var(--sec)">print</span>("' + toks.trim() + '")'
        + (isVisual() && first ? `<span class="cm">// ${first.icon} ${esc(first.text.toLowerCase().replace(/[^a-z']/g, ''))}</span>` : '');
    }
    el.style.opacity = 0; stage.append(el); els.set(li, el); el.getBoundingClientRect();
  }
  return el;
}
function renderLines(m, L, wordIdx) {
  const vh = innerHeight / 100;
  const keep = new Set();
  const span = m === 'visual' ? 3 : 5;
  for (let i = L - span; i <= L + span; i++) {
    if (!P.lines[i]) continue;
    const d = i - L, a = Math.abs(d); keep.add(i);
    const el = lineEl(i);
    let y, s, o, x = 0;
    if (m === 'visual') {
      y = d === 0 ? 0 : Math.sign(d) * (14 + (a - 1) * 9.5) * vh * (a === 1 ? 1 : 1);
      s = d === 0 ? 1 : [1, .46, .38, .3][a] || .3; o = d === 0 ? 1 : d > 0 ? .55 / a : .35 / a;
      el.style.filter = a > 1 ? `blur(${(a - 1) * .05 * vh}px)` : 'none';
    } else if (m === 'code') {
      y = d * 6.2 * vh; s = 1; o = a === 0 ? 1 : clamp(.62 - a * .1, .1, .6);
      el.classList.toggle('cur', d === 0);
    } else {                                              // branch
      y = d * 12 * vh; s = d === 0 ? 1 : .78; o = a === 0 ? 1 : clamp(.7 - a * .12, .1, .7);
      x = (i % 3 - 1) * 3 * vh;
      el.style.setProperty('--bx', (15 + (i % 3) * 3.2) + 'vw');
      el.style.paddingLeft = (26 + (i % 3) * 3.2) + 'vw';
      el.style.fontSize = vh * 5 * S.size + 'px';
    }
    if (m === 'visual') el.style.fontSize = vh * 7.2 * S.size + 'px';
    if (m === 'code') el.style.fontSize = vh * 3.1 * S.size + 'px';
    el.style.opacity = o;
    el.style.transform = `translateY(-50%) translate(${x}px,${y}px) scale(${s})`;
    el.style.transformOrigin = m === 'visual' ? '50% 50%' : '0 50%';
    el.classList.toggle('cur', d === 0);
  }
  for (const [k, el] of els) if (!keep.has(k)) { els.delete(k); el.style.opacity = 0; setTimeout(() => el.remove(), 500); }
  // word highlight inside current line
  for (const [li, el] of els) {
    el.querySelectorAll('.k[data-g]').forEach((k) => {
      const g = +k.dataset.g;
      k.className = 'k ' + (li < L ? 'past' : li > L ? 'next' : g < wordIdx ? 'past' : g === wordIdx ? 'now' : 'next');
    });
  }
  if (m === 'branch') drawRail(L, keep);
}
function drawRail(L, keep) {
  const svg = stage.querySelector('#rail'); if (!svg) return;
  const H = innerHeight, W = innerWidth, pts = [];
  for (const i of [...keep].sort((a, b) => a - b)) {
    const el = els.get(i); if (!el) continue;
    const bx = (15 + (i % 3) * 3.2) / 100 * W;
    pts.push({ i, x: bx, y: H * .46 + (i - L) * 12 * H / 100 });
  }
  let d = '', branches = '';
  pts.forEach((p, k) => {
    if (k === 0) { d += `M${p.x},${p.y}`; return; }
    const q = pts[k - 1], my = (q.y + p.y) / 2;
    d += ` C${q.x},${my} ${p.x},${my} ${p.x},${p.y}`;
    if (p.i % 4 === 0) branches += `<path d="M${p.x},${p.y} C${p.x - 70},${p.y + 10} ${p.x - 70},${p.y + 50} ${p.x},${p.y + H * .12}" stroke="var(--lyric)" stroke-width="3" fill="none" opacity=".35"/>`;
  });
  svg.innerHTML = `<path d="${d}" stroke="var(--sec)" stroke-width="5" fill="none" opacity=".75" stroke-linecap="round"/>${branches}`;
}

// ───────── main loop ─────────
function frame() {
  const t = now();
  const m = mode();
  if (P.words.length) {
    const wi = Math.max(0, curIndex(P.words, t, (w) => w.t));
    const li = P.words[wi] ? P.words[wi].line : 0;
    const started = P.words[0] && t >= P.words[0].t - 1.5;
    if (m === 'fish' || m === 'ship' || m === 'web' || m === 'const') {
      if (wi !== lastWord || m !== frame.m) { lastWord = wi; renderWords(m, started ? wi : -1); }
    } else {
      if (wi !== lastWord || li !== lastLine || m !== frame.m) { lastWord = wi; lastLine = li; renderLines(m, started ? li : -1, started ? wi : -1); }
    }
    frame.m = m;
  } else if (!els.has('msg')) {
    const e = document.createElement('div'); e.className = 'w'; e.style.fontSize = '5vh'; e.style.color = 'var(--lyric)';
    e.style.transform = 'translate(-50%,-50%)'; e.textContent = P.track ? '♪  No lyrics found for this track' : '♪';
    stage.append(e); els.set('msg', e);
  }
  if (P.demo && P.playing && t > DEMO.duration + 2) { P.pos = 0; P.at = performance.now(); }
  requestAnimationFrame(frame);
}

// ───────── colors / settings ─────────
function dominant(img) {
  const c = document.createElement('canvas'); c.width = c.height = 24;
  const g = c.getContext('2d', { willReadFrequently: true });
  try { g.drawImage(img, 0, 0, 24, 24); } catch (_) { return null; }
  const d = g.getImageData(0, 0, 24, 24).data;
  let r = 0, gg = 0, b = 0, wsum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    const w = (mx - mn) / 255 * (mx / 255) + .02;
    r += d[i] * w; gg += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
  }
  return [r / wsum, gg / wsum, b / wsum];
}
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return [h, s, l];
}
const hsl = (h, s, l) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
function syncColors(img) {
  const rgb = dominant(img); if (!rgb) return;
  const [h, s] = toHsl(rgb), ss = clamp(s, .45, .95);
  autoColors = { lyric: hsl(h, ss, .78), highlight: hsl(h, clamp(s * .3, .05, .25), .97), secondary: hsl(h, ss, .6) };
  applyColors();
  if (window.Lights) window.Lights.setAuto(h, s);
}
function applyColors() {
  const c = S.autoSync && autoColors ? autoColors : S.colors;
  const r = document.documentElement.style;
  r.setProperty('--lyric', c.lyric); r.setProperty('--hi', c.highlight); r.setProperty('--sec', c.secondary);
}
function applySettings() {
  const r = document.documentElement.style;
  r.setProperty('--font', FONT_STACKS[S.font] || FONT_STACKS['SF Pro']);
  r.setProperty('--size', S.size);
  document.body.classList.toggle('dim', !!S.dim);
  document.body.classList.toggle('noart', !S.showArt);
  document.body.classList.toggle('noicons', S.hideIcons === true);
  $('#b-dim').classList.toggle('off', !S.dim); $('#b-art').classList.toggle('off', !S.showArt);
  $('#b-icons').classList.toggle('off', S.hideIcons === true);
  applyColors();
  if (styleKey() !== applySettings.style || S.hideIcons !== applySettings.hide) {
    applySettings.style = styleKey(); applySettings.hide = S.hideIcons; clearStage();
  } else clearStageIfSize();
}
function clearStageIfSize() { if (applySettings.size !== S.size || applySettings.font !== S.font) { applySettings.size = S.size; applySettings.font = S.font; lastWord = lastLine = -2; } }

// ───────── state from main process ─────────
function setArt(src) {
  const img = $('#art');
  img.onload = () => syncColors(img);
  img.crossOrigin = 'anonymous'; img.src = src || '';
}
api.onSettings((s) => {
  S = { ...S, ...s, colors: { ...S.colors, ...(s.colors || {}) } }; applySettings();
  if (window.Lights && s.lights) { S.lights = s.lights; window.Lights.apply(s.lights); $('#b-lights').classList.toggle('off', !s.lights.on); }
});
api.onState((st) => {
  if (!st || !st.track) { startDemo(); return; }
  P.demo = false; document.body.classList.remove('demo');
  const t = st.track;
  P.playing = st.playing; P.pos = st.position; P.at = performance.now();
  if (t.key !== P.key) { P.key = t.key; P.track = t; setLyrics(null, 0); P.lyricsSet = false; setArt(t.artwork); P.artSet = !!t.artwork; }
  P.track = t;
  if (t.artwork && !P.artSet) { setArt(t.artwork); P.artSet = true; }
  if (t.lyrics && !P.lyricsSet) { P.lyricsSet = true; setLyrics(t.lyrics, t.duration); }
  setPlayIcon();
});
function startDemo() {
  if (P.demo) return;
  P.demo = true; P.key = 'demo'; P.track = DEMO; P.playing = true; P.pos = 0; P.at = performance.now();
  document.body.classList.add('demo');
  setArt(demoArt()); setLyrics({ synced: true, lines: DEMO.lines }, DEMO.duration); setPlayIcon();
}
function setPlayIcon() {
  $('#i-pause').style.display = P.playing ? '' : 'none';
  $('#i-play').style.display = P.playing ? 'none' : '';
}

// ───────── controls ─────────
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 1400);
}
const cmd = (c) => { if (P.demo) { if (c === 'toggle') { P.pos = now() - (S.offset || 0); P.playing = !P.playing; P.at = performance.now(); setPlayIcon(); } if (c === 'prev' || c === 'next') { P.pos = 0; P.at = performance.now(); } } else api.cmd(c); };
$('#b-prev').onclick = () => cmd('prev');
$('#b-next').onclick = () => cmd('next');
$('#b-play').onclick = () => cmd('toggle');
$('#b-repeat').onclick = () => { cmd('repeat'); toast('Repeat toggled'); };
$('#b-settings').onclick = () => api.settingsMenu();
$('#b-dim').onclick = () => api.set('dim', !S.dim) || (!hasApi && (S.dim = !S.dim, applySettings()));
$('#b-art').onclick = () => api.set('showArt', !S.showArt) || (!hasApi && (S.showArt = !S.showArt, applySettings()));
$('#b-lights').onclick = () => {
  const on = !(S.lights ? S.lights.on : true);
  if (hasApi) api.lights({ on }); else { S.lights = { ...(S.lights || {}), on }; window.Lights.apply({ on }); $('#b-lights').classList.toggle('off', !on); }
  toast(on ? 'Edge lights on' : 'Edge lights off');
};
$('#b-lights').oncontextmenu = (e) => { e.preventDefault(); api.openLights(); };
$('#b-icons').onclick = () => { S.hideIcons = !S.hideIcons; applySettings(); toast(S.hideIcons ? 'Word icons off' : 'Word icons on'); };
$('#b-full').onclick = () => { api.set('fullscreen', !S.fullscreen); if (!hasApi) S.fullscreen = !S.fullscreen; toast(S.fullscreen ? 'Windowed' : 'Fullscreen'); };
$('#b-sync').onclick = (e) => {
  const next = +((S.offset || 0) + (e.shiftKey ? -.25 : .25)).toFixed(2);
  S.offset = next; api.set('offset', next); toast(`Lyric offset ${next > 0 ? '+' : ''}${next}s`);
};
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); cmd('toggle'); }
  else if (e.key === 'ArrowRight') cmd('next'); else if (e.key === 'ArrowLeft') cmd('prev');
  else if (e.key === 'Escape') api.hide();
});
let idleT; const wake = () => { document.body.classList.add('active'); document.body.classList.remove('idle'); clearTimeout(idleT);
  idleT = setTimeout(() => { document.body.classList.remove('active'); document.body.classList.add('idle'); }, 3500); };
addEventListener('mousemove', wake); wake();
addEventListener('resize', () => { lastWord = lastLine = -2; });

window.__lyrik = { setStyle: (s) => { S.style = s; applySettings(); }, S: () => S, seek: (t) => { P.pos = t; P.at = performance.now(); } };
api.ready();
applySettings();
setTimeout(() => { if (!P.track) startDemo(); }, 1200);
requestAnimationFrame(frame);
})();
