import * as THREE from 'three'
import { Track } from './game/track.js'
import { Environment } from './game/environment.js'
import { Vehicle, VEHICLE_SPECS, PLAYER_COLORS } from './game/vehicle.js'
import { RiderPhysics } from './game/physics.js'
import { ChaseCamera } from './game/camera.js'
import { Input, isTouchDevice } from './game/input.js'
import { loadAssets } from './game/assets.js'
import { NetHost, NetClient, MSG, randomRoom } from './net/net.js'
import { RemoteRider } from './net/remote.js'
import { UI, formatTime } from './ui/ui.js'

const STATE = { LOADING: 'loading', JOIN: 'join', LOBBY: 'lobby', COUNTDOWN: 'countdown', RACING: 'racing', FINISHED: 'finished' }
const SEND_HZ = 15
const MAX_PLAYERS = 12

class Game {
  constructor() {
    this.ui = new UI()
    this.state = STATE.LOADING
    this.players = new Map()     // id -> { id, name, avatar, vehicle, color, isHost }
    this.vehicles = new Map()    // id -> Vehicle
    this.remotes = new Map()     // id -> RemoteRider
    this.results = []
    this.laps = 2
    this.myId = 'local'
    this.isHost = false
    this.net = null
    this.raceStart = 0
    this._sendAccum = 0
    this._clock = new THREE.Clock()
    this._elapsed = 0

    this._initRenderer()
    this._bindUI()
  }

  _initRenderer() {
    const canvas = document.getElementById('scene')
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: window.devicePixelRatio < 2,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.92
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 6000)
    this.chase = new ChaseCamera(this.camera)

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(window.innerWidth, window.innerHeight)
    })
  }

  _bindUI() {
    this.ui.el.joinGo.addEventListener('click', () => this._onJoinClick())
    this.ui.el.nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._onJoinClick() })
    this.ui.el.startRace.addEventListener('click', () => this._hostStartRace())
    this.ui.el.again.addEventListener('click', () => this._hostReturnToLobby())
    this.ui.el.copyLink.addEventListener('click', () => this._copyLink())
  }

  async boot() {
    this.ui.setProgress(0.05, 'Loading island textures…')
    const textures = await loadAssets((frac) => {
      this.ui.setProgress(0.05 + frac * 0.55, 'Loading island textures…')
    })

    this.ui.setProgress(0.65, 'Carving the coast road…')
    await nextFrame()

    this.track = new Track()
    this.scene.add(this.track.build(textures))

    this.ui.setProgress(0.78, 'Planting palm trees…')
    await nextFrame()

    this.env = new Environment(this.scene, this.renderer, this.track, textures)
    this.env.build()

    this.ui.setProgress(0.95, 'Almost there…')
    await nextFrame()

    this.input = new Input()
    this.input.onRespawn = () => { if (this.state === STATE.RACING && this.me) this.me.respawn() }

    // Park the camera somewhere scenic for the menus.
    this._menuTarget = this.track.pointAt(0.02)

    this.ui.setProgress(1, 'Ready')
    await sleep(280)

    this._readRoomFromUrl()
    this.ui.show('join')
    this.state = STATE.JOIN
    this.ui.el.nick.focus()

    this._loop()
  }

  _readRoomFromUrl() {
    const params = new URLSearchParams(location.search)
    const room = (params.get('room') || '').trim().toLowerCase()
    if (room && /^[a-z0-9]{3,12}$/.test(room)) {
      this.roomCode = room
      this.isHost = false
      this.ui.setJoinSubtitle('You have been invited to a race — set up your racer')
    } else {
      this.roomCode = randomRoom()
      this.isHost = true
      this.ui.setJoinSubtitle('Set up your racer, then invite your team')
    }
  }

  // ---------- Join ----------
  async _onJoinClick() {
    const name = this.ui.el.nick.value.trim()
    if (name.length < 2) return this.ui.joinError('Enter a nickname (at least 2 characters)')
    if (name.length > 14) return this.ui.joinError('Nickname is too long')

    this.ui.joinError('')
    this.ui.el.joinGo.disabled = true
    this.ui.el.joinGo.textContent = this.isHost ? 'Opening the paddock…' : 'Connecting…'

    this.myProfile = {
      name,
      avatar: this.ui.avatar,
      vehicle: this.ui.vehicle,
    }

    try {
      if (this.isHost) await this._startAsHost()
      else await this._startAsClient()
    } catch (err) {
      console.error(err)
      this.ui.joinError(err.message || 'Connection failed. Please try again.')
      this.ui.el.joinGo.disabled = false
      this.ui.el.joinGo.textContent = 'Join the race'
    }
  }

  async _startAsHost() {
    this.net = new NetHost(this.roomCode)
    this.net.on('message', (peerId, msg) => this._hostOnMessage(peerId, msg))
    this.net.on('leave', (peerId) => this._hostOnLeave(peerId))

    await this.net.start()
    this.net.startKeepalive()

    this.myId = 'host'
    this.players.set(this.myId, {
      id: this.myId, ...this.myProfile, color: PLAYER_COLORS[0], isHost: true,
    })

    this.state = STATE.LOBBY
    this.ui.show('lobby')
    this._refreshLobby()
  }

  async _startAsClient() {
    this.net = new NetClient(this.roomCode)
    this.net.on('message', (msg) => this._clientOnMessage(msg))
    this.net.on('hostgone', () => {
      this.ui.connToast('The host left — the race has ended.', 0)
      if (this.state === STATE.RACING) this.input.disable()
    })

    const id = await this.net.connect()
    this.myId = id
    this.net.send(MSG.HELLO, this.myProfile)

    this.state = STATE.LOBBY
    this.ui.show('lobby')
    this.ui.el.lobbyStatus.textContent = 'Waiting for the host to start…'
  }

  _copyLink() {
    const link = this._shareLink()
    navigator.clipboard?.writeText(link)
      .then(() => this.ui.connToast('Link copied — send it to your team'))
      .catch(() => {
        this.ui.el.shareLink.select()
        this.ui.connToast('Press ⌘C / Ctrl+C to copy')
      })
  }

  _shareLink() {
    return `${location.origin}${location.pathname}?room=${this.roomCode}`
  }

  // ---------- Host: message handling ----------
  _hostOnMessage(peerId, msg) {
    const { type, data } = msg || {}

    if (type === MSG.HELLO) {
      if (this.players.size >= MAX_PLAYERS) {
        this.net.send(peerId, MSG.ROSTER, { full: true, players: [] })
        return
      }
      // Reject anything after the lights go out so a late joiner can't appear
      // mid-race with no grid slot.
      if (this.state !== STATE.LOBBY) {
        this.net.send(peerId, MSG.ROSTER, { late: true, players: this._rosterPayload() })
        return
      }
      const color = PLAYER_COLORS[this.players.size % PLAYER_COLORS.length]
      this.players.set(peerId, {
        id: peerId,
        name: sanitizeName(data?.name),
        avatar: sanitizeAvatar(data?.avatar),
        vehicle: VEHICLE_SPECS[data?.vehicle] ? data.vehicle : 'scooter',
        color,
        isHost: false,
      })
      this._broadcastRoster()
      this._refreshLobby()
      this.ui.connToast(`${this.players.get(peerId).name} joined`)
      return
    }

    if (type === MSG.STATE) {
      const remote = this.remotes.get(peerId)
      if (remote) remote.push(data, this._elapsed)
      return
    }

    if (type === MSG.FINISH) {
      this._recordFinish(peerId, data?.time)
      return
    }
  }

  _hostOnLeave(peerId) {
    const p = this.players.get(peerId)
    if (p) this.ui.connToast(`${p.name} left`)
    this.players.delete(peerId)
    this._removeVehicle(peerId)
    this.remotes.delete(peerId)
    this._broadcastRoster()
    if (this.state === STATE.LOBBY) this._refreshLobby()
    else this._checkRaceOver()
  }

  _rosterPayload() {
    return [...this.players.values()]
  }

  _broadcastRoster() {
    this.net.broadcast(MSG.ROSTER, { players: this._rosterPayload(), laps: this.ui.laps })
  }

  // ---------- Client: message handling ----------
  _clientOnMessage(msg) {
    const { type, data } = msg || {}

    if (type === MSG.ROSTER) {
      if (data?.full) {
        this.ui.connToast('That race is full.', 0)
        return
      }
      if (data?.late) {
        this.ui.connToast('The race already started — you will join the next one.', 0)
      }
      this.players = new Map((data.players || []).map(p => [p.id, p]))
      if (data.laps) this.laps = data.laps
      if (this.state === STATE.LOBBY) this._refreshLobby()
      else this._pruneDeparted()
      return
    }

    if (type === MSG.START) {
      this.laps = data.laps
      this._beginRace(data.grid)
      return
    }

    if (type === MSG.SNAPSHOT) {
      for (const s of data.riders) {
        if (s.id === this.myId) continue
        const remote = this.remotes.get(s.id)
        if (remote) remote.push(s, this._elapsed)
      }
      return
    }

    if (type === MSG.RESULTS) {
      this._showResults(data.results)
      return
    }

    if (type === MSG.LOBBY) {
      this._resetToLobby()
      return
    }
  }

  _refreshLobby() {
    const players = [...this.players.values()]
    this.ui.renderLobby({
      players,
      isHost: this.isHost,
      shareLink: this._shareLink(),
      canStart: players.length >= 1,
      statusText: this.isHost
        ? (players.length < 2
            ? 'Share the link above. You can start solo for a practice lap.'
            : `${players.length} riders ready.`)
        : 'Waiting for the host to start…',
    })
  }

  // ---------- Race lifecycle ----------
  _hostStartRace() {
    this.laps = this.ui.laps
    const ids = [...this.players.keys()]
    const grid = ids.map((id, i) => ({ id, slot: i }))

    this.net.broadcast(MSG.START, { laps: this.laps, grid })
    this._beginRace(grid)
  }

  _beginRace(grid) {
    this.results = []
    this._clearVehicles()
    this.remotes.clear()

    const slotById = new Map(grid.map(g => [g.id, g.slot]))

    for (const p of this.players.values()) {
      const slot = slotById.get(p.id) ?? 0
      const start = this.track.startSlot(slot)
      const vehicle = new Vehicle({
        type: p.vehicle, color: p.color, name: p.name, isLocal: p.id === this.myId,
      })
      vehicle.group.position.copy(start.position)
      vehicle.group.rotation.y = start.heading
      this.scene.add(vehicle.group)
      this.vehicles.set(p.id, vehicle)

      if (p.id === this.myId) {
        this.me = new RiderPhysics(this.track, VEHICLE_SPECS[p.vehicle] || VEHICLE_SPECS.scooter, start)
        this.meProfile = p
      } else {
        const r = new RemoteRider()
        r.position.copy(start.position)
        r.heading = start.heading
        this.remotes.set(p.id, r)
      }
    }

    this.state = STATE.COUNTDOWN
    this.ui.showHud(isTouchDevice())
    this.input.disable()
    this._runCountdown()
  }

  async _runCountdown() {
    for (const n of ['3', '2', '1']) {
      this.ui.countdown(n)
      await sleep(1000)
      if (this.state !== STATE.COUNTDOWN) return
    }
    this.ui.countdown('GO!')
    this.state = STATE.RACING
    this.raceStart = performance.now() / 1000
    this.input.enable()
    setTimeout(() => this.ui.hideCountdown(), 700)
  }

  _recordFinish(id, time) {
    if (this.results.some(r => r.id === id)) return
    const p = this.players.get(id)
    if (!p) return
    this.results.push({ id, name: p.name, avatar: p.avatar, color: p.color, time })
    this._checkRaceOver()
  }

  _checkRaceOver() {
    if (!this.isHost) return
    const active = [...this.players.keys()]
    const allDone = active.every(id => this.results.some(r => r.id === id))
    if (allDone && active.length > 0) this._publishResults()
  }

  _publishResults() {
    if (this._resultsPublished) return
    this._resultsPublished = true

    // Anyone still out on track when the race ends is a DNF, ordered by distance.
    const finished = [...this.results].sort((a, b) => a.time - b.time)
    const dnfIds = [...this.players.keys()].filter(id => !this.results.some(r => r.id === id))
    const dnf = dnfIds.map(id => {
      const p = this.players.get(id)
      const dist = id === this.myId ? (this.me?.raceDistance ?? 0) : (this.remotes.get(id)?.lapProgress ?? 0)
      return { id, name: p.name, avatar: p.avatar, color: p.color, time: null, dist }
    }).sort((a, b) => b.dist - a.dist)

    const rows = [...finished, ...dnf]
    this.net.broadcast(MSG.RESULTS, { results: rows })
    this._showResults(rows)
  }

  _showResults(rows) {
    this.state = STATE.FINISHED
    this.input.disable()
    this.ui.hideTouch()
    this.ui.show('results')
    this.ui.renderResults(rows, this.myId, this.isHost)
  }

  _hostReturnToLobby() {
    this.net.broadcast(MSG.LOBBY, {})
    this._resetToLobby()
  }

  _resetToLobby() {
    this._resultsPublished = false
    this.results = []
    this._clearVehicles()
    this.remotes.clear()
    this.me = null
    this.state = STATE.LOBBY
    this.ui.show('lobby')
    this._refreshLobby()
  }

  // Mid-race the host may tell us someone left. Remove their bike so it doesn't
  // sit frozen on the track, and drop their interpolation buffer.
  _pruneDeparted() {
    for (const id of [...this.vehicles.keys()]) {
      if (id !== this.myId && !this.players.has(id)) {
        this._removeVehicle(id)
        this.remotes.delete(id)
      }
    }
  }

  _clearVehicles() {
    for (const [id] of this.vehicles) this._removeVehicle(id)
    this.vehicles.clear()
  }

  _removeVehicle(id) {
    const v = this.vehicles.get(id)
    if (!v) return
    this.scene.remove(v.group)
    v.dispose()
    this.vehicles.delete(id)
  }

  // ---------- Frame loop ----------
  _loop() {
    const tick = () => {
      requestAnimationFrame(tick)
      // Clamp dt so a background tab doesn't resume with a giant physics step
      // that flings riders off the island.
      const dt = Math.min(this._clock.getDelta(), 0.05)
      this._elapsed += dt

      this.env.update(dt, this._elapsed)

      if (this.state === STATE.RACING || this.state === STATE.COUNTDOWN) {
        this._updateRace(dt)
      } else {
        this.chase.orbit(this._menuTarget, this._elapsed, 18, 8)
        this.env.focusShadow(this._menuTarget)
      }

      this.renderer.render(this.scene, this.camera)
    }
    tick()
  }

  _updateRace(dt) {
    const racing = this.state === STATE.RACING

    // --- Local rider ---
    if (this.me) {
      if (racing && !this.me.finished) {
        this.me.update(dt, this.input.state)

        if (this.me.lapProgress >= this.laps) {
          this.me.finished = true
          const time = performance.now() / 1000 - this.raceStart
          this.me.finishTime = time
          this.input.disable()
          this.ui.toast('FINISH!')
          if (this.isHost) this._recordFinish(this.myId, time)
          else this.net.send(MSG.FINISH, { time })
        } else if (this.me.lap > (this._shownLap ?? 0)) {
          this._shownLap = this.me.lap
          if (this.me.lap < this.laps) this.ui.toast(`LAP ${this.me.lap + 1}`)
        }
      } else if (this.me.finished) {
        // Coast to a stop after crossing the line.
        this.me.update(dt, { forward: false, back: false, left: false, right: false, drift: false })
      }

      const v = this.vehicles.get(this.myId)
      if (v) {
        v.group.position.copy(this.me.position)
        v.group.rotation.y = this.me.heading
        v.updateVisual(dt, {
          speed: this.me.speed, steer: this.me.steerVis, lean: this.me.lean,
          drifting: this.me.drifting, onDirt: this.me.onDirt,
        })
      }

      this.chase.follow(this.me, dt)
      if (this.me.onDirt && this.me.speed > 8) this.chase.addShake(dt * 0.5)
      this.env.focusShadow(this.me.position)
      this.ui.setWrongWay(racing && this.me.wrongWay && !this.me.finished)
    }

    // --- Remote riders ---
    for (const [id, remote] of this.remotes) {
      remote.update(this._elapsed)
      const v = this.vehicles.get(id)
      if (!v) continue
      v.group.position.copy(remote.position)
      v.group.rotation.y = remote.heading
      v.updateVisual(dt, {
        speed: remote.speed, steer: 0, lean: remote.lean,
        drifting: remote.drifting, onDirt: remote.onDirt,
      })
    }

    // --- Networking ---
    if (racing) {
      this._sendAccum += dt
      if (this._sendAccum >= 1 / SEND_HZ) {
        this._sendAccum = 0
        this._sendState()
      }
    }

    this._updateHud()
  }

  _sendState() {
    if (!this.me || !this.net) return
    const s = {
      x: round2(this.me.position.x), y: round2(this.me.position.y), z: round2(this.me.position.z),
      h: round3(this.me.heading), l: round3(this.me.lean),
      s: round2(this.me.speed), d: this.me.drifting ? 1 : 0,
      o: this.me.onDirt ? 1 : 0, p: round3(this.me.lapProgress),
    }

    if (this.isHost) {
      // The host is the hub: fold its own state into the snapshot it relays.
      const riders = [{ id: this.myId, ...s }]
      for (const [id, remote] of this.remotes) {
        const last = remote.buffer[remote.buffer.length - 1]
        if (!last) continue
        riders.push({
          id,
          x: round2(last.pos.x), y: round2(last.pos.y), z: round2(last.pos.z),
          h: round3(last.heading), l: round3(last.lean), s: round2(last.speed),
          d: last.drifting ? 1 : 0, o: last.onDirt ? 1 : 0, p: round3(last.lapProgress),
        })
      }
      this.net.broadcast(MSG.SNAPSHOT, { riders })
    } else {
      this.net.send(MSG.STATE, s)
    }
  }

  _updateHud() {
    if (!this.me) return

    const rows = []
    rows.push({
      id: this.myId,
      name: this.meProfile?.name || 'You',
      avatar: this.meProfile?.avatar || '🙂',
      color: this.meProfile?.color || '#fff',
      progress: this.me.lapProgress,
    })
    for (const [id, remote] of this.remotes) {
      const p = this.players.get(id)
      if (!p) continue
      rows.push({ id, name: p.name, avatar: p.avatar, color: p.color, progress: remote.lapProgress })
    }
    rows.sort((a, b) => b.progress - a.progress)

    const myPos = rows.findIndex(r => r.id === this.myId) + 1
    this.ui.setHud({
      position: myPos || 1,
      total: rows.length,
      lap: this.me.lap + 1,
      laps: this.laps,
      speed: this.me.speed,
    })
    this.ui.setStandings(rows, this.myId)
  }
}

// ---------- helpers ----------
const round2 = (n) => Math.round(n * 100) / 100
const round3 = (n) => Math.round(n * 1000) / 1000
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()))

function sanitizeName(name) {
  const s = String(name ?? '').trim().slice(0, 14)
  return s.length >= 2 ? s : 'Rider'
}

function sanitizeAvatar(a) {
  const s = String(a ?? '').trim()
  // One or two code points — enough for an emoji, not enough for a payload.
  return [...s].length >= 1 && [...s].length <= 3 ? s : '🙂'
}

const game = new Game()
// Exposed for the headless test harness (and handy when debugging in the
// browser console). Harmless in production — it exposes no secrets.
window.__game = game
game.boot().catch((err) => {
  console.error(err)
  document.getElementById('load-text').textContent =
    'Something went wrong starting the game. Please reload.'
})
