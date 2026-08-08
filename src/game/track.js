import * as THREE from 'three'

// The circuit is a closed Catmull-Rom spline through hand-placed control points.
// Everything else in the game (spawns, lap progress, AI-free boundary checks,
// scenery placement) queries this class rather than hardcoding coordinates.

export const TRACK_WIDTH = 15
const SEGMENTS = 600          // road mesh resolution around the loop
const LOOKUP = 2400           // resolution of the progress lookup table

// A coastal circuit: long beach straight, hairpin at the temple headland,
// sweeping climb through the rice terraces, fast descent back to the sea.
const CONTROL_POINTS = [
  [0, 0, 0],
  [70, 0, -14],
  [138, 2, -52],
  [186, 6, -120],
  [190, 10, -196],
  [150, 14, -252],
  [78, 16, -272],
  [8, 15, -252],
  [-42, 12, -206],
  [-58, 9, -140],
  [-102, 7, -104],
  [-166, 6, -108],
  [-206, 4, -62],
  [-198, 2, 16],
  [-146, 1, 58],
  [-72, 0, 46],
]

export class Track {
  constructor() {
    this.curve = new THREE.CatmullRomCurve3(
      CONTROL_POINTS.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      true,
      'catmullrom',
      0.5
    )
    this.length = this.curve.getLength()
    this._buildLookup()
    this.group = new THREE.Group()
  }

  // Uniform-arclength sampling table so progress maps to real distance, not
  // spline parameter (which bunches up on tight corners).
  _buildLookup() {
    this._pts = []
    this._tangents = []
    for (let i = 0; i <= LOOKUP; i++) {
      const t = i / LOOKUP
      this._pts.push(this.curve.getPointAt(t))
      this._tangents.push(this.curve.getTangentAt(t).normalize())
    }
  }

  pointAt(t) { return this.curve.getPointAt(this._wrap(t)) }
  tangentAt(t) { return this.curve.getTangentAt(this._wrap(t)).normalize() }

  _wrap(t) { return ((t % 1) + 1) % 1 }

  // Sideways unit vector at t (right-hand side of the road).
  sideAt(t) {
    const tan = this.tangentAt(t)
    return new THREE.Vector3(-tan.z, 0, tan.x).normalize()
  }

  // Nearest point on the centreline. Coarse scan over the lookup table, then a
  // local refine. `hint` (previous t) keeps the search local during a race so a
  // car near a track crossover can't teleport its lap progress to the far side.
  nearest(pos, hint = null) {
    let bestI = 0
    let bestD = Infinity

    if (hint === null) {
      for (let i = 0; i < LOOKUP; i++) {
        const d = this._pts[i].distanceToSquared(pos)
        if (d < bestD) { bestD = d; bestI = i }
      }
    } else {
      // Search a window around the hint (±6% of the lap) only.
      const centre = Math.round(this._wrap(hint) * LOOKUP)
      const span = Math.round(LOOKUP * 0.06)
      for (let k = -span; k <= span; k++) {
        const i = ((centre + k) % LOOKUP + LOOKUP) % LOOKUP
        const d = this._pts[i].distanceToSquared(pos)
        if (d < bestD) { bestD = d; bestI = i }
      }
    }

    const t = bestI / LOOKUP
    const centre = this._pts[bestI]
    const tan = this._tangents[bestI]
    const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize()
    const offset = new THREE.Vector3().subVectors(pos, centre).dot(side)

    return { t, distance: Math.sqrt(bestD), offset, centre, tangent: tan, side }
  }

  // Evenly spaced staggered grid slots behind the start line.
  startSlot(index) {
    const row = Math.floor(index / 2)
    const col = index % 2 === 0 ? -1 : 1
    const t = this._wrap(-(row * 7 + 8) / this.length)
    const centre = this.pointAt(t)
    const side = this.sideAt(t)
    const tan = this.tangentAt(t)
    const pos = centre.clone().addScaledVector(side, col * 3.6)
    return { position: pos, heading: Math.atan2(tan.x, tan.z) }
  }

  build(textures) {
    this.group.clear()
    this.group.add(this._roadMesh(textures))
    this.group.add(this._kerbs())
    this.group.add(this._startLine())
    for (const b of this._barriers()) this.group.add(b)
    return this.group
  }

  _roadMesh(textures) {
    const positions = []
    const uvs = []
    const normals = []
    const indices = []

    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS
      const c = this.pointAt(t)
      const s = this.sideAt(t)
      const half = TRACK_WIDTH / 2

      const l = c.clone().addScaledVector(s, -half)
      const r = c.clone().addScaledVector(s, half)

      positions.push(l.x, l.y + 0.05, l.z, r.x, r.y + 0.05, r.z)
      normals.push(0, 1, 0, 0, 1, 0)
      const v = t * this.length / 8
      uvs.push(0, v, 1, v)

      if (i < SEGMENTS) {
        const a = i * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(indices)

    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a3a40,
      roughness: 0.92,
      metalness: 0.02,
      map: textures?.asphalt || null,
      normalMap: textures?.asphaltNormal || null,
      normalScale: new THREE.Vector2(0.6, 0.6),
    })

    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    mesh.name = 'road'
    return mesh
  }

  // Red/white kerbing along both edges, drawn as alternating small boxes.
  _kerbs() {
    const g = new THREE.Group()
    const count = 260
    const red = new THREE.MeshStandardMaterial({ color: 0xd63b3b, roughness: 0.7 })
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 })
    const geo = new THREE.BoxGeometry(1.5, 0.16, this.length / count * 0.94)

    const redM = new THREE.InstancedMesh(geo, red, count)
    const whiteM = new THREE.InstancedMesh(geo, white, count)
    let ri = 0, wi = 0
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const scale = new THREE.Vector3(1, 1, 1)

    for (let i = 0; i < count; i++) {
      const t = i / count
      const c = this.pointAt(t)
      const s = this.sideAt(t)
      const tan = this.tangentAt(t)
      q.setFromAxisAngle(up, Math.atan2(tan.x, tan.z))

      for (const dir of [-1, 1]) {
        const p = c.clone().addScaledVector(s, dir * (TRACK_WIDTH / 2 + 0.75))
        p.y += 0.11
        m.compose(p, q, scale)
        if ((i + (dir > 0 ? 1 : 0)) % 2 === 0) {
          if (ri < count) redM.setMatrixAt(ri++, m)
        } else {
          if (wi < count) whiteM.setMatrixAt(wi++, m)
        }
      }
    }
    redM.count = ri
    whiteM.count = wi
    redM.receiveShadow = whiteM.receiveShadow = true
    g.add(redM, whiteM)
    return g
  }

  _startLine() {
    const c = this.pointAt(0)
    const tan = this.tangentAt(0)
    const geo = new THREE.PlaneGeometry(TRACK_WIDTH, 3)
    const canvas = document.createElement('canvas')
    canvas.width = 256; canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = '#111'
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 16; x++) {
        if ((x + y) % 2 === 0) ctx.fillRect(x * 16, y * 16, 16, 16)
      }
    }
    const tex = new THREE.CanvasTexture(canvas)
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }))
    mesh.rotation.x = -Math.PI / 2
    mesh.rotation.z = -Math.atan2(tan.x, tan.z)
    mesh.position.copy(c)
    mesh.position.y += 0.08
    return mesh
  }

  // Bamboo posts lining the circuit — visual only; collision uses spline offset.
  _barriers() {
    const count = 150
    const geo = new THREE.CylinderGeometry(0.16, 0.2, 1.5, 6)
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8894f, roughness: 0.85 })
    const mesh = new THREE.InstancedMesh(geo, mat, count * 2)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const scale = new THREE.Vector3(1, 1, 1)
    let i = 0
    for (let k = 0; k < count; k++) {
      const t = k / count
      const c = this.pointAt(t)
      const s = this.sideAt(t)
      for (const dir of [-1, 1]) {
        const p = c.clone().addScaledVector(s, dir * (TRACK_WIDTH / 2 + 2.2))
        p.y += 0.75
        m.compose(p, q, scale)
        mesh.setMatrixAt(i++, m)
      }
    }
    mesh.castShadow = true
    return [mesh]
  }
}
