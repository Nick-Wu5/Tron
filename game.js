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

// =============================================================================
// TRAIL FADING CONFIGURATION
// Segments remain solid for TRAIL_SOLID_TICKS, then fade for TRAIL_FADE_TICKS,
// then are removed from collision and cleaned up.
// Total lifetime = TRAIL_SOLID_TICKS + TRAIL_FADE_TICKS
// =============================================================================
const TRAIL_SOLID_MS = 3000; // 3 seconds fully visible/solid
const TRAIL_FADE_MS = 2000; // 2 seconds fade-out
const TRAIL_TOTAL_MS = TRAIL_SOLID_MS + TRAIL_FADE_MS; // 5 seconds total
const TRAIL_TOTAL_TICKS = Math.ceil(TRAIL_TOTAL_MS / TICK_INTERVAL); // ~100 ticks

// =============================================================================
// PORTAL CONFIGURATION
// Teleportation portals come in pairs - entering one exits at the other
// =============================================================================
const PORTAL_COUNT = 1; // Number of portal pairs per round
const PORTAL_COOLDOWN_TICKS = 20; // 1 second before player can re-enter any portal
const PORTAL_MIN_DISTANCE = 15; // Minimum distance between portals in a pair
const PORTAL_EDGE_MARGIN = 5; // Minimum distance from board edge
const PORTAL_PLAYER_MARGIN = 10; // Minimum distance from player starting positions

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
    this.occupied = new Map(); // "x,y" -> spawnTick for O(1) collision + expiration
    this.trails = { 1: [], 2: [] }; // Full trail arrays: [{x, y, spawnTick}, ...]
    this.winner = null;
    
    // Portal state (regenerated each round)
    // Array of portal pairs: [{a: {x, y, exitDir}, b: {x, y, exitDir}}, ...]
    this.portals = [];

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
      portalCooldown: 0, // Ticks until player can use portals again
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
    this.occupied.clear(); // Map now, but clear() works the same
    this.trails = { 1: [], 2: [] };
    this.winner = null;

    // Reset player round state
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (player) {
        player.alive = true;
        player.inputQueue = null;
        player.portalCooldown = 0;
      }
    }
    
    // Generate new portal positions for this round
    this.generatePortals();
  }

  /**
   * Generates random portal pair positions for the round.
   * Each pair has two portals (a and b) with exit directions facing away from center.
   */
  generatePortals() {
    this.portals = [];
    
    // Player starting positions to avoid
    const p1Start = { x: 10, y: Math.floor(this.gridHeight / 2) };
    const p2Start = { x: this.gridWidth - 11, y: Math.floor(this.gridHeight / 2) };
    
    for (let i = 0; i < PORTAL_COUNT; i++) {
      let attempts = 0;
      let portalPair = null;
      
      while (!portalPair && attempts < 100) {
        attempts++;
        
        // Generate portal A position
        const ax = PORTAL_EDGE_MARGIN + Math.floor(Math.random() * (this.gridWidth - 2 * PORTAL_EDGE_MARGIN));
        const ay = PORTAL_EDGE_MARGIN + Math.floor(Math.random() * (this.gridHeight - 2 * PORTAL_EDGE_MARGIN));
        
        // Generate portal B position
        const bx = PORTAL_EDGE_MARGIN + Math.floor(Math.random() * (this.gridWidth - 2 * PORTAL_EDGE_MARGIN));
        const by = PORTAL_EDGE_MARGIN + Math.floor(Math.random() * (this.gridHeight - 2 * PORTAL_EDGE_MARGIN));
        
        // Check distance between portals
        const dist = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
        if (dist < PORTAL_MIN_DISTANCE) continue;
        
        // Check distance from player starts
        const distA1 = Math.sqrt((ax - p1Start.x) ** 2 + (ay - p1Start.y) ** 2);
        const distA2 = Math.sqrt((ax - p2Start.x) ** 2 + (ay - p2Start.y) ** 2);
        const distB1 = Math.sqrt((bx - p1Start.x) ** 2 + (by - p1Start.y) ** 2);
        const distB2 = Math.sqrt((bx - p2Start.x) ** 2 + (by - p2Start.y) ** 2);
        
        if (distA1 < PORTAL_PLAYER_MARGIN || distA2 < PORTAL_PLAYER_MARGIN ||
            distB1 < PORTAL_PLAYER_MARGIN || distB2 < PORTAL_PLAYER_MARGIN) {
          continue;
        }
        
        // Check not overlapping with existing portals
        let overlaps = false;
        for (const existing of this.portals) {
          if ((existing.a.x === ax && existing.a.y === ay) ||
              (existing.b.x === ax && existing.b.y === ay) ||
              (existing.a.x === bx && existing.a.y === by) ||
              (existing.b.x === bx && existing.b.y === by)) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;
        
        // Calculate exit directions (face away from board center)
        const centerX = this.gridWidth / 2;
        const centerY = this.gridHeight / 2;
        
        portalPair = {
          a: {
            x: ax,
            y: ay,
            exitDir: this.getExitDirection(ax, ay, centerX, centerY),
          },
          b: {
            x: bx,
            y: by,
            exitDir: this.getExitDirection(bx, by, centerX, centerY),
          },
        };
      }
      
      if (portalPair) {
        this.portals.push(portalPair);
        console.log(`[Portals] Generated pair: A(${portalPair.a.x},${portalPair.a.y}) <-> B(${portalPair.b.x},${portalPair.b.y})`);
      }
    }
  }

  /**
   * Determines exit direction facing away from a reference point (usually board center).
   * @param {number} x - Portal X position
   * @param {number} y - Portal Y position  
   * @param {number} refX - Reference X (center)
   * @param {number} refY - Reference Y (center)
   * @returns {string} - Direction: UP, DOWN, LEFT, or RIGHT
   */
  getExitDirection(x, y, refX, refY) {
    const dx = x - refX;
    const dy = y - refY;
    
    // Choose the dominant axis direction away from center
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? "RIGHT" : "LEFT";
    } else {
      return dy > 0 ? "DOWN" : "UP";
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
    const teleported = { 1: false, 2: false }; // Track who teleported this tick
    
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      // Decrement portal cooldown
      if (player.portalCooldown > 0) {
        player.portalCooldown--;
      }

      const vec = DIR_VECTORS[player.dir];
      nextPositions[id] = {
        x: player.x + vec.x,
        y: player.y + vec.y,
      };
    }

    // -------------------------------------------------------------------------
    // STEP 2.5: Check for portal teleportation
    // If player's next position is a portal and they're not on cooldown,
    // teleport them to the linked portal and apply cooldown
    // -------------------------------------------------------------------------
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;
      if (player.portalCooldown > 0) continue; // Can't use portal while on cooldown

      const next = nextPositions[id];
      
      // Check if next position is a portal
      for (const portalPair of this.portals) {
        let exitPortal = null;
        
        if (next.x === portalPair.a.x && next.y === portalPair.a.y) {
          // Entering portal A, exit at B
          exitPortal = portalPair.b;
        } else if (next.x === portalPair.b.x && next.y === portalPair.b.y) {
          // Entering portal B, exit at A
          exitPortal = portalPair.a;
        }
        
        if (exitPortal) {
          // Teleport: change next position to exit portal
          nextPositions[id] = {
            x: exitPortal.x,
            y: exitPortal.y,
          };
          
          // Change player direction to exit direction
          player.dir = exitPortal.exitDir;
          
          // Apply cooldown to prevent immediate re-entry
          player.portalCooldown = PORTAL_COOLDOWN_TICKS;
          
          teleported[id] = true;
          
          console.log(`[Portal] Player ${id} teleported to (${exitPortal.x},${exitPortal.y}) facing ${exitPortal.exitDir}`);
          break; // Only one teleport per tick
        }
      }
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

      // Check trail collision (O(1) lookup via Map)
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

      // Add current position to trail and occupied map BEFORE moving
      // Include spawnTick for client-side fade timing
      const trailCell = { x: player.x, y: player.y, spawnTick: this.tick };
      const key = `${player.x},${player.y}`;

      this.occupied.set(key, this.tick); // Map: key -> spawnTick
      this.trails[id].push(trailCell);
      trailsDelta[id] = trailCell;

      // Move to next position
      const next = nextPositions[id];
      player.x = next.x;
      player.y = next.y;
    }

    // -------------------------------------------------------------------------
    // STEP 5.5: Expire old trail segments (remove from collision after total lifetime)
    // -------------------------------------------------------------------------
    this.expireOldTrailSegments();

    // -------------------------------------------------------------------------
    // STEP 6: Broadcast state
    // -------------------------------------------------------------------------
    this.tick++;

    // Determine if we should send full trails (every FULL_SYNC_INTERVAL ticks)
    const sendFull = this.tick % FULL_SYNC_INTERVAL === 0;
    this.broadcastState(sendFull, trailsDelta);
  }

  // ==========================================================================
  // TRAIL EXPIRATION
  // Removes segments from collision map and trail arrays after total lifetime
  // ==========================================================================

  /**
   * Removes trail segments that have exceeded their total lifetime.
   * Called every tick to ensure expired segments no longer cause collisions.
   * Uses efficient O(n) scan of trails array (already sorted by spawnTick).
   */
  expireOldTrailSegments() {
    const expirationTick = this.tick - TRAIL_TOTAL_TICKS;
    
    for (const id of [1, 2]) {
      const trail = this.trails[id];
      let expiredCount = 0;
      
      // Trails are in chronological order, so scan from front
      // Count how many segments have expired
      while (expiredCount < trail.length && trail[expiredCount].spawnTick <= expirationTick) {
        const segment = trail[expiredCount];
        const key = `${segment.x},${segment.y}`;
        
        // Only remove from occupied if this segment owns the cell
        // (handles edge case of player crossing their own old trail position)
        if (this.occupied.get(key) === segment.spawnTick) {
          this.occupied.delete(key);
        }
        expiredCount++;
      }
      
      // Remove expired segments from front of array
      if (expiredCount > 0) {
        this.trails[id] = trail.slice(expiredCount);
      }
    }
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
      // Trail fade timing constants (clients need these for visual sync)
      trailTiming: {
        tickInterval: TICK_INTERVAL,
        solidMs: TRAIL_SOLID_MS,
        fadeMs: TRAIL_FADE_MS,
      },
      // Portal positions for client rendering
      portals: this.portals,
    };

    // Add trail data (now includes spawnTick per segment)
    if (sendFullTrails || this.tick === 0) {
      // Full trail sync - segments already contain {x, y, spawnTick}
      msg.trailsFull = {
        1: [...this.trails[1]],
        2: [...this.trails[2]],
      };
    } else if (trailsDelta) {
      // Delta only - segments contain {x, y, spawnTick}
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
