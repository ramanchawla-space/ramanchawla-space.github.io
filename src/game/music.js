// Procedural rave soundtrack — synthesized entirely with the Web Audio API, so
// there is no audio file to fetch, licence or ship. A single scheduler loop
// lays down a four-on-the-floor kick, an off-beat bass, open/closed hats and a
// filtered acid-style lead, all driven from one BPM clock.
//
// Browsers refuse to start audio before a user gesture, so `start()` must be
// called from a click/keydown handler (the join screen's first click covers
// this) and is a no-op on repeat calls.

const BPM = 128
const STEP = 60 / BPM / 4          // one 16th note
const LOOKAHEAD = 0.12              // seconds of schedule kept queued
const TICK_MS = 25                  // scheduler wake interval

// A short acid-house-style riff, one note per 16th step, two bars (32 steps).
// Semitone offsets from a root of A2 (110 Hz) — minor scale, classic rave lead.
const LEAD_ROOT = 110
const LEAD_STEPS = [
  0, -1, 0, 3, 0, -1, 0, 3, 5, 3, 0, -1, 0, 3, 7, 5,
  0, -1, 0, 3, 0, -1, 0, 3, 5, 3, 5, 7, 5, 3, 0, -1,
]
const BASS_STEPS = [0, 0, -1, 0, 0, 0, -1, 0, 3, 3, 0, 3, 0, 0, -1, 0]

export class Music {
  constructor() {
    this.ctx = null
    this.started = false
    this.muted = false
    this._nextStep = 0
    this._stepIndex = 0
    this._timer = null
    this._masterGain = null
  }

  // Safe to call many times; only the first (post-gesture) call does anything.
  start() {
    if (this.started) return
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    this.started = true

    this.ctx = new Ctx()
    this._masterGain = this.ctx.createGain()
    this._masterGain.gain.value = this.muted ? 0 : 0.55

    // Gentle master compression so the layered synths don't clip together.
    const comp = this.ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.ratio.value = 5
    this._masterGain.connect(comp)
    comp.connect(this.ctx.destination)

    this._nextStep = this.ctx.currentTime + 0.1
    this._stepIndex = 0
    this._timer = setInterval(() => this._schedule(), TICK_MS)
  }

  toggleMute() {
    this.muted = !this.muted
    if (this._masterGain) {
      const now = this.ctx.currentTime
      this._masterGain.gain.cancelScheduledValues(now)
      this._masterGain.gain.linearRampToValueAtTime(this.muted ? 0 : 0.55, now + 0.15)
    }
    return this.muted
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    if (this.ctx) this.ctx.close()
    this.started = false
  }

  // Queue every step whose start time falls within the lookahead window.
  _schedule() {
    const ctx = this.ctx
    while (this._nextStep < ctx.currentTime + LOOKAHEAD) {
      this._playStep(this._stepIndex, this._nextStep)
      this._nextStep += STEP
      this._stepIndex = (this._stepIndex + 1) % 32
    }
  }

  _playStep(i, t) {
    const beat = i % 16
    if (beat % 4 === 0) this._kick(t)
    if (beat % 4 === 2) this._clap(t)
    if (beat % 2 === 1) this._hat(t, true)
    else this._hat(t, false)

    const bassSemi = BASS_STEPS[i % BASS_STEPS.length]
    this._bass(t, LEAD_ROOT / 2 * Math.pow(2, bassSemi / 12))

    // Lead plays a busier two-bar pattern, dropped an octave every other bar
    // for variation, and skips a few steps so it doesn't wall-of-sound.
    if (i % 2 === 0) {
      const semi = LEAD_STEPS[i % LEAD_STEPS.length]
      const freq = LEAD_ROOT * 2 * Math.pow(2, semi / 12)
      this._lead(t, freq)
    }
  }

  // --- Voices ---

  _kick(t) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.09)
    gain.gain.setValueAtTime(1.0, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    osc.connect(gain).connect(this._masterGain)
    osc.start(t)
    osc.stop(t + 0.3)
  }

  _clap(t) {
    const ctx = this.ctx
    const noise = this._noiseSource()
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1500
    bp.Q.value = 1.2
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.7, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    noise.connect(bp).connect(gain).connect(this._masterGain)
    noise.start(t)
    noise.stop(t + 0.2)
  }

  _hat(t, open) {
    const ctx = this.ctx
    const noise = this._noiseSource()
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 7000
    const gain = ctx.createGain()
    const dur = open ? 0.16 : 0.045
    gain.gain.setValueAtTime(open ? 0.22 : 0.16, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
    noise.connect(hp).connect(gain).connect(this._masterGain)
    noise.start(t)
    noise.stop(t + dur + 0.02)
  }

  _bass(t, freq) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const filt = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.value = freq
    filt.type = 'lowpass'
    filt.frequency.setValueAtTime(900, t)
    filt.frequency.exponentialRampToValueAtTime(120, t + STEP * 0.9)
    filt.Q.value = 4
    gain.gain.setValueAtTime(0.5, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + STEP * 0.95)
    osc.connect(filt).connect(gain).connect(this._masterGain)
    osc.start(t)
    osc.stop(t + STEP)
  }

  _lead(t, freq) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const filt = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.value = freq
    filt.type = 'lowpass'
    filt.Q.value = 12
    // Classic acid sweep: filter cutoff races up then decays each note.
    filt.frequency.setValueAtTime(400, t)
    filt.frequency.exponentialRampToValueAtTime(3200, t + 0.03)
    filt.frequency.exponentialRampToValueAtTime(500, t + STEP * 1.7)
    gain.gain.setValueAtTime(0.16, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + STEP * 1.8)
    osc.connect(filt).connect(gain).connect(this._masterGain)
    osc.start(t)
    osc.stop(t + STEP * 1.9)
  }

  _noiseSource() {
    const ctx = this.ctx
    const len = Math.floor(ctx.sampleRate * 0.2)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    return src
  }
}
