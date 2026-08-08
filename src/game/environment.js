import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { Water } from 'three/examples/jsm/objects/Water.js'
import { TRACK_WIDTH } from './track.js'

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

const WORLD = 1400

export class Environment {
  constructor(scene, renderer, track, textures) {
    this.scene = scene
    this.renderer = renderer
    this.track = track
    this.tex = textures || {}
    this.rand = mulberry32(20260808)
    this.water = null
    this.sun = new THREE.Vector3()
  }

  build() {
    this._sky()
    this._lights()
    this._ground()
    this._ocean()
    this._beach()
    this._riceTerraces()
    this._palms()
    this._temple()
    this._volcano()
    this._foliage()
    this._flags()
  }

  // --- Sky & atmosphere: golden-hour Bali sunset ---
  _sky() {
    const sky = new Sky()
    sky.scale.setScalar(20000)
    this.scene.add(sky)

    // Sunset atmosphere. High turbidity with low rayleigh washes the sky to grey,
    // so keep turbidity modest and rayleigh high enough for real blue scattering
    // overhead, with mie providing the warm glow near the sun.
    const u = sky.material.uniforms
    u.turbidity.value = 4
    u.rayleigh.value = 1.2
    u.mieCoefficient.value = 0.02
    u.mieDirectionalG.value = 0.94

    // Sun kept a little higher: below ~5° the whole sky desaturates to haze.
    const phi = THREE.MathUtils.degToRad(90 - 16)
    const theta = THREE.MathUtils.degToRad(122)
    this.sun.setFromSphericalCoords(1, phi, theta)
    u.sunPosition.value.copy(this.sun)

    // Light haze only. Denser than ~0.0005 and the volcano and rice terraces
    // wash out to flat white before you can see them.
    this.scene.fog = new THREE.FogExp2(0xe8c9a4, 0.00045)

    // Use the sky as the environment map so metal/rough surfaces pick up
    // real sky colour instead of looking flat.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const rt = pmrem.fromScene(sky)
    this.scene.environment = rt.texture
    pmrem.dispose()
  }

  _lights() {
    const sunLight = new THREE.DirectionalLight(0xffd9a0, 3.1)
    sunLight.position.copy(this.sun).multiplyScalar(400)
    sunLight.castShadow = true
    sunLight.shadow.mapSize.set(2048, 2048)
    const d = 320
    sunLight.shadow.camera.left = -d
    sunLight.shadow.camera.right = d
    sunLight.shadow.camera.top = d
    sunLight.shadow.camera.bottom = -d
    sunLight.shadow.camera.near = 1
    sunLight.shadow.camera.far = 1200
    sunLight.shadow.bias = -0.0005
    sunLight.shadow.normalBias = 0.03
    this.scene.add(sunLight)
    this.sunLight = sunLight

    this.scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x4a6741, 0.7))
    const bounce = new THREE.DirectionalLight(0xff9d6e, 0.5)
    bounce.position.set(-200, 60, 180)
    this.scene.add(bounce)
  }

  // Terrain that follows the track height so the road never floats.
  _ground() {
    const size = WORLD
    const seg = 200
    const geo = new THREE.PlaneGeometry(size, size, seg, seg)
    geo.rotateX(-Math.PI / 2)

    const pos = geo.attributes.position
    const v = new THREE.Vector3()
    const colors = []
    const grass = new THREE.Color(0x5f8a3f)
    const dry = new THREE.Color(0x8a9b52)
    const sand = new THREE.Color(0xd8c89a)

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      const near = this.track.nearest(v)

      // Rolling hills, flattened smoothly toward the road so there are no cliffs
      // at the track edge.
      const n =
        Math.sin(v.x * 0.006) * Math.cos(v.z * 0.007) * 14 +
        Math.sin(v.x * 0.021 + 1.7) * Math.cos(v.z * 0.017) * 4.5

      const distFromEdge = Math.max(0, near.distance - TRACK_WIDTH / 2 - 3)
      const blend = THREE.MathUtils.clamp(distFromEdge / 45, 0, 1)
      const smooth = blend * blend * (3 - 2 * blend)

      let y = THREE.MathUtils.lerp(near.centre.y, near.centre.y + n, smooth)

      // Carve the ocean side down into a beach slope.
      const beachFactor = THREE.MathUtils.clamp((v.x + 300) / -260, 0, 1)
      y = THREE.MathUtils.lerp(y, -6, beachFactor)

      pos.setY(i, y)

      const c = y < 1.5 ? sand : (near.distance < 60 ? grass : grass.clone().lerp(dry, this.rand() * 0.5))
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
      this.tex.grass.repeat.set(120, 120)
    }

    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    this.scene.add(mesh)
    this.ground = mesh
  }

  _ocean() {
    const geo = new THREE.PlaneGeometry(6000, 6000)
    const water = new Water(geo, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: this.tex.waterNormals || null,
      sunDirection: this.sun.clone().normalize(),
      sunColor: 0xffdcb0,
      waterColor: 0x0d5c6b,
      distortionScale: 3.2,
      fog: true,
    })
    water.rotation.x = -Math.PI / 2
    water.position.set(-900, -3.2, -100)
    this.scene.add(water)
    this.water = water
  }

  _beach() {
    const geo = new THREE.PlaneGeometry(420, 1600, 1, 40)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      pos.setY(i, THREE.MathUtils.mapLinear(x, -210, 210, -5.5, 3) + Math.sin(pos.getZ(i) * 0.02) * 1.2)
    }
    geo.computeVertexNormals()
    const mat = new THREE.MeshStandardMaterial({ color: 0xe4d3a8, roughness: 0.95 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(-430, 0, -100)
    mesh.receiveShadow = true
    this.scene.add(mesh)
  }

  // Signature Bali: stepped emerald rice paddies on the inland hillside.
  _riceTerraces() {
    const group = new THREE.Group()
    const steps = 16
    const green = new THREE.Color(0x4faa3c)
    const lush = new THREE.Color(0x7ed957)

    for (let i = 0; i < steps; i++) {
      const r = 60 + i * 15
      const h = 3 + i * 2.1
      const geo = new THREE.CylinderGeometry(r, r + 3, 2.4, 40, 1, true)
      const mat = new THREE.MeshStandardMaterial({
        color: green.clone().lerp(lush, i / steps),
        roughness: 0.85,
        side: THREE.DoubleSide,
      })
      const ring = new THREE.Mesh(geo, mat)
      ring.position.set(190, h, -430)
      ring.castShadow = ring.receiveShadow = true
      group.add(ring)

      // Flooded paddy surface catching the sunset — the reflective look.
      const water = new THREE.Mesh(
        new THREE.RingGeometry(r - 12, r, 40),
        new THREE.MeshStandardMaterial({
          color: 0x9fd8c4, roughness: 0.08, metalness: 0.55,
          transparent: true, opacity: 0.82, side: THREE.DoubleSide,
        })
      )
      water.rotation.x = -Math.PI / 2
      water.position.set(190, h + 1.25, -430)
      group.add(water)
    }
    this.scene.add(group)
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

  // Scatter palms outside the track using instanced-friendly cloning, keeping a
  // clear margin so they never block the racing line.
  _palms() {
    const group = new THREE.Group()
    const variants = []
    for (let i = 0; i < 7; i++) variants.push(this._makePalm())

    let placed = 0
    let guard = 0
    while (placed < 220 && guard < 4000) {
      guard++
      const x = (this.rand() - 0.5) * WORLD * 0.85
      const z = (this.rand() - 0.5) * WORLD * 0.85
      const p = new THREE.Vector3(x, 0, z)
      const near = this.track.nearest(p)

      // Keep a clean corridor around the road, and don't plant in the sea.
      if (near.distance < TRACK_WIDTH / 2 + 7) continue
      if (near.distance > 240 && this.rand() > 0.35) continue
      if (x < -330) continue

      const tree = variants[Math.floor(this.rand() * variants.length)].clone()
      const y = this._terrainHeight(x, z, near)
      if (y < 0.2) continue
      tree.position.set(x, y, z)
      tree.rotation.y = this.rand() * Math.PI * 2
      const s = 0.75 + this.rand() * 0.6
      tree.scale.setScalar(s)
      group.add(tree)
      placed++
    }

    // Dense palm grove behind the beach.
    for (let i = 0; i < 60; i++) {
      const tree = variants[Math.floor(this.rand() * variants.length)].clone()
      const x = -300 - this.rand() * 90
      const z = (this.rand() - 0.5) * 1100 - 100
      tree.position.set(x, 1.2 + this.rand(), z)
      tree.rotation.y = this.rand() * Math.PI * 2
      tree.rotation.z = (this.rand() - 0.5) * 0.14   // leaning toward the sea
      tree.scale.setScalar(0.85 + this.rand() * 0.7)
      group.add(tree)
    }

    this.scene.add(group)
  }

  _terrainHeight(x, z, near) {
    const n =
      Math.sin(x * 0.006) * Math.cos(z * 0.007) * 14 +
      Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017) * 4.5
    const distFromEdge = Math.max(0, near.distance - TRACK_WIDTH / 2 - 3)
    const blend = THREE.MathUtils.clamp(distFromEdge / 45, 0, 1)
    const smooth = blend * blend * (3 - 2 * blend)
    let y = THREE.MathUtils.lerp(near.centre.y, near.centre.y + n, smooth)
    const beachFactor = THREE.MathUtils.clamp((x + 300) / -260, 0, 1)
    return THREE.MathUtils.lerp(y, -6, beachFactor)
  }

  // Pura-style sea temple on the headland: tiered meru towers + split gate.
  _temple() {
    const g = new THREE.Group()
    const stone = new THREE.MeshStandardMaterial({ color: 0x6b6255, roughness: 0.94 })
    const thatch = new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.98 })

    const base = new THREE.Mesh(new THREE.BoxGeometry(46, 4, 34), stone)
    base.position.y = 2
    base.receiveShadow = base.castShadow = true
    g.add(base)

    // Meru towers — the stacked pagoda roofs.
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
      t.position.set(x, 4, z)
      return t
    }
    g.add(meru(-13, 0, 7, 1.15), meru(0, -5, 11, 1.0), meru(13, 2, 5, 0.9))

    // Candi bentar (split gate)
    for (const side of [-1, 1]) {
      const half = new THREE.Mesh(new THREE.BoxGeometry(4, 15, 5), stone)
      half.position.set(side * 4, 11.5, 17)
      half.castShadow = true
      g.add(half)
      for (let i = 0; i < 5; i++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(4.6 - i * 0.5, 0.7, 5.4 - i * 0.5), stone)
        step.position.set(side * 4, 18.5 + i * 1.2, 17)
        g.add(step)
      }
    }

    g.position.set(155, 12, -300)
    g.rotation.y = -0.5
    this.scene.add(g)
  }

  // Mount Agung on the horizon.
  _volcano() {
    const g = new THREE.Group()
    const geo = new THREE.ConeGeometry(300, 240, 48, 8)
    const pos = geo.attributes.position
    const v = new THREE.Vector3()
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      const ridge = Math.sin(Math.atan2(v.z, v.x) * 7) * 9 * (1 - v.y / 240)
      pos.setX(i, v.x + ridge)
      pos.setZ(i, v.z + ridge)
    }
    geo.computeVertexNormals()

    const mtn = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x4a5a53, roughness: 1, flatShading: true,
    }))
    mtn.position.y = 120
    g.add(mtn)

    // Hazy secondary peak for depth.
    const small = new THREE.Mesh(
      new THREE.ConeGeometry(190, 130, 32, 4),
      new THREE.MeshStandardMaterial({ color: 0x5b6a63, roughness: 1, flatShading: true })
    )
    small.position.set(-330, 65, 120)
    g.add(small)

    g.position.set(420, 0, -1050)
    this.scene.add(g)
  }

  // Low ground cover: ferns, frangipani bushes, tall grass tufts.
  _foliage() {
    const bushGeo = new THREE.IcosahedronGeometry(1.5, 0)
    const colors = [0x2f6b2f, 0x3f8a3a, 0x59a544]
    const mats = colors.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }))
    const COUNT = 900
    const meshes = mats.map(m => new THREE.InstancedMesh(bushGeo, m, COUNT))
    const counts = [0, 0, 0]

    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()

    let guard = 0
    let placed = 0
    while (placed < COUNT * 2 && guard < 20000) {
      guard++
      const x = (this.rand() - 0.5) * WORLD * 0.8
      const z = (this.rand() - 0.5) * WORLD * 0.8
      p.set(x, 0, z)
      const near = this.track.nearest(p)
      if (near.distance < TRACK_WIDTH / 2 + 3.5) continue
      if (x < -300) continue
      const y = this._terrainHeight(x, z, near)
      if (y < 0.5) continue

      const idx = Math.floor(this.rand() * 3)
      if (counts[idx] >= COUNT) continue
      p.set(x, y + 0.5, z)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rand() * Math.PI)
      s.set(0.6 + this.rand() * 1.4, 0.5 + this.rand() * 1.1, 0.6 + this.rand() * 1.4)
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

  // Balinese penjor / umbul-umbul banners along the start straight.
  _flags() {
    const g = new THREE.Group()
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xc9b28a, roughness: 0.9 })
    const clothColors = [0xffd54f, 0xef5350, 0xffffff, 0x26a69a]
    this.banners = []

    for (let i = 0; i < 26; i++) {
      const t = (i / 26) * 0.09
      const c = this.track.pointAt(t)
      const side = this.track.sideAt(t)
      for (const dir of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7, 6), poleMat)
        const p = c.clone().addScaledVector(side, dir * (TRACK_WIDTH / 2 + 3.4))
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
    this.scene.add(g)
  }

  update(dt, elapsed) {
    if (this.water) this.water.material.uniforms.time.value += dt * 0.55
    // Gentle banner sway.
    for (let i = 0; i < this.banners.length; i++) {
      const b = this.banners[i]
      b.rotation.y = Math.sin(elapsed * 1.7 + i * 0.6) * 0.35
    }
  }

  // Keep the shadow frustum centred on the player so shadows stay crisp
  // across a 1400-unit world without a huge shadow map.
  focusShadow(target) {
    if (!this.sunLight) return
    this.sunLight.position.copy(this.sun).multiplyScalar(400).add(target)
    this.sunLight.target.position.copy(target)
    this.sunLight.target.updateMatrixWorld()
    if (!this.sunLight.target.parent) this.scene.add(this.sunLight.target)
  }
}
