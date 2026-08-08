import puppeteer from 'puppeteer'
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader']})
const p = await b.newPage()
await p.goto((process.env.URL || 'http://localhost:5178/'), {waitUntil:'domcontentloaded', timeout:60000})
await p.waitForFunction(()=>window.__game&&window.__game.track, {timeout:60000})

// Simulate 5 seconds of full throttle at different fixed timesteps.
// A dt-independent integrator should give near-identical distance for each.
const out = await p.evaluate(async () => {
  const g = window.__game
  const { RiderPhysics } = await import('/src/game/physics.js')
  const { VEHICLE_SPECS } = await import('/src/game/vehicle.js')
  const input = {forward:true, back:false, left:false, right:false, drift:false}
  const res = {}
  for (const fps of [15, 30, 60, 144]) {
    const dt = 1/fps
    const r = new RiderPhysics(g.track, VEHICLE_SPECS.bike, g.track.startSlot(0))
    const startPos = r.position.clone()
    for (let t=0; t<5; t+=dt) r.update(dt, input)
    res[fps] = { dist: +r.position.distanceTo(startPos).toFixed(2), speed: +r.speed.toFixed(2) }
  }
  return res
})
console.log(JSON.stringify(out, null, 2))
const speeds = Object.values(out).map(v=>v.speed)
const spread = Math.max(...speeds) - Math.min(...speeds)
console.log('\nspeed spread across 15-144fps:', spread.toFixed(3), 'm/s')
const ok = spread < 0.5
console.log(ok ? 'PASS — frame-rate independent' : 'FAIL — physics depends on frame rate')
if(!ok) process.exitCode = 1
await b.close()
