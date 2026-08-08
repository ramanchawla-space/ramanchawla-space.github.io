import { Peer } from 'peerjs'

// P2P networking over PeerJS (WebRTC). The host's browser is the hub: every
// client connects to the host, and the host relays state to everyone else in a
// star topology. No server of our own — which is what lets this live on GitHub
// Pages.
//
// Authority split:
//   - Each client simulates its OWN rider and sends its transform upstream.
//   - The host owns race state: who's in, when the race starts, and finish order.
// This keeps latency invisible for the player you actually control, at the cost
// of remote riders being ~100ms behind (hidden by interpolation).

export const MSG = {
  HELLO: 'hello',           // client -> host: profile on connect
  ROSTER: 'roster',         // host -> all: full player list
  START: 'start',           // host -> all: begin countdown
  STATE: 'state',           // client -> host: my transform
  SNAPSHOT: 'snapshot',     // host -> all: everyone's transforms
  FINISH: 'finish',         // client -> host: I crossed the line
  RESULTS: 'results',       // host -> all: final standings
  LOBBY: 'lobby',           // host -> all: return to lobby
  PING: 'ping',             // client -> host: liveness heartbeat
}

// A WebRTC data channel does NOT reliably fire 'close' when a tab is killed,
// the machine sleeps, or wifi drops — there's no clean teardown handshake. So we
// heartbeat: clients ping, and the host evicts anyone who goes quiet. Without
// this, one colleague slamming their laptop shut hangs the race for everyone,
// because the host waits forever for a finish that will never arrive.
const PING_INTERVAL_MS = 1000
const PEER_TIMEOUT_MS = 6000

const HOST_PREFIX = 'baliracer-'
// Public PeerJS broker. Free, no signup — fine for a team-sized game.
const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
}

function randomRoom() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

export class NetHost {
  constructor(roomCode) {
    this.room = roomCode || randomRoom()
    this.peer = null
    this.conns = new Map()      // peerId -> DataConnection
    this.lastSeen = new Map()   // peerId -> timestamp of last inbound message
    this.handlers = {}
    this.ready = false
    this._sweep = null
  }

  // Evict peers that have stopped sending anything. Any inbound message counts
  // as liveness, so an actively racing player is never falsely dropped.
  _startSweep() {
    if (this._sweep) return
    this._sweep = setInterval(() => {
      const now = Date.now()
      for (const [id, seen] of [...this.lastSeen]) {
        if (now - seen > PEER_TIMEOUT_MS) this._drop(id)
      }
    }, 1500)
  }

  _drop(peerId) {
    const conn = this.conns.get(peerId)
    if (conn) { try { conn.close() } catch {} }
    this.conns.delete(peerId)
    const had = this.lastSeen.delete(peerId)
    if (had) this._emit('leave', peerId)
  }

  on(event, fn) { this.handlers[event] = fn; return this }
  _emit(event, ...args) { this.handlers[event]?.(...args) }

  start() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(HOST_PREFIX + this.room, PEER_OPTS)

      const timeout = setTimeout(() => {
        reject(new Error('Could not reach the matchmaking service. Check your network and retry.'))
      }, 15000)

      this.peer.on('open', () => {
        clearTimeout(timeout)
        this.ready = true
        resolve(this.room)
      })

      this.peer.on('connection', (conn) => this._accept(conn))

      this.peer.on('error', (err) => {
        clearTimeout(timeout)
        // 'unavailable-id' means another tab already hosts this room code.
        if (err.type === 'unavailable-id') {
          reject(new Error('That room code is already in use. Reload to get a new one.'))
        } else if (!this.ready) {
          reject(err)
        } else {
          this._emit('error', err)
        }
      })

      this.peer.on('disconnected', () => {
        // Broker connection dropped; existing data channels survive. Reconnect
        // so late joiners can still find us.
        if (!this.peer.destroyed) this.peer.reconnect()
      })
    })
  }

  _accept(conn) {
    conn.on('open', () => {
      this.conns.set(conn.peer, conn)
      this.lastSeen.set(conn.peer, Date.now())
      this._startSweep()
    })
    conn.on('data', (msg) => {
      this.lastSeen.set(conn.peer, Date.now())
      // Heartbeats carry no game data; they exist only to prove liveness.
      if (msg?.type === MSG.PING) return
      this._emit('message', conn.peer, msg)
    })
    conn.on('close', () => this._drop(conn.peer))
    conn.on('error', () => this._drop(conn.peer))
  }

  send(peerId, type, data) {
    const conn = this.conns.get(peerId)
    if (conn?.open) {
      try { conn.send({ type, data }) } catch { /* channel closing */ }
    }
  }

  broadcast(type, data, exclude = null) {
    const payload = { type, data }
    for (const [id, conn] of this.conns) {
      if (id === exclude) continue
      if (conn.open) {
        try { conn.send(payload) } catch { /* channel closing */ }
      }
    }
  }

  // Keeps client-side host-timeout detection from firing while everyone sits in
  // the lobby, where no snapshots are flowing.
  startKeepalive() {
    clearInterval(this._keepalive)
    this._keepalive = setInterval(() => this.broadcast(MSG.PING, 0), PING_INTERVAL_MS)
  }

  destroy() {
    clearInterval(this._sweep)
    clearInterval(this._keepalive)
    this._sweep = null
    for (const conn of this.conns.values()) { try { conn.close() } catch {} }
    this.conns.clear()
    this.lastSeen.clear()
    try { this.peer?.destroy() } catch {}
  }
}

export class NetClient {
  constructor(roomCode) {
    this.room = roomCode
    this.peer = null
    this.conn = null
    this.handlers = {}
    this.id = null
  }

  on(event, fn) { this.handlers[event] = fn; return this }
  _emit(event, ...args) { this.handlers[event]?.(...args) }

  // Ping upstream so the host knows we're alive, and watch for the host itself
  // going silent (they closed their tab, so the race is over for everyone).
  _startHeartbeat() {
    this._lastHostMsg = Date.now()
    clearInterval(this._hb)
    this._hb = setInterval(() => {
      this.send(MSG.PING, 0)
      if (Date.now() - this._lastHostMsg > PEER_TIMEOUT_MS * 2) this._hostGone()
    }, PING_INTERVAL_MS)
  }

  _hostGone() {
    if (this._gone) return      // only report it once
    this._gone = true
    clearInterval(this._hb)
    this._emit('hostgone')
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(PEER_OPTS)

      const timeout = setTimeout(() => {
        reject(new Error("Couldn't reach the host. Ask them to check the game is still open."))
      }, 20000)

      this.peer.on('open', (id) => {
        this.id = id
        const conn = this.peer.connect(HOST_PREFIX + this.room, {
          reliable: true,
          serialization: 'json',
        })
        this.conn = conn

        conn.on('open', () => {
          clearTimeout(timeout)
          this._startHeartbeat()
          resolve(id)
        })
        conn.on('data', (msg) => {
          this._lastHostMsg = Date.now()
          this._emit('message', msg)
        })
        conn.on('close', () => this._hostGone())
        conn.on('error', (e) => {
          clearTimeout(timeout)
          reject(e)
        })
      })

      this.peer.on('error', (err) => {
        clearTimeout(timeout)
        if (err.type === 'peer-unavailable') {
          reject(new Error('That race has ended or the link is wrong. Ask your host for a fresh link.'))
        } else {
          reject(err)
        }
      })
    })
  }

  send(type, data) {
    if (this.conn?.open) {
      try { this.conn.send({ type, data }) } catch { /* channel closing */ }
    }
  }

  destroy() {
    clearInterval(this._hb)
    try { this.conn?.close() } catch {}
    try { this.peer?.destroy() } catch {}
  }
}

export { randomRoom }
