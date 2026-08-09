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

## The circuit

One lap runs through nine named sectors, announced on screen as you enter each.
Road width and surface change per sector, so each one handles differently:

| Sector | Width | Surface | Character |
|---|---|---|---|
| 🏖️ Kuta Beach Straight | 18 m | asphalt | Wide warm-up past banner-lined sand |
| 🌊 Coast Road | 15 m | asphalt | Rockfall off the cliff on the sea side |
| 🛕 Pura Headland | 13 m | stone | Drives through a split gate flanked by guardian statues |
| 🌴 Jungle Gorge | 12 m | asphalt | Enclosed canopy, fallen logs, brush fire |
| 🌉 River Causeway | **7 m** | stone | Stone bridge over the river — **no barriers, you can fall in** |
| 🌾 Tegallalang Terraces | 11 m | dirt | Climb alongside flooded rice paddies |
| 🌋 Agung Switchbacks | 10 m | dirt | Volcanic scree, lava-heated ground |
| 🏘️ Village Street | 12 m | stone | Compound walls, warungs, stray cows |
| ⛰️ Descent to the Sea | 16 m | asphalt | Fast run back to the start line |

## Obstacles

37 hazards are placed around the lap. Placement is a fixed table, not random —
every player must see the same rock in the same place or the race isn't fair.
None fully block the road: there is always a line through, but it costs you
either speed or the apex.

| Hazard | Effect | Notes |
|---|---|---|
| 🪨 Big rock | Scrubs ~78% of speed | The harshest hit on the track |
| 🐄 Cow | Scrubs ~74% | Wanders; a Bali road classic |
| 🛖 Market stall | Scrubs ~61% | Village street only |
| 🪵 Log / rock | Scrubs ~55–60% | Deflects you off the contact normal |
| 🔥 Fire | Slows + 1.6 s burning | Screen tints, camera shakes |
| 🕳️ Pothole | Slows + brief spin | Easy to clip on the apex |
| 💧 Mud | Heavy drag | Irrigation washout on the terraces |
| 🛢️ Oil | Barely slows you | But costs ~1.1 s of steering control — the real trap |
| 🌺 Offering | Light tap | Canang sari left on the roadside |

Falling off the causeway drops you into the river and respawns you on the deck
after ~1.4 s. The HUD warns you about what's coming with a proximity bar, flashes
on impact, and tints the screen while you're burning, spinning or in the water.

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

Two further harnesses are run on demand rather than in `npm test`:

| Harness | What it does |
|---|---|
| `clearance.mjs` | Sweeps 220 points around the lap and raycasts for scenery standing in the road. Caught 27 intrusions when the Bali sectors were built — a rice terrace across the tarmac, 18 house roofs over the racing line — that no single screenshot would have shown. |
| `shots.mjs` | Drives to ten scenic points and screenshots each, for eyeballing the look of a sector after changing it. |

Headless software WebGL runs at ~4 fps, so the lap and multiplayer suites drive
the opening stretch under real physics and then skip to the final stretch. That
keeps them correctness tests rather than tests of how fast the CI box is.

## Notes on the scene

Scattered detail (palms, jungle, foliage, terrain) is procedural and seeded
(`mulberry32`), so every player sees it in identical positions — necessary when
racing the same track. Landmarks and hazards are hand-placed instead, anchored to
a lap position `t` and an offset from the centreline, so they stay glued to the
road when the spline is retuned.

Everything reads the road's width from `Track.widthAt(t)` rather than a constant,
which is what lets the causeway narrow to 7 m while the beach straight stays at
18 m without the kerbs, barriers, scenery or physics drifting out of agreement.

Scenery placement uses `Environment._roadClearance()`, not `Track.nearest()`.
`nearest()` scans a lookup table, and where the circuit doubles back on itself
the nearest *sample* can belong to a different pass of the road than the truly
nearest point — so an object could pass its spawn check and still land on the
tarmac. `_roadClearance()` bins road samples into a uniform grid and gets it
right; `test/clearance.mjs` verifies the result.

Textures load from a CDN with procedural fallbacks, so a blocked corporate
network degrades the look instead of breaking the game.

## Deploying

```bash
./deploy.sh
```

Builds and force-pushes `dist/` to the `gh-pages` branch, which Pages serves.
Allow about a minute for GitHub's CDN to pick up the change.

GitHub Actions would be tidier, but pushing `.github/workflows/` requires the
`workflow` token scope, which this machine's `gh` login doesn't have. To switch
over:

```bash
gh auth refresh -s workflow
mkdir -p .github/workflows && mv .ci-backup/deploy.yml .github/workflows/
```

then set the Pages source to "GitHub Actions" in the repo settings.
