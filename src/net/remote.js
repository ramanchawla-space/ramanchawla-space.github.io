import * as THREE from 'three'

// Snapshot interpolation for remote riders.
//
// Network updates arrive ~15/s but we render at 60fps. Rather than snapping to
// each packet (which looks like teleporting), we render remote riders slightly
// in the past and interpolate between the two snapshots bracketing that time.
// 120ms of delay is enough to smooth over normal office-wifi jitter.

const INTERP_DELAY = 0.12
const BUFFER_MAX = 20

export class RemoteRider {
  constructor() {
    this.buffer = []
    this.position = new THREE.Vector3()
    this.heading = 0
    this.lean = 0
    this.speed = 0
    this.drifting = false
    this.onDirt = false
    this.lapProgress = 0
    this._hasSnapshot = false
  }

  // now = local clock in seconds
  push(state, now) {
    this.buffer.push({
      t: now,
      pos: new THREE.Vector3(state.x, state.y, state.z),
      heading: state.h,
      lean: state.l || 0,
      speed: state.s || 0,
      drifting: !!state.d,
      onDirt: !!state.o,
      lapProgress: state.p || 0,
    })
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift()

    if (!this._hasSnapshot) {
      this.position.copy(this.buffer[0].pos)
      this.heading = this.buffer[0].heading
      this._hasSnapshot = true
    }
  }

  update(now) {
    if (this.buffer.length === 0) return

    const renderTime = now - INTERP_DELAY

    // Drop snapshots we've moved past, but always keep one to interpolate from.
    while (this.buffer.length > 2 && this.buffer[1].t <= renderTime) {
      this.buffer.shift()
    }

    const a = this.buffer[0]
    const b = this.buffer[1]

    if (!b) {
      // No newer snapshot yet — extrapolate briefly along the last heading so
      // a dropped packet reads as continued motion rather than a freeze.
      const ahead = Math.min(renderTime - a.t, 0.25)
      if (ahead > 0 && a.speed > 0.5) {
        const dir = new THREE.Vector3(Math.sin(a.heading), 0, Math.cos(a.heading))
        this.position.copy(a.pos).addScaledVector(dir, a.speed * ahead)
      } else {
        this.position.copy(a.pos)
      }
      this.heading = a.heading
      this.lean = a.lean
      this.speed = a.speed
      this.drifting = a.drifting
      this.onDirt = a.onDirt
      this.lapProgress = a.lapProgress
      return
    }

    const span = b.t - a.t
    const alpha = span > 1e-4 ? THREE.MathUtils.clamp((renderTime - a.t) / span, 0, 1) : 1

    this.position.lerpVectors(a.pos, b.pos, alpha)
    this.heading = lerpAngle(a.heading, b.heading, alpha)
    this.lean = THREE.MathUtils.lerp(a.lean, b.lean, alpha)
    this.speed = THREE.MathUtils.lerp(a.speed, b.speed, alpha)
    this.lapProgress = THREE.MathUtils.lerp(a.lapProgress, b.lapProgress, alpha)
    this.drifting = b.drifting
    this.onDirt = b.onDirt
  }
}

// Interpolate headings the short way round so crossing ±π doesn't spin the bike.
function lerpAngle(a, b, t) {
  let diff = (b - a) % (Math.PI * 2)
  if (diff > Math.PI) diff -= Math.PI * 2
  if (diff < -Math.PI) diff += Math.PI * 2
  return a + diff * t
}
