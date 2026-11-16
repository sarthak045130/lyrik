// Beat analysis shared by file mode (whole song) and live mode (streamed audio).
// 1. EnvBuilder turns raw samples into an "onset strength" envelope (kick band + hi-hat/snare band).
// 2. estimateTempo() finds BPM + beat phase from an envelope.
// 3. pickOnsets() finds the individual hits (used to place notes in file mode).
window.Analyzer = (() => {
  const HOP = 512;

  class EnvBuilder {
    constructor(sr) {
      this.sr = sr; this.dt = HOP / sr;
      this.a = 1 - Math.exp(-2 * Math.PI * 160 / sr);          // ~160 Hz low-pass (kick / bass)
      this.lp = 0; this.prev = 0; this.n = 0; this.eL = 0; this.eH = 0;
      this.pL = 0; this.pH = 0; this.level = 0;
    }
    // returns an array of envelope values for the frames completed by this chunk
    push(x) {
      const out = [];
      for (let i = 0; i < x.length; i++) {
        const s = x[i];
        this.lp += this.a * (s - this.lp);
        const d = s - this.prev; this.prev = s;
        this.eL += this.lp * this.lp; this.eH += d * d; this.level += s * s;
        if (++this.n === HOP) {
          const L = Math.log(1 + 4000 * this.eL / HOP), H = Math.log(1 + 12000 * this.eH / HOP);
          const v = Math.max(0, L - this.pL) * 1.0 + Math.max(0, H - this.pH) * 0.7;
          this.pL = L; this.pH = H; out.push({ v, rms: Math.sqrt(this.level / HOP) });
          this.n = 0; this.eL = this.eH = this.level = 0;
        }
      }
      return out;
    }
  }

  function envelopeOf(samples, sr) {
    const b = new EnvBuilder(sr), env = new Float32Array(Math.floor(samples.length / HOP));
    let k = 0;
    const CH = 65536;
    for (let i = 0; i < samples.length; i += CH) {
      for (const f of b.push(samples.subarray(i, Math.min(samples.length, i + CH)))) if (k < env.length) env[k++] = f.v;
    }
    return { env, dt: HOP / sr };
  }

  function detrend(env, dt) {
    const n = env.length, w = Math.max(2, Math.round(0.4 / dt)), cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + env[i];
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
      e[i] = Math.max(0, env[i] - (cs[b] - cs[a]) / (b - a));
    }
    return e;
  }

  // Returns { bpm, period, phase, conf } — phase = time (s, envelope clock) of some beat in [0, period).
  function estimateTempo(env, dt, bpmMin = 75, bpmMax = 165) {
    const n = env.length;
    if (n < 4 / dt) return null;
    const e = detrend(env, dt);
    const lagMin = Math.floor(60 / bpmMax / dt), lagMax = Math.ceil(60 / bpmMin / dt);
    const ac = new Float64Array(lagMax * 2 + 2);
    for (let l = lagMin; l < ac.length; l++) {
      let s = 0; for (let i = 0; i + l < n; i++) s += e[i] * e[i + l]; ac[l] = s / (n - l);
    }
    let best = 0, bl = 0, sum = 0, cnt = 0;
    for (let l = lagMin; l <= lagMax; l++) {
      const bpm = 60 / (l * dt), prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.7, 2));
      const sc = (ac[l] + 0.5 * ac[2 * l] + 0.25 * (ac[l >> 1] || 0)) * prior;
      sum += sc; cnt++;
      if (sc > best) { best = sc; bl = l; }
    }
    if (!bl || best <= 0) return null;
    const conf = best / (sum / cnt);
    // fine search: tempo ±3 % and phase, scoring a comb of beats over the whole window
    const comb = (period) => {
      const pf = period / dt; let bestS = -1, bestP = 0;
      for (let p = 0; p < pf; p += 1) {
        let s = 0;
        for (let t = p; t < n - 1; t += pf) {
          const i = Math.round(t); s += e[i] + 0.5 * (e[i - 1] || 0) + 0.5 * (e[i + 1] || 0);
        }
        if (s > bestS) { bestS = s; bestP = p; }
      }
      return [bestS / (n / pf), bestP * dt];
    };
    let bestPeriod = bl * dt, bestScore = -1, bestPhase = 0;
    const base = bl * dt;
    for (let f = 0.97; f <= 1.03; f += 0.002) {
      const [s, ph] = comb(base * f);
      if (s > bestScore) { bestScore = s; bestPeriod = base * f; bestPhase = ph; }
    }
    return { bpm: 60 / bestPeriod, period: bestPeriod, phase: bestPhase, conf };
  }

  // Individual onsets (time in seconds, strength). Local-adaptive threshold + local maxima.
  function pickOnsets(env, dt, minGap = 0.12) {
    const n = env.length, w = Math.round(0.6 / dt), out = [];
    const cs = new Float64Array(n + 1), cs2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { cs[i + 1] = cs[i] + env[i]; cs2[i + 1] = cs2[i] + env[i] * env[i]; }
    let last = -9;
    for (let i = 2; i < n - 2; i++) {
      const v = env[i];
      if (v < env[i - 1] || v < env[i + 1] || v < env[i - 2] || v < env[i + 2]) continue;
      const a = Math.max(0, i - w), b = Math.min(n, i + w + 1), m = (cs[b] - cs[a]) / (b - a);
      const sd = Math.sqrt(Math.max(0, (cs2[b] - cs2[a]) / (b - a) - m * m));
      if (v < m + 0.9 * sd || v < 0.25) continue;
      const t = (i + 0.5) * dt;
      if (t - last < minGap) {                                 // keep the stronger of two close hits
        if (out.length && v > out[out.length - 1].s) { out[out.length - 1] = { t, s: v }; last = t; }
        continue;
      }
      out.push({ t, s: v }); last = t;
    }
    return out;
  }

  return { HOP, EnvBuilder, envelopeOf, estimateTempo, pickOnsets };
})();
