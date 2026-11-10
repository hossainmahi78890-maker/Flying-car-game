/* All sounds are synthesised with Web Audio — no audio files needed. */

const KEY = "hte_muted";

export class Sound {
  constructor() {
    this.ctx = null;
    try {
      this.muted = localStorage.getItem(KEY) === "1";
    } catch {
      this.muted = false;
    }
  }

  /** Must be called from a user gesture (browsers block audio before one). */
  init() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    // Diesel engine: two detuned oscillators through a low-pass filter.
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = "lowpass";
    this.engFilter.frequency.value = 500;
    this.engFilter.connect(this.engGain).connect(this.master);
    this.engA = ctx.createOscillator();
    this.engA.type = "sawtooth";
    this.engB = ctx.createOscillator();
    this.engB.type = "square";
    this.engA.connect(this.engFilter);
    const sub = ctx.createGain();
    sub.gain.value = 0.5;
    this.engB.connect(sub).connect(this.engFilter);
    this.engA.start();
    this.engB.start();

    // White noise for doors, scrapes and crashes.
    const len = ctx.sampleRate * 1.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m) {
    this.muted = m;
    try {
      localStorage.setItem(KEY, m ? "1" : "0");
    } catch {}
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  /** rpm 0..1 within the current gear, load 0..1 (throttle). */
  engine(on, rpm, load) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 30 + rpm * 62;
    this.engA.frequency.setTargetAtTime(f, t, 0.06);
    this.engB.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(320 + load * 650 + rpm * 520, t, 0.08);
    this.engGain.gain.setTargetAtTime(on ? 0.05 + load * 0.06 + rpm * 0.03 : 0, t, 0.12);
  }

  hornOn() {
    if (!this.ctx || this.horn) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(0.12, ctx.currentTime, 0.01);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 2400;
    f.connect(g).connect(this.master);
    const oscs = [392, 494, 587].map((freq) => {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = freq;
      o.connect(f);
      o.start();
      return o;
    });
    this.horn = { g, oscs };
  }

  hornOff() {
    if (!this.horn) return;
    const { g, oscs } = this.horn;
    const t = this.ctx.currentTime;
    g.gain.setTargetAtTime(0, t, 0.03);
    oscs.forEach((o) => o.stop(t + 0.2));
    this.horn = null;
  }

  _burst({ dur, type, freq, q = 1, gain, attack = 0.005 }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  _tone(freq, dur, gain = 0.08, type = "sine", delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  door() {
    this._burst({ dur: 0.7, type: "bandpass", freq: 1500, q: 0.8, gain: 0.16, attack: 0.02 });
  }
  tick() {
    this._tone(880, 0.09, 0.06);
  }
  scrape() {
    this._burst({ dur: 0.35, type: "highpass", freq: 2200, gain: 0.12 });
  }
  crash() {
    this._burst({ dur: 0.9, type: "lowpass", freq: 700, gain: 0.5 });
    this._tone(55, 0.6, 0.35);
  }
  chime() {
    this._tone(660, 0.35, 0.07, "triangle");
    this._tone(880, 0.5, 0.07, "triangle", 0.18);
  }
}
