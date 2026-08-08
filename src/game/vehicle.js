import * as THREE from 'three'

// Handling profiles. The scooter turns harder but tops out lower; the bike is
// faster in a straight line but needs more room to change direction.
export const VEHICLE_SPECS = {
  scooter: {
    maxSpeed: 30,
    accel: 26,
    brake: 42,
    turn: 2.5,
    grip: 3.4,
    label: 'Scooter',
  },
  bike: {
    maxSpeed: 39,
    accel: 32,
    brake: 46,
    turn: 1.95,
    grip: 2.8,
    label: 'Bike',
  },
}

export const PLAYER_COLORS = [
  '#ff6b35', '#17c3b2', '#ffd166', '#ef476f',
  '#7b61ff', '#06d6a0', '#f78ba0', '#4cc9f0',
  '#f9844a', '#90be6d', '#c77dff', '#ff9f1c',
]

function bodyMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.32,
    metalness: 0.62,
  })
}

const DARK = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.75, metalness: 0.25 })
const CHROME = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.18, metalness: 0.95 })
const TYRE = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.95 })
const GLASS = new THREE.MeshStandardMaterial({
  color: 0x88ccdd, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.55,
})

function makeWheel(radius, width) {
  const g = new THREE.Group()
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(radius, width, 10, 22), TYRE)
  g.add(tyre)
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width * 1.4, 14), CHROME)
  rim.rotation.x = Math.PI / 2
  g.add(rim)
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.5, 0.05, width * 0.6), CHROME)
    spoke.rotation.z = (i / 5) * Math.PI
    g.add(spoke)
  }
  g.rotation.y = Math.PI / 2
  return g
}

function makeRider(color) {
  const g = new THREE.Group()
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a07a, roughness: 0.85 })
  const suit = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).offsetHSL(0, 0, -0.14), roughness: 0.6 })

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.5, 4, 10), suit)
  torso.position.set(0, 1.28, -0.05)
  torso.rotation.x = 0.42                    // leaning forward over the bars
  torso.castShadow = true
  g.add(torso)

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 14), bodyMaterial(color))
  helmet.position.set(0, 1.76, 0.12)
  helmet.castShadow = true
  g.add(helmet)

  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.275, 14, 12, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.32, Math.PI * 0.34), GLASS)
  visor.position.copy(helmet.position)
  visor.rotation.y = -Math.PI / 2
  g.add(visor)

  // Arms reaching to the handlebars
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.52, 4, 8), suit)
    arm.position.set(side * 0.26, 1.3, 0.42)
    arm.rotation.x = 1.15
    g.add(arm)

    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.42, 4, 8), suit)
    leg.position.set(side * 0.19, 0.82, -0.16)
    leg.rotation.x = -0.45
    g.add(leg)

    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.3), DARK)
    boot.position.set(side * 0.22, 0.58, -0.02)
    g.add(boot)
  }

  const hands = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.1), skin)
  hands.position.set(0, 1.02, 0.66)
  g.add(hands)

  return g
}

function makeScooter(color) {
  const g = new THREE.Group()
  const paint = bodyMaterial(color)

  // Step-through frame with the characteristic curved apron
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 1.0), DARK)
  deck.position.set(0, 0.44, -0.18)
  deck.castShadow = true
  g.add(deck)

  const bodyShell = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.62, 6, 12), paint)
  bodyShell.rotation.z = Math.PI / 2
  bodyShell.rotation.y = Math.PI / 2
  bodyShell.position.set(0, 0.62, -0.62)
  bodyShell.castShadow = true
  g.add(bodyShell)

  const apron = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.72, 0.22), paint)
  apron.position.set(0, 0.76, 0.42)
  apron.rotation.x = -0.22
  apron.castShadow = true
  g.add(apron)

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.72), DARK)
  seat.position.set(0, 0.95, -0.52)
  g.add(seat)

  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8), CHROME)
  column.position.set(0, 0.92, 0.6)
  column.rotation.x = -0.2
  g.add(column)

  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.78, 8), DARK)
  bars.rotation.z = Math.PI / 2
  bars.position.set(0, 1.3, 0.68)
  g.add(bars)

  const headlight = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), new THREE.MeshStandardMaterial({
    color: 0xfff3c4, emissive: 0xffd98a, emissiveIntensity: 0.85, roughness: 0.3,
  }))
  headlight.position.set(0, 1.06, 0.62)
  g.add(headlight)

  const front = makeWheel(0.34, 0.09)
  front.position.set(0, 0.34, 0.72)
  g.add(front)
  const rear = makeWheel(0.34, 0.11)
  rear.position.set(0, 0.34, -0.78)
  g.add(rear)

  const fender = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 6, 12, Math.PI * 0.6), paint)
  fender.position.set(0, 0.34, 0.72)
  fender.rotation.y = Math.PI / 2
  fender.rotation.z = Math.PI * 0.2
  g.add(fender)

  return { group: g, frontWheel: front, rearWheel: rear, steerParts: [column, bars, front, headlight, fender] }
}

function makeBike(color) {
  const g = new THREE.Group()
  const paint = bodyMaterial(color)

  const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.68, 6, 12), paint)
  tank.rotation.z = Math.PI / 2
  tank.rotation.y = Math.PI / 2
  tank.position.set(0, 0.86, 0.02)
  tank.castShadow = true
  g.add(tank)

  const fairing = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.95, 10), paint)
  fairing.rotation.x = Math.PI / 2 + 0.18
  fairing.position.set(0, 0.86, 0.72)
  fairing.castShadow = true
  g.add(fairing)

  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.52), DARK)
  engine.position.set(0, 0.55, -0.1)
  g.add(engine)

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.7), paint)
  tail.position.set(0, 0.95, -0.72)
  tail.rotation.x = -0.22
  tail.castShadow = true
  g.add(tail)

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.6), DARK)
  seat.position.set(0, 0.94, -0.44)
  g.add(seat)

  // Twin exhausts
  for (const side of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.85, 8), CHROME)
    pipe.rotation.x = Math.PI / 2 - 0.1
    pipe.position.set(side * 0.16, 0.45, -0.72)
    g.add(pipe)
  }

  const forks = new THREE.Group()
  for (const side of [-1, 1]) {
    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.95, 8), CHROME)
    fork.position.set(side * 0.15, 0.72, 0.84)
    fork.rotation.x = -0.32
    forks.add(fork)
  }
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 8), DARK)
  bars.rotation.z = Math.PI / 2
  bars.position.set(0, 1.12, 0.78)
  forks.add(bars)

  const headlight = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), new THREE.MeshStandardMaterial({
    color: 0xfff3c4, emissive: 0xffd98a, emissiveIntensity: 1.0, roughness: 0.3,
  }))
  headlight.position.set(0, 0.98, 0.98)
  forks.add(headlight)
  g.add(forks)

  const front = makeWheel(0.42, 0.1)
  front.position.set(0, 0.42, 0.94)
  g.add(front)
  const rear = makeWheel(0.44, 0.14)
  rear.position.set(0, 0.44, -0.86)
  g.add(rear)

  return { group: g, frontWheel: front, rearWheel: rear, steerParts: [forks, front] }
}

// Floating nameplate above each rider so you can tell colleagues apart.
function makeLabel(text, color) {
  const canvas = document.createElement('canvas')
  const dpr = 2
  canvas.width = 320 * dpr
  canvas.height = 80 * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  ctx.fillStyle = 'rgba(6,32,42,0.82)'
  const r = 16
  ctx.beginPath()
  ctx.roundRect(4, 10, 312, 46, r)
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.stroke()

  ctx.font = 'bold 26px Outfit, Segoe UI, sans-serif'
  ctx.fillStyle = '#f2f7f9'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text.slice(0, 14), 160, 34)

  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }))
  sprite.scale.set(4.2, 1.05, 1)
  sprite.position.y = 2.9
  sprite.renderOrder = 999
  return sprite
}

export class Vehicle {
  constructor({ type, color, name, isLocal }) {
    this.type = VEHICLE_SPECS[type] ? type : 'scooter'
    this.spec = VEHICLE_SPECS[this.type]
    this.color = color
    this.name = name
    this.isLocal = isLocal

    this.group = new THREE.Group()

    const built = this.type === 'bike' ? makeBike(color) : makeScooter(color)
    this.chassis = new THREE.Group()      // leans; holds bike + rider
    this.chassis.add(built.group)
    this.frontWheel = built.frontWheel
    this.rearWheel = built.rearWheel
    this.steerParts = built.steerParts

    this.rider = makeRider(color)
    this.chassis.add(this.rider)

    this.group.add(this.chassis)
    this.group.add(makeLabel(name, color))

    this.group.traverse(o => { if (o.isMesh) o.castShadow = true })

    this._dust = this._makeDust()
    this.group.add(this._dust)
  }

  _makeDust() {
    const count = 40
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(count * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({
      color: 0xd9c9a4, size: 0.42, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true,
    })
    const pts = new THREE.Points(geo, mat)
    pts.frustumCulled = false
    this._dustLife = new Float32Array(count)
    this._dustVel = new Float32Array(count * 3)
    return pts
  }

  // dt-driven visuals: wheel spin, body lean, steering, and drift dust.
  updateVisual(dt, { speed, steer, lean, drifting, onDirt }) {
    const spin = speed * dt / 0.4
    this.frontWheel.rotation.x -= spin
    this.rearWheel.rotation.x -= spin

    this.chassis.rotation.z = THREE.MathUtils.lerp(this.chassis.rotation.z, lean, 1 - Math.pow(0.001, dt))
    for (const p of this.steerParts) {
      p.rotation.y = THREE.MathUtils.lerp(p.rotation.y || 0, steer * 0.42, 1 - Math.pow(0.0001, dt))
    }

    this._updateDust(dt, speed, drifting, onDirt)
  }

  _updateDust(dt, speed, drifting, onDirt) {
    const emit = (drifting && speed > 6) || (onDirt && speed > 4)
    const pos = this._dust.geometry.attributes.position.array
    const life = this._dustLife
    const vel = this._dustVel
    const mat = this._dust.material

    mat.opacity = THREE.MathUtils.lerp(mat.opacity, emit ? 0.5 : 0, 1 - Math.pow(0.002, dt))

    for (let i = 0; i < life.length; i++) {
      const i3 = i * 3
      life[i] -= dt
      if (life[i] <= 0) {
        if (!emit) continue
        life[i] = 0.5 + Math.random() * 0.5
        pos[i3] = (Math.random() - 0.5) * 0.5
        pos[i3 + 1] = 0.12
        pos[i3 + 2] = -0.9 - Math.random() * 0.3
        vel[i3] = (Math.random() - 0.5) * 1.4
        vel[i3 + 1] = 0.7 + Math.random() * 1.1
        vel[i3 + 2] = -1.4 - Math.random() * 1.6
      } else {
        pos[i3] += vel[i3] * dt
        pos[i3 + 1] += vel[i3 + 1] * dt
        pos[i3 + 2] += vel[i3 + 2] * dt
        vel[i3 + 1] -= 0.7 * dt
      }
    }
    this._dust.geometry.attributes.position.needsUpdate = true
  }

  setVisible(v) { this.group.visible = v }

  dispose() {
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose() }
      }
    })
  }
}
