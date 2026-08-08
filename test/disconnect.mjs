// A colleague closing their tab mid-race must not hang the race for everyone.
import puppeteer from 'puppeteer'
const BASE = process.env.URL || 'http://localhost:5178/'
const ARGS=['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader']
const bs=[]; const errs=[]
const mk=async(tag)=>{const b=await puppeteer.launch({headless:'new',args:ARGS});bs.push(b);const p=await b.newPage()
  await p.setViewport({width:640,height:480})
  p.on('pageerror',e=>errs.push(`[${tag}] ${e.message}`))
  p.on('console',m=>{if(m.type()==='error')errs.push(`[${tag}] ${m.text()}`)})
  return p}
let code=0
try{
  const host=await mk('HOST')
  await host.goto(BASE,{waitUntil:'domcontentloaded',timeout:60000})
  await host.waitForFunction(()=>!document.getElementById('join').classList.contains('hidden'),{timeout:60000})
  await host.type('#nick','Hostie'); await host.click('#join-go')
  await host.waitForFunction(()=>!document.getElementById('lobby').classList.contains('hidden'),{timeout:45000})
  const link=await host.$eval('#share-link',e=>e.value)

  const cli=await mk('CLIENT')
  await cli.goto(link,{waitUntil:'domcontentloaded',timeout:60000})
  await cli.waitForFunction(()=>!document.getElementById('join').classList.contains('hidden'),{timeout:60000})
  await cli.type('#nick','Quitter'); await cli.click('#join-go')
  await host.waitForFunction(()=>window.__game.players.size===2,{timeout:30000})
  console.log('  → 2 players in lobby')

  await host.click('.lapbtn[data-laps="1"]'); await host.click('#start-race')
  await host.waitForFunction(()=>!document.getElementById('hud').classList.contains('hidden'),{timeout:20000})
  await cli.waitForFunction(()=>!document.getElementById('hud').classList.contains('hidden'),{timeout:20000})
  await new Promise(r=>setTimeout(r,4200))
  console.log('  → race running, now killing the client tab')

  await bs[1].close()   // colleague slams the laptop shut

  // Host should notice the drop and remove them from the roster.
  await host.waitForFunction(()=>window.__game.players.size===1,{timeout:30000})
  console.log('  → host detected the disconnect, roster back to 1')

  // Host finishes alone; the dropped player must not block results.
  await host.evaluate(()=>{
    const g=window.__game
    g.input.enable()
    g.me.lapProgress=0.985; g.me._lastT=0.985; g.me._trackT=0.985
    const c=g.track.pointAt(0.985), tan=g.track.tangentAt(0.985)
    g.me.position.copy(c); g.me.heading=Math.atan2(tan.x,tan.z)
    setInterval(()=>{ if(g.me&&!g.me.finished) g.input.state.forward=true },40)
  })
  await host.waitForFunction(()=>!document.getElementById('results').classList.contains('hidden'),{timeout:60000})
  const rows=await host.evaluate(()=>[...document.querySelectorAll('#result-list .rn')].map(e=>e.textContent))
  console.log('  → host results:',JSON.stringify(rows))
  if(rows.length!==1||rows[0]!=='Hostie') throw new Error('Expected solo result for Hostie, got '+JSON.stringify(rows))
  console.log('\nDISCONNECT TEST PASSED — race completed after a mid-race drop')
}catch(e){console.error('\nDISCONNECT TEST FAILED:',e.message);code=1}
finally{
  if(errs.length){console.error('Console errors:');[...new Set(errs)].slice(0,10).forEach(e=>console.error('  ! '+e))}
  else console.log('No console errors.')
  for(const b of bs)await b.close().catch(()=>{})
  process.exit(code)
}
