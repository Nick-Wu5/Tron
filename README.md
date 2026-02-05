# TRON Lightcycles

A two-player Tron Lightcycles game with an authoritative Node.js server and Three.js 3D client.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

Then open **http://localhost:3000** in two browser tabs to play!

## How to Play

1. **Open two browser tabs** at http://localhost:3000
2. Each tab is automatically assigned as Player 1 or Player 2
3. **Both players click "START"** when ready
4. **3-2-1 countdown** begins
5. **Use arrow keys** (↑ ↓ ← →) to steer your lightcycle
6. Avoid walls and trails (yours and your opponent's)
7. Last player alive wins!
8. **Press R** to play again after a game ends

## Controls

| Key | Action                  |
| --- | ----------------------- |
| ↑   | Turn Up                 |
| ↓   | Turn Down               |
| ←   | Turn Left               |
| →   | Turn Right              |
| R   | Reset (after game over) |

## Architecture

**Authoritative Server Model**: All game logic runs on the server. Clients only render and send input.

```
┌─────────────────┐         WebSocket          ┌─────────────────┐
│   Client A      │◄──────────────────────────►│                 │
│   (Three.js)    │                            │   Authoritative │
└─────────────────┘                            │      Server     │
                                               │    (Node.js)    │
┌─────────────────┐         WebSocket          │                 │
│   Client B      │◄──────────────────────────►│                 │
│   (Three.js)    │                            │                 │
└─────────────────┘                            └─────────────────┘
```

## Game Flow

```
waiting → ready → countdown → running → gameOver → (reset) → ready
```

1. **waiting**: Fewer than 2 players connected
2. **ready**: Both players connected, waiting for both to click Start
3. **countdown**: 3-second countdown (3...2...1...GO)
4. **running**: Game in progress at 20 Hz tick rate
5. **gameOver**: Round ended, press R to reset

## Configuration

Edit constants in `game.js`:

| Constant            | Default | Description        |
| ------------------- | ------- | ------------------ |
| `TICK_RATE`         | 20      | Ticks per second   |
| `COUNTDOWN_SECONDS` | 3       | Pre-game countdown |
| `GRID_WIDTH`        | 80      | Arena width        |
| `GRID_HEIGHT`       | 60      | Arena height       |

## File Structure

```
tron/
├── server.js          # HTTP + WebSocket server
├── game.js            # Game state machine and tick loop
├── client/
│   ├── index.html     # Game page
│   ├── style.css      # UI styling
│   └── client.js      # Three.js rendering + WebSocket client
├── package.json
└── README.md
```

## Protocol

### Client → Server

| Message                                           | Description                          |
| ------------------------------------------------- | ------------------------------------ |
| `{ type: "start" }`                               | Player ready to begin                |
| `{ type: "input", dir: "UP\|DOWN\|LEFT\|RIGHT" }` | Movement input                       |
| `{ type: "reset" }`                               | Request new round (only in gameOver) |

### Server → Client

| Message                              | Description             |
| ------------------------------------ | ----------------------- |
| `{ type: "assign", playerId, grid }` | Player ID and grid size |
| `{ type: "state", ... }`             | Game state update       |
| `{ type: "countdown", secondsLeft }` | Countdown tick          |
| `{ type: "error", message }`         | Error notification      |

## Collision Rules

- **Wall**: Eliminated
- **Any trail**: Eliminated
- **Head-on** (same cell): Both eliminated (draw)

## Score

Score persists across rounds until server restart.
