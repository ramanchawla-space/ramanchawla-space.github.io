import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { Water } from 'three/examples/jsm/objects/Water.js'

// Deterministic PRNG so the island looks identical on every machine — important
// for multiplayer, where players must see palms in the same places.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

const WORLD = 1700

// The gorge the causeway crosses. Terrain inside this radius is carved away to
// a riverbed, and the river water plane sits at RIVER_Y.
const GORGE = { x: -76, z: -232, radius: 130, inner: 62 }

// The river sits above sea level: the gorge is inland and elevated, and keeping
// it clear of the ocean plane (y = -3.2) stops the sea rendering through the
// riverbed. The causeway deck is ~25, so this is still a ~20m drop.
const RIVER_Y = 4

export class Environment {
  constructor(scene, renderer, track, textures) {
    this.scene = scene
    this.renderer = renderer
    this.track = track
    this.tex = textures || {}
    this.rand = mulberry32(20260808)
    this.water = null
    this.river = null
    this.sun = new THREE.Vector3()
    this._animated = []
  }

  build() {
    this._sky()
    this._lights()
    this._ground()
    this._ocean()
    this._beach()
    this._gorge()
    this._waterfall()
    this._riceTerraces()
    this._volcano()
    this._templeComplex()
    this._roadsideShrines()
    this._village()
    this._banyans()
    this._palms()
    this._jungle()
    this._foliage()
    this._flags()
    this._birds()
  }

  // --- Sky & atmosphere: late-afternoon Bali, sun dropping toward the sea ---
  _sky() {
    const sky = new Sky()
    sky.scale.setScalar(20000)
    this.scene.add(sky)

    // Sunset atmosphere. High turbidity with low rayleigh washes the sky to grey,
    // so keep turbidity modest and rayleigh high enough for real blue scattering
    // overhead, with mie providing the warm glow near the sun.
    const u = sky.material.uniforms
    u.turbidity.value = 5
    u.rayleigh.value = 1.35
    u.mieCoefficient.value = 0.021
    u.mieDirectionalG.value = 0.93

    // Sun kept a little higher: below ~5° the whole sky desaturates to haze.
    const phi = THREE.MathUtils.degToRad(90 - 15)
    const theta = THREE.MathUtils.degToRad(128)
    this.sun.setFromSphericalCoords(1, phi, theta)
    u.sunPosition.value.copy(this.sun)

    // Light haze only. Denser than ~0.0005 and the volcano and rice terraces
    // wash out to flat white before you can see them.
    this.scene.fog = new THREE.FogExp2(0xe6c6a2, 0.00042)

    // Use the sky as the environment map so metal/rough surfaces pick up
    // real sky colour instead of looking flat.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const rt = pmrem.fromScene(sky)
    this.scene.environment = rt.texture
    pmrem.dispose()
  }

  _lights() {
    const sunLight = new THREE.DirectionalLight(0xffd3a0, 3.2)
    sunLight.position.copy(this.sun).multiplyScalar(400)
    sunLight.castShadow = true
    sunLight.shadow.mapSize.set(2048, 2048)
    const d = 340
    sunLight.shadow.camera.left = -d
    sunLight.shadow.camera.right = d
    sunLight.shadow.camera.top = d
    sunLight.shadow.camera.bottom = -d
    sunLight.shadow.camera.near = 1
    sunLight.shadow.camera.far = 1400
    sunLight.shadow.bias = -0.0005
    sunLight.shadow.normalBias = 0.03
    this.scene.add(sunLight)
    this.sunLight = sunLight

    this.scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x4a6741, 0.75))
    const bounce = new THREE.DirectionalLight(0xff9d6e, 0.5)
    bounce.position.set(-200, 60, 180)
    this.scene.add(bounce)
  }

  // True lateral clearance between a world point and the tarmac, in metres
  // (negative means the point is on the road).
  //
  // Track.nearest() scans a lookup table, and where the circuit doubles back on
  // itself the nearest *sample* can belong to a different pass of the road than
  // the truly nearest point — so a scatter point can clear the check at spawn
  // and still land on the tarmac. This bins every road sample into a uniform
  // grid once, then tests only the bins near the query. Scatter systems call
  // this instead of reading `near.distance` directly.
  _roadClearance(x, z) {
    if (!this._roadGrid) this._buildRoadGrid()
    const { cell, bins, minX, minZ, cols, rows } = this._roadGrid

    const cx = Math.floor((x - minX) / cell)
    const cz = Math.floor((z - minZ) / cell)

    let worst = Infinity
    // A road sample can be at most one cell away and still be the closest, but
    // sweep a 2-cell ring to stay safe on wide stretches.
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const gx = cx + dx, gz = cz + dz
        if (gx < 0 || gz < 0 || gx >= cols || gz >= rows) continue
        const bin = bins[gz * cols + gx]
        if (!bin) continue
        for (let i = 0; i < bin.length; i += 3) {
          const d = Math.hypot(bin[i] - x, bin[i + 1] - z) - bin[i + 2]
          if (d < worst) worst = d
        }
      }
    }
    return worst
  }

  _buildRoadGrid() {
    const SAMPLES = 1200
    const cell = 40
    const pts = []
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity

    for (let i = 0; i < SAMPLES; i++) {
      const t = i / SAMPLES
      const c = this.track.pointAt(t)
      pts.push([c.x, c.z, this.track.halfWidthAt(t)])
      if (c.x < minX) minX = c.x
      if (c.z < minZ) minZ = c.z
      if (c.x > maxX) maxX = c.x
      if (c.z > maxZ) maxZ = c.z
    }

    minX -= cell * 3; minZ -= cell * 3
    const cols = Math.ceil((maxX + cell * 3 - minX) / cell)
    const rows = Math.ceil((maxZ + cell * 3 - minZ) / cell)
    const bins = new Array(cols * rows).fill(null)

    for (const [px, pz, hw] of pts) {
      const gx = Math.floor((px - minX) / cell)
      const gz = Math.floor((pz - minZ) / cell)
      const k = gz * cols + gx
      ;(bins[k] ??= []).push(px, pz, hw)
    }

    this._roadGrid = { cell, bins, minX, minZ, cols, rows }
  }

  // How strongly a point is pulled under the sea, ramping up over the outer
  // ring of the terrain plane: 0 well inland, 1 at the very edge. Uses a square
  // (Chebyshev) distance so the falloff matches the square plane's boundary.
  _shoreFalloff(x, z) {
    const edge = WORLD / 2
    const d = Math.max(Math.abs(x), Math.abs(z))
    const start = edge * 0.62
    if (d < start) return 0
    const k = THREE.MathUtils.clamp((d - start) / (edge - start), 0, 1)
    return k * k * (3 - 2 * k)
  }

  // How deep into the gorge a world point sits: 0 outside, 1 at the riverbed.
  _gorgeFactor(x, z) {
    const d = Math.hypot(x - GORGE.x, z - GORGE.z)
    if (d > GORGE.radius) return 0
    if (d < GORGE.inner) return 1
    const k = 1 - (d - GORGE.inner) / (GORGE.radius - GORGE.inner)
    return k * k * (3 - 2 * k)
  }

  // Terrain that follows the track height so the road never floats, with
  // per-region character: beach sand, jungle floor, terraced hillside, volcanic
  // scree, and the river gorge carved out underneath the causeway.
  _ground() {
    const size = WORLD
    const seg = 260
    const geo = new THREE.PlaneGeometry(size, size, seg, seg)
    geo.rotateX(-Math.PI / 2)

    const pos = geo.attributes.position
    const v = new THREE.Vector3()
    const colors = []

    const sand = new THREE.Color(0xdccBa0)
    const grass = new THREE.Color(0x5f8a3f)
    const jungle = new THREE.Color(0x2f5f2c)
    const paddy = new THREE.Color(0x7cbb4a)
    const scree = new THREE.Color(0x54504a)
    const ash = new THREE.Color(0x3b3733)
    const rock = new THREE.Color(0x6d6459)
    const c = new THREE.Color()

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      const near = this.track.nearest(v)

      // Rolling hills, flattened smoothly toward the road so there are no cliffs
      // at the track edge.
      const n =
        Math.sin(v.x * 0.006) * Math.cos(v.z * 0.007) * 16 +
        Math.sin(v.x * 0.021 + 1.7) * Math.cos(v.z * 0.017) * 5.0 +
        Math.sin(v.x * 0.045 + 3.1) * Math.cos(v.z * 0.038) * 1.6

      // Inland the ground climbs toward the volcano in the north-west. Faded in
      // with distance from the circuit: applied near the road it would bury the
      // track in a trench, since the road's own gradient is far gentler.
      const inland = THREE.MathUtils.clamp((-v.z - 100) / 700, 0, 1)
      const away = THREE.MathUtils.clamp((near.distance - 90) / 260, 0, 1)
      const climb = inland * inland * 130 * away

      // The causeway is a bridge, not an embankment: there the ground must fall
      // away right at the road edge instead of being held level with the deck,
      // or the gorge fills in and the crossing loses all its drama.
      const onBridge = near.zone?.name === 'causeway'
      const flatten = onBridge ? 4 : 48

      const distFromEdge = Math.max(0, near.distance - near.halfWidth - (onBridge ? 1 : 3))
      const blend = THREE.MathUtils.clamp(distFromEdge / flatten, 0, 1)
      const smooth = blend * blend * (3 - 2 * blend)

      let y = THREE.MathUtils.lerp(near.centre.y, near.centre.y + n + climb, smooth)

      // Carve the ocean side down into a beach slope.
      const beachFactor = THREE.MathUtils.clamp((v.x + 340) / -300, 0, 1)
      y = THREE.MathUtils.lerp(y, -7, beachFactor)

      // Carve the river gorge under the causeway.
      const gf = this._gorgeFactor(v.x, v.z) * smooth
      if (gf > 0) y = THREE.MathUtils.lerp(y, RIVER_Y - 5, gf)

      // Drop the outer rim of the island below sea level so the terrain plane
      // disappears into the ocean instead of ending at a visible straight edge.
      y = THREE.MathUtils.lerp(y, -30, this._shoreFalloff(v.x, v.z))

      pos.setY(i, y)

      // Colour by zone and height.
      const zoneName = near.zone?.name
      if (y < 1.0 && beachFactor > 0.15) c.copy(sand)
      else if (gf > 0.35) c.copy(rock)
      else if (y > 150) c.copy(ash)
      else if (y > 95) c.copy(scree).lerp(ash, THREE.MathUtils.clamp((y - 95) / 55, 0, 1))
      else if (zoneName === 'terrace') c.copy(paddy).lerp(grass, this.rand() * 0.4)
      else if (zoneName === 'jungle' || zoneName === 'causeway') c.copy(jungle).lerp(grass, this.rand() * 0.35)
      else if (near.distance < 60) c.copy(grass)
      else c.copy(grass).lerp(jungle, this.rand() * 0.45)

      colors.push(c.r, c.g, c.b)
    }

    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geo.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      map: this.tex.grass || null,
    })
    if (this.tex.grass) {
      this.tex.grass.wrapS = this.tex.grass.wrapT = THREE.RepeatWrapping
      this.tex.grass.repeat.set(140, 140)
    }

    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    this.scene.add(mesh)
    this.ground = mesh
  }

  _ocean() {
    // Large enough that the horizon is always water in every direction — the
    // island plane ends at ±850, and anything past it must read as open sea
    // rather than the void beyond the terrain's edge.
    const geo = new THREE.PlaneGeometry(24000, 24000)
    const water = new Water(geo, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: this.tex.waterNormals || null,
      sunDirection: this.sun.clone().normalize(),
      sunColor: 0xffdcb0,
      waterColor: 0x0e6273,
      distortionScale: 3.4,
      fog: true,
    })
    water.rotation.x = -Math.PI / 2
    water.position.set(0, -3.2, -100)
    this.scene.add(water)
    this.water = water
  }

  _beach() {
    const geo = new THREE.PlaneGeometry(460, 1900, 1, 48)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      pos.setY(i, THREE.MathUtils.mapLinear(x, -230, 230, -6, 3.5) + Math.sin(pos.getZ(i) * 0.02) * 1.3)
    }
    geo.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ color: 0xe6d5aa, roughness: 0.95 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(-470, 0, -100)
    mesh.receiveShadow = true
    this.scene.add(mesh)

    // Surf line: a translucent foam strip that breathes in and out.
    const foam = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 1900, 1, 40),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, transparent: true, opacity: 0.5, roughness: 0.35,
      })
    )
    foam.rotation.x = -Math.PI / 2
    foam.position.set(-620, -2.4, -100)
    this.scene.add(foam)
    this._animated.push({ kind: 'foam', mesh: foam })

    // Jukung outriggers pulled up on the sand.
    for (let i = 0; i < 6; i++) {
      const boat = this._makeJukung()
      boat.position.set(-500 - this.rand() * 60, -1.2, -700 + i * 240 + this.rand() * 60)
      boat.rotation.y = this.rand() * Math.PI
      this.scene.add(boat)
    }
  }

  // Traditional Balinese outrigger canoe, painted with an eye on the prow.
  _makeJukung() {
    const g = new THREE.Group()
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x1b6ca8, roughness: 0.72 })
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xf4a259, roughness: 0.8 })
    const bambooMat = new THREE.MeshStandardMaterial({ color: 0xb99a5e, roughness: 0.9 })

    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.7, 6.5, 5, 10), hullMat)
    hull.rotation.z = Math.PI / 2
    hull.position.y = 0.8
    hull.castShadow = true
    g.add(hull)

    const prow = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.0, 7), trimMat)
    prow.rotation.z = -Math.PI / 2
    prow.position.set(4.4, 1.1, 0)
    g.add(prow)

    // Outrigger floats on bamboo spars, both sides.
    for (const side of [-1, 1]) {
      const float = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 4.4, 4, 7), bambooMat)
      float.rotation.z = Math.PI / 2
      float.position.set(0, 0.35, side * 3.4)
      g.add(float)
      for (const dx of [-1.6, 1.6]) {
        const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.6, 5), bambooMat)
        spar.rotation.x = Math.PI / 2
        spar.position.set(dx, 1.2, side * 1.7)
        g.add(spar)
      }
    }
    return g
  }

  // The river gorge under the causeway: water surface, rocky banks, boulders.
  _gorge() {
    // Sized to the carved basin, not larger: an oversized plane would extend
    // past the gorge rim and swallow the causeway and the road either side.
    // Sits below the ocean plane's level, so it must be the only water visible
    // down here — see _ocean(), which is clipped away from the island interior.
    const riverGeo = new THREE.PlaneGeometry(GORGE.inner * 2.1, GORGE.inner * 2.1)
    const river = new Water(riverGeo, {
      textureWidth: 256,
      textureHeight: 256,
      waterNormals: this.tex.waterNormals || null,
      sunDirection: this.sun.clone().normalize(),
      sunColor: 0xffdcb0,
      waterColor: 0x1d5a4a,
      distortionScale: 1.8,
      fog: true,
    })
    river.rotation.x = -Math.PI / 2
    river.position.set(GORGE.x, RIVER_Y, GORGE.z)
    this.scene.add(river)
    this.river = river

    // Boulders in the riverbed, so falling in reads as a real drop.
    const boulderMat = new THREE.MeshStandardMaterial({ color: 0x5e574e, roughness: 1, flatShading: true })
    for (let i = 0; i < 22; i++) {
      const a = this.rand() * Math.PI * 2
      const r = this.rand() * GORGE.inner
      const b = new THREE.Mesh(new THREE.DodecahedronGeometry(1.4 + this.rand() * 3.2, 0), boulderMat)
      b.position.set(GORGE.x + Math.cos(a) * r, RIVER_Y - 1 + this.rand() * 2.2, GORGE.z + Math.sin(a) * r)
      b.rotation.set(this.rand(), this.rand(), this.rand())
      b.castShadow = true
      this.scene.add(b)
    }

    // Cliff walls around the rim, giving the gorge a hard edge. The causeway
    // crosses this rim, so each slab is rejected if it would stand in the road.
    const cliffMat = new THREE.MeshStandardMaterial({ color: 0x6b6055, roughness: 1, flatShading: true })
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2
      const r = GORGE.inner + 8 + this.rand() * 14
      const h = 14 + this.rand() * 16
      const w = 12 + this.rand() * 10
      const d = 10 + this.rand() * 8

      const x = GORGE.x + Math.cos(a) * r
      const z = GORGE.z + Math.sin(a) * r
      // Half the slab's diagonal is the worst-case reach toward the centreline.
      if (this._roadClearance(x, z) < Math.hypot(w, d) / 2 + 2) continue

      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), cliffMat)
      slab.position.set(x, RIVER_Y + h / 2 - 4, z)
      slab.rotation.y = a + (this.rand() - 0.5) * 0.5
      slab.castShadow = slab.receiveShadow = true
      this.scene.add(slab)
    }
  }

  // A tiered waterfall feeding the gorge — the Bali postcard shot, framed so
  // riders see it as they come onto the causeway.
  _waterfall() {
    const g = new THREE.Group()
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x4f4a42, roughness: 1, flatShading: true })

    const cliff = new THREE.Mesh(new THREE.BoxGeometry(56, 62, 26), rockMat)
    cliff.position.set(0, 24, 0)
    cliff.castShadow = cliff.receiveShadow = true
    g.add(cliff)

    // Three falling sheets of water at slightly different widths and speeds.
    const fallMat = new THREE.MeshStandardMaterial({
      color: 0xdff2f5, roughness: 0.15, metalness: 0.1,
      transparent: true, opacity: 0.82,
    })
    const sheets = []
    for (let i = 0; i < 3; i++) {
      const w = 6 - i * 1.4
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, 58, 1, 12), fallMat.clone())
      sheet.position.set(-8 + i * 8, 26, 13.4)
      g.add(sheet)
      sheets.push(sheet)
    }

    // Mist cloud at the base.
    const mist = new THREE.Mesh(
      new THREE.SphereGeometry(13, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xdfeef2, transparent: true, opacity: 0.2, depthWrite: false })
    )
    mist.position.set(0, 1, 18)
    mist.scale.set(1.4, 0.5, 1)
    g.add(mist)

    // Mossy ledges catching the spray.
    const mossMat = new THREE.MeshStandardMaterial({ color: 0x3f6b32, roughness: 0.95 })
    for (let i = 0; i < 5; i++) {
      const ledge = new THREE.Mesh(new THREE.BoxGeometry(9 + this.rand() * 8, 1.6, 5), mossMat)
      ledge.position.set(-18 + this.rand() * 36, 8 + i * 11, 13.8)
      g.add(ledge)
    }

    // Feeds the gorge from upstream. The cliff block is 56 wide, so the site is
    // pushed away from the circuit far enough that no part of it reaches the
    // road — the jungle sector passes close by on its way to the causeway.
    g.position.set(GORGE.x - 40, RIVER_Y, GORGE.z - 150)
    g.rotation.y = 0.4
    this.scene.add(g)
    this._animated.push({ kind: 'waterfall', sheets, mist })
  }

  // Signature Bali: stepped emerald rice paddies on the inland hillside, now
  // placed so the track climbs right alongside them.
  _riceTerraces() {
    const green = new THREE.Color(0x4faa3c)
    const lush = new THREE.Color(0x86e05c)

    // These hillsides are big — the base ring is baseR + (steps-1)*spacing
    // across — and hand-placing them repeatedly pushed paddy rings through the
    // road somewhere else on the lap (the circuit doubles back on itself twice).
    // So each candidate is checked against the track here: the ring stack is
    // shrunk until it clears the tarmac, and dropped if it can't.
    const candidates = [
      { x: -250, z: -160, steps: 12, baseR: 28, spacing: 9 },
      { x: -108, z: -52, steps: 10, baseR: 24, spacing: 8 },
    ]

    const sites = []
    for (const cand of candidates) {
      const clearance = this._roadClearance(cand.x, cand.z) - 14

      let steps = cand.steps
      while (steps > 3 && cand.baseR + (steps - 1) * cand.spacing > clearance) steps--
      if (steps < 4) continue

      // Sit the stack on the local ground so it neither floats nor sinks.
      const near = this.track.nearest(new THREE.Vector3(cand.x, 0, cand.z))
      sites.push({ ...cand, steps, base: this._terrainHeight(cand.x, cand.z, near) })
    }

    for (const site of sites) {
      const group = new THREE.Group()
      for (let i = 0; i < site.steps; i++) {
        // Widest ring at the bottom, narrowing as it climbs — a stepped hill,
        // not an inverted cone. `base` lifts the whole site to the local
        // ground height so it doesn't sink into the hillside.
        const r = site.baseR + (site.steps - 1 - i) * site.spacing
        const h = site.base + i * 2.4
        const geo = new THREE.CylinderGeometry(r, r + 3.4, 3.0, 44, 1, true)
        const mat = new THREE.MeshStandardMaterial({
          color: green.clone().lerp(lush, i / site.steps),
          roughness: 0.85,
          side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(geo, mat)
        ring.position.set(site.x, h, site.z)
        ring.castShadow = ring.receiveShadow = true
        group.add(ring)

        // Flooded paddy surface catching the sunset — the reflective look.
        const water = new THREE.Mesh(
          new THREE.RingGeometry(r - 13, r, 44),
          new THREE.MeshStandardMaterial({
            color: 0xa8dcc8, roughness: 0.07, metalness: 0.6,
            transparent: true, opacity: 0.84, side: THREE.DoubleSide,
          })
        )
        water.rotation.x = -Math.PI / 2
        water.position.set(site.x, h + 1.35, site.z)
        group.add(water)

        // Rice stalks poking through the water on every third terrace.
        if (i % 3 === 0) {
          const stalkMat = new THREE.MeshStandardMaterial({ color: 0x9ad35e, roughness: 0.9 })
          const stalks = new THREE.InstancedMesh(
            new THREE.ConeGeometry(0.28, 1.5, 4), stalkMat, 60
          )
          const m = new THREE.Matrix4()
          for (let k = 0; k < 60; k++) {
            const a = (k / 60) * Math.PI * 2 + this.rand()
            const rr = r - 3 - this.rand() * 8
            m.setPosition(site.x + Math.cos(a) * rr, h + 2.0, site.z + Math.sin(a) * rr)
            stalks.setMatrixAt(k, m)
          }
          group.add(stalks)
        }
      }

      // A farmer's hut on the top terrace.
      const hut = this._makeHut(0.9)
      hut.position.set(site.x + 6, site.base + site.steps * 2.4, site.z + 6)
      group.add(hut)

      this.scene.add(group)
    }
  }

  _makeHut(scale = 1) {
    const g = new THREE.Group()
    const wood = new THREE.MeshStandardMaterial({ color: 0x6f4e34, roughness: 0.94 })
    const thatch = new THREE.MeshStandardMaterial({ color: 0x8a6b3d, roughness: 0.99 })

    const walls = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 4.4), wood)
    walls.position.y = 1.6
    walls.castShadow = true
    g.add(walls)

    const roof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 3.4, 4), thatch)
    roof.position.y = 4.6
    roof.rotation.y = Math.PI / 4
    roof.castShadow = true
    g.add(roof)

    g.scale.setScalar(scale)
    return g
  }

  // Mount Agung dominating the horizon, with a smoking crater.
  _volcano() {
    const g = new THREE.Group()
    const geo = new THREE.ConeGeometry(420, 400, 56, 10)
    const pos = geo.attributes.position
    const v = new THREE.Vector3()
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      const ridge = Math.sin(Math.atan2(v.z, v.x) * 7) * 14 * (1 - v.y / 400)
      pos.setX(i, v.x + ridge)
      pos.setZ(i, v.z + ridge)
    }
    geo.computeVertexNormals()

    const mtn = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x46554f, roughness: 1, flatShading: true,
    }))
    mtn.position.y = 200
    g.add(mtn)

    // Bare volcanic cone near the summit.
    const cap = new THREE.Mesh(
      new THREE.ConeGeometry(150, 130, 40, 4),
      new THREE.MeshStandardMaterial({ color: 0x3a352f, roughness: 1, flatShading: true })
    )
    cap.position.y = 350
    g.add(cap)

    // Smoke plume drifting off the crater.
    const plumeMat = new THREE.MeshBasicMaterial({
      color: 0xd9d2c9, transparent: true, opacity: 0.28, depthWrite: false,
    })
    const plume = new THREE.Mesh(new THREE.SphereGeometry(52, 14, 12), plumeMat)
    plume.position.set(10, 440, 0)
    plume.scale.set(1.2, 0.7, 1.2)
    g.add(plume)

    // Hazy secondary peaks for depth.
    const small = new THREE.Mesh(
      new THREE.ConeGeometry(240, 180, 32, 4),
      new THREE.MeshStandardMaterial({ color: 0x58675f, roughness: 1, flatShading: true })
    )
    small.position.set(-430, 90, 160)
    g.add(small)

    const far = new THREE.Mesh(
      new THREE.ConeGeometry(300, 150, 24, 3),
      new THREE.MeshStandardMaterial({ color: 0x64726a, roughness: 1, flatShading: true })
    )
    far.position.set(520, 75, 260)
    g.add(far)

    g.position.set(-260, 0, -1250)

    // The peaks sit ~1000 units away, far outside the sun's 340-unit shadow
    // frustum that follows the player. Sampling the shadow map out there
    // produces heavy acne — a checkerboard across the whole mountain — so opt
    // the distant scenery out of shadowing entirely.
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false } })

    this.scene.add(g)
    this._animated.push({ kind: 'plume', mesh: plume })
  }

  // Pura-style temple complex on the headland the track curves around, with a
  // second candi bentar gate the road actually passes through.
  _templeComplex() {
    const stone = new THREE.MeshStandardMaterial({ color: 0x6b6255, roughness: 0.94 })
    const darkStone = new THREE.MeshStandardMaterial({ color: 0x4d4740, roughness: 0.96 })
    const thatch = new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.98 })
    const gold = new THREE.MeshStandardMaterial({ color: 0xd4a437, roughness: 0.35, metalness: 0.7 })

    // --- Main sea temple, off to the side of the headland ---
    const g = new THREE.Group()
    const base = new THREE.Mesh(new THREE.BoxGeometry(56, 5, 42), stone)
    base.position.y = 2.5
    base.receiveShadow = base.castShadow = true
    g.add(base)

    const meru = (x, z, tiers, scale) => {
      const t = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(5 * scale, 6 * scale, 5 * scale), stone)
      body.position.y = 3 * scale
      body.castShadow = true
      t.add(body)
      for (let i = 0; i < tiers; i++) {
        const w = (7 - i * (5.2 / tiers)) * scale
        const roof = new THREE.Mesh(new THREE.ConeGeometry(w, 2.1 * scale, 4), thatch)
        roof.position.y = (6 + i * 2.3) * scale
        roof.rotation.y = Math.PI / 4
        roof.castShadow = true
        t.add(roof)
      }
      // Gold finial on top.
      const finial = new THREE.Mesh(new THREE.ConeGeometry(0.5 * scale, 1.8 * scale, 6), gold)
      finial.position.y = (6 + tiers * 2.3) * scale
      t.add(finial)
      t.position.set(x, 5, z)
      return t
    }
    g.add(meru(-16, 0, 7, 1.2), meru(0, -6, 11, 1.05), meru(15, 3, 5, 0.95), meru(-4, 12, 3, 0.8))

    // Candi bentar (split gate) facing the sea.
    for (const side of [-1, 1]) {
      const half = new THREE.Mesh(new THREE.BoxGeometry(4.5, 16, 5.5), stone)
      half.position.set(side * 4.5, 13, 21)
      half.castShadow = true
      g.add(half)
      for (let i = 0; i < 5; i++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(5.1 - i * 0.55, 0.7, 5.9 - i * 0.55), stone)
        step.position.set(side * 4.5, 21 + i * 1.2, 21)
        g.add(step)
      }
    }

    g.position.set(268, 14, -232)
    g.rotation.y = -0.55
    this.scene.add(g)

    // --- Gateway the road drives through, at the temple zone entrance ---
    const gateT = 0.305
    const c = this.track.pointAt(gateT)
    const side = this.track.sideAt(gateT)
    const tan = this.track.tangentAt(gateT)
    const half = this.track.halfWidthAt(gateT)
    const gate = new THREE.Group()

    for (const dir of [-1, 1]) {
      const tower = new THREE.Group()
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(4, 17, 6), stone)
      shaft.position.y = 8.5
      shaft.castShadow = true
      tower.add(shaft)
      // Stepped taper, the split-gate silhouette.
      for (let i = 0; i < 6; i++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(4.4 - i * 0.5, 0.9, 6.4 - i * 0.6), darkStone)
        step.position.y = 17.5 + i * 1.1
        tower.add(step)
      }
      // Carved relief bands.
      for (let i = 0; i < 4; i++) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.5, 6.4), darkStone)
        band.position.y = 3 + i * 3.6
        tower.add(band)
      }
      tower.position.copy(c).addScaledVector(side, dir * (half + 2.6))
      gate.add(tower)

      // Guardian statue at the foot of each tower.
      const statue = this._makeGuardian()
      statue.position.copy(c).addScaledVector(side, dir * (half + 6.5))
      statue.rotation.y = Math.atan2(-side.x * dir, -side.z * dir)
      gate.add(statue)
    }

    gate.rotation.y = 0
    // Orient the towers to face along the road.
    gate.children.forEach(child => { child.rotation.y = Math.atan2(tan.x, tan.z) })
    this.scene.add(gate)
  }

  // Dwarapala guardian statue — the stone figures flanking Balinese gateways.
  _makeGuardian() {
    const g = new THREE.Group()
    const stone = new THREE.MeshStandardMaterial({ color: 0x5f594f, roughness: 0.97 })
    const cloth = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.9 })

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.6, 2.4), stone)
    plinth.position.y = 0.8
    plinth.castShadow = true
    g.add(plinth)

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.05, 3.0, 8), stone)
    body.position.y = 3.1
    body.castShadow = true
    g.add(body)

    // The checked poleng sarong they are always dressed in.
    const sarong = new THREE.Mesh(new THREE.CylinderGeometry(1.08, 1.15, 1.2, 8), cloth)
    sarong.position.y = 2.2
    g.add(sarong)

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.72, 10, 8), stone)
    head.position.y = 5.0
    head.castShadow = true
    g.add(head)

    // Crown and tusks.
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.72, 1.1, 8), stone)
    crown.position.y = 5.8
    g.add(crown)
    for (const s of [-1, 1]) {
      const tusk = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 5), cloth)
      tusk.position.set(s * 0.3, 4.68, 0.6)
      tusk.rotation.x = Math.PI
      g.add(tusk)
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.24, 2.2, 6), stone)
      arm.position.set(s * 1.0, 3.2, 0.15)
      arm.rotation.z = s * 0.25
      g.add(arm)
    }
    return g
  }

  // Small shrines and split gates dotted along the roadside — the thing that
  // most makes a Bali road feel like a Bali road.
  _roadsideShrines() {
    const stone = new THREE.MeshStandardMaterial({ color: 0x6a6154, roughness: 0.95 })
    const thatch = new THREE.MeshStandardMaterial({ color: 0x2f2b25, roughness: 0.98 })
    const cloth = new THREE.MeshStandardMaterial({
      color: 0xf0eade, roughness: 0.9, side: THREE.DoubleSide,
    })

    const spots = [0.055, 0.135, 0.225, 0.345, 0.425, 0.575, 0.645, 0.735, 0.825, 0.885, 0.955]

    for (const t of spots) {
      const c = this.track.pointAt(t)
      const side = this.track.sideAt(t)
      const tan = this.track.tangentAt(t)
      const half = this.track.halfWidthAt(t)
      const dir = this.rand() > 0.5 ? 1 : -1

      const g = new THREE.Group()

      // Padmasana-style shrine: stone plinth, tapering tower, thatched cap.
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 2.2), stone)
      plinth.position.y = 0.6
      plinth.castShadow = true
      g.add(plinth)

      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 3.4, 8), stone)
      column.position.y = 2.9
      column.castShadow = true
      g.add(column)

      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 1.9), stone)
      seat.position.y = 4.8
      g.add(seat)

      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 2.0, 4), thatch)
      roof.position.y = 6.0
      roof.rotation.y = Math.PI / 4
      roof.castShadow = true
      g.add(roof)

      // White ceremonial cloth wrapped round the column.
      const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.85, 0.9, 8), cloth)
      wrap.position.y = 2.0
      g.add(wrap)

      g.position.copy(c).addScaledVector(side, dir * (half + 5.5))
      g.position.y = c.y
      g.rotation.y = Math.atan2(tan.x, tan.z)
      this.scene.add(g)
    }
  }

  // A Balinese village street: compound walls, warungs, scooters parked up.
  _village() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x8d7f6c, roughness: 0.96 })
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a4a35, roughness: 0.94 })
    const thatch = new THREE.MeshStandardMaterial({ color: 0x8f7040, roughness: 0.99 })
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.95 })

    // Line both sides of the village stretch with walled compounds.
    for (let i = 0; i < 26; i++) {
      const t = 0.80 + (i / 26) * 0.12
      const c = this.track.pointAt(t)
      const side = this.track.sideAt(t)
      const tan = this.track.tangentAt(t)
      const half = this.track.halfWidthAt(t)
      const yaw = Math.atan2(tan.x, tan.z)

      for (const dir of [-1, 1]) {
        const g = new THREE.Group()
        // The group is rotated by `yaw`, which maps local +x onto -side (not
        // +side). Rather than rely on that, `out(n)` is defined empirically as
        // "n metres further from the centreline": getting this sign wrong put
        // every house roof directly over the road.
        const out = (n) => -dir * n

        // Compound wall with a tiled coping. Kept below eye level from the
        // chase camera so the village never walls the rider in.
        const wall = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.0, 9), wallMat)
        wall.position.y = 1.0
        wall.castShadow = wall.receiveShadow = true
        g.add(wall)

        const coping = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 9.2), roofMat)
        coping.position.y = 2.15
        g.add(coping)

        // Roughly every third compound gets a house, set well behind the wall.
        // Denser than this and the street stops reading as a village and
        // becomes a walled canyon with no view out to the island.
        if (i % 3 === (dir > 0 ? 0 : 1)) {
          const house = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 7), wallMat)
          house.position.set(out(9), 1.6, 0)
          house.castShadow = true
          g.add(house)

          const roof = new THREE.Mesh(new THREE.ConeGeometry(4.8, 2.8, 4), i % 2 ? roofMat : thatch)
          roof.position.set(out(9), 4.6, 0)
          roof.rotation.y = Math.PI / 4
          roof.castShadow = true
          g.add(roof)
        }

        // Occasional warung with a hand-painted sign facing the road.
        if (i % 5 === 2 && dir > 0) {
          const counter = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 4), wood)
          counter.position.set(out(-0.9), 0.55, 0)
          g.add(counter)
          const sign = new THREE.Mesh(
            new THREE.PlaneGeometry(3.2, 0.9),
            new THREE.MeshStandardMaterial({ color: 0x2f7d52, roughness: 0.85, side: THREE.DoubleSide })
          )
          sign.position.set(out(-1.4), 2.4, 0)
          sign.rotation.y = Math.PI / 2
          g.add(sign)
        }

        // The wall sits just off the verge; the house is another 9m behind it.
        g.position.copy(c).addScaledVector(side, dir * (half + 4.5))
        g.rotation.y = yaw
        this.scene.add(g)
      }
    }

    // Power lines strung along the street — the tangled cables are unmistakable.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9a9186, roughness: 0.95 })
    const wireMat = new THREE.LineBasicMaterial({ color: 0x1c1c1c })
    let prevTop = null
    for (let i = 0; i <= 14; i++) {
      const t = 0.80 + (i / 14) * 0.12
      const c = this.track.pointAt(t)
      const side = this.track.sideAt(t)
      const half = this.track.halfWidthAt(t)

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 11, 6), poleMat)
      const base = c.clone().addScaledVector(side, half + 3.0)
      pole.position.copy(base).setY(c.y + 5.5)
      pole.castShadow = true
      this.scene.add(pole)

      const top = base.clone().setY(c.y + 10.4)
      if (prevTop) {
        // Three sagging cables between each pair of poles.
        for (let k = 0; k < 3; k++) {
          const sag = 1.0 + k * 0.5
          const mid = prevTop.clone().lerp(top, 0.5).setY(
            (prevTop.y + top.y) / 2 - sag
          )
          const curve = new THREE.QuadraticBezierCurve3(
            prevTop.clone().add(new THREE.Vector3(0, -k * 0.45, 0)),
            mid,
            top.clone().add(new THREE.Vector3(0, -k * 0.45, 0))
          )
          const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(12))
          this.scene.add(new THREE.Line(geo, wireMat))
        }
      }
      prevTop = top
    }
  }

  // Huge banyan trees with hanging aerial roots — the sacred trees you find at
  // village crossroads all over the island.
  _banyans() {
    const sites = [
      { t: 0.325, dir: 1, off: 16 },
      { t: 0.855, dir: -1, off: 15 },
      { t: 0.415, dir: -1, off: 18 },
    ]

    const barkMat = new THREE.MeshStandardMaterial({ color: 0x6d5a45, roughness: 0.96 })
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x2c5d2a, roughness: 0.88, flatShading: true,
    })

    for (const site of sites) {
      const g = new THREE.Group()

      // Buttressed trunk: several fused cylinders.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const r = 1.5 + this.rand() * 0.8
        const t = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r, 12 + this.rand() * 4, 7), barkMat)
        t.position.set(Math.cos(a) * 1.6, 6, Math.sin(a) * 1.6)
        t.rotation.z = Math.cos(a) * 0.08
        t.castShadow = true
        g.add(t)
      }
      const core = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.4, 14, 9), barkMat)
      core.position.y = 7
      core.castShadow = true
      g.add(core)

      // Broad canopy from overlapping blobs.
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2
        const r = i === 0 ? 0 : 5 + this.rand() * 5
        const blob = new THREE.Mesh(
          new THREE.IcosahedronGeometry(5 + this.rand() * 3.5, 1), leafMat
        )
        blob.position.set(Math.cos(a) * r, 15 + this.rand() * 4, Math.sin(a) * r)
        blob.scale.y = 0.72
        blob.castShadow = true
        g.add(blob)
      }

      // Aerial roots dropping from the canopy.
      for (let i = 0; i < 24; i++) {
        const a = this.rand() * Math.PI * 2
        const r = 3 + this.rand() * 8
        const len = 5 + this.rand() * 7
        const root = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.13, len, 4), barkMat
        )
        root.position.set(Math.cos(a) * r, 14 - len / 2, Math.sin(a) * r)
        g.add(root)
      }

      const c = this.track.pointAt(site.t)
      const side = this.track.sideAt(site.t)
      const half = this.track.halfWidthAt(site.t)
      g.position.copy(c).addScaledVector(side, site.dir * (half + site.off))
      this.scene.add(g)
    }
  }

  _makePalm() {
    const palm = new THREE.Group()
    const h = 9 + this.rand() * 7

    // Curved trunk built from stacked segments — straight cylinders read as fake.
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(this.rand() * 0.8 - 0.4, h * 0.35, this.rand() * 0.6 - 0.3),
      new THREE.Vector3(this.rand() * 1.6 - 0.8, h * 0.7, this.rand() * 1.2 - 0.6),
      new THREE.Vector3(this.rand() * 2.4 - 1.2, h, this.rand() * 1.8 - 0.9),
    ])
    const trunk = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 10, 0.34, 7, false),
      new THREE.MeshStandardMaterial({ color: 0x8b6f47, roughness: 0.93 })
    )
    trunk.castShadow = true
    palm.add(trunk)

    const top = curve.getPointAt(1)
    const frondMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x2f7d32).offsetHSL(0, 0, (this.rand() - 0.5) * 0.12),
      roughness: 0.75, side: THREE.DoubleSide,
    })

    const n = 8 + Math.floor(this.rand() * 4)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rand() * 0.3
      const len = 3.6 + this.rand() * 1.8
      const shape = new THREE.Shape()
      shape.moveTo(0, 0)
      shape.quadraticCurveTo(len * 0.5, 0.55, len, 0.05)
      shape.quadraticCurveTo(len * 0.5, -0.35, 0, 0)
      const frond = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), frondMat)
      frond.position.copy(top)
      frond.rotation.set(-Math.PI / 2 + (0.45 + this.rand() * 0.4), 0, 0)
      frond.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), a)
      frond.castShadow = true
      palm.add(frond)
    }

    // Coconuts
    for (let i = 0; i < 3; i++) {
      const nut = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 })
      )
      nut.position.copy(top).add(new THREE.Vector3((this.rand() - 0.5) * 0.9, -0.45, (this.rand() - 0.5) * 0.9))
      palm.add(nut)
    }
    return palm
  }

  // Scatter palms outside the track, keeping a clear margin so they never block
  // the racing line, and skipping the volcanic slopes where nothing grows.
  _palms() {
    const group = new THREE.Group()
    const variants = []
    for (let i = 0; i < 7; i++) variants.push(this._makePalm())

    let placed = 0
    let guard = 0
    while (placed < 240 && guard < 5000) {
      guard++
      const x = (this.rand() - 0.5) * WORLD * 0.8
      const z = (this.rand() - 0.5) * WORLD * 0.8
      const p = new THREE.Vector3(x, 0, z)
      const near = this.track.nearest(p)

      // Keep a clean corridor around the road — wide enough for the fronds,
      // which reach several units past the trunk — and don't plant in the sea.
      if (this._roadClearance(x, z) < 11) continue
      if (near.distance > 250 && this.rand() > 0.35) continue
      if (x < -380) continue
      if (this._gorgeFactor(x, z) > 0.3) continue

      const y = this._terrainHeight(x, z, near)
      if (y < 0.2 || y > 90) continue      // no palms on the volcano

      const tree = variants[Math.floor(this.rand() * variants.length)].clone()
      tree.position.set(x, y, z)
      tree.rotation.y = this.rand() * Math.PI * 2
      tree.scale.setScalar(0.75 + this.rand() * 0.6)
      group.add(tree)
      placed++
    }

    // Dense palm grove behind the beach.
    for (let i = 0; i < 70; i++) {
      const tree = variants[Math.floor(this.rand() * variants.length)].clone()
      const x = -340 - this.rand() * 100
      const z = (this.rand() - 0.5) * 1300 - 100
      tree.position.set(x, 1.2 + this.rand(), z)
      tree.rotation.y = this.rand() * Math.PI * 2
      tree.rotation.z = (this.rand() - 0.5) * 0.14   // leaning toward the sea
      tree.scale.setScalar(0.85 + this.rand() * 0.7)
      group.add(tree)
    }

    this.scene.add(group)
  }

  // Dense jungle canopy walling in the gorge section, so that stretch feels
  // enclosed and green rather than open coast.
  _jungle() {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x574734, roughness: 0.96 })
    const canopyMats = [0x1f4d22, 0x2b6b2b, 0x3a8036].map(
      c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true })
    )

    const trunkGeo = new THREE.CylinderGeometry(0.6, 0.95, 16, 6)
    const canopyGeo = new THREE.IcosahedronGeometry(4.6, 0)

    const COUNT = 420
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, COUNT)
    const canopies = canopyMats.map(m => new THREE.InstancedMesh(canopyGeo, m, COUNT))
    const canopyCount = [0, 0, 0]

    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)

    let placed = 0
    let guard = 0
    while (placed < COUNT && guard < 12000) {
      guard++
      // Concentrate around the jungle/causeway/terrace stretch of the lap.
      const t = 0.34 + this.rand() * 0.36
      const c = this.track.pointAt(t)
      const side = this.track.sideAt(t)
      const dir = this.rand() > 0.5 ? 1 : -1
      const half = this.track.halfWidthAt(t)
      const off = half + 9 + this.rand() * 85

      const x = c.x + side.x * dir * off + (this.rand() - 0.5) * 22
      const z = c.z + side.z * dir * off + (this.rand() - 0.5) * 22
      p.set(x, 0, z)
      const near = this.track.nearest(p)
      // Margin covers the widest scaled canopy blob (≈7 units), not just the
      // trunk, so no tree overhangs the racing line.
      if (this._roadClearance(x, z) < 13) continue
      if (this._gorgeFactor(x, z) > 0.45) continue

      const y = this._terrainHeight(x, z, near)
      if (y < 0.5) continue
      // Reject trees on ground that rises steeply above the adjacent road: a
      // 16m trunk rooted 25m uphill puts its canopy across the driver's view.
      if (y > near.centre.y + 14) continue

      const scale = 0.7 + this.rand() * 0.8
      q.setFromAxisAngle(up, this.rand() * Math.PI * 2)

      p.set(x, y + 8 * scale, z)
      s.set(scale, scale, scale)
      m4.compose(p, q, s)
      trunks.setMatrixAt(placed, m4)

      const ci = Math.floor(this.rand() * 3)
      if (canopyCount[ci] < COUNT) {
        p.set(x, y + (15 + this.rand() * 3) * scale, z)
        s.set(scale * (1 + this.rand() * 0.5), scale * 0.8, scale * (1 + this.rand() * 0.5))
        m4.compose(p, q, s)
        canopies[ci].setMatrixAt(canopyCount[ci]++, m4)
      }
      placed++
    }

    trunks.count = placed
    trunks.castShadow = true
    this.scene.add(trunks)
    canopies.forEach((mesh, i) => {
      mesh.count = canopyCount[i]
      mesh.castShadow = true
      this.scene.add(mesh)
    })
  }

  // Must mirror _ground()'s height function exactly, or scenery placed with it
  // will float above or sink into the terrain mesh.
  _terrainHeight(x, z, near) {
    const n =
      Math.sin(x * 0.006) * Math.cos(z * 0.007) * 16 +
      Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017) * 5.0 +
      Math.sin(x * 0.045 + 3.1) * Math.cos(z * 0.038) * 1.6
    const inland = THREE.MathUtils.clamp((-z - 100) / 700, 0, 1)
    const away = THREE.MathUtils.clamp((near.distance - 90) / 260, 0, 1)
    const climb = inland * inland * 130 * away
    const onBridge = near.zone?.name === 'causeway'
    const distFromEdge = Math.max(0, near.distance - near.halfWidth - (onBridge ? 1 : 3))
    const blend = THREE.MathUtils.clamp(distFromEdge / (onBridge ? 4 : 48), 0, 1)
    const smooth = blend * blend * (3 - 2 * blend)
    let y = THREE.MathUtils.lerp(near.centre.y, near.centre.y + n + climb, smooth)
    const beachFactor = THREE.MathUtils.clamp((x + 340) / -300, 0, 1)
    y = THREE.MathUtils.lerp(y, -7, beachFactor)
    const gf = this._gorgeFactor(x, z) * smooth
    if (gf > 0) y = THREE.MathUtils.lerp(y, RIVER_Y - 5, gf)
    return THREE.MathUtils.lerp(y, -30, this._shoreFalloff(x, z))
  }

  // Low ground cover: ferns, frangipani bushes, tall grass tufts.
  _foliage() {
    const bushGeo = new THREE.IcosahedronGeometry(1.5, 0)
    const colors = [0x2f6b2f, 0x3f8a3a, 0x59a544, 0xb5487f]   // last one = frangipani
    const mats = colors.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }))
    const COUNT = 900
    const meshes = mats.map(m => new THREE.InstancedMesh(bushGeo, m, COUNT))
    const counts = [0, 0, 0, 0]

    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()

    let guard = 0
    let placed = 0
    while (placed < COUNT * 2.5 && guard < 24000) {
      guard++
      const x = (this.rand() - 0.5) * WORLD * 0.78
      const z = (this.rand() - 0.5) * WORLD * 0.78
      p.set(x, 0, z)
      const near = this.track.nearest(p)
      // Bushes scale up to ~2 units across, so keep them clear of the verge.
      if (this._roadClearance(x, z) < 5.5) continue
      if (x < -320) continue
      if (this._gorgeFactor(x, z) > 0.4) continue
      const y = this._terrainHeight(x, z, near)
      if (y < 0.5 || y > 120) continue

      // Frangipani is rarer than the greens.
      const idx = this.rand() > 0.88 ? 3 : Math.floor(this.rand() * 3)
      if (counts[idx] >= COUNT) continue
      p.set(x, y + 0.5, z)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rand() * Math.PI)
      const sc = idx === 3 ? 0.5 : 1
      s.set((0.6 + this.rand() * 1.4) * sc, (0.5 + this.rand() * 1.1) * sc, (0.6 + this.rand() * 1.4) * sc)
      m4.compose(p, q, s)
      meshes[idx].setMatrixAt(counts[idx]++, m4)
      placed++
    }

    meshes.forEach((mesh, i) => {
      mesh.count = counts[i]
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.scene.add(mesh)
    })
  }

  // Balinese penjor — the tall arched bamboo poles — plus umbul-umbul banners
  // along the start straight and through the village.
  _flags() {
    const g = new THREE.Group()
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xc9b28a, roughness: 0.9 })
    const clothColors = [0xffd54f, 0xef5350, 0xffffff, 0x26a69a]
    this.banners = []

    // Banner-lined start straight.
    for (let i = 0; i < 26; i++) {
      const t = (i / 26) * 0.09
      const c = this.track.pointAt(t)
      const side = this.track.sideAt(t)
      const half = this.track.halfWidthAt(t)
      for (const dir of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7, 6), poleMat)
        const p = c.clone().addScaledVector(side, dir * (half + 3.4))
        pole.position.copy(p).setY(c.y + 3.5)
        pole.castShadow = true
        g.add(pole)

        const cloth = new THREE.Mesh(
          new THREE.PlaneGeometry(0.9, 4.5, 4, 8),
          new THREE.MeshStandardMaterial({
            color: clothColors[(i + (dir > 0 ? 1 : 0)) % clothColors.length],
            roughness: 0.8, side: THREE.DoubleSide,
          })
        )
        cloth.position.copy(p).setY(c.y + 4.6)
        cloth.position.addScaledVector(side, dir * 0.5)
        g.add(cloth)
        this.banners.push(cloth)
      }
    }

    // Penjor: tall bamboo poles that arch over the road, hung with palm-leaf
    // decorations. These line the village street and the temple approach.
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0xd9c87a, roughness: 0.85, side: THREE.DoubleSide,
    })
    for (const range of [[0.29, 0.37], [0.80, 0.91]]) {
      const n = 10
      for (let i = 0; i < n; i++) {
        const t = range[0] + (i / n) * (range[1] - range[0])
        const c = this.track.pointAt(t)
        const side = this.track.sideAt(t)
        const half = this.track.halfWidthAt(t)
        const dir = i % 2 === 0 ? 1 : -1
        const base = c.clone().addScaledVector(side, dir * (half + 2.0))

        // The characteristic curve: straight up, then bending over the road.
        const curve = new THREE.CatmullRomCurve3([
          base.clone().setY(c.y),
          base.clone().setY(c.y + 5).addScaledVector(side, -dir * 0.4),
          base.clone().setY(c.y + 8.5).addScaledVector(side, -dir * 2.2),
          base.clone().setY(c.y + 9.8).addScaledVector(side, -dir * 5.5),
        ])
        const pole = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 14, 0.13, 5, false), poleMat
        )
        pole.castShadow = true
        g.add(pole)

        // Palm-leaf tassel hanging off the tip.
        const tip = curve.getPointAt(1)
        const tassel = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 3.2, 2, 5), leafMat)
        tassel.position.copy(tip).setY(tip.y - 1.7)
        g.add(tassel)
        this.banners.push(tassel)
      }
    }

    this.scene.add(g)
  }

  // A few birds circling over the coast, purely for life in the sky.
  _birds() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a, side: THREE.DoubleSide })
    const flock = new THREE.Group()
    for (let i = 0; i < 14; i++) {
      const shape = new THREE.Shape()
      shape.moveTo(-1.4, 0)
      shape.quadraticCurveTo(-0.7, 0.5, 0, 0.08)
      shape.quadraticCurveTo(0.7, 0.5, 1.4, 0)
      shape.quadraticCurveTo(0.7, 0.18, 0, -0.05)
      shape.quadraticCurveTo(-0.7, 0.18, -1.4, 0)
      const bird = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat)
      bird.rotation.x = -Math.PI / 2
      bird.userData.r = 120 + this.rand() * 220
      bird.userData.phase = this.rand() * Math.PI * 2
      bird.userData.h = 70 + this.rand() * 60
      bird.userData.speed = 0.06 + this.rand() * 0.05
      flock.add(bird)
    }
    flock.position.set(-350, 0, -150)
    this.scene.add(flock)
    this._animated.push({ kind: 'birds', flock })
  }

  update(dt, elapsed) {
    if (this.water) this.water.material.uniforms.time.value += dt * 0.55
    if (this.river) this.river.material.uniforms.time.value += dt * 1.4

    // Gentle banner sway.
    for (let i = 0; i < this.banners.length; i++) {
      const b = this.banners[i]
      b.rotation.y = Math.sin(elapsed * 1.7 + i * 0.6) * 0.35
    }

    for (const a of this._animated) {
      if (a.kind === 'waterfall') {
        // Scroll the falling sheets' UVs to fake flowing water, and breathe
        // the mist so the base of the fall never looks static.
        for (let i = 0; i < a.sheets.length; i++) {
          const s = a.sheets[i]
          s.material.opacity = 0.72 + Math.sin(elapsed * (3 + i) + i) * 0.1
          s.scale.x = 1 + Math.sin(elapsed * 2.2 + i * 1.3) * 0.06
        }
        const m = 1 + Math.sin(elapsed * 0.9) * 0.08
        a.mist.scale.set(1.4 * m, 0.5 * m, m)
      } else if (a.kind === 'foam') {
        a.mesh.position.x = -620 + Math.sin(elapsed * 0.4) * 9
        a.mesh.material.opacity = 0.42 + Math.sin(elapsed * 0.4) * 0.12
      } else if (a.kind === 'plume') {
        a.mesh.position.x = 10 + Math.sin(elapsed * 0.14) * 22
        a.mesh.material.opacity = 0.24 + Math.sin(elapsed * 0.3) * 0.05
      } else if (a.kind === 'birds') {
        for (const b of a.flock.children) {
          const u = b.userData
          const ang = elapsed * u.speed + u.phase
          b.position.set(Math.cos(ang) * u.r, u.h + Math.sin(elapsed * 0.5 + u.phase) * 6, Math.sin(ang) * u.r)
          b.rotation.z = -ang + Math.PI / 2
          // Wing flap via a squash on the wingspan axis.
          b.scale.y = 0.6 + Math.abs(Math.sin(elapsed * 6 + u.phase)) * 0.6
        }
      }
    }
  }

  // Keep the shadow frustum centred on the player so shadows stay crisp
  // across the world without a huge shadow map.
  focusShadow(target) {
    if (!this.sunLight) return
    this.sunLight.position.copy(this.sun).multiplyScalar(400).add(target)
    this.sunLight.target.position.copy(target)
    this.sunLight.target.updateMatrixWorld()
    if (!this.sunLight.target.parent) this.scene.add(this.sunLight.target)
  }
}
