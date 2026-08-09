import * as THREE from 'three'

// Track hazards. Every obstacle is anchored to a lap position `t` and a lateral
// offset from the centreline, so it stays glued to the road no matter how the
// spline is retuned. Physics asks `sample()` for the hazards near the rider each
// step; the renderer animates them from `update()`.
//
// Placement is deterministic (fixed table, no RNG) so every player in a
// multiplayer race sees the same rock in the same place — a hazard that only
// exists on one client would make the race unfair and desyncs obvious.

// --- Effects an obstacle can apply on contact ---
// slow:    multiply speed by `factor` (mud, sand, market stalls)
// bump:    lose speed and get thrown laterally (rocks, boulders, cows)
// spin:    lose grip and heading control briefly (oil, fire, potholes)
// nudge:   gentle push back toward the centreline (parapets, cones)

export const HAZARD = {
  ROCK: 'rock',
  BOULDER: 'boulder',
  FIRE: 'fire',
  POTHOLE: 'pothole',
  MUD: 'mud',
  OIL: 'oil',
  COW: 'cow',
  STALL: 'stall',
  OFFERING: 'offering',
  LOG: 'log',
  DEBRIS: 'debris',
}

// The hand-placed hazard table. `t` is the lap position, `off` the lateral
// offset in metres from the centreline (positive = right-hand side).
// Deliberately arranged so no hazard fully blocks the road: there is always a
// racing line through, but it costs you either speed or the ideal apex.
const LAYOUT = [
  // --- Beach straight: warm-up, wide road, easy to read at speed ---
  { t: 0.035, off: -4.5, type: HAZARD.DEBRIS },
  { t: 0.062, off: 4.0, type: HAZARD.OFFERING },
  { t: 0.088, off: 0.5, type: HAZARD.POTHOLE },

  // --- Coast road: a rockfall off the cliff on the sea side ---
  { t: 0.145, off: -3.2, type: HAZARD.ROCK },
  { t: 0.158, off: -5.4, type: HAZARD.ROCK },
  { t: 0.172, off: 3.6, type: HAZARD.BOULDER },
  { t: 0.205, off: 0.0, type: HAZARD.OIL },
  { t: 0.242, off: -4.2, type: HAZARD.POTHOLE },
  { t: 0.258, off: 4.4, type: HAZARD.ROCK },

  // --- Temple approach: ceremony offerings and a sacred banyan cow ---
  { t: 0.300, off: 3.0, type: HAZARD.OFFERING },
  { t: 0.312, off: -3.0, type: HAZARD.OFFERING },
  { t: 0.336, off: -1.2, type: HAZARD.COW },
  { t: 0.362, off: 3.8, type: HAZARD.STALL },

  // --- Jungle gorge: fallen logs and a burning brush fire ---
  { t: 0.395, off: -2.6, type: HAZARD.LOG },
  { t: 0.412, off: 3.2, type: HAZARD.FIRE },
  { t: 0.432, off: -3.4, type: HAZARD.MUD },
  { t: 0.448, off: 2.2, type: HAZARD.ROCK },

  // --- Causeway over the water: barely two riders wide, one rock in the middle
  //     of it. This is the signature "thread the needle" moment of the lap. ---
  { t: 0.482, off: -1.8, type: HAZARD.ROCK },
  { t: 0.508, off: 1.9, type: HAZARD.DEBRIS },
  { t: 0.534, off: -1.6, type: HAZARD.POTHOLE },

  // --- Rice terraces: irrigation mud washed across the dirt road ---
  { t: 0.578, off: 0.0, type: HAZARD.MUD },
  { t: 0.598, off: -3.0, type: HAZARD.MUD },
  { t: 0.618, off: 2.8, type: HAZARD.COW },
  { t: 0.646, off: -2.4, type: HAZARD.LOG },
  { t: 0.664, off: 3.2, type: HAZARD.ROCK },

  // --- Volcanic switchbacks: lava-heated ground and scattered scree ---
  { t: 0.696, off: 2.6, type: HAZARD.FIRE },
  { t: 0.714, off: -2.8, type: HAZARD.BOULDER },
  { t: 0.736, off: 0.8, type: HAZARD.ROCK },
  { t: 0.752, off: -3.4, type: HAZARD.FIRE },
  { t: 0.778, off: 2.4, type: HAZARD.POTHOLE },

  // --- Village street: market stalls, a stray cow, spilled cooking oil ---
  { t: 0.818, off: -3.8, type: HAZARD.STALL },
  { t: 0.836, off: 3.6, type: HAZARD.STALL },
  { t: 0.858, off: -1.0, type: HAZARD.COW },
  { t: 0.878, off: 2.2, type: HAZARD.OIL },
  { t: 0.902, off: -3.0, type: HAZARD.DEBRIS },

  // --- Final descent: one last boulder before the beach ---
  { t: 0.938, off: 3.4, type: HAZARD.BOULDER },
  { t: 0.966, off: -2.0, type: HAZARD.POTHOLE },
]

// Per-type physical characteristics. `radius` is the collision circle;
// `warn` is the short label the HUD flashes when you are approaching one.
const SPEC = {
  [HAZARD.ROCK]:     { radius: 1.5, effect: 'bump', factor: 0.62, kick: 5.0, warn: 'ROCK!' },
  [HAZARD.BOULDER]:  { radius: 2.6, effect: 'bump', factor: 0.38, kick: 8.5, warn: 'BIG ROCK!' },
  [HAZARD.FIRE]:     { radius: 2.2, effect: 'spin', factor: 0.55, kick: 2.0, warn: 'FIRE!' },
  [HAZARD.POTHOLE]:  { radius: 1.5, effect: 'spin', factor: 0.74, kick: 1.2, warn: 'POTHOLE' },
  [HAZARD.MUD]:      { radius: 3.4, effect: 'slow', factor: 0.55, kick: 0, warn: 'MUD' },
  [HAZARD.OIL]:      { radius: 2.8, effect: 'spin', factor: 0.94, kick: 0, warn: 'SLIPPERY!' },
  [HAZARD.COW]:      { radius: 1.9, effect: 'bump', factor: 0.45, kick: 6.0, warn: 'COW!' },
  [HAZARD.STALL]:    { radius: 2.1, effect: 'bump', factor: 0.50, kick: 4.0, warn: 'MARKET!' },
  [HAZARD.OFFERING]: { radius: 0.9, effect: 'slow', factor: 0.88, kick: 0, warn: null },
  [HAZARD.LOG]:      { radius: 2.4, effect: 'bump', factor: 0.55, kick: 3.0, warn: 'LOG!' },
  [HAZARD.DEBRIS]:   { radius: 1.4, effect: 'slow', factor: 0.72, kick: 1.0, warn: null },
}

// How far ahead (in metres along the road) the HUD warns you.
const WARN_DISTANCE = 55

export class Obstacles {
  constructor(track) {
    this.track = track
    this.group = new THREE.Group()
    this.items = []
    this._animated = []       // subset needing per-frame work (fire, cows, flags)
    this._buildShared()
  }

  // Shared geometry/materials — 37 obstacles built from ~10 unique meshes keeps
  // the draw call count and memory flat.
  _buildShared() {
    this.mat = {
      rock: new THREE.MeshStandardMaterial({ color: 0x6f6a63, roughness: 0.97, flatShading: true }),
      darkRock: new THREE.MeshStandardMaterial({ color: 0x4b4741, roughness: 1, flatShading: true }),
      wood: new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.95 }),
      thatch: new THREE.MeshStandardMaterial({ color: 0xb08d52, roughness: 0.98 }),
      cloth: new THREE.MeshStandardMaterial({ color: 0xd94f3d, roughness: 0.85, side: THREE.DoubleSide }),
      mud: new THREE.MeshStandardMaterial({ color: 0x4a3722, roughness: 0.55, metalness: 0.15 }),
      oil: new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.08, metalness: 0.85 }),
      hole: new THREE.MeshStandardMaterial({ color: 0x14120f, roughness: 1 }),
      hide: new THREE.MeshStandardMaterial({ color: 0xd8cdbb, roughness: 0.9 }),
      hideDark: new THREE.MeshStandardMaterial({ color: 0x8a7a63, roughness: 0.9 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 0.9, side: THREE.DoubleSide }),
      basket: new THREE.MeshStandardMaterial({ color: 0xc9a253, roughness: 0.92 }),
      ember: new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 1, emissive: 0xff4400, emissiveIntensity: 0.5 }),
    }
  }

  build() {
    for (const entry of LAYOUT) {
      const spec = SPEC[entry.type]
      if (!spec) continue

      const c = this.track.pointAt(entry.t)
      const side = this.track.sideAt(entry.t)
      const tan = this.track.tangentAt(entry.t)
      const half = this.track.halfWidthAt(entry.t)

      // Clamp the offset so a hazard can never end up off the road edge on a
      // narrow stretch — the causeway would otherwise drop rocks into the river.
      const maxOff = Math.max(0, half - spec.radius * 0.55)
      const off = THREE.MathUtils.clamp(entry.off, -maxOff, maxOff)

      const pos = c.clone().addScaledVector(side, off)
      const yaw = Math.atan2(tan.x, tan.z)

      const mesh = this._makeMesh(entry.type, yaw, entry.t)
      mesh.position.copy(pos)
      this.group.add(mesh)

      const item = {
        type: entry.type, t: entry.t, off, spec,
        position: pos, mesh,
        radius: spec.radius,
        // Distance along the road, used for the "hazard ahead" warning.
        s: entry.t * this.track.length,
      }
      this.items.push(item)
      if (mesh.userData.animate) this._animated.push(item)
    }

    // Sorted by lap position so the near-hazard lookup can binary-search.
    this.items.sort((a, b) => a.t - b.t)
    return this.group
  }

  _makeMesh(type, yaw, t) {
    const g = new THREE.Group()
    g.rotation.y = yaw

    switch (type) {
      case HAZARD.ROCK: return this._rock(g, 1)
      case HAZARD.BOULDER: return this._rock(g, 2.1)
      case HAZARD.FIRE: return this._fire(g)
      case HAZARD.POTHOLE: return this._pothole(g)
      case HAZARD.MUD: return this._mud(g)
      case HAZARD.OIL: return this._oil(g)
      case HAZARD.COW: return this._cow(g)
      case HAZARD.STALL: return this._stall(g, t)
      case HAZARD.OFFERING: return this._offering(g)
      case HAZARD.LOG: return this._log(g)
      default: return this._debris(g)
    }
  }

  // --- Individual hazard builders ---

  _rock(g, scale) {
    const geo = new THREE.DodecahedronGeometry(1.2 * scale, 0)
    // Deform the vertices so each rock silhouette differs, using the scale as
    // the seed so it stays deterministic.
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const f = 0.78 + (Math.sin(i * 12.9898 + scale * 78.233) * 0.5 + 0.5) * 0.42
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.8, pos.getZ(i) * f)
    }
    geo.computeVertexNormals()

    const rock = new THREE.Mesh(geo, scale > 1.5 ? this.mat.darkRock : this.mat.rock)
    rock.position.y = 0.75 * scale
    rock.rotation.set(0.3, 0.9, 0.15)
    rock.castShadow = rock.receiveShadow = true
    g.add(rock)

    // Rubble skirt so it looks like it fell rather than being placed.
    for (let i = 0; i < 4; i++) {
      const a = i * 1.7
      const chip = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22 * scale, 0), this.mat.rock)
      chip.position.set(Math.cos(a) * 1.5 * scale, 0.15, Math.sin(a) * 1.4 * scale)
      chip.castShadow = true
      g.add(chip)
    }
    return g
  }

  // Burning brush pile: emissive embers plus animated flame billboards.
  _fire(g) {
    const pile = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 0), this.mat.ember)
    pile.position.y = 0.4
    pile.castShadow = true
    g.add(pile)

    // Charred branches poking out of the fire.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.5, 5), this.mat.darkRock)
      stick.position.set(Math.cos(a) * 0.4, 0.55, Math.sin(a) * 0.4)
      stick.rotation.set(Math.cos(a) * 0.7, 0, Math.sin(a) * -0.7)
      g.add(stick)
    }

    // Flame sheets: three crossed planes with an additive gradient. Cheaper and
    // more readable at racing speed than a particle system.
    const flames = new THREE.Group()
    const flameMat = new THREE.MeshBasicMaterial({
      map: makeFlameTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.4), flameMat)
      plane.position.y = 1.6
      plane.rotation.y = (i / 3) * Math.PI
      flames.add(plane)
    }
    g.add(flames)

    const light = new THREE.PointLight(0xff7a26, 6, 22, 2)
    light.position.y = 1.4
    g.add(light)

    // Smoke column, so you can spot the fire from a corner away.
    const smokeMat = new THREE.MeshBasicMaterial({
      map: makeSmokeTexture(), transparent: true, opacity: 0.3, depthWrite: false,
    })
    const smoke = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 9), smokeMat)
    smoke.position.y = 5.6
    g.add(smoke)

    g.userData.animate = { kind: 'fire', flames, light, smoke }
    return g
  }

  _pothole(g) {
    const hole = new THREE.Mesh(new THREE.CircleGeometry(1.5, 16), this.mat.hole)
    hole.rotation.x = -Math.PI / 2
    hole.position.y = 0.07
    g.add(hole)

    // Broken asphalt lip so it doesn't read as a flat decal.
    const lip = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.14, 5, 16), this.mat.darkRock)
    lip.rotation.x = -Math.PI / 2
    lip.position.y = 0.1
    g.add(lip)
    return g
  }

  _mud(g) {
    const geo = new THREE.CircleGeometry(3.4, 20)
    // Irregular edge — a perfect circle of mud looks placed.
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const f = 0.75 + (Math.sin(i * 4.3) * 0.5 + 0.5) * 0.45
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f, pos.getZ(i))
    }
    geo.computeVertexNormals()
    const patch = new THREE.Mesh(geo, this.mat.mud)
    patch.rotation.x = -Math.PI / 2
    patch.position.y = 0.08
    patch.receiveShadow = true
    g.add(patch)
    return g
  }

  _oil(g) {
    const slick = new THREE.Mesh(new THREE.CircleGeometry(2.8, 20), this.mat.oil)
    slick.rotation.x = -Math.PI / 2
    slick.position.y = 0.075
    slick.scale.set(1, 0.65, 1)
    g.add(slick)
    return g
  }

  // A Bali road classic: a cow standing where it pleases.
  _cow(g) {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 1.25, 5, 10), this.mat.hide)
    body.rotation.z = Math.PI / 2
    body.position.y = 1.15
    body.castShadow = true
    g.add(body)

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.7), this.mat.hide)
    head.position.set(1.2, 1.25, 0)
    head.castShadow = true
    g.add(head)

    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 0.3), this.mat.hideDark)
    snout.position.set(1.52, 1.1, 0)
    g.add(snout)

    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.42, 6), this.mat.hideDark)
      horn.position.set(1.15, 1.6, side * 0.2)
      horn.rotation.z = side * 0.3
      g.add(horn)

      for (const fwd of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 1.15, 6), this.mat.hide)
        leg.position.set(fwd * 0.62, 0.57, side * 0.36)
        leg.castShadow = true
        g.add(leg)
      }
    }

    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.9, 5), this.mat.hideDark)
    tail.position.set(-1.0, 1.0, 0)
    tail.rotation.z = 0.35
    g.add(tail)

    // Cows wander a little and swing their tail — enough motion to catch the eye.
    g.userData.animate = { kind: 'cow', tail, phase: g.position.x }
    return g
  }

  // Roadside warung / market stall with a thatched roof and hanging cloth.
  _stall(g, t) {
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 1.5), this.mat.wood)
    table.position.y = 1.0
    table.castShadow = true
    g.add(table)

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), this.mat.wood)
        leg.position.set(sx * 1.15, 0.5, sz * 0.6)
        g.add(leg)
      }
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.3, 6), this.mat.wood)
      post.position.set(sx * 1.25, 1.15, 0)
      post.castShadow = true
      g.add(post)
    }

    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.4, 0.9, 4), this.mat.thatch)
    roof.position.y = 2.7
    roof.rotation.y = Math.PI / 4
    roof.castShadow = true
    g.add(roof)

    // Baskets of fruit on the table.
    for (let i = 0; i < 3; i++) {
      const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.24, 0.3, 10), this.mat.basket)
      basket.position.set(-0.8 + i * 0.8, 1.24, 0)
      g.add(basket)
      const fruit = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 8, 6),
        i === 1 ? this.mat.leaf : this.mat.cloth
      )
      fruit.position.set(-0.8 + i * 0.8, 1.44, 0)
      fruit.scale.y = 0.6
      g.add(fruit)
    }

    // Awning cloth that flutters.
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.7, 6, 2), this.mat.cloth)
    cloth.position.set(0, 2.05, 0.78)
    g.add(cloth)

    g.userData.animate = { kind: 'stall', cloth, phase: t * 40 }
    return g
  }

  // Canang sari — the little daily offering baskets left on Balinese roadsides.
  _offering(g) {
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), this.mat.basket)
    tray.position.y = 0.12
    tray.castShadow = true
    g.add(tray)

    const petals = [0xff6b9d, 0xffd166, 0xffffff, 0xff8c42]
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2
      const petal = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 6, 5),
        new THREE.MeshStandardMaterial({ color: petals[i], roughness: 0.8 })
      )
      petal.position.set(Math.cos(a) * 0.14, 0.24, Math.sin(a) * 0.14)
      petal.scale.y = 0.55
      g.add(petal)
    }

    // A stick of incense with a faint glow.
    const incense = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 0.45, 4),
      new THREE.MeshStandardMaterial({ color: 0x8b4513, emissive: 0xff5500, emissiveIntensity: 0.4 })
    )
    incense.position.set(0.16, 0.4, 0)
    g.add(incense)
    return g
  }

  _log(g) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 4.6, 9), this.mat.wood)
    trunk.rotation.x = Math.PI / 2
    trunk.rotation.z = 0.12
    trunk.position.y = 0.58
    trunk.castShadow = trunk.receiveShadow = true
    g.add(trunk)

    // Snapped branches and a few leaves still attached.
    for (let i = 0; i < 3; i++) {
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 1.3, 5), this.mat.wood)
      branch.position.set(0.3, 0.9, -1.4 + i * 1.4)
      branch.rotation.set(0.4, 0, -0.9)
      g.add(branch)

      const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.5, 5), this.mat.leaf)
      leaf.position.set(0.85, 1.25, -1.4 + i * 1.4)
      leaf.rotation.set(-1.1, 0.4, 0)
      g.add(leaf)
    }
    return g
  }

  // Scattered roadside junk — fallen coconuts, palm fronds, a tyre.
  _debris(g) {
    for (let i = 0; i < 5; i++) {
      const a = i * 1.9
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), this.mat.wood)
      nut.position.set(Math.cos(a) * 0.8, 0.25, Math.sin(a) * 0.7)
      nut.scale.set(1, 0.85, 1)
      nut.castShadow = true
      g.add(nut)
    }
    const frond = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.7), this.mat.leaf)
    frond.rotation.set(-Math.PI / 2, 0, 0.5)
    frond.position.y = 0.09
    g.add(frond)

    const tyre = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.16, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x1d1d20, roughness: 0.95 })
    )
    tyre.rotation.x = -Math.PI / 2
    tyre.position.set(-0.6, 0.16, 0.5)
    tyre.castShadow = true
    g.add(tyre)
    return g
  }

  // --- Runtime queries ---

  // Hazards whose centre is within `range` metres of `pos`. The rider only ever
  // touches a handful, so we window by lap position first rather than testing
  // all 37 every physics step.
  near(pos, t, range = 6) {
    const out = []
    const tSpan = (range + 4) / this.track.length
    for (const item of this.items) {
      let d = item.t - t
      if (d > 0.5) d -= 1
      else if (d < -0.5) d += 1
      if (Math.abs(d) > tSpan) continue
      if (item.position.distanceTo(pos) <= range + item.radius) out.push(item)
    }
    return out
  }

  // The next hazard ahead of `t` worth warning about, or null.
  nextWarning(t) {
    let best = null
    let bestD = Infinity
    for (const item of this.items) {
      if (!item.spec.warn) continue
      let d = item.t - t
      if (d < 0) d += 1
      const metres = d * this.track.length
      if (metres < bestD) { bestD = metres; best = item }
    }
    return best && bestD <= WARN_DISTANCE ? { item: best, distance: bestD } : null
  }

  update(dt, elapsed) {
    for (const item of this._animated) {
      const a = item.mesh.userData.animate
      if (a.kind === 'fire') {
        // Flicker: scale and brightness wobble on two out-of-phase sines so the
        // flame never looks like it is on a loop.
        const f = 1 + Math.sin(elapsed * 11 + item.t * 30) * 0.14
          + Math.sin(elapsed * 17.3 + item.t * 11) * 0.07
        a.flames.scale.set(f, f * 1.12, f)
        a.flames.rotation.y += dt * 0.6
        a.light.intensity = 5 + Math.sin(elapsed * 13 + item.t * 20) * 2.2
        a.smoke.position.y = 5.6 + Math.sin(elapsed * 0.7 + item.t * 9) * 0.5
        a.smoke.material.opacity = 0.22 + Math.sin(elapsed * 1.3) * 0.06
      } else if (a.kind === 'cow') {
        a.tail.rotation.x = Math.sin(elapsed * 2.4 + a.phase) * 0.5
        item.mesh.rotation.y += Math.sin(elapsed * 0.35 + a.phase) * dt * 0.12
      } else if (a.kind === 'stall') {
        a.cloth.rotation.x = Math.sin(elapsed * 2.1 + a.phase) * 0.16
      }
    }
  }

  // Face the fire and smoke billboards at the camera each frame.
  faceCamera(camera) {
    for (const item of this._animated) {
      const a = item.mesh.userData.animate
      if (a.kind !== 'fire') continue
      a.smoke.lookAt(camera.position.x, a.smoke.getWorldPosition(_tmp).y, camera.position.z)
    }
  }
}

const _tmp = new THREE.Vector3()

// --- Procedural textures for the flame and smoke billboards ---

function makeFlameTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')

  // Teardrop flame: bright core fading to transparent orange at the tips.
  const grad = ctx.createRadialGradient(64, 92, 4, 64, 78, 62)
  grad.addColorStop(0.0, 'rgba(255,255,220,1)')
  grad.addColorStop(0.25, 'rgba(255,214,96,0.95)')
  grad.addColorStop(0.55, 'rgba(255,120,20,0.6)')
  grad.addColorStop(0.8, 'rgba(190,45,10,0.2)')
  grad.addColorStop(1.0, 'rgba(120,20,0,0)')

  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.moveTo(64, 4)
  ctx.bezierCurveTo(104, 54, 116, 84, 64, 124)
  ctx.bezierCurveTo(12, 84, 24, 54, 64, 4)
  ctx.fill()

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeSmokeTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')
  const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 62)
  grad.addColorStop(0, 'rgba(70,64,58,0.75)')
  grad.addColorStop(0.5, 'rgba(90,84,78,0.35)')
  grad.addColorStop(1, 'rgba(110,104,98,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export { SPEC as HAZARD_SPEC, LAYOUT as HAZARD_LAYOUT }
