// Two real browsers over real WebRTC. Host opens a room, client joins via the
// share link, both drive, and we assert:
//   1. roster syncs both ways (each sees 2 players)
//   2. the race starts on both simultaneously
//   3. each side sees the OTHER rider actually moving (snapshot relay works)
//   4. remote positions track the true positions (interpolation isn't drifting)
//   5. both finish and get identical results ordering
//
// This is the test that matters most: everything before it was single-player.

import puppeteer from 'puppeteer'

const URL = process.env.URL || 'http://localhost:5178/'
const ARGS = ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
  '--autoplay-policy=no-user-gesture-required']

const errors = []
let browsers = []

function trap(page, tag) {
  page.on('pageerror', e => errors.push(`[${tag}] PAGEERROR: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`) })
}

async function newPage(tag) {
  const b = await puppeteer.launch({ headless: 'new', args: ARGS })
  browsers.push(b)
  const p = await b.newPage()
  await p.setViewport({ width: 900, height: 620 })
  trap(p, tag)
  return p
}

// Engage the same centreline autopilot used in the lap test.
async function autopilot(page) {
  await page.evaluate(() => {
    const g = window.__game
    g.input.enable()
    g._ap = setInterval(() => {
      const me = g.me
      if (!me || me.finished) return
      const near = g.track.nearest(me.position, me._trackT)
      const tgt = g.track.pointAt((near.t + 24 / g.track.length) % 1)
      let d = Math.atan2(tgt.x - me.position.x, tgt.z - me.position.z) - me.heading
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      g.input.state.left = d > 0.04
      g.input.state.right = d < -0.04
      g.input.state.forward = Math.abs(d) < 0.6
    }, 40)
  })
}

const step = (m) => console.log('  → ' + m)

try {
  step('launching host browser')
  const host = await newPage('HOST')
  await host.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await host.waitForFunction(() => !document.getElementById('join').classList.contains('hidden'), { timeout: 60000 })

  await host.type('#nick', 'HostRider')
  await host.click('.vehicle[data-vehicle="bike"]')
  await host.click('#join-go')
  await host.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'), { timeout: 45000 })

  const link = await host.$eval('#share-link', el => el.value)
  step('host lobby open, share link: ' + link)

  step('launching client browser and joining via link')
  const client = await newPage('CLIENT')
  await client.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await client.waitForFunction(() => !document.getElementById('join').classList.contains('hidden'), { timeout: 60000 })

  // Client should have picked up the room from the URL and be in guest mode.
  const isGuest = await client.evaluate(() => !window.__game.isHost)
  if (!isGuest) throw new Error('Client did not detect room from URL — it thinks it is the host')

  await client.type('#nick', 'GuestRider')
  await client.click('.vehicle[data-vehicle="scooter"]')
  await client.click('#join-go')

  step('waiting for P2P connection + roster sync')
  await client.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'), { timeout: 60000 })

  // ---- ASSERT 1: both sides see both players ----
  await host.waitForFunction(() => window.__game.players.size === 2, { timeout: 30000 })
  await client.waitForFunction(() => window.__game.players.size === 2, { timeout: 30000 })

  const rosters = {
    host: await host.evaluate(() => [...window.__game.players.values()].map(p => p.name).sort()),
    client: await client.evaluate(() => [...window.__game.players.values()].map(p => p.name).sort()),
  }
  console.log('  rosters:', JSON.stringify(rosters))
  if (rosters.host.join() !== 'GuestRider,HostRider') throw new Error('Host roster wrong: ' + rosters.host)
  if (rosters.client.join() !== 'GuestRider,HostRider') throw new Error('Client roster wrong: ' + rosters.client)
  step('ASSERT 1 passed — roster synced both ways')

  // ---- Start the race ----
  step('host starting race (1 lap)')
  await host.click('.lapbtn[data-laps="1"]')
  await host.click('#start-race')

  // ---- ASSERT 2: race starts on BOTH ----
  await host.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'), { timeout: 20000 })
  await client.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'), { timeout: 20000 })
  step('ASSERT 2 passed — race started on both clients')

  // Each side should have created a vehicle for both riders, and one remote.
  const spawn = {
    host: await host.evaluate(() => ({ v: window.__game.vehicles.size, r: window.__game.remotes.size })),
    client: await client.evaluate(() => ({ v: window.__game.vehicles.size, r: window.__game.remotes.size })),
  }
  console.log('  spawned:', JSON.stringify(spawn))
  if (spawn.host.v !== 2 || spawn.host.r !== 1) throw new Error('Host spawn wrong: ' + JSON.stringify(spawn.host))
  if (spawn.client.v !== 2 || spawn.client.r !== 1) throw new Error('Client spawn wrong: ' + JSON.stringify(spawn.client))

  await new Promise(r => setTimeout(r, 4200))   // countdown
  step('engaging autopilot on both')
  await autopilot(host)
  await autopilot(client)

  await new Promise(r => setTimeout(r, 12000))

  // ---- ASSERT 3: each side sees the other rider MOVING ----
  const sample = async (page) => page.evaluate(() => {
    const g = window.__game
    const remote = [...g.remotes.values()][0]
    return {
      myProgress: g.me ? +g.me.lapProgress.toFixed(4) : 0,
      remoteProgress: remote ? +remote.lapProgress.toFixed(4) : 0,
      remotePos: remote ? [+remote.position.x.toFixed(1), +remote.position.z.toFixed(1)] : null,
      remoteSpeed: remote ? +remote.speed.toFixed(1) : 0,
      bufferLen: remote ? remote.buffer.length : 0,
    }
  })

  const h1 = await sample(host)
  const c1 = await sample(client)
  await new Promise(r => setTimeout(r, 3000))
  const h2 = await sample(host)
  const c2 = await sample(client)

  console.log('  host sees remote:', JSON.stringify(h1), '->', JSON.stringify(h2))
  console.log('  client sees remote:', JSON.stringify(c1), '->', JSON.stringify(c2))

  if (h2.remoteProgress <= h1.remoteProgress) throw new Error('Host does not see the client advancing (snapshot relay broken)')
  if (c2.remoteProgress <= c1.remoteProgress) throw new Error('Client does not see the host advancing (snapshot relay broken)')
  if (h2.remoteSpeed < 5) throw new Error('Host sees client stationary, speed=' + h2.remoteSpeed)
  if (c2.remoteSpeed < 5) throw new Error('Client sees host stationary, speed=' + c2.remoteSpeed)
  step('ASSERT 3 passed — both sides see the other rider moving')

  // ---- ASSERT 4: remote view tracks truth (not drifting badly) ----
  const truth = {
    hostProgress: h2.myProgress,
    clientProgress: c2.myProgress,
  }
  // Host's view of client vs client's own progress. ~120ms interp delay plus
  // network latency, so allow a small window.
  const hostErr = Math.abs(h2.remoteProgress - truth.clientProgress) * 1164   // metres
  const clientErr = Math.abs(c2.remoteProgress - truth.hostProgress) * 1164
  console.log(`  interp error: host-view-of-client=${hostErr.toFixed(1)}m  client-view-of-host=${clientErr.toFixed(1)}m`)
  if (hostErr > 60) throw new Error(`Host's view of client drifted ${hostErr.toFixed(1)}m`)
  if (clientErr > 60) throw new Error(`Client's view of host drifted ${clientErr.toFixed(1)}m`)
  step('ASSERT 4 passed — interpolated positions track truth')

  // ---- ASSERT 5: both reach results with same ordering ----
  // Advance both riders to 97% of the lap. Headless software WebGL runs at ~4fps,
  // so driving a full 1164m lap would take many minutes of wall clock; this tests
  // the finish/results path, which is what we actually care about here.
  step('advancing both riders to the final stretch')
  for (const p of [host, client]) {
    await p.evaluate(() => {
      const g = window.__game
      g.me.lapProgress = 0.97
      g.me._lastT = 0.97
      g.me._trackT = 0.97
      const c = g.track.pointAt(0.97)
      const tan = g.track.tangentAt(0.97)
      g.me.position.copy(c)
      g.me.heading = Math.atan2(tan.x, tan.z)
    })
  }

  step('waiting for both to finish (up to 120s)')
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const done = await Promise.all([
      host.evaluate(() => !document.getElementById('results').classList.contains('hidden')),
      client.evaluate(() => !document.getElementById('results').classList.contains('hidden')),
    ])
    if (done[0] && done[1]) break
    await new Promise(r => setTimeout(r, 1000))
  }

  const finalRows = async (page) => page.evaluate(() =>
    [...document.querySelectorAll('#result-list .rn')].map(e => e.textContent))
  const hr = await finalRows(host)
  const cr = await finalRows(client)
  console.log('  host results: ', JSON.stringify(hr))
  console.log('  client results:', JSON.stringify(cr))

  if (hr.length !== 2) throw new Error('Host results should list 2 riders, got ' + hr.length)
  if (cr.length !== 2) throw new Error('Client results should list 2 riders, got ' + cr.length)
  if (hr.join() !== cr.join()) throw new Error(`Result ordering disagrees: host=${hr} client=${cr}`)
  step('ASSERT 5 passed — both agree on final standings')

  console.log('\nMULTIPLAYER TEST PASSED')
} catch (err) {
  console.error('\nMULTIPLAYER TEST FAILED:', err.message)
  for (let i = 0; i < browsers.length; i++) {
    const pages = await browsers[i].pages().catch(() => [])
    if (pages[0]) await pages[0].screenshot({ path: `test/mp-fail-${i}.png` }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  if (errors.length) {
    console.error('\nConsole errors (' + errors.length + '):')
    for (const e of [...new Set(errors)].slice(0, 20)) console.error('  ! ' + e)
  } else {
    console.log('No console errors.')
  }
  for (const b of browsers) await b.close().catch(() => {})
}
