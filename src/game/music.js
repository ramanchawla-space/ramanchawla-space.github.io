// Procedural rave soundtrack — synthesized entirely with the Web Audio API, so
// there is no audio file to fetch, licence or ship.
//
// Rather than one bar looped forever, this plays a rotating PLAYLIST of
// distinct tracks. Each track has its own BPM, key and lead/bass character,
// and a real arrangement (intro -> build -> drop -> breakdown -> drop ->
// outro) built from short musical phrases instead of one riff repeated
// unchanged. When a track's arrangement finishes, the next track in a
// shuffled play order fades in automatically — like a DJ set, not a loop.
//
// Browsers refuse to start audio before a user gesture, so `start()` must be
// called from a click/keydown handler (the join screen's first click covers
// this) and is a no-op on repeat calls.

const LOOKAHEAD = 0.15              // seconds of schedule kept queued
const TICK_MS = 25                  // scheduler wake interval
const XFADE = 1.4                   // seconds to crossfade between tracks

// --- Musical building blocks -----------------------------------------------
// Phrases are semitone offsets from a track's root, one entry per 16th step.
// `null` = rest. Sections below reference these by name so a track's
// arrangement is a sequence of *different* phrases, not one bar on repeat.

const PHRASE = {
  // Basslines
  bassPulse:   [0, null, null, 0, null, null, 0, null, 0, null, null, 0, null, null, 0, null],
  bassDrive:   [0, 0, null, 0, 0, null, 0, 0, 3, 3, null, 3, 0, null, -2, null],
  bassOffbeat: [null, 0, null, 0, null, 0, null, 0, null, 3, null, 3, null, 0, null, -2],
  bassRoot:    [0, null, null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null],

  // Leads / stabs (two bars, 32 steps) — each track picks a couple of these
  // and alternates them across sections so the melody actually develops.
  leadA: [0, 3, 7, 3, 0, 3, 7, 10, 0, 3, 7, 3, 5, 7, 10, 12,
          0, 3, 7, 3, 0, 3, 7, 10, 12, 10, 7, 5, 3, 0, null, null],
  leadB: [12, 10, 7, 5, 3, 5, 7, 5, 0, null, 3, null, 7, null, 10, null,
          12, 10, 7, 5, 3, 5, 7, 10, 12, 15, 12, 10, 7, 5, 3, 0],
  leadC: [0, null, 7, null, 5, null, 7, null, 0, null, 7, null, 3, null, 5, null,
          10, null, 7, null, 5, null, 3, null, 0, null, null, null, null, null, null, null],
  stab:  [0, null, null, null, 5, null, null, null, 7, null, null, null, 3, null, null, null],
}

// A track = a full song. `sections` is the arrangement in play order; each
// section names a length in bars and which phrases/layers are active, so the
// energy genuinely rises and falls instead of looping flat.
const TRACKS = [
  {
    name: 'Paddy Field Anthem', bpm: 132, root: 220, minor: true,
    lead: 'saw', bass: 'saw',
    sections: [
      { bars: 4,  kick: false, bass: null,          lead: null,   hats: 'closed' },
      { bars: 4,  kick: true,  bass: 'bassPulse',    lead: null,   hats: 'closed' },
      { bars: 8,  kick: true,  bass: 'bassDrive',    lead: 'leadA', hats: 'open', clap: true },
      { bars: 8,  kick: true,  bass: 'bassOffbeat',  lead: 'leadB', hats: 'open', clap: true, riser: true },
      { bars: 4,  kick: false, bass: 'bassRoot',     lead: 'leadC', hats: 'closed' },
      { bars: 8,  kick: true,  bass: 'bassDrive',    lead: 'leadB', hats: 'open', clap: true },
      { bars: 4,  kick: true,  bass: 'bassPulse',    lead: 'stab', hats: 'closed', clap: true },
    ],
  },
  {
    name: 'Causeway Overdrive', bpm: 140, root: 174.6 /* F3 */, minor: true,
    lead: 'square', bass: 'saw',
    sections: [
      { bars: 4,  kick: false, bass: 'bassRoot',     lead: null,   hats: 'closed' },
      { bars: 4,  kick: true,  bass: 'bassOffbeat',  lead: null,   hats: 'closed', riser: true },
      { bars: 8,  kick: true,  bass: 'bassDrive',    lead: 'leadC', hats: 'open', clap: true },
      { bars: 8,  kick: true,  bass: 'bassDrive',    lead: 'leadA', hats: 'open', clap: true },
      { bars: 4,  kick: false, bass: null,           lead: 'stab', hats: 'closed' },
      { bars: 8,  kick: true,  bass: 'bassOffbeat',  lead: 'leadA', hats: 'open', clap: true, riser: true },
      { bars: 4,  kick: true,  bass: 'bassPulse',    lead: 'leadC', hats: 'closed', clap: true },
    ],
  },
  {
    name: 'Volcano Acid', bpm: 136, root: 130.8 /* C3 */, minor: false,
    lead: 'saw', bass: 'square',
    sections: [
      { bars: 4,  kick: false, bass: 'bassPulse',    lead: null,   hats: 'closed' },
      { bars: 4,  kick: true,  bass: 'bassPulse',    lead: 'stab', hats: 'closed' },
      { bars: 8,  kick: true,  bass: 'bassDrive',    lead: 'leadB', hats: 'open', clap: true },
      { bars: 4,  kick: false, bass: 'bassRoot',     lead: 'leadC', hats: 'closed', riser: true },
      { bars: 8,  kick: true,  bass: 'bassOffbeat',  lead: 'leadA', hats: 'open', clap: true },
      { bars: 8,  kick: true,  bass: 'bassDrive',    lead: 'leadB', hats: 'open', clap: true, riser: true },
      { bars: 4,  kick: true,  bass: 'bassPulse',    lead: 'stab', hats: 'closed', clap: true },
    ],
  },
]

export class Music {
  constructor() {
    this.ctx = null
    this.started = false
    this.muted = false
    this._timer = null
    this._masterGain = null
    this._trackGain = null      // per-track gain node, used to crossfade
    this._nextStep = 0
    this._stepIndex = 0
    this._playOrder = []
    this._playIdx = -1
    this._track = null
    this._plan = []             // flattened per-step section lookup for current track
    this._queuedNextAt = null   // step count remaining before we trigger the next track
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

    this._shufflePlaylist()
    this._loadTrack(this._nextInPlaylist(), this.ctx.currentTime + 0.1)

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

  // --- Playlist -------------------------------------------------------------

  _shufflePlaylist() {
    this._playOrder = TRACKS.map((_, i) => i)
    for (let i = this._playOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[this._playOrder[i], this._playOrder[j]] = [this._playOrder[j], this._playOrder[i]]
    }
    this._playIdx = -1
  }

  _nextInPlaylist() {
    this._playIdx++
    if (this._playIdx >= this._playOrder.length) this._shufflePlaylist(), this._playIdx = 0
    return TRACKS[this._playOrder[this._playIdx]]
  }

  // Build the current track's step-by-step plan and (re)start its clock.
  // `at` is the audio-context time the first step should play.
  _loadTrack(track, at) {
    this._track = track
    this._step = 60 / track.bpm / 4
    this._plan = flattenSections(track.sections)
    this._stepIndex = 0
    this._nextStep = at

    // A fresh gain node per track makes the crossfade trivial: fade the old
    // one out and disconnect it once silent, fade the new one in from zero.
    const prevGain = this._trackGain
    const g = this.ctx.createGain()
    g.gain.value = 0
    g.connect(this._masterGain)
    g.gain.linearRampToValueAtTime(1, at + XFADE)
    this._trackGain = g

    if (prevGain) {
      prevGain.gain.cancelScheduledValues(at)
      prevGain.gain.setValueAtTime(prevGain.gain.value, at)
      prevGain.gain.linearRampToValueAtTime(0, at + XFADE)
      setTimeout(() => { try { prevGain.disconnect() } catch {} }, (XFADE + 0.5) * 1000)
    }
  }

  // Queue every step whose start time falls within the lookahead window.
  _schedule() {
    const ctx = this.ctx
    while (this._nextStep < ctx.currentTime + LOOKAHEAD) {
      const done = this._stepIndex >= this._plan.length
      if (done) {
        // Track finished its arrangement — start the next one now, crossfading.
        this._loadTrack(this._nextInPlaylist(), this._nextStep)
        continue
      }
      this._playStep(this._plan[this._stepIndex], this._stepIndex, this._nextStep)
      this._nextStep += this._step
      this._stepIndex++
    }
  }

  _playStep(section, i, t) {
    const track = this._track
    const beat = i % 16
    const out = this._trackGain

    if (section.kick && beat % 4 === 0) this._kick(t, out)
    if (section.clap && beat % 4 === 2) this._clap(t, out)
    if (section.hats === 'open' && beat % 2 === 1) this._hat(t, true, out)
    else if (section.hats) this._hat(t, false, out)

    if (section.bass) {
      const semi = PHRASE[section.bass][i % 16]
      if (semi !== null) this._bass(t, track.root / 2 * semitone(semi, track.minor), track.bass, out)
    }
    if (section.lead && i % 2 === 0) {
      const phrase = PHRASE[section.lead]
      const semi = phrase[i % phrase.length]
      if (semi !== null) this._lead(t, track.root * 2 * semitone(semi, track.minor), track.lead, out)
    }
    // A rising filtered-noise sweep in the last bar of a build section, the
    // classic "here comes the drop" cue.
    if (section.riser && beat === 0 && i % 64 >= 48) this._riser(t, out)
  }

  // --- Voices -----------------------------------------------------------

  _kick(t, out) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.09)
    gain.gain.setValueAtTime(1.0, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    osc.connect(gain).connect(out)
    osc.start(t)
    osc.stop(t + 0.3)
  }

  _clap(t, out) {
    const ctx = this.ctx
    const noise = this._noiseSource()
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1500
    bp.Q.value = 1.2
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.7, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    noise.connect(bp).connect(gain).connect(out)
    noise.start(t)
    noise.stop(t + 0.2)
  }

  _hat(t, open, out) {
    const ctx = this.ctx
    const noise = this._noiseSource()
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 7000
    const gain = ctx.createGain()
    const dur = open ? 0.16 : 0.045
    gain.gain.setValueAtTime(open ? 0.22 : 0.16, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
    noise.connect(hp).connect(gain).connect(out)
    noise.start(t)
    noise.stop(t + dur + 0.02)
  }

  _bass(t, freq, wave, out) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const filt = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = wave
    osc.frequency.value = freq
    filt.type = 'lowpass'
    filt.frequency.setValueAtTime(900, t)
    filt.frequency.exponentialRampToValueAtTime(120, t + this._step * 0.9)
    filt.Q.value = 4
    gain.gain.setValueAtTime(0.5, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + this._step * 0.95)
    osc.connect(filt).connect(gain).connect(out)
    osc.start(t)
    osc.stop(t + this._step)
  }

  _lead(t, freq, wave, out) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const filt = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = wave
    osc.frequency.value = freq
    filt.type = 'lowpass'
    filt.Q.value = 12
    // Classic acid sweep: filter cutoff races up then decays each note.
    filt.frequency.setValueAtTime(400, t)
    filt.frequency.exponentialRampToValueAtTime(3200, t + 0.03)
    filt.frequency.exponentialRampToValueAtTime(500, t + this._step * 1.7)
    gain.gain.setValueAtTime(0.16, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + this._step * 1.8)
    osc.connect(filt).connect(gain).connect(out)
    osc.start(t)
    osc.stop(t + this._step * 1.9)
  }

  // A white-noise sweep with a filter cutoff rising over ~2 bars — the
  // "tension building to a drop" riser used throughout dance music.
  _riser(t, out) {
    const ctx = this.ctx
    const dur = this._step * 16
    const noise = this._noiseSource(dur)
    const filt = ctx.createBiquadFilter()
    filt.type = 'bandpass'
    filt.Q.value = 0.8
    filt.frequency.setValueAtTime(200, t)
    filt.frequency.exponentialRampToValueAtTime(9000, t + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.35, t + dur * 0.9)
    gain.gain.linearRampToValueAtTime(0, t + dur)
    noise.connect(filt).connect(gain).connect(out)
    noise.start(t)
    noise.stop(t + dur)
  }

  _noiseSource(seconds = 0.2) {
    const ctx = this.ctx
    const len = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    return src
  }
}

// Semitone offset -> frequency ratio, snapped to a minor or major scale so
// basslines and leads always land in key even as phrases jump around.
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
function semitone(n, minor) {
  const scale = minor ? MINOR_SCALE : MAJOR_SCALE
  const octave = Math.floor(n / scale.length)
  const idx = ((n % scale.length) + scale.length) % scale.length
  const semi = octave * 12 + scale[idx]
  return Math.pow(2, semi / 12)
}

// Expand a track's `sections` (bars + flags) into one entry per 16th-note
// step, so the scheduler can just walk an array without tracking section
// boundaries itself.
function flattenSections(sections) {
  const plan = []
  for (const section of sections) {
    const steps = section.bars * 16
    for (let i = 0; i < steps; i++) plan.push(section)
  }
  return plan
}
