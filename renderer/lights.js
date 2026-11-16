// Edge light: a thin neon strip that travels around the screen border, as in the reference video:
// one long flat band (~55% of the border) of even brightness, red-orange at both ends blending into amber in the
// middle, sliding counter-clockwise at about one lap every 3 seconds. The resting edge stays dark.
//
// Two motion modes:
//   moving — constant, steady motion (needs no audio at all)
//   beat   — the strip keeps moving but surges forward and flares on every beat of the music
//            (beat source: system-audio loopback → onset detection + a tempo-locked beat grid;
//             if audio can't be captured it falls back to constant motion and says why in the settings window)
window.Lights = (() => {
  'use strict';
  const cv = document.getElementById('lights');
  const ctx = cv.getContext('2d');
  const A = window.Analyzer;
  const api = window.api;

  const DEF = {
    on: true, reaction: 'moving', colorMode: 'auto', colors: ['#ffaa58', '#e63c14', '#e0451a'],
    edges: { top: true, right: true, bottom: true, left: true }, direction: 'ccw', strips: 1, speed: 0.59,
    tail: 0.5, thickness: 0.6, glow: 0.35, outline: 0, intensity: 0.9, sensitivity: 0.5, fade: 0.5,
    audio: 'system', preview: false,
  };
  let C = JSON.parse(JSON.stringify(DEF));
  let autoCols = ['#ffaa58', '#e63c14'];          // [body, ends], taken from the album art

  const E = {
    head: 0, pulse: 0, boost: 0, presence: 0, level: 0.9,
    mean: 0, dev: 0.2, prevV: 0, lastFire: -9, lastSound: -9, hist: [], histDt: 0.0116, tEnd: 0,
    grid: null, lastGridN: -1, bpm: 0, lastEst: 0, status: '', lastStatusSent: '', previewT: 0,
    t0: performance.now() / 1000, lap: 3,
  };
  let cap = null, capState = 'idle';            // idle | starting | live | failed

  // ───────── helpers ─────────
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  const hslRgb = (h, s, l) => {
    h = ((h % 360) + 360) % 360; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  };
  const mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;
  const tri = (c, x) => (x < 0.5 ? mix(c[0], c[1], x * 2) : mix(c[1], c[2], (x - 0.5) * 2));

  function status(text) {
    E.status = text;
    if (text !== E.lastStatusSent && api && api.lightsStatus) { E.lastStatusSent = text; api.lightsStatus(text); }
  }

  // colour along the strip: x = 0 at the front end … 1 at the back end
  const ss = (v) => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
  const bodyEnds = (body, ends, x) => mix(ends, body, ss(Math.min(x, 1 - x) / 0.17));
  function stripColor(x, t) {
    switch (C.colorMode) {
      case 'ends': return bodyEnds(hex(C.colors[0]), hex(C.colors[1]), x);
      case 'single': return hex(C.colors[0]);
      case 'gradient': return mix(hex(C.colors[0]), hex(C.colors[1]), x);
      case 'palette': return tri(C.colors.slice(0, 3).map(hex), x);
      case 'rainbow': return hslRgb(t * 30 - x * 220, 0.95, 0.6);
      default: return bodyEnds(hex(autoCols[0]), hex(autoCols[1]), x);
    }
  }

  // ───────── audio capture + beat detection (used by Beat Sync) ─────────
  async function startCapture() {
    if (capState !== 'idle' || !navigator.mediaDevices) return;
    if (C.audio === 'off') { capState = 'failed'; status('Audio listening is off — the strip moves at a steady pace'); return; }
    capState = 'starting'; status('Starting audio capture…');
    let stream = null;
    try {
      if (C.audio === 'mic') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach((t) => t.stop());
      }
    } catch (_) { stream = null; }
    if (!stream || !stream.getAudioTracks().length) {
      capState = 'failed';
      status(C.audio === 'mic' ? 'Couldn’t open the microphone — the strip moves at a steady pace'
        : 'Couldn’t capture system audio (on Mac allow “System Audio Recording”) — the strip moves at a steady pace');
      return;
    }
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const src = ac.createMediaStreamSource(stream), proc = ac.createScriptProcessor(1024, 1, 1), mute = ac.createGain();
    mute.gain.value = 0;
    const b = new A.EnvBuilder(ac.sampleRate);
    E.histDt = b.dt;
    proc.onaudioprocess = (e) => feed(b.push(e.inputBuffer.getChannelData(0)), ac.currentTime, b.dt);
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
    cap = { ac, stream, proc, src, mute, t0: ac.currentTime, b };
    capState = 'live'; status('Listening to your music…');
  }
  function stopCapture() {
    if (!cap) { if (capState !== 'live') capState = 'idle'; return; }
    try { cap.proc.onaudioprocess = null; cap.stream.getTracks().forEach((t) => t.stop()); cap.ac.close(); } catch (_) {}
    cap = null; capState = 'idle';
  }

  function fire(strength, tf) {                  // a beat: flare + surge the strip forward
    E.pulse = Math.max(E.pulse, strength);
    E.boost = Math.min(E.boost + 1.5 * strength, 2.6);
    E.lastFire = tf;
  }
  // frames: array of {v, rms}; tNow: audio-clock time at the end of the last frame
  function feed(frames, tNow, dt) {
    const k = 3.6 - 2.6 * C.sensitivity;
    frames.forEach((f, j) => {
      const tf = tNow - (frames.length - 1 - j) * dt - dt * 0.5, v = f.v;
      if (f.rms > 0.003) E.lastSound = tf;
      E.hist.push(v); if (E.hist.length > 1300) E.hist.splice(0, 200);
      const thr = E.mean + k * E.dev + 0.12;
      if (v > thr && v >= E.prevV && tf - E.lastFire > 0.17) fire(clamp(0.6 + (v - thr) / (E.dev * 5 + 0.3), 0.6, 1), tf);
      E.mean += (v - E.mean) * 0.015; E.dev += (Math.abs(v - E.mean) - E.dev) * 0.015; E.dev = Math.max(E.dev, 0.02);
      E.prevV = v; E.tEnd = tf;
    });
  }
  function updateGrid(tNow) {
    if (tNow - E.lastEst < 2 || E.hist.length * E.histDt < 7) return;
    E.lastEst = tNow;
    const n = Math.min(E.hist.length, Math.round(12 / E.histDt)), env = Float32Array.from(E.hist.slice(-n));
    const est = A.estimateTempo(env, E.histDt);
    if (est && est.conf > 2.4) {
      const t0 = E.tEnd - (n - 1) * E.histDt;
      E.grid = { per: est.period, p0: t0 + est.phase }; E.bpm = est.bpm;
      status(`Beat-synced · ${Math.round(est.bpm)} BPM`);
    }
  }

  // ───────── per-frame update ─────────
  let last = performance.now() / 1000;
  function frame(nowMs) {
    const wall = nowMs / 1000, dt = Math.min(0.1, wall - last); last = wall;
    const t = wall - E.t0;
    const on = C.on && !document.hidden;
    if (cv.style.display !== (on ? 'block' : 'none')) cv.style.display = on ? 'block' : 'none';
    if (!on) { requestAnimationFrame(frame); return; }

    E.lap = 9 * Math.pow(1.4 / 9, C.speed);                      // seconds per lap: 9 s … 1.4 s
    const wantBeat = C.reaction === 'beat' || C.preview;
    let live = false;

    if (C.preview) {                                              // metronome preview at 120 BPM
      E.previewT += dt; while (E.previewT >= 0.5) { E.previewT -= 0.5; fire(0.95, 0); }
      E.presence = 1; live = true;
    } else if (wantBeat) {
      if (capState === 'idle') startCapture();
      if (capState === 'live') {
        updateGrid(cap.ac.currentTime);
        if (E.grid) {                                             // fill in beats the onset detector missed
          const n = Math.floor((E.tEnd - E.grid.p0) / E.grid.per);
          if (n > E.lastGridN) { const tb = E.grid.p0 + n * E.grid.per; if (E.tEnd - tb < 0.1 && E.lastFire < tb - 0.09) fire(0.62, tb); E.lastGridN = n; }
        }
        const sounding = cap.ac.currentTime - E.lastSound < 0.7;
        E.presence += ((sounding ? 1 : 0) - E.presence) * Math.min(1, dt * 3);
        if (!sounding && E.status.indexOf('Beat-synced') === 0) status('Waiting for music…');
        live = true;
      }
    } else {
      if (capState === 'live') stopCapture();
      if (E.status !== 'Constant moving') status('Constant moving');
    }

    E.pulse *= Math.exp(-dt * (13 - C.fade * 10));
    E.boost *= Math.exp(-dt / 0.28);
    let speedMul = 1;
    if (live) {
      speedMul = 0.35 + 0.35 * E.presence + E.boost;              // keeps drifting between beats, surges on each one
      E.level = C.intensity * clamp(0.34 + 0.26 * E.presence + 0.4 * E.pulse, 0, 1.1);
    } else { E.pulse = 0; E.boost = 0; E.level = C.intensity; }
    E.head = (E.head + dt * speedMul / E.lap) % 1;
    draw(t, E.pulse);
    requestAnimationFrame(frame);
  }

  // ───────── drawing ─────────
  const gc = document.createElement('canvas'), gctx = gc.getContext('2d');      // glow layer (low resolution)
  const hc = document.createElement('canvas'), hctx = hc.getContext('2d');      // blurred glow
  let path = null, pathKey = '';

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(64, Math.round(innerWidth * dpr)), h = Math.max(64, Math.round(innerHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }
  addEventListener('resize', sizeCanvas); sizeCanvas();

  // points around the border, clockwise from the top-left corner; u = 0..1 along the whole border
  function buildPath(w, h, lw) {
    const key = `${w}x${h}x${lw.toFixed(2)}`;
    if (key === pathKey) return path;
    const inset = lw / 2, x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset, W = x1 - x0, H = y1 - y0, P = 2 * (W + H);
    const corners = [0, W / P, (W + H) / P, (2 * W + H) / P], us = [];
    const K = 520; for (let i = 0; i < K; i++) us.push(i / K);
    corners.forEach((c) => us.push(c)); us.sort((a, b) => a - b);
    const U = []; for (const u of us) if (!U.length || u - U[U.length - 1] > 1e-6) U.push(u);
    U.push(1);
    const at = (u) => {
      const l = u * P;
      if (l <= W) return [x0 + l, y0];
      if (l <= W + H) return [x1, y0 + (l - W)];
      if (l <= 2 * W + H) return [x1 - (l - W - H), y1];
      return [x0, y1 - (l - 2 * W - H)];
    };
    const pts = U.map(at), segs = [];
    for (let i = 0; i < U.length - 1; i++) {
      const um = (U[i] + U[i + 1]) / 2, l = um * P;
      segs.push({ ax: pts[i][0], ay: pts[i][1], bx: pts[i + 1][0], by: pts[i + 1][1], u: um, edge: l < W ? 'top' : l < W + H ? 'right' : l < 2 * W + H ? 'bottom' : 'left' });
    }
    path = { segs, corners: [[x0, y0, 0, 'top'], [x1, y0, corners[1], 'right'], [x1, y1, corners[2], 'bottom'], [x0, y1, corners[3], 'left']] };
    pathKey = key; return path;
  }

  // brightness of the strip at distance d behind its front end: an even band of length T with very short soft ends
  function profile(d, T) {
    const e = 0.012;
    if (d > T) return 0;
    return ss(d / e) * ss((T - d) / e);
  }

  // brightness + colour at border position u
  function sample(u, t, T, lv, outBase) {
    const ccw = C.direction !== 'cw', s = ccw ? ((1 - u) % 1) : u, n = C.strips;
    let f = 0, x = 1;
    for (let k = 0; k < n; k++) {
      const hs = (E.head + k / n) % 1, d = (((hs - s) % 1) + 1) % 1, v = profile(d, T);
      if (v > f) { f = v; x = d / T; }
    }
    const a = lv * (outBase + (1 - outBase) * f);
    let col = stripColor(x, t);
    const white = 0.3 * E.pulse * f;
    if (white > 0.01) col = mix(col, [255, 255, 255], white);
    return { a, col, f };
  }

  function draw(t, pulse) {
    sizeCanvas();
    const w = cv.width, h = cv.height, minD = Math.min(w, h), dpr = w / innerWidth;
    ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, w, h);
    const lv = E.level; if (lv < 0.01) return;
    const lw = Math.max(1.4 * dpr, minD * (0.0018 + 0.0052 * C.thickness) * (1 + 0.5 * pulse));
    const T = clamp((0.15 + 0.8 * C.tail) * (1 + 0.1 * pulse), 0.1, 0.97) / (C.strips > 1 ? C.strips * 0.75 : 1);
    const outBase = 0.3 * C.outline, ed = C.edges, P = buildPath(w, h, lw);
    const segs = P.segs, vals = new Array(segs.length);
    for (let i = 0; i < segs.length; i++) vals[i] = ed[segs[i].edge] ? sample(segs[i].u, t, T, lv, outBase) : null;

    // soft glow (drawn small, blurred, scaled up)
    if (C.glow > 0.01) {
      const gw = Math.round(w / 4), gh = Math.round(h / 4);
      if (gc.width !== gw || gc.height !== gh) { gc.width = gw; gc.height = gh; hc.width = gw; hc.height = gh; }
      gctx.setTransform(1, 0, 0, 1, 0, 0); gctx.clearRect(0, 0, gw, gh);
      gctx.setTransform(gw / w, 0, 0, gh / h, 0, 0);
      gctx.globalCompositeOperation = 'lighter'; gctx.lineCap = 'butt';
      gctx.lineWidth = minD * (0.006 + 0.05 * C.glow) * (1 + 0.8 * pulse);
      const ga = 0.22 + 0.5 * C.glow;
      for (let i = 0; i < segs.length; i++) {
        const v = vals[i]; if (!v || v.a < 0.02) continue;
        const sg = segs[i]; gctx.strokeStyle = rgba(v.col, v.a * ga);
        gctx.beginPath(); gctx.moveTo(sg.ax, sg.ay); gctx.lineTo(sg.bx, sg.by); gctx.stroke();
      }
      hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.clearRect(0, 0, gw, gh);
      hctx.filter = 'blur(2.5px)'; hctx.drawImage(gc, 0, 0); hctx.filter = 'none';
      ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(hc, 0, 0, w, h);
    }

    // crisp neon line
    ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'butt'; ctx.lineWidth = lw;
    for (let i = 0; i < segs.length; i++) {
      const v = vals[i]; if (!v || v.a < 0.01) continue;
      const sg = segs[i]; ctx.strokeStyle = rgba(v.col, v.a);
      ctx.beginPath(); ctx.moveTo(sg.ax, sg.ay); ctx.lineTo(sg.bx, sg.by); ctx.stroke();
    }
    for (const [cx, cy, cu, edge] of P.corners) {                  // fill the outer corner squares
      if (!ed[edge]) continue;
      const v = sample(cu, t, T, lv, outBase); if (v.a < 0.01) continue;
      ctx.fillStyle = rgba(v.col, v.a); ctx.fillRect(cx - lw / 2, cy - lw / 2, lw, lw);
    }
  }

  // ───────── public ─────────
  function apply(cfg) {
    if (!cfg) return;
    const prevAudio = C.audio;
    C = { ...C, ...cfg, colors: (cfg.colors || C.colors).slice(0, 3), edges: { ...C.edges, ...(cfg.edges || {}) } };
    C.strips = clamp(Math.round(C.strips || 1), 1, 3);
    if (prevAudio !== C.audio) { stopCapture(); capState = 'idle'; }
    if (!C.on || C.reaction !== 'beat') { if (capState === 'live') stopCapture(); }
    if (capState === 'failed' && (!C.on || C.reaction !== 'beat')) capState = 'idle';
  }
  function setAuto(h, s) {              // album-art colours (hue 0-360, saturation 0-1): body colour + deeper ends
    const sat = clamp(s, 0.7, 0.97);
    autoCols = [toHex(...hslRgb(h + 6, sat, 0.62)), toHex(...hslRgb(h - 14, sat, 0.5))];
  }
  const testAttach = (ac) => { cap = { ac, stream: { getTracks: () => [] }, proc: {}, t0: 0 }; capState = 'live'; E.tEnd = 0; };
  requestAnimationFrame(frame);
  return { apply, setAuto, feed, testAttach, fire, state: () => ({ ...E, cap: capState, cfg: C }), retry: () => { if (capState === 'failed') capState = 'idle'; } };
})();
