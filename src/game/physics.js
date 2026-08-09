import * as THREE from 'three'

// Arcade motorbike physics: velocity-based with a lateral grip term, so the
// vehicle can slide sideways under drift but naturally re-aligns to its heading.
// Deliberately forgiving — colleagues playing for 5 minutes should have fun,
// not fight a simulator.

const OFFROAD_DRAG = 0.55        // fraction of speed retained per second off-track
const WALL_MARGIN = 6            // metres past the road edge before we push back

// Fixed simulation step (120Hz). All physics runs at this rate via an
// accumulator so results are frame-rate independent.
const FIXED_DT = 1 / 120
const MAX_ACCUM = 0.25           // never simulate more than 250ms of backlog

// Coasting drag. Light enough that the engine can reach its rated top speed,
// strong enough that releasing the throttle slows you noticeably.
const DRAG_PER_SEC = 0.16

// After a hazard hit, ignore that same hazard for a moment. Without this a
// rider sitting in a mud patch takes the speed penalty 120 times a second and
// stops dead, which feels broken rather than difficult.
const HIT_COOLDOWN = 0.85

// Falling off the causeway: how long the plunge lasts before we fish you out.
const RESPAWN_DELAY = 1.4

export class RiderPhysics {
  constructor(track, spec, start, obstacles = null) {
    this.track = track
    this.spec = spec
    this.obstacles = obstacles

    this.position = start.position.clone()
    this.heading = start.heading
    this.velocity = new THREE.Vector3()
    this.speed = 0
    this.lean = 0
    this.steerVis = 0
    this.drifting = false
    this.onDirt = false

    // Hazard state, read by the renderer and HUD.
    this.spinOut = 0            // seconds of reduced control remaining
    this.onFire = 0             // seconds of scorch effect remaining
    this.inWater = false
    this.falling = false
    this._fallTimer = 0
    this.lastHit = null         // { type, warn } for the most recent contact
    this.hitFlash = 0           // counts down; drives the HUD impact flash
    this._cooldowns = new Map() // hazard item -> seconds until it can hit again

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

    // Tick down all the timed hazard states.
    this.spinOut = Math.max(0, this.spinOut - dt)
    this.onFire = Math.max(0, this.onFire - dt)
    this.hitFlash = Math.max(0, this.hitFlash - dt)
    for (const [k, v] of this._cooldowns) {
      const left = v - dt
      if (left <= 0) this._cooldowns.delete(k)
      else this._cooldowns.set(k, left)
    }

    // Plunging off the causeway: no control at all until we respawn you.
    if (this.falling) {
      this._fallTimer -= dt
      this.velocity.y -= 22 * dt
      this.position.addScaledVector(this.velocity, dt)
      this.speed = 0
      if (this._fallTimer <= 0) this.respawn()
      return
    }

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

    // A spin-out (fire, oil, pothole) partly overrides your steering with an
    // involuntary rotation, so you have to ride it out rather than instantly
    // correcting.
    let steerAuthority = 1
    if (this.spinOut > 0) {
      steerAuthority = 0.35
      this.heading += this._spinDir * this.spinOut * 2.6 * dt
    }

    this.heading += steer * steerSign * spec.turn * speedFactor * highSpeedDamp * steerAuthority * dt

    // --- Lateral grip / drift ---
    const newForward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))
    const right = new THREE.Vector3(newForward.z, 0, -newForward.x)

    const fwdComp = this.velocity.dot(newForward)
    const latComp = this.velocity.dot(right)

    this.drifting = input.drift && sp > 8
    // Holding drift cuts grip, letting the rear step out through a corner.
    // A spin-out cuts it further — that is what makes oil and fire dangerous.
    let grip = this.drifting ? spec.grip * 0.28 : spec.grip
    if (this.spinOut > 0) grip *= 0.3
    const latRetained = latComp * Math.exp(-grip * dt)

    this.velocity.copy(newForward).multiplyScalar(fwdComp).addScaledVector(right, latRetained)

    // --- Speed cap ---
    const cap = spec.maxSpeed * (this.drifting ? 0.93 : 1)
    if (this.velocity.length() > cap) this.velocity.setLength(cap)

    // --- Surface & boundaries ---
    const near = this.track.nearest(this.position, this._trackT)
    this._trackT = near.t
    const absOffset = Math.abs(near.offset)
    const half = near.halfWidth
    this.onDirt = absOffset > half
    this.zone = near.zone

    if (this.onDirt) {
      // Grass and sand slow you down; heavier the further out you go.
      const severity = THREE.MathUtils.clamp((absOffset - half) / 8, 0, 1)
      this.velocity.multiplyScalar(Math.pow(1 - (1 - OFFROAD_DRAG) * severity, dt))
    }

    // --- Hazards ---
    if (this.obstacles) this._resolveHazards(dt, near)

    // --- Edge handling ---
    // On the causeway there is no verge and no barrier: run wide and you go
    // into the river. Everywhere else a soft wall pushes you back.
    const onCauseway = near.zone?.name === 'causeway'

    if (onCauseway) {
      if (absOffset > half + 0.6) {
        this._beginFall()
        return
      }
    } else {
      const wallOffset = half + WALL_MARGIN
      if (absOffset > wallOffset) {
        const dir = Math.sign(near.offset)
        const push = near.side.clone().multiplyScalar(-dir * (absOffset - wallOffset) * 9)
        this.velocity.add(push.multiplyScalar(dt))
        this.velocity.multiplyScalar(0.965)
        // Clamp position so a fast rider can't tunnel through the barrier.
        const clamped = near.centre.clone().addScaledVector(near.side, dir * wallOffset)
        this.position.x = clamped.x
        this.position.z = clamped.z
      }
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

  // Test the rider against nearby hazards and apply the first contact found.
  // Only one hazard resolves per step: stacking a boulder and a mud patch in the
  // same tick would scrub nearly all your speed at once.
  _resolveHazards(dt, near) {
    const hits = this.obstacles.near(this.position, near.t, 3.2)
    for (const item of hits) {
      if (this._cooldowns.has(item)) continue

      const dx = this.position.x - item.position.x
      const dz = this.position.z - item.position.z
      const dist = Math.hypot(dx, dz)
      // Rider hitbox is a ~1.1m circle; hazards use their declared radius.
      if (dist > item.radius + 1.1) continue

      this._applyHit(item, dx, dz, dist, near)
      this._cooldowns.set(item, HIT_COOLDOWN)
      break
    }
  }

  _applyHit(item, dx, dz, dist, near) {
    const { effect, factor, kick } = item.spec
    const impactSpeed = this.speed

    this.lastHit = { type: item.type, warn: item.spec.warn }
    this.hitFlash = 0.4

    if (effect === 'slow') {
      // Mud and debris: bleed speed, no loss of control.
      this.velocity.multiplyScalar(factor)
    } else if (effect === 'bump') {
      // Solid objects: scrub speed hard and deflect off the contact normal, so
      // clipping a rock's edge throws you sideways rather than stopping you.
      this.velocity.multiplyScalar(factor)
      if (dist > 0.001 && kick > 0) {
        const nx = dx / dist
        const nz = dz / dist
        const strength = kick * THREE.MathUtils.clamp(impactSpeed / this.spec.maxSpeed, 0.35, 1)
        this.velocity.x += nx * strength
        this.velocity.z += nz * strength
        // Push clear of the obstacle so we can't get wedged inside it.
        const overlap = item.radius + 1.1 - dist
        if (overlap > 0) {
          this.position.x += nx * overlap
          this.position.z += nz * overlap
        }
      }
      // A big enough impact also unsettles the bike.
      if (impactSpeed > this.spec.maxSpeed * 0.45) {
        this.spinOut = Math.max(this.spinOut, 0.5)
        this._spinDir = Math.sign(dx * near.side.x + dz * near.side.z) || 1
      }
    } else if (effect === 'spin') {
      // Fire, oil, potholes: you keep most of your speed but lose the front end.
      this.velocity.multiplyScalar(factor)
      this.spinOut = Math.max(this.spinOut, item.type === 'oil' ? 1.1 : 0.75)
      this._spinDir = (near.offset >= 0 ? 1 : -1) * (item.type === 'oil' ? 1 : -1)
      if (item.type === 'fire') this.onFire = 1.6
    }
  }

  _beginFall() {
    this.falling = true
    this.inWater = true
    this._fallTimer = RESPAWN_DELAY
    this.velocity.y = 1.5
    this.velocity.x *= 0.6
    this.velocity.z *= 0.6
    this.lastHit = { type: 'water', warn: 'SPLASH!' }
    this.hitFlash = 0.6
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

  // The hazard the HUD should be warning about, if any.
  get warning() {
    if (!this.obstacles) return null
    return this.obstacles.nextWarning(this._trackT)
  }

  respawn() {
    const near = this.track.nearest(this.position, this._trackT)
    this.position.copy(near.centre)
    this.position.y += 0.2
    this.heading = Math.atan2(near.tangent.x, near.tangent.z)
    this.velocity.set(0, 0, 0)
    this.speed = 0
    this.falling = false
    this.inWater = false
    this.spinOut = 0
    this.onFire = 0
    this._fallTimer = 0
  }
}
