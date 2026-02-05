/**
 * Tron Lightcycles - Game Logic
 *
 * Authoritative game state machine with:
 * - Lobby/ready flow
 * - Countdown scheduling
 * - Deterministic tick loop
 * - O(1) collision detection via occupied Set
 *
 * Status flow: waiting → ready → countdown → running → gameOver
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const TICK_RATE = 20; // 20 Hz = 50ms per tick
const TICK_INTERVAL = 1000 / TICK_RATE; // 50ms
const COUNTDOWN_SECONDS = 3; // 3...2...1...GO
const FULL_SYNC_INTERVAL = 40; // Send full trails every 40 ticks (2 seconds)
const GRID_WIDTH = 80;
const GRID_HEIGHT = 60;

// Direction vectors
const DIR_VECTORS = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

// Opposite directions (for 180° turn validation)
const OPPOSITES = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

// ============================================================================
// GAME CLASS
// ============================================================================

class Game {
  constructor() {
    this.gridWidth = GRID_WIDTH;
    this.gridHeight = GRID_HEIGHT;

    // Player connections and state
    // players[1] and players[2] (1-indexed for clarity)
    this.players = {
      1: null,
      2: null,
    };

    // Persistent score across rounds
    this.score = { 1: 0, 2: 0 };

    // Game status: waiting | ready | countdown | running | gameOver
    this.status = "waiting";

    // Round state (reset each round)
    this.tick = 0;
    this.occupied = new Set(); // "x,y" strings for O(1) collision
    this.trails = { 1: [], 2: [] }; // Full trail arrays for broadcasting
    this.winner = null;

    // Tick loop timer
    this.tickTimer = null;

    // Countdown timer
    this.countdownTimer = null;
    this.countdownValue = 0;
  }

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  getPlayerCount() {
    return (this.players[1] ? 1 : 0) + (this.players[2] ? 1 : 0);
  }

  getGridSize() {
    return { w: this.gridWidth, h: this.gridHeight };
  }

  addPlayer(ws) {
    // Assign to first available slot
    const playerId = this.players[1] === null ? 1 : 2;

    this.players[playerId] = {
      id: playerId,
      ws: ws,
      x: 0,
      y: 0,
      dir: "RIGHT",
      alive: true,
      connected: true,
      ready: false,
      inputQueue: null, // Last queued input direction
    };

    // Check if we now have 2 players
    this.updateStatusAfterConnection();

    return playerId;
  }

  removePlayer(playerId) {
    const player = this.players[playerId];
    if (!player) return;

    console.log(
      `[Disconnect] Player ${playerId} disconnecting, status: ${this.status}`
    );

    player.connected = false;
    player.ws = null;

    // Handle disconnection based on current status
    if (this.status === "countdown") {
      // Cancel countdown, return to waiting
      console.log(`[Disconnect] Cancelling countdown due to disconnect`);
      this.cancelCountdown();
      this.status = "waiting";
      this.broadcastState();
    } else if (this.status === "running") {
      // Player disconnected during game - other player wins
      console.log(`[Disconnect] Player ${playerId} left during game`);
      this.stopTickLoop();
      player.alive = false;
      const otherId = playerId === 1 ? 2 : 1;
      if (this.players[otherId] && this.players[otherId].connected) {
        this.winner = otherId;
        this.score[otherId]++;
        console.log(`[Disconnect] Player ${otherId} wins by disconnect`);
      }
      this.status = "gameOver";
      this.broadcastState();
    } else if (this.status === "ready") {
      // Return to waiting
      console.log(`[Disconnect] Returning to waiting state`);
      this.status = "waiting";
      this.broadcastState();
    } else if (this.status === "gameOver") {
      // Player left during gameOver - just broadcast updated state
      console.log(`[Disconnect] Player left during gameOver`);
      this.broadcastState();
    }

    // Clean up player slot for reuse
    this.players[playerId] = null;

    // Update status (may change if we went from 2 to 1 player)
    this.updateStatusAfterConnection();
  }

  updateStatusAfterConnection() {
    const count = this.getPlayerCount();

    if (this.status === "waiting" && count === 2) {
      // Both players connected, move to ready state
      this.status = "ready";
      // Reset ready flags for both players
      if (this.players[1]) this.players[1].ready = false;
      if (this.players[2]) this.players[2].ready = false;
      this.broadcastState();
    } else if (this.status === "ready" && count < 2) {
      this.status = "waiting";
      this.broadcastState();
    }
  }

  // ==========================================================================
  // MESSAGE HANDLERS
  // ==========================================================================

  handleStart(playerId) {
    const player = this.players[playerId];
    if (!player || !player.connected) return;

    // Only accept start in 'ready' status
    if (this.status !== "ready") {
      this.sendToPlayer(playerId, {
        type: "error",
        message: "Cannot start in current state",
      });
      return;
    }

    player.ready = true;
    console.log(`Player ${playerId} is ready`);

    // Check if both players are ready
    if (this.players[1]?.ready && this.players[2]?.ready) {
      this.startCountdown();
    } else {
      // Broadcast so other player sees ready status
      this.broadcastState();
    }
  }

  handleInput(playerId, dir) {
    const player = this.players[playerId];
    if (!player || !player.connected || !player.alive) return;

    // Only accept inputs during running (could queue during countdown but spec says ignore)
    if (this.status !== "running") return;

    // Validate: no 180° turns
    if (OPPOSITES[player.dir] === dir) {
      // Silently ignore illegal turn
      return;
    }

    // Queue input (last valid input wins if multiple arrive before tick)
    player.inputQueue = dir;
  }

  handleReset(playerId) {
    // Only allow reset in gameOver state
    if (this.status !== "gameOver") {
      this.sendToPlayer(playerId, {
        type: "error",
        message: "Cannot reset in current state",
      });
      return;
    }

    // Debounce: prevent double-reset by immediately changing status
    // This prevents race condition if both players reset simultaneously
    console.log(`[Reset] Player ${playerId} requested reset`);
    this.status = "ready"; // Change status FIRST to prevent duplicate resets

    // Reset round state
    this.resetRoundState();

    // Reset ready flags - both must click start again
    if (this.players[1]) this.players[1].ready = false;
    if (this.players[2]) this.players[2].ready = false;

    console.log(`[Reset] Round reset complete, status: ${this.status}`);
    this.broadcastState();
  }

  // ==========================================================================
  // COUNTDOWN LOGIC
  // ==========================================================================

  startCountdown() {
    console.log("[Game] Starting countdown...");
    this.status = "countdown";
    this.countdownValue = COUNTDOWN_SECONDS;

    // Broadcast initial countdown
    this.broadcastCountdown();

    // Schedule countdown ticks (1 per second)
    this.countdownTimer = setInterval(() => {
      this.countdownValue--;
      this.broadcastCountdown(); // Always broadcast (including 0 for "GO!")

      if (this.countdownValue <= 0) {
        // Countdown finished - start the game
        this.cancelCountdown();
        this.startRound();
      }
    }, 1000);
  }

  cancelCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.countdownValue = 0;
  }

  broadcastCountdown() {
    this.broadcast({ type: "countdown", secondsLeft: this.countdownValue });
  }

  // ==========================================================================
  // ROUND INITIALIZATION
  // ==========================================================================

  startRound() {
    console.log("[Game] Starting round!");
    this.resetRoundState();
    this.initializePlayerPositions();
    this.status = "running";
    console.log(
      `[Game] P1 at (${this.players[1]?.x},${this.players[1]?.y}), P2 at (${this.players[2]?.x},${this.players[2]?.y})`
    );

    // Broadcast initial state with full trails (empty at start)
    this.broadcastState(true); // true = force full trail sync

    // Start tick loop
    this.startTickLoop();
  }

  resetRoundState() {
    this.tick = 0;
    this.occupied.clear();
    this.trails = { 1: [], 2: [] };
    this.winner = null;

    // Reset player round state
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (player) {
        player.alive = true;
        player.inputQueue = null;
      }
    }
  }

  initializePlayerPositions() {
    // Player 1: left side, facing right
    if (this.players[1]) {
      this.players[1].x = 10;
      this.players[1].y = Math.floor(this.gridHeight / 2);
      this.players[1].dir = "RIGHT";
    }

    // Player 2: right side, facing left
    if (this.players[2]) {
      this.players[2].x = this.gridWidth - 11;
      this.players[2].y = Math.floor(this.gridHeight / 2);
      this.players[2].dir = "LEFT";
    }

    // Note: Starting positions are NOT added to occupied set
    // Players can occupy their starting cell
  }

  // ==========================================================================
  // TICK LOOP
  // ==========================================================================

  startTickLoop() {
    this.tickTimer = setInterval(() => this.processTick(), TICK_INTERVAL);
  }

  stopTickLoop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * TICK ORDER (CRITICAL - follow exactly):
   * 1) Apply queued inputs (validate no 180°)
   * 2) Compute proposed next positions for both alive players (no mutation yet)
   * 3) Resolve collisions (wall, trail, head-on)
   * 4) Determine outcome (draw/winner/continue)
   * 5) Commit movement for alive players (add to trail, update position)
   * 6) Broadcast authoritative state snapshot
   */
  processTick() {
    if (this.status !== "running") return;

    const trailsDelta = { 1: null, 2: null };

    // -------------------------------------------------------------------------
    // STEP 1: Apply queued inputs
    // -------------------------------------------------------------------------
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      if (player.inputQueue !== null) {
        // Double-check 180° validation (already checked in handleInput, but be safe)
        if (OPPOSITES[player.dir] !== player.inputQueue) {
          player.dir = player.inputQueue;
        }
        player.inputQueue = null;
      }
    }

    // -------------------------------------------------------------------------
    // STEP 2: Compute proposed next positions (no mutation yet)
    // -------------------------------------------------------------------------
    const nextPositions = {};
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      const vec = DIR_VECTORS[player.dir];
      nextPositions[id] = {
        x: player.x + vec.x,
        y: player.y + vec.y,
      };
    }

    // -------------------------------------------------------------------------
    // STEP 3: Resolve collisions
    // -------------------------------------------------------------------------
    const deaths = { 1: false, 2: false };

    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      const next = nextPositions[id];

      // Check wall collision
      if (
        next.x < 0 ||
        next.x >= this.gridWidth ||
        next.y < 0 ||
        next.y >= this.gridHeight
      ) {
        deaths[id] = true;
        continue;
      }

      // Check trail collision (O(1) lookup)
      const key = `${next.x},${next.y}`;
      if (this.occupied.has(key)) {
        deaths[id] = true;
        continue;
      }
    }

    // Head-on collision check: both alive players moving to same cell
    if (
      !deaths[1] &&
      !deaths[2] &&
      this.players[1]?.alive &&
      this.players[2]?.alive
    ) {
      const next1 = nextPositions[1];
      const next2 = nextPositions[2];
      if (next1 && next2 && next1.x === next2.x && next1.y === next2.y) {
        deaths[1] = true;
        deaths[2] = true;
      }
    }

    // Pass-through collision check: players swap positions (crossing paths)
    // P1 at A moving to B, P2 at B moving to A => they pass through each other
    if (
      !deaths[1] &&
      !deaths[2] &&
      this.players[1]?.alive &&
      this.players[2]?.alive
    ) {
      const p1 = this.players[1];
      const p2 = this.players[2];
      const next1 = nextPositions[1];
      const next2 = nextPositions[2];
      if (
        next1 &&
        next2 &&
        p1.x === next2.x &&
        p1.y === next2.y &&
        p2.x === next1.x &&
        p2.y === next1.y
      ) {
        // They're swapping positions - treat as head-on collision
        console.log(`[Tick ${this.tick}] Pass-through collision detected`);
        deaths[1] = true;
        deaths[2] = true;
      }
    }

    // -------------------------------------------------------------------------
    // STEP 4: Determine outcome
    // -------------------------------------------------------------------------
    // Mark dead players
    for (const id of [1, 2]) {
      if (deaths[id] && this.players[id]) {
        this.players[id].alive = false;
      }
    }

    // Check win condition
    const p1Alive = this.players[1]?.alive ?? false;
    const p2Alive = this.players[2]?.alive ?? false;

    if (!p1Alive && !p2Alive) {
      // Both dead = draw
      this.winner = "draw";
      this.status = "gameOver";
      this.stopTickLoop();
      console.log(
        `[Game] DRAW at tick ${this.tick}! Score: P1=${this.score[1]}, P2=${this.score[2]}`
      );
    } else if (!p1Alive && p2Alive) {
      this.winner = 2;
      this.score[2]++;
      this.status = "gameOver";
      this.stopTickLoop();
      console.log(
        `[Game] Player 2 WINS at tick ${this.tick}! Score: P1=${this.score[1]}, P2=${this.score[2]}`
      );
    } else if (p1Alive && !p2Alive) {
      this.winner = 1;
      this.score[1]++;
      this.status = "gameOver";
      this.stopTickLoop();
      console.log(
        `[Game] Player 1 WINS at tick ${this.tick}! Score: P1=${this.score[1]}, P2=${this.score[2]}`
      );
    }

    // -------------------------------------------------------------------------
    // STEP 5: Commit movement for alive players
    // -------------------------------------------------------------------------
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      // Add current position to trail and occupied set BEFORE moving
      const trailCell = { x: player.x, y: player.y };
      const key = `${player.x},${player.y}`;

      this.occupied.add(key);
      this.trails[id].push(trailCell);
      trailsDelta[id] = trailCell;

      // Move to next position
      const next = nextPositions[id];
      player.x = next.x;
      player.y = next.y;
    }

    // -------------------------------------------------------------------------
    // STEP 6: Broadcast state
    // -------------------------------------------------------------------------
    this.tick++;

    // Determine if we should send full trails (every FULL_SYNC_INTERVAL ticks)
    const sendFull = this.tick % FULL_SYNC_INTERVAL === 0;
    this.broadcastState(sendFull, trailsDelta);
  }

  // ==========================================================================
  // BROADCASTING
  // ==========================================================================

  broadcastState(sendFullTrails = false, trailsDelta = null) {
    // Build player data array
    const playersData = [];
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (player) {
        playersData.push({
          id: player.id,
          x: player.x,
          y: player.y,
          dir: player.dir,
          alive: player.alive,
          ready: player.ready,
        });
      }
    }

    const msg = {
      type: "state",
      tick: this.tick,
      status: this.status,
      players: playersData,
      score: { 1: this.score[1], 2: this.score[2] },
      winner: this.winner,
    };

    // Add trail data
    if (sendFullTrails || this.tick === 0) {
      // Full trail sync
      msg.trailsFull = {
        1: [...this.trails[1]],
        2: [...this.trails[2]],
      };
    } else if (trailsDelta) {
      // Delta only
      msg.trailsDelta = trailsDelta;
    }

    this.broadcast(msg);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (player?.ws?.readyState === 1) {
        // WebSocket.OPEN = 1
        player.ws.send(data);
      }
    }
  }

  sendToPlayer(playerId, msg) {
    const player = this.players[playerId];
    if (player?.ws?.readyState === 1) {
      player.ws.send(JSON.stringify(msg));
    }
  }
}

module.exports = Game;
