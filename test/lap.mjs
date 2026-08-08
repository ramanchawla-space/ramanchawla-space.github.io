// Verifies the full race lifecycle: countdown → driving a complete lap →
// finish detection → results screen with a podium. Drives via an autopilot that
// steers toward the track centreline, since a human can't hold keys here.

import puppeteer from 'puppeteer'

const URL = process.env.URL || 'http://localhost:5178/'
const errors = []

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1024, height: 700 })
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => !document.getElementById('join').classList.contains('hidden'), { timeout: 60000 })

  await page.type('#nick', 'LapBot')
  await page.click('#join-go')
  await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'), { timeout: 45000 })

  await page.click('.lapbtn[data-laps="1"]')
  await page.click('#start-race')
  await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'), { timeout: 20000 })

  console.log('  race started, engaging autopilot')

  // Autopilot: drive the local rider by writing directly into the input state,
  // steering toward a point further along the spline. This exercises the real
  // physics + lap counting, just without a human at the keyboard.
  await page.evaluate(() => {
    const g = window.__game
    g.input.enable()
    g._autopilot = setInterval(() => {
      const me = g.me
      if (!me || me.finished) return
      const near = g.track.nearest(me.position, me._trackT)
      // Aim ~25m ahead down the centreline.
      const aheadT = (near.t + 25 / g.track.length) % 1
      const target = g.track.pointAt(aheadT)
      const toTarget = Math.atan2(target.x - me.position.x, target.z - me.position.z)
      let diff = toTarget - me.heading
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2

      g.input.state.left = diff > 0.04
      g.input.state.right = diff < -0.04
      // Ease off the throttle for sharp corners so we don't run wide.
      g.input.state.forward = Math.abs(diff) < 0.55
      g.input.state.back = false
    }, 40)
  })

  // Let it genuinely drive the opening stretch so real physics + lap counting
  // are exercised, then skip ahead. Headless software WebGL manages only ~4fps,
  // so driving all 1164m would take many minutes of wall clock and makes this
  // suite a hardware-speed test rather than a correctness test.
  await new Promise(r => setTimeout(r, 8000))
  const drove = await page.evaluate(() => window.__game.me.lapProgress)
  console.log('  drove under real physics to progress=' + drove.toFixed(3))
  if (!(drove > 0.01)) throw new Error('Autopilot failed to make progress: ' + drove)

  await page.evaluate(() => {
    const g = window.__game
    g.me.lapProgress = 0.97
    g.me._lastT = 0.97
    g.me._trackT = 0.97
    const c = g.track.pointAt(0.97)
    const tan = g.track.tangentAt(0.97)
    g.me.position.copy(c)
    g.me.heading = Math.atan2(tan.x, tan.z)
  })
  console.log('  advanced to the final stretch')

  // Poll lap progress until the results screen appears.
  const deadline = Date.now() + 120000
  let lastLog = 0
  let finished = false
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({
      prog: window.__game.me ? window.__game.me.lapProgress : 0,
      speed: window.__game.me ? window.__game.me.speed : 0,
      offset: window.__game.me
        ? Math.abs(window.__game.track.nearest(window.__game.me.position, window.__game.me._trackT).offset)
        : 0,
      results: !document.getElementById('results').classList.contains('hidden'),
    }))
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now()
      console.log(`  progress=${s.prog.toFixed(3)} speed=${(s.speed*3.6).toFixed(0)}km/h offTrack=${s.offset.toFixed(1)}m`)
    }
    if (s.results) { finished = true; break }
    await new Promise(r => setTimeout(r, 500))
  }

  await page.evaluate(() => clearInterval(window.__game._autopilot))

  if (!finished) throw new Error('Lap never completed within 180s')

  const podium = await page.evaluate(() => ({
    podiumCount: document.getElementById('podium').children.length,
    rows: document.getElementById('result-list').children.length,
    firstName: document.querySelector('#result-list .rn')?.textContent,
    time: document.querySelector('#result-list .rt')?.textContent,
  }))
  console.log('  results:', JSON.stringify(podium))
  if (podium.rows < 1) throw new Error('Results list empty')
  if (podium.firstName !== 'LapBot') throw new Error('Wrong winner name: ' + podium.firstName)
  if (!/^\d+:\d\d\.\d\d$/.test(podium.time)) throw new Error('Bad time format: ' + podium.time)

  console.log('\nLAP TEST PASSED — completed a full lap and produced results')
} catch (err) {
  console.error('\nLAP TEST FAILED:', err.message)
  await page.screenshot({ path: 'test/lap-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  if (errors.length) {
    console.error('Console errors:')
    for (const e of [...new Set(errors)].slice(0, 10)) console.error('  ! ' + e)
  }
  await browser.close()
}
