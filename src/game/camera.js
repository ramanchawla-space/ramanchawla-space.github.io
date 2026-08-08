import * as THREE from 'three'

// Chase camera that trails the rider with speed-dependent pull-back and FOV
// widening, which is what actually sells the sense of speed.

const BASE_DIST = 8.2
const BASE_HEIGHT = 3.4
const BASE_FOV = 62

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera
    this.camera.fov = BASE_FOV
    this.camera.updateProjectionMatrix()

    this._pos = new THREE.Vector3()
    this._look = new THREE.Vector3()
    this._initialised = false
    this.shake = 0
  }

  // Cinematic orbit used in the lobby and on the results screen.
  orbit(target, elapsed, radius = 16, height = 7) {
    const a = elapsed * 0.22
    this.camera.position.set(
      target.x + Math.sin(a) * radius,
      target.y + height,
      target.z + Math.cos(a) * radius
    )
    this.camera.lookAt(target.x, target.y + 1.2, target.z)
    this.camera.fov = 55
    this.camera.updateProjectionMatrix()
    this._initialised = false
  }

  follow(rider, dt) {
    const speedRatio = THREE.MathUtils.clamp(rider.speed / rider.spec.maxSpeed, 0, 1)

    const dist = BASE_DIST + speedRatio * 2.4
    const height = BASE_HEIGHT + speedRatio * 0.5

    const back = new THREE.Vector3(-Math.sin(rider.heading), 0, -Math.cos(rider.heading))
    const desired = rider.position.clone()
      .addScaledVector(back, dist)
      .add(new THREE.Vector3(0, height, 0))

    // Under drift, swing slightly toward the outside of the slide.
    if (rider.drifting) {
      const right = new THREE.Vector3(Math.cos(rider.heading), 0, -Math.sin(rider.heading))
      desired.addScaledVector(right, rider.lean * 3.5)
    }

    if (!this._initialised) {
      this._pos.copy(desired)
      this._look.copy(rider.position)
      this._initialised = true
    }

    // Frame-rate independent smoothing.
    const posLambda = 1 - Math.pow(0.0016, dt)
    const lookLambda = 1 - Math.pow(0.0002, dt)
    this._pos.lerp(desired, posLambda)

    const lookTarget = rider.position.clone()
      .addScaledVector(back, -4)
      .add(new THREE.Vector3(0, 1.5, 0))
    this._look.lerp(lookTarget, lookLambda)

    this.camera.position.copy(this._pos)

    // Off-road rumble.
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake
      this.camera.position.y += (Math.random() - 0.5) * this.shake
      this.shake *= Math.pow(0.02, dt)
    }

    this.camera.lookAt(this._look)

    const targetFov = BASE_FOV + speedRatio * 16
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.pow(0.01, dt))
    this.camera.updateProjectionMatrix()
  }

  addShake(amount) {
    this.shake = Math.min(0.6, this.shake + amount)
  }
}
