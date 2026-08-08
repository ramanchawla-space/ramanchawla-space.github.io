import * as THREE from 'three'

// Photoreal textures pulled from the three.js example asset CDN (jsDelivr).
// Every load is individually optional: if a work network blocks the CDN or a
// request times out, we fall back to a procedurally generated texture so the
// game still starts. A racing game that shows a blank screen because a texture
// 404'd is worse than one with slightly plainer asphalt.

const CDN = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/textures/'

const SOURCES = [
  { key: 'waterNormals', url: CDN + 'waternormals.jpg', repeat: null, srgb: false },
  { key: 'asphalt', url: CDN + 'terrain/grasslight-big.jpg', repeat: [1, 1], srgb: true },
  { key: 'grass', url: CDN + 'terrain/grasslight-big.jpg', repeat: [120, 120], srgb: true },
]

const TIMEOUT_MS = 9000

function loadOne(loader, src) {
  return new Promise((resolve) => {
    let settled = false
    const done = (tex) => { if (!settled) { settled = true; resolve(tex) } }

    const timer = setTimeout(() => done(null), TIMEOUT_MS)

    loader.load(
      src.url,
      (tex) => {
        clearTimeout(timer)
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        if (src.repeat) tex.repeat.set(src.repeat[0], src.repeat[1])
        if (src.srgb) tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 8
        done(tex)
      },
      undefined,
      () => { clearTimeout(timer); done(null) }
    )
  })
}

// --- Procedural fallbacks ---

function noiseTexture(base, speck, size = 256) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  const img = ctx.getImageData(0, 0, size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * speck
    d[i] = Math.max(0, Math.min(255, d[i] + n))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

function flatNormalTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 8
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#8080ff'
  ctx.fillRect(0, 0, 8, 8)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

export async function loadAssets(onProgress) {
  const loader = new THREE.TextureLoader()
  loader.setCrossOrigin('anonymous')

  const out = {}
  let done = 0

  await Promise.all(SOURCES.map(async (src) => {
    const tex = await loadOne(loader, src)
    if (tex) out[src.key] = tex
    done++
    onProgress?.(done / SOURCES.length, src.key)
  }))

  // Fill any gaps so downstream code never has to null-check.
  if (!out.asphalt) {
    out.asphalt = noiseTexture('#3c3c42', 26)
    out.asphalt.repeat.set(2, 40)
  } else {
    out.asphalt.repeat.set(2, 40)
    out.asphalt.colorSpace = THREE.SRGBColorSpace
  }
  if (!out.grass) {
    out.grass = noiseTexture('#5f8a3f', 30)
    out.grass.repeat.set(120, 120)
  }
  if (!out.waterNormals) {
    out.waterNormals = flatNormalTexture()
    out.waterNormals.repeat.set(8, 8)
  }
  out.asphaltNormal = flatNormalTexture()

  return out
}
