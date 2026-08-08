// Runs the whole suite against a temporary dev server.
//   npm test
import { spawn } from 'child_process'
import { once } from 'events'

const SUITE = [
  ['smoke.mjs', 'boots, renders, connects, drives'],
  ['dt.mjs', 'physics is frame-rate independent'],
  ['lap.mjs', 'completes a lap and shows results'],
  ['multiplayer.mjs', 'two browsers over real WebRTC'],
  ['disconnect.mjs', 'survives a mid-race drop'],
]

const PORT = 5199
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

// Wait for vite to report ready.
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start')), 30000)
  server.stdout.on('data', (d) => {
    if (d.toString().includes('ready in')) { clearTimeout(t); resolve() }
  })
  server.on('exit', (c) => { clearTimeout(t); reject(new Error('vite exited: ' + c)) })
})
console.log(`dev server on :${PORT}\n`)

let failed = 0
for (const [file, desc] of SUITE) {
  console.log(`\n=== ${file} — ${desc} ===`)
  const child = spawn('node', [`test/${file}`], {
    stdio: 'inherit',
    env: { ...process.env, URL: `http://localhost:${PORT}/` },
  })
  const [code] = await once(child, 'exit')
  if (code !== 0) { failed++; console.error(`--- ${file} FAILED ---`) }
}

server.kill('SIGTERM')

console.log('\n' + '='.repeat(46))
console.log(failed === 0 ? `ALL ${SUITE.length} SUITES PASSED` : `${failed}/${SUITE.length} SUITES FAILED`)
process.exit(failed === 0 ? 0 : 1)
