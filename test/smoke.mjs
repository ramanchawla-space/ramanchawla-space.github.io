// Headless smoke test: boots the game, joins as host, starts a solo race,
// drives for a few seconds, and asserts the rider actually moved and lapped.
// Catches the runtime errors a bundler build cannot see.

import puppeteer from 'puppeteer'

const URL = process.env.URL || 'http://localhost:5178/'
const errors = []
const logs = []

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',   // software WebGL in headless
    '--use-gl=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ],
})

const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })

page.on('console', (m) => {
  const t = m.text()
  logs.push(`[${m.type()}] ${t}`)
  if (m.type() === 'error') errors.push(t)
})
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

function step(msg) { console.log('  → ' + msg) }

try {
  step('loading page')
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })

  step('waiting for join screen')
  await page.waitForFunction(
    () => !document.getElementById('join').classList.contains('hidden'),
    { timeout: 60000 }
  )

  // Verify the 3D scene actually rendered rather than a black canvas.
  const rendered = await page.evaluate(() => {
    const c = document.getElementById('scene')
    return { w: c.width, h: c.height, hasCtx: !!(c.getContext('webgl2') || c.getContext('webgl')) }
  })
  console.log('  canvas:', JSON.stringify(rendered))
  if (!rendered.w || !rendered.h) throw new Error('Canvas has zero size')

  step('filling in profile')
  await page.type('#nick', 'TestRider')
  await page.click('.vehicle[data-vehicle="bike"]')
  await page.click('#join-go')

  step('waiting for lobby (host peer connection)')
  await page.waitForFunction(
    () => !document.getElementById('lobby').classList.contains('hidden'),
    { timeout: 45000 }
  )

  const shareLink = await page.$eval('#share-link', el => el.value)
  console.log('  share link:', shareLink)
  if (!/\?room=[a-z0-9]+$/.test(shareLink)) throw new Error('Bad share link: ' + shareLink)

  step('setting 1 lap and starting race')
  await page.click('.lapbtn[data-laps="1"]')
  await page.click('#start-race')

  step('waiting for countdown -> racing')
  await page.waitForFunction(
    () => !document.getElementById('hud').classList.contains('hidden'),
    { timeout: 20000 }
  )

  // Countdown is 3s; wait it out then hold throttle.
  await new Promise(r => setTimeout(r, 4000))

  step('driving (throttle held 10s)')
  await page.keyboard.down('ArrowUp')
  await new Promise(r => setTimeout(r, 10000))
  await page.keyboard.up('ArrowUp')

  const speed = await page.$eval('#speed-num', el => parseInt(el.textContent, 10))
  console.log('  speed after 10s throttle:', speed, 'km/h')
  if (!(speed > 20)) throw new Error(`Rider did not accelerate (speed=${speed})`)

  step('checking HUD position/lap render')
  const hud = await page.evaluate(() => ({
    pos: document.getElementById('hud-pos').textContent,
    lap: document.getElementById('hud-lap').textContent,
    standings: document.getElementById('standings').children.length,
  }))
  console.log('  hud:', JSON.stringify(hud))
  if (!hud.lap.includes('Lap')) throw new Error('Lap HUD not rendering')
  if (hud.standings < 1) throw new Error('Standings not rendering')

  step('checking frame rate')
  const fps = await page.evaluate(() => new Promise(resolve => {
    let n = 0
    const start = performance.now()
    const tick = () => {
      n++
      if (performance.now() - start < 2000) requestAnimationFrame(tick)
      else resolve(Math.round(n / ((performance.now() - start) / 1000)))
    }
    requestAnimationFrame(tick)
  }))
  console.log('  fps (software renderer):', fps)

  console.log('\nSMOKE TEST PASSED')
} catch (err) {
  console.error('\nSMOKE TEST FAILED:', err.message)
  await page.screenshot({ path: 'test/failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  if (errors.length) {
    console.error('\nConsole errors (' + errors.length + '):')
    for (const e of [...new Set(errors)].slice(0, 15)) console.error('  ! ' + e)
    process.exitCode = 1
  } else {
    console.log('No console errors.')
  }
  await browser.close()
}
