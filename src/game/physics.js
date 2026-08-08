import * as THREE from 'three'
import { TRACK_WIDTH } from './track.js'

// Arcade motorbike physics: velocity-based with a lateral grip term, so the
// vehicle can slide sideways under drift but naturally re-aligns to its heading.
// Deliberately forgiving — colleagues playing for 5 minutes should have fun,
// not fight a simulator.

const OFFROAD_DRAG = 0.55        // fraction of speed retained per second off-track
const WALL_OFFSET = TRACK_WIDTH / 2 + 6   // hard limit before we push back

// Fixed simulation step (120Hz). All physics runs at this rate via an
// accumulator so results are frame-rate independent.
const FIXED_DT = 1 / 120
const MAX_ACCUM = 0.25           // never simulate more than 250ms of backlog

// Coasting drag. Light enough that the engine can reach its rated top speed,
// strong enough that releasing the throttle slows you noticeably.
const DRAG_PER_SEC = 0.16

export class RiderPhysics {
  constructor(track, spec, start) {
    this.track = track
    this.spec = spec

    this.position = start.position.clone()
    this.heading = start.heading
    this.velocity = new THREE.Vector3()
    this.speed = 0
    this.lean = 0
    this.steerVis = 0
    this.drifting = false
    this.onDirt = false

    // Lap tracking
    this.lapProgress = 0        // continuous, increases past 1.0 each lap
    this._lastT = track.nearest(this.position).t
    this.lap = 0
    this.finished = false
    this.finishTime = null
    this.wrongWay = false

    this._trackT = this._lastT
  }

  // Public entry point. Splits the frame's elapsed time into fixed-size steps so
  // the simulation is identical regardless of frame rate — a colleague on a
  // 144Hz laptop and one on a 30fps machine must get the same lap times.
  // Without this, drag and acceleration compound differently per step size.
  update(dt, input) {
    this._accum = (this._accum || 0) + dt
    // Cap the backlog so a stalled tab doesn't spiral into hundreds of steps.
    if (this._accum > MAX_ACCUM) this._accum = MAX_ACCUM
    while (this._accum >= FIXED_DT) {
      this._step(FIXED_DT, input)
      this._accum -= FIXED_DT
    }
  }

  _step(dt, input) {
    const spec = this.spec

    // --- Longitudinal ---
    const throttle = input.forward ? 1 : 0
    const braking = input.back ? 1 : 0

    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))

    if (throttle) {
      // Engine force tapers as we approach top speed, so the vehicle settles at
      // its rated maximum instead of fighting drag forever. Quadratic falloff
      // gives strong low-end punch and a smooth approach to terminal speed.
      const fwdSpeed = this.velocity.dot(forward)
      const ratio = THREE.MathUtils.clamp(fwdSpeed / spec.maxSpeed, 0, 1)
      const power = 1 - ratio * ratio
      this.velocity.addScaledVector(forward, spec.accel * power * dt)
    }
    if (braking) {
      // Brake toward zero, then reverse slowly.
      const fwdSpeed = this.velocity.dot(forward)
      if (fwdSpeed > 0.5) {
        this.velocity.addScaledVector(forward, -spec.brake * dt)
      } else {
        this.velocity.addScaledVector(forward, -spec.accel * 0.35 * dt)
      }
    }

    // Rolling resistance + air drag, as a true per-second decay. Coasting bleeds
    // speed harder than driving, so lifting off has a felt effect.
    const dragFactor = throttle ? 1.0 : 2.2
    this.velocity.multiplyScalar(Math.exp(-DRAG_PER_SEC * dragFactor * dt))

    // --- Steering ---
    // Turn rate scales with speed: no pivoting on the spot, and less twitchy
    // at top speed. Peaks around a third of max speed.
    const sp = this.velocity.length()
    const speedFactor = THREE.MathUtils.clamp(sp / (spec.maxSpeed * 0.32), 0, 1)
    const highSpeedDamp = THREE.MathUtils.lerp(1, 0.62, THREE.MathUtils.clamp(sp / spec.maxSpeed, 0, 1))

    let steer = 0
    if (input.left) steer += 1
    if (input.right) steer -= 1

    // Reverse the steering sense when rolling backwards, as a real vehicle does.
    const movingBackwards = this.velocity.dot(forward) < -0.2
    const steerSign = movingBackwards ? -1 : 1

    this.heading += steer * steerSign * spec.turn * speedFactor * highSpeedDamp * dt

    // --- Lateral grip / drift ---
    const newForward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    const right = new THREE.Vector3(newForward.z, 0, -newForward.x)

    const fwdComp = this.velocity.dot(newForward)
    const latComp = this.velocity.dot(right)

    this.drifting = input.drift && sp > 8
    // Holding drift cuts grip, letting the rear step out through a corner.
    const grip = this.drifting ? spec.grip * 0.28 : spec.grip
    const latRetained = latComp * Math.exp(-grip * dt)

    this.velocity.copy(newForward).multiplyScalar(fwdComp).addScaledVector(right, latRetained)

    // --- Speed cap ---
    const cap = spec.maxSpeed * (this.drifting ? 0.93 : 1)
    if (this.velocity.length() > cap) this.velocity.setLength(cap)

    // --- Surface & boundaries ---
    const near = this.track.nearest(this.position, this._trackT)
    this._trackT = near.t
    const absOffset = Math.abs(near.offset)
    this.onDirt = absOffset > TRACK_WIDTH / 2

    if (this.onDirt) {
      // Grass and sand slow you down; heavier the further out you go.
      const severity = THREE.MathUtils.clamp((absOffset - TRACK_WIDTH / 2) / 8, 0, 1)
      this.velocity.multiplyScalar(Math.pow(1 - (1 - OFFROAD_DRAG) * severity, dt))
    }

    // Soft wall: push back toward the road instead of a hard stop.
    if (absOffset > WALL_OFFSET) {
      const dir = Math.sign(near.offset)
      const push = near.side.clone().multiplyScalar(-dir * (absOffset - WALL_OFFSET) * 9)
      this.velocity.add(push.multiplyScalar(dt))
      this.velocity.multiplyScalar(0.965)
      // Clamp position so a fast rider can't tunnel through the barrier.
      const clamped = near.centre.clone().addScaledVector(near.side, dir * WALL_OFFSET)
      this.position.x = clamped.x
      this.position.z = clamped.z
    }

    // --- Integrate ---
    this.position.addScaledVector(this.velocity, dt)
    this.speed = this.velocity.length()

    // Follow the terrain/track height.
    const groundY = near.centre.y
    this.position.y = THREE.MathUtils.lerp(this.position.y, groundY, 1 - Math.pow(0.0001, dt))

    // --- Visual lean: banking into the corner, plus drift kick ---
    const targetLean = -steer * steerSign * THREE.MathUtils.clamp(sp / spec.maxSpeed, 0, 1) * 0.55
      - (latRetained / spec.maxSpeed) * 0.5
    this.lean = THREE.MathUtils.lerp(this.lean, THREE.MathUtils.clamp(targetLean, -0.7, 0.7), 1 - Math.pow(0.005, dt))
    this.steerVis = THREE.MathUtils.lerp(this.steerVis, steer * steerSign, 1 - Math.pow(0.002, dt))

    this._updateProgress(near)
  }

  // Continuous lap progress. Detects wrap-around in both directions so going
  // backwards over the line un-counts the lap rather than banking a free one.
  _updateProgress(near) {
    const t = near.t
    let delta = t - this._lastT

    if (delta > 0.5) delta -= 1        // wrapped backwards over the start line
    else if (delta < -0.5) delta += 1  // wrapped forwards over the start line

    // Ignore absurd jumps (e.g. a respawn) rather than banking phantom distance.
    if (Math.abs(delta) < 0.25) {
      this.lapProgress += delta
    }
    this._lastT = t

    this.lap = Math.max(0, Math.floor(this.lapProgress))

    // Wrong-way warning: moving against the track tangent at speed.
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    this.wrongWay = this.speed > 5 && forward.dot(near.tangent) < -0.35
  }

  // Total distance travelled along the circuit, used for live position ranking.
  get raceDistance() {
    return this.lapProgress * this.track.length
  }

  respawn() {
    const near = this.track.nearest(this.position, this._trackT)
    this.position.copy(near.centre)
    this.position.y += 0.2
    this.heading = Math.atan2(near.tangent.x, near.tangent.z)
    this.velocity.set(0, 0, 0)
    this.speed = 0
  }
}
