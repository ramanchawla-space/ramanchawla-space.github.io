// Screenshot harness: boots the game, starts a solo race, then teleports the
// camera to a set of scenic points around the lap and captures each one.
// Run with: node test/shots.mjs
import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

const URL = process.env.URL || 'http://localhost:5173/'
const OUT = '/tmp/bali-shots'
mkdirSync(OUT, { recursive: true })

// Lap positions worth looking at, and how to frame each.
const SHOTS = [
  { name: '01-beach-start', t: 0.005, dist: 16, height: 6, pitch: 0.10 },
  { name: '02-coast-rocks', t: 0.148, dist: 18, height: 6, pitch: 0.10 },
  { name: '03-temple-gate', t: 0.288, dist: 34, height: 10, pitch: 0.10 },
  { name: '04-jungle-fire', t: 0.404, dist: 16, height: 5, pitch: 0.07 },
  { name: '05-causeway', t: 0.462, dist: 26, height: 9, pitch: 0.11 },
  { name: '06-causeway-low', t: 0.494, dist: 13, height: 3.2, pitch: 0.03 },
  { name: '07-terraces', t: 0.592, dist: 22, height: 8, pitch: 0.11 },
  { name: '08-volcano', t: 0.744, dist: 20, height: 7, pitch: 0.09 },
  { name: '09-village-cow', t: 0.846, dist: 16, height: 4.2, pitch: 0.05 },
  { name: '10-descent', t: 0.944, dist: 20, height: 7, pitch: 0.11 },
]

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-gpu', '--use-gl=angle', '--use-angle=metal', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 })

page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text()) })
page.on('pageerror', e => console.log('  [pageerror]', e.message))

console.log('Loading', URL)
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })

// Wait for the island to finish building.
await page.waitForFunction(() => window.__game?.state === 'join', { timeout: 60000 })
console.log('Booted.')

// Start a solo race so the HUD and a rider are present.
await page.type('#nick', 'Wayan')
await page.click('#join-go')
await page.waitForFunction(() => window.__game?.state === 'lobby', { timeout: 30000 })
await page.click('#start-race')
await page.waitForFunction(() => window.__game?.state === 'racing', { timeout: 30000 })
console.log('Racing.')

// Freeze the chase camera so we can position it by hand.
await page.evaluate(() => {
  const g = window.__game
  g.chase.follow = () => {}
  g.chase.orbit = () => {}
})

for (const s of SHOTS) {
  await page.evaluate((s) => {
    const g = window.__game
    const c = g.track.pointAt(s.t)
    const tan = g.track.tangentAt(s.t)

    // Move the rider to the spot and run one physics step there, so the zone
    // readout, surface state and hazard warnings match what the camera sees.
    if (g.me) {
      g.me.position.copy(c)
      g.me.position.y += 0.2
      g.me.heading = Math.atan2(tan.x, tan.z)
      g.me.velocity.set(0, 0, 0)
      g.me._trackT = s.t
      g.me._lastT = s.t
      g.me.update(1 / 60, { forward: false, back: false, left: false, right: false, drift: false })
    }

    // Sit behind the point, looking forward down the road.
    g.camera.position.set(
      c.x - tan.x * s.dist,
      c.y + s.height,
      c.z - tan.z * s.dist
    )
    g.camera.lookAt(c.x + tan.x * 14, c.y + 1.5 - s.pitch * 14, c.z + tan.z * 14)
    g.camera.fov = 64
    g.camera.updateProjectionMatrix()
    g.env.focusShadow(c)
  }, s)

  // Let a few frames render so water, shadows and flames settle.
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: `${OUT}/${s.name}.png` })
  console.log('  shot', s.name)
}

await browser.close()
console.log('Done →', OUT)
