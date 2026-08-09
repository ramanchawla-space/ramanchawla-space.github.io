// Scenery-clearance check: walks the whole lap and reports any mesh that
// intrudes into the corridor a rider actually occupies, or that would block the
// chase camera. Placement bugs (a rice terrace across the road, a house roof
// overhanging it) are invisible in a unit test and easy to miss in one
// screenshot, so this sweeps every zone at once.
//
// Run with: node test/clearance.mjs
import puppeteer from 'puppeteer'

const URL = process.env.URL || 'http://localhost:5173/'

// Obstacles are deliberately on the road, so they are exempt.
const EXEMPT_NAMES = new Set(['road'])

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
})
const page = await browser.newPage()
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await page.waitForFunction(() => window.__game?.state === 'join', { timeout: 60000 })

const report = await page.evaluate((exempt) => {
  const THREE = window.__THREE
  const g = window.__game
  const T = g.track

  // Everything belonging to the track group or the hazard set is expected to be
  // on or beside the road.
  const allowed = new Set()
  T.group.traverse(o => allowed.add(o))
  g.obstacles.group.traverse(o => allowed.add(o))

  const problems = []
  const SAMPLES = 220

  for (let i = 0; i < SAMPLES; i++) {
    const t = i / SAMPLES
    const c = T.pointAt(t)
    const tan = T.tangentAt(t)
    const half = T.halfWidthAt(t)
    const zone = T.zoneAt(t).name

    // Cast across the road at rider height, both directions, plus straight up.
    // Anything solid within the road width is an intrusion.
    const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize()
    const origin = c.clone().setY(c.y + 1.4)

    for (const dir of [side.clone(), side.clone().negate()]) {
      const rc = new THREE.Raycaster(origin, dir, 0.5, half + 1.5)
      for (const hit of rc.intersectObjects(g.scene.children, true)) {
        const o = hit.object
        if (allowed.has(o) || exempt.includes(o.name)) continue
        if (!o.visible || o.material?.transparent && o.material.opacity < 0.3) continue

        // Report only what actually encroaches on the tarmac. The probe reaches
        // a little past the road edge to catch overhangs, so an object whose
        // own centre is comfortably outside (the temple gate towers, roadside
        // shrines) is deliberate scenery, not an intrusion. Reuse the
        // environment's grid-backed clearance rather than Track.nearest(),
        // which does a full table scan per call and makes this sweep crawl.
        const centre = o.getWorldPosition(new THREE.Vector3())
        if (g.env._roadClearance(centre.x, centre.z) > 1.0) continue

        problems.push({
          t: +t.toFixed(3), zone, kind: 'lateral',
          dist: +hit.distance.toFixed(1), half: +half.toFixed(1),
          geo: o.geometry?.type,
          col: o.material?.color?.getHexString?.() ?? '',
        })
        break
      }
    }

    // Headroom: nothing solid should hang lower than ~5m over the centreline.
    // (Penjor poles arch over the road, so allow their thin tubes through.)
    const up = new THREE.Raycaster(c.clone().setY(c.y + 0.3), new THREE.Vector3(0, 1, 0), 0.5, 5)
    for (const hit of up.intersectObjects(g.scene.children, true)) {
      const o = hit.object
      if (allowed.has(o)) continue
      if (!o.visible) continue
      const p = o.geometry?.parameters ?? {}
      // Thin tubes and small decorations are fine overhead.
      if ((p.radius ?? 9) < 0.4) continue
      problems.push({
        t: +t.toFixed(3), zone, kind: 'overhead',
        dist: +hit.distance.toFixed(1), half: +half.toFixed(1),
        geo: o.geometry?.type,
        col: o.material?.color?.getHexString?.() ?? '',
      })
      break
    }
  }
  return problems
}, [...EXEMPT_NAMES])

if (!report.length) {
  console.log('PASS — no scenery intrudes on the racing corridor.')
} else {
  console.log(`FAIL — ${report.length} intrusion(s):`)
  // Group by zone so it's obvious which part of the island is wrong.
  const byZone = {}
  for (const p of report) (byZone[p.zone] ??= []).push(p)
  for (const [zone, list] of Object.entries(byZone)) {
    console.log(`\n  ${zone} (${list.length})`)
    for (const p of list.slice(0, 6)) {
      console.log(`    t=${p.t} ${p.kind} d=${p.dist} half=${p.half} ${p.geo} #${p.col}`)
    }
    if (list.length > 6) console.log(`    …and ${list.length - 6} more`)
  }
}

await browser.close()
process.exit(report.length ? 1 : 0)
