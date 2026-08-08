// Keyboard + touch input. Exposes a plain object the physics step reads.

const KEY_MAP = {
  ArrowUp: 'forward', KeyW: 'forward',
  ArrowDown: 'back', KeyS: 'back',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'drift', ShiftLeft: 'drift', ShiftRight: 'drift',
}

export class Input {
  constructor() {
    this.state = { forward: false, back: false, left: false, right: false, drift: false }
    this.onRespawn = null
    this._enabled = false

    this._down = (e) => {
      if (!this._enabled) return
      const action = KEY_MAP[e.code]
      if (action) {
        this.state[action] = true
        e.preventDefault()   // stop arrow keys / space scrolling the page
      }
      if (e.code === 'KeyR' && this.onRespawn) this.onRespawn()
    }
    this._up = (e) => {
      const action = KEY_MAP[e.code]
      if (action) { this.state[action] = false; e.preventDefault() }
    }
    // Releasing keys on blur prevents a stuck throttle when the user alt-tabs.
    this._blur = () => this.reset()

    window.addEventListener('keydown', this._down, { passive: false })
    window.addEventListener('keyup', this._up, { passive: false })
    window.addEventListener('blur', this._blur)

    this._bindTouch()
  }

  _bindTouch() {
    const pairs = [
      ['t-gas', 'forward'], ['t-brake', 'back'],
      ['t-left', 'left'], ['t-right', 'right'],
    ]
    for (const [id, action] of pairs) {
      const el = document.getElementById(id)
      if (!el) continue
      const on = (e) => { e.preventDefault(); this.state[action] = true }
      const off = (e) => { e.preventDefault(); this.state[action] = false }
      el.addEventListener('pointerdown', on)
      el.addEventListener('pointerup', off)
      el.addEventListener('pointerleave', off)
      el.addEventListener('pointercancel', off)
    }
  }

  enable() { this._enabled = true }
  disable() { this._enabled = false; this.reset() }
  reset() { for (const k in this.state) this.state[k] = false }
}

export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches
}
