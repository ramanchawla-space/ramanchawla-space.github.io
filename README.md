# Bali Racer 🛵🏍️

A browser multiplayer racing game set on a Balinese coastal circuit. Built for
playing with work colleagues — one person hosts, everyone else joins with a link.

**Play: https://ramanchawla-space.github.io/**

## How to run a race

1. Open the site. You're the **host** by default.
2. Enter a nickname, pick a picture and a vehicle (scooter or bike).
3. Click **Join the race** — you land in the lobby with a share link.
4. Send that link to your colleagues. They set up their own racer and appear in
   your lobby.
5. Pick lap count (1–3) and hit **Start the race**.
6. First across the line after the final lap wins. Podium at the end.

**The host must keep their tab open for the whole race** — their browser is the
server (see below).

## Controls

| Action | Keys |
|---|---|
| Throttle | `↑` or `W` |
| Brake / reverse | `↓` or `S` |
| Steer | `←` `→` or `A` `D` |
| Drift | `Space` or `Shift` |
| Respawn on track | `R` |

Touch controls appear automatically on phones and tablets.

## How the multiplayer works

GitHub Pages serves static files only — it can't run a game server. So the
**host's browser is the server**: players connect directly to it over WebRTC
(PeerJS), in a star topology.

- Each player simulates **their own** rider and sends its transform upstream at
  15 Hz. Your own bike therefore has zero input latency.
- The host owns race state: roster, race start, and finish order.
- Remote riders are rendered ~120 ms in the past and interpolated between
  snapshots, which hides normal network jitter. Measured position error in
  testing was 2–3 m.
- Clients heartbeat once a second. A WebRTC channel does *not* reliably fire
  `close` when a laptop lid shuts, so the host evicts silent peers after 6 s.
  Without that, one person dropping would hang the race for everyone.

Trade-off of this design: no accounts, no keys, no server cost, but the host has
to stay connected. Good for up to ~12 players.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
npm test         # headless browser suite (see below)
```

### Tests

The suite drives real Chrome instances via Puppeteer:

| Suite | What it proves |
|---|---|
| `smoke.mjs` | Boots, renders WebGL, hosts a room, accelerates |
| `dt.mjs` | Physics is frame-rate independent (0.000 m/s spread, 15–144 fps) |
| `lap.mjs` | Completes a lap, detects the finish, renders results |
| `multiplayer.mjs` | Two real browsers over WebRTC: roster sync, snapshot relay, interpolation accuracy, agreed standings |
| `disconnect.mjs` | A mid-race drop doesn't hang the race |

Headless software WebGL runs at ~4 fps, so the lap and multiplayer suites drive
the opening stretch under real physics and then skip to the final stretch. That
keeps them correctness tests rather than tests of how fast the CI box is.

## Notes on the scene

The island is procedural and seeded (`mulberry32`), so every player sees palms,
foliage and terrain in identical positions — necessary when racing the same
track. Textures load from a CDN with procedural fallbacks, so a blocked
corporate network degrades the look instead of breaking the game.

Deployment is via GitHub Actions on push to `main`.
