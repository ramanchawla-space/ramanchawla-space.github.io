// Thin DOM layer. All screen transitions and HUD writes go through here so the
// game loop never touches the DOM directly.

const AVATARS = ['🐵', '🦊', '🐯', '🦁', '🐸', '🐨', '🐼', '🦄', '🐲', '🦖', '🐙', '🦩', '🐝', '🦜', '🐳', '🦈', '🌺', '🥥']

const $ = (id) => document.getElementById(id)

export class UI {
  constructor() {
    this.el = {
      loading: $('loading'), loadBar: $('load-bar'), loadText: $('load-text'),
      join: $('join'), nick: $('nick'), avatars: $('avatars'), joinGo: $('join-go'),
      joinErr: $('join-err'), joinSub: $('join-sub'),
      lobby: $('lobby'), playerList: $('player-list'), lobbyStatus: $('lobby-status'),
      startRace: $('start-race'), hostShare: $('host-share'), shareLink: $('share-link'),
      copyLink: $('copy-link'), lapsRow: $('laps-row'),
      hud: $('hud'), hudPos: $('hud-pos'), hudLap: $('hud-lap'), standings: $('standings'),
      speedNum: $('speed-num'), countdown: $('countdown'), lapToast: $('lap-toast'),
      wrongway: $('wrongway'),
      results: $('results'), podium: $('podium'), resultList: $('result-list'),
      again: $('again'), againNote: $('again-note'),
      connToast: $('conn-toast'), touch: $('touch'),
    }

    this.avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)]
    this.vehicle = 'scooter'
    this.laps = 2
    this._buildAvatars()
    this._bindVehicles()
    this._bindLaps()
  }

  _buildAvatars() {
    this.el.avatars.innerHTML = ''
    for (const a of AVATARS) {
      const b = document.createElement('button')
      b.className = 'avatar' + (a === this.avatar ? ' sel' : '')
      b.textContent = a
      b.type = 'button'
      b.addEventListener('click', () => {
        this.avatar = a
        this.el.avatars.querySelectorAll('.avatar').forEach(x => x.classList.remove('sel'))
        b.classList.add('sel')
      })
      this.el.avatars.appendChild(b)
    }
  }

  _bindVehicles() {
    const btns = document.querySelectorAll('.vehicle')
    btns.forEach(b => {
      if (b.dataset.vehicle === this.vehicle) b.classList.add('sel')
      b.addEventListener('click', () => {
        this.vehicle = b.dataset.vehicle
        btns.forEach(x => x.classList.remove('sel'))
        b.classList.add('sel')
      })
    })
  }

  _bindLaps() {
    const btns = document.querySelectorAll('.lapbtn')
    btns.forEach(b => {
      b.addEventListener('click', () => {
        this.laps = parseInt(b.dataset.laps, 10)
        btns.forEach(x => x.classList.remove('active'))
        b.classList.add('active')
      })
    })
  }

  // --- Screens ---
  show(name) {
    for (const k of ['loading', 'join', 'lobby', 'results']) {
      this.el[k].classList.toggle('hidden', k !== name)
    }
    this.el.hud.classList.add('hidden')
  }

  showHud(withTouch) {
    for (const k of ['loading', 'join', 'lobby', 'results']) this.el[k].classList.add('hidden')
    this.el.hud.classList.remove('hidden')
    this.el.touch.classList.toggle('hidden', !withTouch)
  }

  hideTouch() { this.el.touch.classList.add('hidden') }

  setProgress(frac, label) {
    this.el.loadBar.style.width = Math.round(frac * 100) + '%'
    if (label) this.el.loadText.textContent = label
  }

  joinError(msg) { this.el.joinErr.textContent = msg || '' }

  setJoinSubtitle(text) { this.el.joinSub.textContent = text }

  // --- Lobby ---
  renderLobby({ players, isHost, shareLink, canStart, statusText }) {
    this.el.hostShare.classList.toggle('hidden', !isHost)
    this.el.lapsRow.classList.toggle('hidden', !isHost)
    if (isHost && shareLink) this.el.shareLink.value = shareLink

    this.el.playerList.innerHTML = ''
    for (const p of players) {
      const row = document.createElement('div')
      row.className = 'prow'
      row.style.setProperty('--c', p.color)
      row.innerHTML = `
        <span class="pa">${p.avatar}</span>
        <span class="pn"></span>
        <span class="pv">${p.vehicle === 'bike' ? '🏍️' : '🛵'}</span>
        ${p.isHost ? '<span class="tag">HOST</span>' : ''}
      `
      // Set the nickname via textContent — never innerHTML — so a colleague
      // typing "<img onerror=...>" as their name can't inject markup.
      row.querySelector('.pn').textContent = p.name
      this.el.playerList.appendChild(row)
    }

    this.el.startRace.classList.toggle('hidden', !isHost)
    this.el.startRace.disabled = !canStart
    this.el.lobbyStatus.textContent = statusText || ''
  }

  // --- HUD ---
  setHud({ position, total, lap, laps, speed }) {
    const ord = ['th', 'st', 'nd', 'rd'][(position % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][position % 100] || 'th'
    this.el.hudPos.innerHTML = `${position}<span class="ord">${ord}</span>`
    this.el.hudLap.textContent = `Lap ${Math.min(lap, laps)}/${laps} · ${total} riders`
    this.el.speedNum.textContent = Math.round(speed * 3.6)
  }

  setStandings(rows, myId) {
    this.el.standings.innerHTML = ''
    rows.slice(0, 8).forEach((r, i) => {
      const d = document.createElement('div')
      d.className = 'srow' + (r.id === myId ? ' me' : '')
      d.style.setProperty('--c', r.color)
      d.innerHTML = `<span class="sp">${i + 1}</span><span class="sa">${r.avatar}</span><span class="sn"></span>`
      d.querySelector('.sn').textContent = r.name
      this.el.standings.appendChild(d)
    })
  }

  setWrongWay(on) { this.el.wrongway.classList.toggle('hidden', !on) }

  countdown(text) {
    const el = this.el.countdown
    el.classList.remove('hidden', 'pop')
    void el.offsetWidth      // restart the CSS animation
    el.textContent = text
    el.classList.add('pop')
  }

  hideCountdown() { this.el.countdown.classList.add('hidden') }

  toast(text) {
    const el = this.el.lapToast
    el.classList.remove('hidden')
    void el.offsetWidth
    el.textContent = text
    el.style.animation = 'none'
    void el.offsetWidth
    el.style.animation = ''
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 1700)
  }

  connToast(text, ms = 3200) {
    const el = this.el.connToast
    el.textContent = text
    el.classList.remove('hidden')
    clearTimeout(this._connTimer)
    if (ms > 0) this._connTimer = setTimeout(() => el.classList.add('hidden'), ms)
  }

  hideConnToast() { this.el.connToast.classList.add('hidden') }

  // --- Results ---
  renderResults(rows, myId, isHost) {
    this.el.podium.innerHTML = ''
    const medals = ['🥇', '🥈', '🥉']
    const order = [1, 0, 2]   // 2nd, 1st, 3rd for the classic podium shape
    for (const idx of order) {
      const r = rows[idx]
      if (!r) continue
      const d = document.createElement('div')
      d.className = `pod p${idx + 1}`
      d.innerHTML = `
        <div class="pa">${r.avatar}</div>
        <div class="pn"></div>
        <div class="block">${medals[idx]}</div>
      `
      d.querySelector('.pn').textContent = r.name
      this.el.podium.appendChild(d)
    }

    this.el.resultList.innerHTML = ''
    rows.forEach((r, i) => {
      const d = document.createElement('div')
      d.className = 'rrow' + (r.id === myId ? ' me' : '')
      d.innerHTML = `
        <span class="rp">${i + 1}</span>
        <span class="pa">${r.avatar}</span>
        <span class="rn"></span>
        <span class="rt">${r.time != null ? formatTime(r.time) : 'DNF'}</span>
      `
      d.querySelector('.rn').textContent = r.name
      this.el.resultList.appendChild(d)
    })

    this.el.again.classList.toggle('hidden', !isHost)
    this.el.againNote.textContent = isHost ? '' : 'Waiting for the host to restart…'
  }
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
}

export { AVATARS }
