import puppeteer from 'puppeteer'
const b = await puppeteer.launch({headless:'new',args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader']})
const p = await b.newPage()
await p.goto((process.env.URL || 'http://localhost:5178/'), {waitUntil:'domcontentloaded', timeout:60000})
await p.waitForFunction(()=>window.__game&&window.__game.track, {timeout:60000})
const out = await p.evaluate(async () => {
  const g = window.__game
  const { RiderPhysics } = await import('/src/game/physics.js')
  const { VEHICLE_SPECS } = await import('/src/game/vehicle.js')
  const res = {}
  for (const type of ['scooter','bike']) {
    const spec = VEHICLE_SPECS[type]
    const r = new RiderPhysics(g.track, spec, g.track.startSlot(0))
    // Autopilot steering so the rider follows the road, like a real player.
    const marks = {}
    let t = 0
    for (let i=0;i<3600;i++){
      const near = g.track.nearest(r.position, r._trackT)
      const aheadT = (near.t + 22/g.track.length)%1
      const tgt = g.track.pointAt(aheadT)
      let diff = Math.atan2(tgt.x-r.position.x, tgt.z-r.position.z) - r.heading
      while(diff>Math.PI)diff-=2*Math.PI; while(diff<-Math.PI)diff+=2*Math.PI
      r.update(1/120, {forward:true,back:false,left:diff>0.03,right:diff<-0.03,drift:false})
      t += 1/120
      const kmh = r.speed*3.6
      if(!marks.t50&&kmh>=50)marks.t50=+t.toFixed(2)
      if(!marks.t80&&kmh>=80)marks.t80=+t.toFixed(2)
      if(!marks.t100&&kmh>=100)marks.t100=+t.toFixed(2)
    }
    res[type]={specMaxKmh:+(spec.maxSpeed*3.6).toFixed(0), sustainedKmh:+(r.speed*3.6).toFixed(1), lapProgress:+r.lapProgress.toFixed(3), ...marks}
  }
  return res
})
console.log(JSON.stringify(out,null,2))
await b.close()
