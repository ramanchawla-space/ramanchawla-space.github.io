import * as THREE from 'three'

// The circuit is a closed Catmull-Rom spline through hand-placed control points.
// Everything else in the game (spawns, lap progress, boundary checks, obstacle
// and scenery placement) queries this class rather than hardcoding coordinates.

export const TRACK_WIDTH = 15          // nominal width; the real width varies by zone
const SEGMENTS = 900                   // road mesh resolution around the loop
const LOOKUP = 2400                    // resolution of the progress lookup table

// A lap through Bali: beach straight → sea-temple headland → jungle gorge with a
// narrow causeway over the water → climb through rice terraces → volcanic
// switchbacks → village street → fast descent back to the sand.
const CONTROL_POINTS = [
  [0, 0, 0],           // start/finish, beachfront
  [78, 0, -12],
  [152, 2, -46],
  [206, 7, -112],
  [214, 12, -196],     // temple headland
  [176, 18, -262],
  [96, 22, -300],
  [16, 24, -300],      // jungle gorge approach
  [-52, 25, -262],     // ── causeway over the river starts here
  [-96, 25, -206],     // ── causeway ends
  [-118, 28, -142],
  [-176, 34, -118],    // rice terrace climb
  [-244, 40, -140],
  [-286, 38, -84],
  [-292, 26, -6],      // volcanic switchback descent
  [-248, 14, 54],
  [-176, 6, 78],       // village street
  [-92, 2, 62],
]

// Named stretches of the lap. `from`/`to` are normalised lap positions (t) and
// each zone declares how wide the road is there and what surface it uses. The
// causeway is deliberately barely wider than two riders.
export const ZONES = [
  { name: 'beach',    from: 0.00, to: 0.12, width: 18, surface: 'asphalt' },
  { name: 'coast',    from: 0.12, to: 0.28, width: 15, surface: 'asphalt' },
  { name: 'temple',   from: 0.28, to: 0.38, width: 13, surface: 'stone' },
  { name: 'jungle',   from: 0.38, to: 0.46, width: 12, surface: 'asphalt' },
  { name: 'causeway', from: 0.46, to: 0.55, width: 7.0, surface: 'stone' },
  { name: 'terrace',  from: 0.55, to: 0.68, width: 11, surface: 'dirt' },
  { name: 'volcano',  from: 0.68, to: 0.80, width: 10, surface: 'dirt' },
  { name: 'village',  from: 0.80, to: 0.92, width: 12, surface: 'stone' },
  { name: 'descent',  from: 0.92, to: 1.00, width: 16, surface: 'asphalt' },
]

// Blend distance (in t) over which one zone's width eases into the next, so the
// road tapers into the causeway instead of stepping off a cliff edge.
const BLEND = 0.022

const wrap01 = (t) => ((t % 1) + 1) % 1

// Shortest signed distance from a to b on a circle of circumference 1.
function circDelta(a, b) {
  let d = b - a
  if (d > 0.5) d -= 1
  else if (d < -0.5) d += 1
  return d
}

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
    this._widths = []
    for (let i = 0; i <= LOOKUP; i++) {
      const t = i / LOOKUP
      this._pts.push(this.curve.getPointAt(t))
      this._tangents.push(this.curve.getTangentAt(t).normalize())
      this._widths.push(this._computeWidth(t))
    }
  }

  pointAt(t) { return this.curve.getPointAt(wrap01(t)) }
  tangentAt(t) { return this.curve.getTangentAt(wrap01(t)).normalize() }

  _wrap(t) { return wrap01(t) }

  // Sideways unit vector at t (right-hand side of the road).
  sideAt(t) {
    const tan = this.tangentAt(t)
    return new THREE.Vector3(-tan.z, 0, tan.x).normalize()
  }

  zoneAt(t) {
    const w = wrap01(t)
    for (const z of ZONES) if (w >= z.from && w < z.to) return z
    return ZONES[0]
  }

  // Road half-width at t, smoothly blended across zone boundaries. Physics,
  // the road mesh, kerbs and scenery all read this, so a zone's width value is
  // the single source of truth for how tight that stretch feels.
  _computeWidth(t) {
    const w = wrap01(t)
    let width = this.zoneAt(w).width

    // Ease across each boundary using the two zones that meet there.
    for (let i = 0; i < ZONES.length; i++) {
      const z = ZONES[i]
      const prev = ZONES[(i - 1 + ZONES.length) % ZONES.length]
      const d = circDelta(z.from, w)          // signed distance past the boundary
      if (Math.abs(d) < BLEND) {
        const k = (d + BLEND) / (2 * BLEND)   // 0 → fully prev, 1 → fully z
        const s = k * k * (3 - 2 * k)
        width = THREE.MathUtils.lerp(prev.width, z.width, s)
        break
      }
    }
    return width
  }

  // Public width lookup — table-driven, so it is cheap enough for the physics
  // step to call every tick.
  widthAt(t) {
    const i = Math.round(wrap01(t) * LOOKUP) % LOOKUP
    return this._widths[i]
  }

  halfWidthAt(t) { return this.widthAt(t) / 2 }

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
      const centre = Math.round(wrap01(hint) * LOOKUP)
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

    return {
      t, distance: Math.sqrt(bestD), offset, centre, tangent: tan, side,
      halfWidth: this._widths[bestI] / 2,
      zone: this.zoneAt(t),
    }
  }

  // Evenly spaced staggered grid slots behind the start line.
  startSlot(index) {
    const row = Math.floor(index / 2)
    const col = index % 2 === 0 ? -1 : 1
    const t = wrap01(-(row * 7 + 8) / this.length)
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
    this.group.add(this._causewayStructure())
    for (const b of this._barriers()) this.group.add(b)
    return this.group
  }

  _roadMesh(textures) {
    const positions = []
    const uvs = []
    const normals = []
    const indices = []
    const colors = []

    // Surface tint per zone — the causeway and village read as pale stone, the
    // terraces and volcano as packed dirt.
    const tint = {
      asphalt: new THREE.Color(0x3a3a40),
      stone: new THREE.Color(0x7d7566),
      dirt: new THREE.Color(0x6b5233),
    }

    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS
      const c = this.pointAt(t)
      const s = this.sideAt(t)
      const half = this.halfWidthAt(t)

      const l = c.clone().addScaledVector(s, -half)
      const r = c.clone().addScaledVector(s, half)

      positions.push(l.x, l.y + 0.05, l.z, r.x, r.y + 0.05, r.z)
      normals.push(0, 1, 0, 0, 1, 0)
      const v = t * this.length / 8
      uvs.push(0, v, 1, v)

      const col = tint[this.zoneAt(t).surface] || tint.asphalt
      colors.push(col.r, col.g, col.b, col.r, col.g, col.b)

      if (i < SEGMENTS) {
        const a = i * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geo.setIndex(indices)

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
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
  // Skipped on the causeway, where the edge is a stone parapet instead.
  _kerbs() {
    const g = new THREE.Group()
    const count = 320
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
      if (this.zoneAt(t).name === 'causeway') continue
      const c = this.pointAt(t)
      const s = this.sideAt(t)
      const tan = this.tangentAt(t)
      const half = this.halfWidthAt(t)
      q.setFromAxisAngle(up, Math.atan2(tan.x, tan.z))

      for (const dir of [-1, 1]) {
        const p = c.clone().addScaledVector(s, dir * (half + 0.75))
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
    const geo = new THREE.PlaneGeometry(this.widthAt(0), 3)
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

  // The causeway: a low stone bridge across the river gorge with a broken
  // parapet, plus support pillars dropping into the water below.
  _causewayStructure() {
    const g = new THREE.Group()
    const zone = ZONES.find(z => z.name === 'causeway')
    const stone = new THREE.MeshStandardMaterial({ color: 0x8a8172, roughness: 0.95 })
    const moss = new THREE.MeshStandardMaterial({ color: 0x53603f, roughness: 0.98 })

    const STEPS = 60
    for (let i = 0; i <= STEPS; i++) {
      const t = zone.from + (zone.to - zone.from) * (i / STEPS)
      const c = this.pointAt(t)
      const s = this.sideAt(t)
      const tan = this.tangentAt(t)
      const half = this.halfWidthAt(t)
      const yaw = Math.atan2(tan.x, tan.z)

      // Deck underside, so the bridge reads as solid from the riverbank.
      if (i < STEPS) {
        const seg = new THREE.Mesh(
          new THREE.BoxGeometry(half * 2 + 1.6, 1.4, (zone.to - zone.from) * this.length / STEPS + 0.6),
          stone
        )
        seg.position.copy(c).setY(c.y - 0.6)
        seg.rotation.y = yaw
        seg.receiveShadow = true
        g.add(seg)
      }

      // Parapet posts — with gaps, so there are places you genuinely fall off.
      if (i % 3 !== 2) {
        for (const dir of [-1, 1]) {
          const post = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.9, 0.9),
            (i + (dir > 0 ? 1 : 0)) % 5 === 0 ? moss : stone
          )
          post.position.copy(c).addScaledVector(s, dir * (half + 0.45)).setY(c.y + 0.5)
          post.rotation.y = yaw
          post.castShadow = true
          g.add(post)
        }
      }

      // Support pillars every fifth step, dropping to the riverbed.
      if (i % 5 === 0) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, 26, 8), stone)
        pillar.position.copy(c).setY(c.y - 13.5)
        pillar.castShadow = true
        g.add(pillar)
      }
    }
    return g
  }

  // Bamboo posts lining the circuit — visual only; collision uses spline offset.
  _barriers() {
    const count = 220
    const geo = new THREE.CylinderGeometry(0.16, 0.2, 1.5, 6)
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8894f, roughness: 0.85 })
    const mesh = new THREE.InstancedMesh(geo, mat, count * 2)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const scale = new THREE.Vector3(1, 1, 1)
    let i = 0
    for (let k = 0; k < count; k++) {
      const t = k / count
      if (this.zoneAt(t).name === 'causeway') continue
      const c = this.pointAt(t)
      const s = this.sideAt(t)
      const half = this.halfWidthAt(t)
      for (const dir of [-1, 1]) {
        const p = c.clone().addScaledVector(s, dir * (half + 2.2))
        p.y += 0.75
        m.compose(p, q, scale)
        mesh.setMatrixAt(i++, m)
      }
    }
    mesh.count = i
    mesh.castShadow = true
    return [mesh]
  }
}
