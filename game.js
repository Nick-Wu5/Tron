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

// =============================================================================
// PROXIMITY SPEED-UP CONFIGURATION
// When a player is close to any trail, they move faster (risk-reward tension)
// Server-authoritative: speed computed on server, client just renders result
// =============================================================================
const PROXIMITY_DISTANCE = 2; // Manhattan distance to trigger boost (2 = within 2 cells)
const BOOSTED_SPEED = 2; // Cells per tick when boosted (normal = 1)
const NECK_EXCLUSION_COUNT = 3; // Exclude last N cells of own trail (the "neck")
const DEBUG_SPEEDUP = true; // Enable speedup diagnostics (set false for production)

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
        player.boosted = false; // Proximity speed-up state
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
    const p2Start = {
      x: this.gridWidth - 11,
      y: Math.floor(this.gridHeight / 2),
    };

    for (let i = 0; i < PORTAL_COUNT; i++) {
      let attempts = 0;
      let portalPair = null;

      while (!portalPair && attempts < 100) {
        attempts++;

        // Generate portal A position
        const ax =
          PORTAL_EDGE_MARGIN +
          Math.floor(Math.random() * (this.gridWidth - 2 * PORTAL_EDGE_MARGIN));
        const ay =
          PORTAL_EDGE_MARGIN +
          Math.floor(
            Math.random() * (this.gridHeight - 2 * PORTAL_EDGE_MARGIN)
          );

        // Generate portal B position
        const bx =
          PORTAL_EDGE_MARGIN +
          Math.floor(Math.random() * (this.gridWidth - 2 * PORTAL_EDGE_MARGIN));
        const by =
          PORTAL_EDGE_MARGIN +
          Math.floor(
            Math.random() * (this.gridHeight - 2 * PORTAL_EDGE_MARGIN)
          );

        // Check distance between portals
        const dist = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
        if (dist < PORTAL_MIN_DISTANCE) continue;

        // Check distance from player starts
        const distA1 = Math.sqrt((ax - p1Start.x) ** 2 + (ay - p1Start.y) ** 2);
        const distA2 = Math.sqrt((ax - p2Start.x) ** 2 + (ay - p2Start.y) ** 2);
        const distB1 = Math.sqrt((bx - p1Start.x) ** 2 + (by - p1Start.y) ** 2);
        const distB2 = Math.sqrt((bx - p2Start.x) ** 2 + (by - p2Start.y) ** 2);

        if (
          distA1 < PORTAL_PLAYER_MARGIN ||
          distA2 < PORTAL_PLAYER_MARGIN ||
          distB1 < PORTAL_PLAYER_MARGIN ||
          distB2 < PORTAL_PLAYER_MARGIN
        ) {
          continue;
        }

        // Check not overlapping with existing portals
        let overlaps = false;
        for (const existing of this.portals) {
          if (
            (existing.a.x === ax && existing.a.y === ay) ||
            (existing.b.x === ax && existing.b.y === ay) ||
            (existing.a.x === bx && existing.a.y === by) ||
            (existing.b.x === bx && existing.b.y === by)
          ) {
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
        console.log(
          `[Portals] Generated pair: A(${portalPair.a.x},${portalPair.a.y}) <-> B(${portalPair.b.x},${portalPair.b.y})`
        );
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

  // ==========================================================================
  // PROXIMITY SPEED-UP HELPER
  // Checks if player is near ANY trail (opponent OR own, excluding "neck")
  // The "neck" is the most recent trail cells directly behind the player
  // ==========================================================================

  /**
   * Checks if a player is near any trail cell (opponent's OR own older trail).
   * We exclude the player's "neck" (last N cells) because:
   * - The neck is always adjacent (would make boost always-on)
   * - But older own trail CAN trigger boost (risky self-loops rewarded)
   * @param {Object} player - Player object with id, x, y
   * @returns {boolean} - True if within PROXIMITY_DISTANCE of triggering trail
   */
  isNearTrail(player) {
    const px = player.x;
    const py = player.y;
    const playerId = player.id;

    // Build a set of the player's "neck" cells to exclude (last N trail cells)
    // These are too recent and would always trigger boost
    const neckSet = new Set();
    const ownTrail = this.trails[playerId];
    const neckStart = Math.max(0, ownTrail.length - NECK_EXCLUSION_COUNT);
    for (let i = neckStart; i < ownTrail.length; i++) {
      neckSet.add(`${ownTrail[i].x},${ownTrail[i].y}`);
    }

    // Check all cells within Manhattan distance
    for (let dx = -PROXIMITY_DISTANCE; dx <= PROXIMITY_DISTANCE; dx++) {
      for (let dy = -PROXIMITY_DISTANCE; dy <= PROXIMITY_DISTANCE; dy++) {
        // Skip if Manhattan distance exceeds threshold
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist > PROXIMITY_DISTANCE || dist === 0) continue;

        const checkX = px + dx;
        const checkY = py + dy;
        const key = `${checkX},${checkY}`;

        // Skip if this is the player's "neck" (recent trail)
        if (neckSet.has(key)) continue;

        // Check if this cell is occupied (any trail - own older OR opponent)
        if (this.occupied.has(key)) {
          return true;
        }
      }
    }

    return false;
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
    // STEP 2: Compute proposed positions with PROXIMITY SPEED-UP
    // If player is near a trail, they move BOOSTED_SPEED cells instead of 1
    // -------------------------------------------------------------------------
    const nextPositions = {};
    const teleported = { 1: false, 2: false }; // Track who teleported this tick
    const playerSpeed = { 1: 1, 2: 1 }; // Track speed for collision checking
    const movementPath = { 1: [], 2: [] }; // All cells traversed this tick

    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      // Decrement portal cooldown
      if (player.portalCooldown > 0) {
        player.portalCooldown--;
      }

      // Check proximity for speed boost (server-authoritative)
      const isBoosted = this.isNearTrail(player);
      const speed = isBoosted ? BOOSTED_SPEED : 1;
      playerSpeed[id] = speed;

      // DEBUG: Log speedup diagnostics (rate-limited to every 20 ticks)
      if (DEBUG_SPEEDUP && (this.tick % 20 === 0 || isBoosted)) {
        const ownTrailLen = this.trails[id]?.length || 0;
        const oppTrailLen = this.trails[id === 1 ? 2 : 1]?.length || 0;
        console.log(
          `[SPEEDUP T${this.tick}] P${id} pos=(${player.x},${player.y}) ` +
            `boosted=${isBoosted} speed=${speed} ownTrail=${ownTrailLen} oppTrail=${oppTrailLen}`
        );
      }

      const vec = DIR_VECTORS[player.dir];

      // Compute all intermediate positions for collision checking
      // When boosted, we move multiple cells and must check each one
      let currentX = player.x;
      let currentY = player.y;

      for (let step = 1; step <= speed; step++) {
        currentX += vec.x;
        currentY += vec.y;
        movementPath[id].push({ x: currentX, y: currentY, step });
      }

      // Final position is the last cell in the path
      nextPositions[id] = {
        x: currentX,
        y: currentY,
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

          console.log(
            `[Portal] Player ${id} teleported to (${exitPortal.x},${exitPortal.y}) facing ${exitPortal.exitDir}`
          );
          break; // Only one teleport per tick
        }
      }
    }

    // -------------------------------------------------------------------------
    // STEP 3: Resolve collisions (check ALL cells in movement path)
    // For boosted movement, collision at ANY intermediate step kills player
    // -------------------------------------------------------------------------
    const deaths = { 1: false, 2: false };
    const deathStep = { 1: -1, 2: -1 }; // Which step caused death (for trail truncation)

    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      const path = movementPath[id];

      // Check each cell in the movement path
      for (const pos of path) {
        // Check wall collision
        if (
          pos.x < 0 ||
          pos.x >= this.gridWidth ||
          pos.y < 0 ||
          pos.y >= this.gridHeight
        ) {
          deaths[id] = true;
          deathStep[id] = pos.step;
          break;
        }

        // Check trail collision (O(1) lookup via Map)
        const key = `${pos.x},${pos.y}`;
        if (this.occupied.has(key)) {
          deaths[id] = true;
          deathStep[id] = pos.step;
          break;
        }
      }
    }

    // Head-on collision check: check if movement paths intersect
    // With boosted movement, we check ALL cells in both paths for overlap
    if (
      !deaths[1] &&
      !deaths[2] &&
      this.players[1]?.alive &&
      this.players[2]?.alive
    ) {
      const path1 = movementPath[1];
      const path2 = movementPath[2];

      // Check if any cell in path1 is also in path2
      const path2Set = new Set(path2.map((p) => `${p.x},${p.y}`));
      for (const pos of path1) {
        if (path2Set.has(`${pos.x},${pos.y}`)) {
          console.log(
            `[Tick ${this.tick}] Head-on collision at (${pos.x},${pos.y})`
          );
          deaths[1] = true;
          deaths[2] = true;
          break;
        }
      }
    }

    // Pass-through collision check: players swap positions (crossing paths)
    // With boosted movement, check if P1's start is in P2's path AND vice versa
    if (
      !deaths[1] &&
      !deaths[2] &&
      this.players[1]?.alive &&
      this.players[2]?.alive
    ) {
      const p1 = this.players[1];
      const p2 = this.players[2];
      const path1 = movementPath[1];
      const path2 = movementPath[2];

      // Check if P1's start position is in P2's path
      const p1StartInP2Path = path2.some(
        (pos) => pos.x === p1.x && pos.y === p1.y
      );
      // Check if P2's start position is in P1's path
      const p2StartInP1Path = path1.some(
        (pos) => pos.x === p2.x && pos.y === p2.y
      );

      if (p1StartInP2Path && p2StartInP1Path) {
        // They're crossing through each other - treat as head-on collision
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
    // For boosted movement, add ALL intermediate cells to trail
    // -------------------------------------------------------------------------
    for (const id of [1, 2]) {
      const player = this.players[id];
      if (!player || !player.alive) continue;

      const path = movementPath[id];
      const trailCells = []; // All new trail cells this tick

      // Add current (starting) position to trail first
      const startCell = { x: player.x, y: player.y, spawnTick: this.tick };
      const startKey = `${player.x},${player.y}`;
      this.occupied.set(startKey, this.tick);
      this.trails[id].push(startCell);
      trailCells.push(startCell);

      // For boosted movement, add intermediate cells to trail too
      // (but not the final position - player will be there)
      if (path.length > 1) {
        for (let i = 0; i < path.length - 1; i++) {
          const pos = path[i];
          const cell = { x: pos.x, y: pos.y, spawnTick: this.tick };
          const key = `${pos.x},${pos.y}`;
          this.occupied.set(key, this.tick);
          this.trails[id].push(cell);
          trailCells.push(cell);
        }
      }

      // Store all trail cells added this tick (may be multiple if boosted)
      trailsDelta[id] = trailCells.length === 1 ? trailCells[0] : trailCells;

      // Move to final position
      const next = nextPositions[id];
      player.x = next.x;
      player.y = next.y;

      // Store current speed for client rendering
      player.boosted = playerSpeed[id] > 1;
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
      while (
        expiredCount < trail.length &&
        trail[expiredCount].spawnTick <= expirationTick
      ) {
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
          boosted: player.boosted || false, // Proximity speed-up indicator
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
