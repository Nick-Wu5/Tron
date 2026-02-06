# TRON Lightcycles

A two-player Tron game with an authoritative Node.js server and Three.js 3D client.

## Quick Start

```bash
npm install
node server.js
```

Open **http://localhost:3000** in two browser tabs to play.

## Controls

- **Arrow keys** or **WASD** — Steer your lightcycle
- **R** — Reset after game over

## Key Features

### Server-Authoritative Architecture

All game logic runs on the server. Clients only render and send input—no cheating possible.

### Deterministic Tick Loop (20 Hz)

The server processes game state in a strict order each tick:

1. Apply queued inputs
2. Compute next positions
3. Resolve collisions
4. Commit movement & update trails
5. Broadcast state to all clients

### Concurrent Event Handling

| Scenario                   | Resolution                                              |
| -------------------------- | ------------------------------------------------------- |
| **Head-on collision**      | Both players occupy same cell → both die (draw)         |
| **Pass-through collision** | Players swap positions in one tick → both die           |
| **Simultaneous death**     | Both hit walls/trails same tick → draw                  |
| **Input race**             | Last valid input per tick wins; 180° turns rejected     |
| **Disconnect mid-game**    | Remaining player wins immediately                       |
| **Reset spam**             | First reset accepted; status change prevents duplicates |

### Proximity Speed Boost

Get close to any trail (within 2 cells) to move **2x faster**. Risk vs reward—speed up near danger!

- Excludes your own "neck" (last 3 trail cells) to prevent always-on boost
- Visual feedback: glowing aura, particles, and "BOOST" indicator

### Fading Trails

Trails persist for 3 seconds (solid), then fade over 2 seconds before disappearing. Creates dynamic gameplay as old paths clear.

### Teleportation Portals

Portal pairs spawn each round. Enter one, exit the other facing outward. 1-second cooldown prevents re-entry loops.

### Visual Effects

- Neon Tron aesthetic with emissive materials
- Bike drop-in animation during countdown
- Death explosions with expanding energy rings
- Dynamic lighting that responds to boost state

## Configuration

Edit `game.js`:

| Constant             | Default | Description                       |
| -------------------- | ------- | --------------------------------- |
| `TICK_RATE`          | 20      | Server ticks per second           |
| `GRID_WIDTH`         | 80      | Arena width in cells              |
| `GRID_HEIGHT`        | 60      | Arena height in cells             |
| `PROXIMITY_DISTANCE` | 2       | Cells from trail to trigger boost |
| `TRAIL_SOLID_MS`     | 3000    | Trail visible duration            |
| `TRAIL_FADE_MS`      | 2000    | Trail fade-out duration           |

## File Structure

```
tron/
├── server.js      # HTTP + WebSocket server
├── game.js        # Game logic, tick loop, collision detection
└── client/
    ├── index.html # Game page
    ├── style.css  # UI styling
    └── client.js  # Three.js rendering
```

## Deployment

Works on Render/Heroku—uses `process.env.PORT` and binds to `0.0.0.0`. Client auto-detects `wss://` for HTTPS.
