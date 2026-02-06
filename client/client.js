/**
 * TRON Lightcycles - Three.js Client
 *
 * Connects to the authoritative game server via WebSocket and renders
 * the game state in 3D using Three.js. No client-side game logic.
 *
 * Features:
 * - Procedural lightcycle bike meshes
 * - Futuristic background environment (starfield + horizon grid)
 * - Neon aesthetic with glowing trails
 */

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

// WebSocket URL: use wss:// for HTTPS (Render), ws:// for HTTP (local dev)
const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = `${WS_PROTOCOL}//${window.location.host}`;

// =============================================================================
// BACKGROUND MUSIC CONFIGURATION
// MP3 file is in the client folder alongside other assets
// =============================================================================
const BGM_PATH = "tron-background-music.mp3";
const BGM_VOLUME = 0.2; // Low default volume
const BGM_STORAGE_KEY = "tron_music_enabled";

// =============================================================================
// VISUAL CONSTANTS - TRON NEON AESTHETIC
// =============================================================================

// Board/background contrast - Board is lighter to stand out from dark background
// Overall lighting brightness adjustment - board colors lifted for cleaner look
const BOARD_COLOR = 0x1a1a2a; // Medium gray-blue - clearly readable
const BOARD_EMISSIVE = 0x1a1a30; // Subtle self-illumination
const GRID_COLOR = 0x3a3a5a; // Brighter grid lines for visibility
const WALL_COLOR = 0x4a4a6a; // Lighter frame color
const WALL_EMISSIVE = 0x6666cc; // Stronger glow for borders

// Player 1: Cyan / Electric Blue
const P1_COLOR = 0x00ffff;
const P1_EMISSIVE = 0x00ccff;
const P1_TRAIL_COLOR = 0x00ddff;
// Bike material contrast - lighter gray base for visibility against board
const P1_DARK = 0x556677; // Medium-light gray with cool tint

// Player 2: Orange / Hot Magenta
const P2_COLOR = 0xff6600;
const P2_EMISSIVE = 0xff4400;
const P2_TRAIL_COLOR = 0xff5500;
// Bike material contrast - lighter gray base for visibility against board
const P2_DARK = 0x665544; // Medium-light gray with warm tint

// Geometry sizes
// Bike scale tweak - bikes are prominently larger than trails
const BIKE_SCALE = 3.5;
// Note: Trail dimensions are defined in  the TRAIL SEGMENTS section

// Background (digital void) visibility - visible but darker than board
const BG_COLOR = 0x080812; // Lifted from pure black so void is visible
const HORIZON_GRID_COLOR = 0x1a1a40; // Slightly brighter for visibility
const STAR_COUNT = 1200; // More stars for visible digital void

// =============================================================================
// STATE
// =============================================================================

let ws = null;
let myPlayerId = null;
let gridSize = { w: 80, h: 60 };
let gameStatus = "waiting";
let lastTick = -1;
let myReadyState = false;

// =============================================================================
// TRAIL FADING STATE
// Timing synced from server, used for client-side visual fade
// =============================================================================
let trailTiming = {
  tickInterval: 50, // ms per tick (default, updated from server)
  solidMs: 2000, // ms segment stays fully visible
  fadeMs: 1000, // ms segment takes to fade out
};
let serverTickOffset = 0; // performance.now() at tick 0 (for local time sync)

// Three.js objects
let scene, camera, renderer, clock;
let playerBikes = {}; // Lightcycle meshes per player
let playerLights = {}; // Point lights for bikes
let playerDirections = {}; // Current direction per player
let trailMeshes = { 1: new Map(), 2: new Map() };

// Visual state
let ambientLight, mainLight;
let arenaGroup;
let backgroundGroup; // Background elements
let starField; // Starfield points

// =============================================================================
// GAME OVER OVERLAY DELAY
// GameOver overlay delay to showcase explosion - delay the banner so users see death
// =============================================================================
const GAMEOVER_OVERLAY_DELAY_MS = 1000; // 1 second delay before showing winner banner
let gameOverAtMs = null; // Timestamp when gameOver was first detected
let pendingGameOverMsg = null; // Store the message to display after delay

// =============================================================================
// PORTAL STATE
// Teleportation portals rendered as glowing rings on the board
// =============================================================================
let portalMeshes = []; // Array of portal mesh groups
let portalData = []; // Server-provided portal positions

// =============================================================================
// BOOST VISUAL EFFECTS STATE
// Dramatic visual feedback when player is near opponent's trail
// =============================================================================
let boostAuras = {}; // Glowing aura meshes per player
let boostParticles = {}; // Speed particle systems per player

// Pedestal: placement + visibility - board surface Y coordinate
// Used for positioning trails and bikes above the raised board
const BOARD_SURFACE_Y = 0.5; // Board thickness, top surface is at this Y

// =============================================================================
// COUNTDOWN DROP-IN ANIMATION STATE
// Bikes descend from above during countdown phase
// =============================================================================
const DROP_START_Y = BOARD_SURFACE_Y + 15; // Start position (high above board)
const DROP_REST_Y = BOARD_SURFACE_Y; // Landing position (board surface)
const DROP_DURATION_MS = 800; // Quick drop when game starts (not during countdown)

// Animation state per player
let dropAnimation = {
  active: false,
  startTime: 0,
  // Track previous status to detect transitions
  previousStatus: "waiting",
  // DEBUG: For logging animation progress
  lastLoggedProgress: -1,
};

// Landing glow meshes (optional visual effect)
let landingGlows = {};

// =============================================================================
// TRON-STYLE EXPLOSION STATE
// Energy discharge effect when a player dies
// =============================================================================
let activeExplosions = []; // Array of active explosion objects

// =============================================================================
// BACKGROUND MUSIC STATE
// =============================================================================
let bgm = null; // Audio element (created on first user interaction)
let musicEnabled = false; // Current playback state
let musicInitialized = false; // Has user enabled music at least once?

// =============================================================================
// DOM ELEMENTS
// =============================================================================

const joinScreen = document.getElementById("join-screen");
const connectionStatus = document.getElementById("connection-status");
const gameHud = document.getElementById("game-hud");
const playerLabel = document.getElementById("player-label");
const gameStatusEl = document.getElementById("game-status");
const scoreP1 = document.getElementById("score-p1");
const scoreP2 = document.getElementById("score-p2");
const readyPanel = document.getElementById("ready-panel");
const readyP1 = document.getElementById("ready-p1");
const readyP2 = document.getElementById("ready-p2");
const startBtn = document.getElementById("start-btn");
const countdownOverlay = document.getElementById("countdown-overlay");
const countdownText = document.getElementById("countdown-text");
const gameoverOverlay = document.getElementById("gameover-overlay");
const winnerText = document.getElementById("winner-text");
const musicToggle = document.getElementById("music-toggle");
const musicIcon = document.getElementById("music-icon");

// Boost indicator (DEBUG)
const boostIndicator = document.getElementById("boost-indicator");
const boostP1 = document.getElementById("boost-p1");
const boostP2 = document.getElementById("boost-p2");
const musicLabel = document.getElementById("music-label");

// =============================================================================
// COORDINATE MAPPING
// =============================================================================

function gridToWorld(x, y) {
  return {
    x: x - gridSize.w / 2 + 0.5,
    z: y - gridSize.h / 2 + 0.5,
  };
}

// =============================================================================
// BACKGROUND MUSIC
// Handles looping background music with autoplay restriction compliance
// =============================================================================

/**
 * Initialize the background music audio element.
 * Called once on first user interaction to comply with autoplay restrictions.
 */
function initBackgroundMusic() {
  if (bgm) return; // Already initialized

  bgm = new Audio(BGM_PATH);
  bgm.loop = true;
  bgm.volume = BGM_VOLUME;
  bgm.preload = "auto";

  // Handle loading errors gracefully
  bgm.addEventListener("error", (e) => {
    console.warn("Background music failed to load:", e);
  });

  // Log when ready to play
  bgm.addEventListener("canplaythrough", () => {
    console.log("Background music loaded and ready");
    // If music should be playing, start it now that it's loaded
    if (musicEnabled && bgm.paused) {
      bgm.play().catch(() => {});
    }
  });

  musicInitialized = true;
  console.log("Background music initialized, loading...");
}

/**
 * Start playing background music.
 * Handles play() promise rejection gracefully.
 */
function startMusic() {
  if (!bgm) {
    initBackgroundMusic();
  }

  if (!bgm) return;

  // Try to play immediately
  const playPromise = bgm.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        console.log("Music started playing");
      })
      .catch((err) => {
        console.log("Music playback issue:", err.message);
      });
  }
}

/**
 * Stop/pause background music.
 */
function stopMusic() {
  if (!bgm) return;
  bgm.pause();
  console.log("Music paused");
}

/**
 * Toggle music on/off. Initializes audio on first enable.
 */
function toggleMusic() {
  musicEnabled = !musicEnabled;

  // Update UI immediately
  updateMusicUI();

  // Start or stop playback
  if (musicEnabled) {
    startMusic();
  } else {
    stopMusic();
  }

  // Persist preference
  localStorage.setItem(BGM_STORAGE_KEY, musicEnabled ? "true" : "false");
}

/**
 * Update the music toggle button UI to reflect current state.
 */
function updateMusicUI() {
  if (!musicToggle) return;

  if (musicEnabled) {
    musicToggle.classList.add("playing");
    musicIcon.textContent = "🔊";
  } else {
    musicToggle.classList.remove("playing");
    musicIcon.textContent = "🔇";
  }
}

/**
 * Load music preference from localStorage and update UI.
 * Does NOT auto-start playback (requires user gesture).
 */
function loadMusicPreference() {
  const stored = localStorage.getItem(BGM_STORAGE_KEY);
  if (stored === "true") {
    // Show UI as enabled, but actual playback starts on first interaction
    musicEnabled = true;
    updateMusicUI();
  }
}

// Setup music toggle button click handler
if (musicToggle) {
  musicToggle.addEventListener("click", toggleMusic);
}

// Load preference on startup (UI only, no autoplay)
loadMusicPreference();

// Start music on first user interaction anywhere if preference was enabled
document.addEventListener(
  "click",
  function startMusicOnFirstClick() {
    if (musicEnabled && !musicInitialized) {
      startMusic();
    }
    // Remove this listener after first click
    document.removeEventListener("click", startMusicOnFirstClick);
  },
  { once: true }
);

// =============================================================================
// THREE.JS SETUP
// =============================================================================

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);
  // Depth separation (fog/exposure) - very light fog preserves background visibility
  // Fog density reduced so city buildings remain visible at distance
  scene.fog = new THREE.FogExp2(BG_COLOR, 0.002);

  clock = new THREE.Clock();

  // =========================================================================
  // Camera framing adjustment - Full board visible with negative space
  // Farther back and higher to create an observational, exhibition-like feel
  // The entire board is fully visible at all times with surrounding space
  // =========================================================================
  camera = new THREE.PerspectiveCamera(
    48, // Moderate FOV avoids distortion while showing full board
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  // Pulled far back: full board visible with comfortable negative space around it
  camera.position.set(0, 95, 85);
  camera.lookAt(0, 0, 0);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Depth separation (fog/exposure) - increased exposure for readable scene
  // Higher exposure ensures pedestal and buildings are visible
  renderer.toneMappingExposure = 1.6;
  document.body.insertBefore(renderer.domElement, document.body.firstChild);

  // =========================================================================
  // LIGHTING - Rebalanced for brightness and readability
  // Goal: Futuristic, clean, luminous - clearly readable board and pedestal
  // =========================================================================

  // Ambient light rebalance - significantly lifted to illuminate entire scene
  // Bright cool tone for clean futuristic feel
  ambientLight = new THREE.AmbientLight(0x6677aa, 0.75);
  scene.add(ambientLight);

  // Hemisphere light - soft sky/ground fill for natural depth
  // Sky color (top) is brighter, ground color (bottom) illuminates pedestal
  const hemiLight = new THREE.HemisphereLight(0x8899cc, 0x334466, 0.6);
  hemiLight.position.set(0, 50, 0);
  scene.add(hemiLight);

  // Key light tuning - main directional light for board illumination
  // Brighter and positioned for even board coverage
  mainLight = new THREE.DirectionalLight(0xaabbdd, 1.4);
  mainLight.position.set(0, 100, 30);
  scene.add(mainLight);

  // Secondary fill light - lifts shadows, illuminates pedestal from below
  const fillLight = new THREE.DirectionalLight(0x5577bb, 0.5);
  fillLight.position.set(0, -30, 0);
  scene.add(fillLight);

  // Overhead accent light - clean highlight on board center
  const overheadLight = new THREE.DirectionalLight(0xccddee, 0.5);
  overheadLight.position.set(0, 120, -20);
  scene.add(overheadLight);

  // =========================================================================
  // Pedestal: reveal light - dedicated lighting to make pedestal visible
  // Multiple lights from different angles create rim/edge highlights
  // =========================================================================

  // Primary pedestal light - from below/side to illuminate the tapered body
  const pedestalLight = new THREE.PointLight(0x7799cc, 2.5, 80);
  pedestalLight.position.set(0, -15, 25);
  scene.add(pedestalLight);

  // Secondary pedestal rim light - creates edge highlight from opposite side
  const pedestalRimLight = new THREE.PointLight(0x5588bb, 2.0, 70);
  pedestalRimLight.position.set(15, -10, -20);
  scene.add(pedestalRimLight);

  // Third pedestal light - fills from the other side
  const pedestalFillLight = new THREE.PointLight(0x6688aa, 1.5, 60);
  pedestalFillLight.position.set(-15, -12, 0);
  scene.add(pedestalFillLight);

  // =========================================================================
  // Background city: visibility tuning - dedicated light for buildings
  // Low intensity directional light aimed at the background perimeter
  // =========================================================================

  // Background fill light - illuminates distant buildings
  const bgLight = new THREE.DirectionalLight(0x334466, 0.8);
  bgLight.position.set(0, 30, 150);
  scene.add(bgLight);

  // Opposite side background light
  const bgLight2 = new THREE.DirectionalLight(0x334455, 0.6);
  bgLight2.position.set(0, 20, -150);
  scene.add(bgLight2);

  // =========================================================================
  // CREATE BACKGROUND FIRST (behind everything)
  // =========================================================================
  createBackground();

  // Handle resize
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();
}

// =============================================================================
// PART 2: FUTURISTIC BACKGROUND
// =============================================================================

function createBackground() {
  backgroundGroup = new THREE.Group();
  backgroundGroup.name = "background";

  // =========================================================================
  // OPTION A: INFINITE HORIZON GRID
  // Background (digital void) visibility - visible horizon grid below
  // =========================================================================

  const horizonSize = 400;
  const horizonY = -8; // Lower to not compete with pedestal

  // Horizon plane - subtle but visible
  const horizonGeom = new THREE.PlaneGeometry(horizonSize, horizonSize);
  const horizonMat = new THREE.MeshBasicMaterial({
    color: 0x0a0a18, // Slightly lighter so it's visible
    transparent: true,
    opacity: 0.8,
  });
  const horizonPlane = new THREE.Mesh(horizonGeom, horizonMat);
  horizonPlane.rotation.x = -Math.PI / 2;
  horizonPlane.position.y = horizonY;
  backgroundGroup.add(horizonPlane);

  // Grid lines on horizon - brighter for visible digital void effect
  const gridSpacing = 10;
  const gridLineMat = new THREE.LineBasicMaterial({
    color: HORIZON_GRID_COLOR,
    transparent: true,
    opacity: 0.35, // More visible grid
  });

  // Create grid lines
  for (let i = -horizonSize / 2; i <= horizonSize / 2; i += gridSpacing) {
    // Horizontal lines (along X)
    const hPoints = [
      new THREE.Vector3(-horizonSize / 2, horizonY + 0.01, i),
      new THREE.Vector3(horizonSize / 2, horizonY + 0.01, i),
    ];
    const hGeom = new THREE.BufferGeometry().setFromPoints(hPoints);
    const hLine = new THREE.Line(hGeom, gridLineMat);
    backgroundGroup.add(hLine);

    // Vertical lines (along Z)
    const vPoints = [
      new THREE.Vector3(i, horizonY + 0.01, -horizonSize / 2),
      new THREE.Vector3(i, horizonY + 0.01, horizonSize / 2),
    ];
    const vGeom = new THREE.BufferGeometry().setFromPoints(vPoints);
    const vLine = new THREE.Line(vGeom, gridLineMat);
    backgroundGroup.add(vLine);
  }

  // =========================================================================
  // OPTION B: ABSTRACT CITY SILHOUETTES
  // Background city: visibility tuning - visible building shapes with emissive edges
  // =========================================================================

  // Background city: visibility tuning - buildings use StandardMaterial for lighting
  const buildingMat = new THREE.MeshStandardMaterial({
    color: 0x181828, // Dark blue-gray body
    emissive: 0x0a0a18, // Subtle self-illumination
    emissiveIntensity: 0.3,
    roughness: 0.8,
    metalness: 0.2,
  });

  // Background city: visibility tuning - STRONG emissive edges for silhouette
  const buildingEdgeMat = new THREE.MeshStandardMaterial({
    color: 0x2244aa,
    emissive: 0x4466dd, // Strong blue glow for edge visibility
    emissiveIntensity: 1.2, // High intensity so edges are clearly visible
    roughness: 0.2,
    metalness: 0.5,
  });

  // Background city: visibility tuning - window accent material
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x3355bb,
    emissive: 0x4477cc, // Glowing windows
    emissiveIntensity: 0.8,
    roughness: 0.3,
    metalness: 0.4,
  });

  // Create buildings around the perimeter - closer and more visible
  const buildingConfigs = [];
  const buildingDistance = 90; // Moved closer for better visibility

  // Background city: visibility tuning - more buildings at denser intervals
  for (let angle = 0; angle < Math.PI * 2; angle += 0.12) {
    const dist = buildingDistance + Math.random() * 50;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const width = 4 + Math.random() * 10;
    const height = 15 + Math.random() * 50; // Taller buildings
    const depth = 4 + Math.random() * 10;
    buildingConfigs.push({ x, z, width, height, depth });
  }

  buildingConfigs.forEach((cfg) => {
    const buildingGeom = new THREE.BoxGeometry(
      cfg.width,
      cfg.height,
      cfg.depth
    );
    const building = new THREE.Mesh(buildingGeom, buildingMat);
    building.position.set(cfg.x, cfg.height / 2 + horizonY, cfg.z);
    backgroundGroup.add(building);

    // Background city: visibility tuning - bright top edge glow
    const edgeGeom = new THREE.BoxGeometry(
      cfg.width + 0.4,
      0.5,
      cfg.depth + 0.4
    );
    const edge = new THREE.Mesh(edgeGeom, buildingEdgeMat);
    edge.position.set(cfg.x, cfg.height + horizonY + 0.25, cfg.z);
    backgroundGroup.add(edge);

    // Background city: visibility tuning - vertical edge strips on corners
    const stripHeight = cfg.height * 0.8;
    const stripGeom = new THREE.BoxGeometry(0.3, stripHeight, 0.3);
    const cornerOffsets = [
      [cfg.width / 2, cfg.depth / 2],
      [-cfg.width / 2, cfg.depth / 2],
      [cfg.width / 2, -cfg.depth / 2],
      [-cfg.width / 2, -cfg.depth / 2],
    ];
    cornerOffsets.forEach(([ox, oz]) => {
      const strip = new THREE.Mesh(stripGeom, buildingEdgeMat);
      strip.position.set(
        cfg.x + ox,
        stripHeight / 2 + horizonY + cfg.height * 0.1,
        cfg.z + oz
      );
      backgroundGroup.add(strip);
    });

    // Background city: visibility tuning - random window rows (emissive accents)
    if (Math.random() > 0.4) {
      const windowRows = Math.floor(2 + Math.random() * 4);
      for (let row = 0; row < windowRows; row++) {
        const windowY = horizonY + 5 + row * (cfg.height / windowRows) * 0.7;
        const windowGeom = new THREE.BoxGeometry(cfg.width * 0.6, 0.8, 0.2);
        const windowMesh = new THREE.Mesh(windowGeom, windowMat);
        windowMesh.position.set(cfg.x, windowY, cfg.z + cfg.depth / 2 + 0.1);
        backgroundGroup.add(windowMesh);
      }
    }
  });

  // =========================================================================
  // OPTION C: STARFIELD / DIGITAL VOID
  // Static points creating a subtle starry backdrop
  // =========================================================================

  const starGeometry = new THREE.BufferGeometry();
  const starPositions = new Float32Array(STAR_COUNT * 3);
  const starColors = new Float32Array(STAR_COUNT * 3);

  for (let i = 0; i < STAR_COUNT; i++) {
    // Distribute stars in a dome above
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.4; // Upper hemisphere only
    const radius = 150 + Math.random() * 200;

    starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = radius * Math.cos(phi) + 20; // Above scene
    starPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

    // Background (digital void) visibility - brighter star colors
    const colorChoice = Math.random();
    if (colorChoice < 0.5) {
      // Blue - brighter
      starColors[i * 3] = 0.4 + Math.random() * 0.4;
      starColors[i * 3 + 1] = 0.5 + Math.random() * 0.4;
      starColors[i * 3 + 2] = 0.9 + Math.random() * 0.1;
    } else if (colorChoice < 0.8) {
      // Cyan - brighter
      starColors[i * 3] = 0.3 + Math.random() * 0.4;
      starColors[i * 3 + 1] = 0.8 + Math.random() * 0.2;
      starColors[i * 3 + 2] = 0.9 + Math.random() * 0.1;
    } else {
      // Purple/Magenta - brighter
      starColors[i * 3] = 0.6 + Math.random() * 0.4;
      starColors[i * 3 + 1] = 0.3 + Math.random() * 0.3;
      starColors[i * 3 + 2] = 0.8 + Math.random() * 0.2;
    }
  }

  starGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(starPositions, 3)
  );
  starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3));

  // Background (digital void) visibility - brighter, larger stars
  const starMat = new THREE.PointsMaterial({
    size: 2.5, // Larger stars for visibility
    vertexColors: true,
    transparent: true,
    opacity: 0.9, // More opaque
    sizeAttenuation: true,
  });

  starField = new THREE.Points(starGeometry, starMat);
  backgroundGroup.add(starField);

  scene.add(backgroundGroup);
}

// =============================================================================
// ARENA CREATION
// =============================================================================

function createBoard() {
  if (arenaGroup) {
    scene.remove(arenaGroup);
  }

  arenaGroup = new THREE.Group();
  arenaGroup.name = "arena";

  // Board/background contrast - Board surface made lighter and more reflective
  // Pedestal: placement + visibility - board raised so pedestal is visible beneath
  const boardThickness = 0.5; // Thicker board for visual presence
  const boardGeom = new THREE.BoxGeometry(
    gridSize.w,
    boardThickness,
    gridSize.h
  );
  const boardMat = new THREE.MeshStandardMaterial({
    color: BOARD_COLOR,
    emissive: BOARD_EMISSIVE,
    emissiveIntensity: 0.25, // Slightly brighter self-illumination
    roughness: 0.5, // Receives light evenly
    metalness: 0.35,
  });
  const board = new THREE.Mesh(boardGeom, boardMat);
  // Pedestal: placement + visibility - board positioned higher to reveal pedestal
  board.position.y = boardThickness / 2; // Board sits at y=0 to y=0.5
  arenaGroup.add(board);

  // Grid lines - clearly visible against board surface
  // Pedestal: placement + visibility - grid lines raised to match new board top
  const boardTopY = boardThickness; // Board top surface Y coordinate
  const gridMat = new THREE.LineBasicMaterial({
    color: GRID_COLOR,
    transparent: true,
    opacity: 0.6, // Good visibility without overpowering
  });

  for (let i = 0; i <= gridSize.h; i += 5) {
    const points = [
      new THREE.Vector3(-gridSize.w / 2, boardTopY + 0.02, i - gridSize.h / 2),
      new THREE.Vector3(gridSize.w / 2, boardTopY + 0.02, i - gridSize.h / 2),
    ];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
    arenaGroup.add(new THREE.Line(lineGeom, gridMat));
  }

  for (let i = 0; i <= gridSize.w; i += 5) {
    const points = [
      new THREE.Vector3(i - gridSize.w / 2, boardTopY + 0.02, -gridSize.h / 2),
      new THREE.Vector3(i - gridSize.w / 2, boardTopY + 0.02, gridSize.h / 2),
    ];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
    arenaGroup.add(new THREE.Line(lineGeom, gridMat));
  }

  // =========================================================================
  // Minimalist glowing board border
  // Clean, low-profile frame with subtle emissive glow
  // Does not act as a wall - purely decorative framing element
  // =========================================================================

  // Border dimensions - thin and low-profile
  const borderHeight = 0.4;
  const borderWidth = 0.8;
  const borderInset = 0.1; // Slight inset from board edge

  // Border material - darker than board with subtle emissive accent
  const borderMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a15, // Darker than board surface
    emissive: 0x2244aa, // Subtle blue glow
    emissiveIntensity: 0.25, // Restrained - accent only
    roughness: 0.6,
    metalness: 0.4,
  });

  // Inner edge glow strip material - slightly brighter accent
  const edgeGlowMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2a,
    emissive: 0x3366cc,
    emissiveIntensity: 0.4,
    roughness: 0.3,
    metalness: 0.5,
  });

  // Create border segments (4 sides)
  const hw = gridSize.w / 2;
  const hh = gridSize.h / 2;

  const borderConfigs = [
    // Top border (negative Z)
    {
      w: gridSize.w + borderWidth * 2,
      d: borderWidth,
      x: 0,
      z: -hh - borderWidth / 2 + borderInset,
    },
    // Bottom border (positive Z)
    {
      w: gridSize.w + borderWidth * 2,
      d: borderWidth,
      x: 0,
      z: hh + borderWidth / 2 - borderInset,
    },
    // Left border (negative X)
    {
      w: borderWidth,
      d: gridSize.h,
      x: -hw - borderWidth / 2 + borderInset,
      z: 0,
    },
    // Right border (positive X)
    {
      w: borderWidth,
      d: gridSize.h,
      x: hw + borderWidth / 2 - borderInset,
      z: 0,
    },
  ];

  borderConfigs.forEach((cfg) => {
    const borderGeom = new THREE.BoxGeometry(cfg.w, borderHeight, cfg.d);
    const border = new THREE.Mesh(borderGeom, borderMat);
    // Pedestal: placement + visibility - borders raised to board top
    border.position.set(cfg.x, boardTopY + borderHeight / 2, cfg.z);
    arenaGroup.add(border);
  });

  // Inner edge glow strips - thin bright lines along the inner edge of border
  const stripHeight = 0.15;
  const stripWidth = 0.12;

  const stripConfigs = [
    // Top inner edge
    { w: gridSize.w, d: stripWidth, x: 0, z: -hh + stripWidth / 2 },
    // Bottom inner edge
    { w: gridSize.w, d: stripWidth, x: 0, z: hh - stripWidth / 2 },
    // Left inner edge
    {
      w: stripWidth,
      d: gridSize.h - stripWidth * 2,
      x: -hw + stripWidth / 2,
      z: 0,
    },
    // Right inner edge
    {
      w: stripWidth,
      d: gridSize.h - stripWidth * 2,
      x: hw - stripWidth / 2,
      z: 0,
    },
  ];

  stripConfigs.forEach((cfg) => {
    const stripGeom = new THREE.BoxGeometry(cfg.w, stripHeight, cfg.d);
    const strip = new THREE.Mesh(stripGeom, edgeGlowMat);
    // Pedestal: placement + visibility - strips raised to board top
    strip.position.set(cfg.x, boardTopY + stripHeight / 2 + 0.01, cfg.z);
    arenaGroup.add(strip);
  });

  // Corner accent pieces - small glowing details at each corner
  const cornerSize = 1.2;
  const cornerHeight = 0.25;
  const cornerMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2a,
    emissive: 0x4488dd,
    emissiveIntensity: 0.5,
    roughness: 0.3,
    metalness: 0.6,
  });

  const cornerPositions = [
    [-hw + cornerSize / 2, -hh + cornerSize / 2],
    [hw - cornerSize / 2, -hh + cornerSize / 2],
    [-hw + cornerSize / 2, hh - cornerSize / 2],
    [hw - cornerSize / 2, hh - cornerSize / 2],
  ];

  cornerPositions.forEach(([x, z]) => {
    const cornerGeom = new THREE.BoxGeometry(
      cornerSize,
      cornerHeight,
      cornerSize
    );
    const corner = new THREE.Mesh(cornerGeom, cornerMat);
    // Pedestal: placement + visibility - corners raised to board top
    corner.position.set(x, boardTopY + cornerHeight / 2 + 0.02, z);
    arenaGroup.add(corner);
  });

  // Corner lights - raised to match new board height
  const corners = [
    [-gridSize.w / 2, gridSize.h / 2],
    [gridSize.w / 2, gridSize.h / 2],
    [-gridSize.w / 2, -gridSize.h / 2],
    [gridSize.w / 2, -gridSize.h / 2],
  ];
  corners.forEach(([x, z]) => {
    const light = new THREE.PointLight(0x4444ff, 0.5, 15);
    light.position.set(x, boardTopY + 2, z);
    arenaGroup.add(light);
  });

  // =========================================================================
  // Tapered pedestal under board
  // Creates a physical, grounded feel like an exhibition piece
  // Only the upper portion is visible; it fades into the dark background below
  // =========================================================================
  createPedestal(arenaGroup);

  scene.add(arenaGroup);
}

// =============================================================================
// TAPERED PEDESTAL UNDER BOARD
// Creates a grounded, exhibition-piece feel for the tabletop arena
// =============================================================================

/**
 * Creates a tapered central pedestal beneath the board.
 * The pedestal is narrower at the top (where it meets the board),
 * wider through the midsection, and tapers as it descends.
 * Only the upper portion is visible from the camera angle.
 *
 * @param {THREE.Group} parentGroup - The arena group to add pedestal to
 */
function createPedestal(parentGroup) {
  const pedestalGroup = new THREE.Group();
  pedestalGroup.name = "pedestal";

  // Pedestal: placement + visibility - clean matte solid color
  // Simple dark gray-blue, no texture or shine
  const pedestalMat = new THREE.MeshStandardMaterial({
    color: 0x252535, // Solid dark gray-blue
    emissive: 0x000000, // No emissive - clean matte look
    emissiveIntensity: 0,
    roughness: 1.0, // Fully matte finish
    metalness: 0, // No metallic sheen
  });

  // Pedestal: reveal light - accent ring material with strong emissive glow
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a5a,
    emissive: 0x5588ee, // Brighter blue glow
    emissiveIntensity: 0.9, // Strong glow for rim highlight effect
    roughness: 0.25,
    metalness: 0.5,
  });

  // =========================================================================
  // Pedestal: placement + visibility - MUCH wider to extend beyond board edges
  // Board is 80x60, so half-diagonal is ~50. Pedestal neck must be > board half-size
  // to be visible from the camera angle. Stacked cylinders for tapered look.
  // =========================================================================

  // Pedestal starts just below board bottom (y = 0)
  const pedestalTopY = -0.5; // Small gap below board

  // Section 1: Neck - VERY wide so it extends beyond the board footprint
  // This is the key to visibility - neck radius must exceed board half-dimensions
  const neckHeight = 6;
  const neckGeom = new THREE.CylinderGeometry(
    38, // radiusTop - extends beyond board edge (board is 80x60, half is 40x30)
    42, // radiusBottom (widens into body)
    neckHeight,
    48 // more segments for smooth appearance
  );
  const neck = new THREE.Mesh(neckGeom, pedestalMat);
  neck.position.y = pedestalTopY - neckHeight / 2;
  pedestalGroup.add(neck);

  // Section 2: Body - widest midsection for visual presence
  const bodyHeight = 12;
  const bodyGeom = new THREE.CylinderGeometry(
    42, // radiusTop (matches neck bottom)
    48, // radiusBottom (widest point)
    bodyHeight,
    48
  );
  const body = new THREE.Mesh(bodyGeom, pedestalMat);
  body.position.y = pedestalTopY - neckHeight - bodyHeight / 2;
  pedestalGroup.add(body);

  // Section 3: Lower taper - narrows as it descends
  const lowerHeight = 20;
  const lowerGeom = new THREE.CylinderGeometry(
    48, // radiusTop (matches body bottom)
    30, // radiusBottom (tapers narrower)
    lowerHeight,
    48
  );
  const lower = new THREE.Mesh(lowerGeom, pedestalMat);
  lower.position.y = pedestalTopY - neckHeight - bodyHeight - lowerHeight / 2;
  pedestalGroup.add(lower);

  // Section 4: Deep extension - fades into void
  const deepHeight = 40;
  const deepGeom = new THREE.CylinderGeometry(
    30, // radiusTop
    15, // radiusBottom (continues narrowing)
    deepHeight,
    48
  );
  const deep = new THREE.Mesh(deepGeom, pedestalMat);
  deep.position.y =
    pedestalTopY - neckHeight - bodyHeight - lowerHeight - deepHeight / 2;
  pedestalGroup.add(deep);

  // =========================================================================
  // Pedestal: reveal light - accent rings for futuristic detail and visibility
  // =========================================================================

  // Top accent ring - bright glow at junction with board (visible edge)
  const ringHeight = 0.8;
  const ringGeom = new THREE.CylinderGeometry(39, 39, ringHeight, 48);
  const ring = new THREE.Mesh(ringGeom, accentMat);
  ring.position.y = pedestalTopY - ringHeight / 2;
  pedestalGroup.add(ring);

  // Mid-body accent ring - second glow ring on the visible body section
  const midRingGeom = new THREE.CylinderGeometry(44, 44, 0.6, 48);
  const midRing = new THREE.Mesh(midRingGeom, accentMat);
  midRing.position.y = pedestalTopY - neckHeight - 3;
  pedestalGroup.add(midRing);

  // Center the pedestal under the board
  pedestalGroup.position.set(0, 0, 0);
  parentGroup.add(pedestalGroup);
}

// =============================================================================
// PART 1: PROCEDURAL LIGHTCYCLE BIKE MESH
// =============================================================================

/**
 * Creates a simplified Tron-style lightcycle bike using primitives.
 * Composed of: body, wheels, front fork, glowing accent strip.
 * @param {number} accentColor - The player's accent color (cyan/orange)
 * @param {number} emissiveColor - The emissive glow color
 * @param {number} darkColor - Dark base color for body
 * @returns {THREE.Group} - The bike mesh group
 */
function createBikeMesh(accentColor, emissiveColor, darkColor) {
  const bike = new THREE.Group();
  const s = BIKE_SCALE;

  // =========================================================================
  // MATERIALS
  // Bike material contrast + metallic sheen - lighter gray for visibility
  // =========================================================================

  // Body material - medium-light gray with slight metallic sheen
  // Provides clear contrast against the darker board surface
  const bodyMat = new THREE.MeshStandardMaterial({
    color: darkColor,
    roughness: 0.55, // Moderate roughness - not too shiny
    metalness: 0.35, // Low metalness for subtle sheen without reflection
  });

  // Glowing accent material
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    emissive: emissiveColor,
    emissiveIntensity: 1.0,
    roughness: 0.2,
    metalness: 0.9,
  });

  // Wheel material (slightly glowing)
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x111122,
    emissive: accentColor,
    emissiveIntensity: 0.3,
    roughness: 0.3,
    metalness: 0.9,
  });

  // =========================================================================
  // MAIN BODY - Elongated sleek shape
  // =========================================================================

  // Lower body (chassis)
  const chassisGeom = new THREE.BoxGeometry(0.35 * s, 0.2 * s, 1.0 * s);
  const chassis = new THREE.Mesh(chassisGeom, bodyMat);
  chassis.position.set(0, 0.2 * s, 0);
  bike.add(chassis);

  // Upper body (cockpit) - angled
  const cockpitGeom = new THREE.BoxGeometry(0.25 * s, 0.25 * s, 0.5 * s);
  const cockpit = new THREE.Mesh(cockpitGeom, bodyMat);
  cockpit.position.set(0, 0.35 * s, -0.1 * s);
  cockpit.rotation.x = -0.2; // Slight forward lean
  bike.add(cockpit);

  // Rear section (engine block)
  const rearGeom = new THREE.BoxGeometry(0.3 * s, 0.3 * s, 0.35 * s);
  const rear = new THREE.Mesh(rearGeom, bodyMat);
  rear.position.set(0, 0.25 * s, 0.35 * s);
  bike.add(rear);

  // =========================================================================
  // WHEELS - Two thin cylinders
  // =========================================================================

  const wheelRadius = 0.2 * s;
  const wheelWidth = 0.08 * s;
  const wheelGeom = new THREE.CylinderGeometry(
    wheelRadius,
    wheelRadius,
    wheelWidth,
    16
  );

  // Front wheel
  const frontWheel = new THREE.Mesh(wheelGeom, wheelMat);
  frontWheel.rotation.z = Math.PI / 2;
  frontWheel.position.set(0, wheelRadius, -0.4 * s);
  bike.add(frontWheel);

  // Rear wheel
  const rearWheel = new THREE.Mesh(wheelGeom, wheelMat);
  rearWheel.rotation.z = Math.PI / 2;
  rearWheel.position.set(0, wheelRadius, 0.4 * s);
  bike.add(rearWheel);

  // =========================================================================
  // FRONT FORK / HANDLEBARS
  // =========================================================================

  const forkGeom = new THREE.BoxGeometry(0.05 * s, 0.3 * s, 0.05 * s);
  const fork = new THREE.Mesh(forkGeom, bodyMat);
  fork.position.set(0, 0.3 * s, -0.4 * s);
  fork.rotation.x = 0.3; // Angled forward
  bike.add(fork);

  // Handlebar
  const handleGeom = new THREE.BoxGeometry(0.35 * s, 0.03 * s, 0.03 * s);
  const handle = new THREE.Mesh(handleGeom, accentMat);
  handle.position.set(0, 0.45 * s, -0.35 * s);
  bike.add(handle);

  // =========================================================================
  // GLOWING ACCENT STRIPS
  // =========================================================================

  // Side strips (left)
  const stripGeom = new THREE.BoxGeometry(0.03 * s, 0.08 * s, 0.9 * s);
  const leftStrip = new THREE.Mesh(stripGeom, accentMat);
  leftStrip.position.set(-0.18 * s, 0.2 * s, 0);
  bike.add(leftStrip);

  // Side strips (right)
  const rightStrip = new THREE.Mesh(stripGeom, accentMat);
  rightStrip.position.set(0.18 * s, 0.2 * s, 0);
  bike.add(rightStrip);

  // Top strip (along cockpit)
  const topStripGeom = new THREE.BoxGeometry(0.05 * s, 0.03 * s, 0.6 * s);
  const topStrip = new THREE.Mesh(topStripGeom, accentMat);
  topStrip.position.set(0, 0.48 * s, -0.05 * s);
  bike.add(topStrip);

  // Rear light bar
  const rearLightGeom = new THREE.BoxGeometry(0.25 * s, 0.05 * s, 0.03 * s);
  const rearLight = new THREE.Mesh(rearLightGeom, accentMat);
  rearLight.position.set(0, 0.25 * s, 0.52 * s);
  bike.add(rearLight);

  // =========================================================================
  // WINDSHIELD (transparent accent)
  // =========================================================================

  const shieldGeom = new THREE.BoxGeometry(0.2 * s, 0.15 * s, 0.02 * s);
  const shieldMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    transparent: true,
    opacity: 0.4,
    emissive: accentColor,
    emissiveIntensity: 0.3,
  });
  const shield = new THREE.Mesh(shieldGeom, shieldMat);
  shield.position.set(0, 0.45 * s, -0.25 * s);
  shield.rotation.x = -0.5;
  bike.add(shield);

  // Store reference to accent material for pulsing
  bike.userData.accentMat = accentMat;
  bike.userData.wheelMat = wheelMat;

  return bike;
}

// =============================================================================
// CREATE PLAYER BIKES
// =============================================================================

function createPlayerBikes() {
  // Remove existing
  if (playerBikes[1]) scene.remove(playerBikes[1]);
  if (playerBikes[2]) scene.remove(playerBikes[2]);
  if (playerLights[1]) scene.remove(playerLights[1]);
  if (playerLights[2]) scene.remove(playerLights[2]);

  // Player 1 bike (cyan)
  // Bike scale tweak - Bikes are now larger than trails for visual prominence
  playerBikes[1] = createBikeMesh(P1_COLOR, P1_EMISSIVE, P1_DARK);
  playerBikes[1].userData.wasAlive = undefined; // Initialize for death detection
  playerDirections[1] = "RIGHT";
  scene.add(playerBikes[1]);

  // Player 1 light - raised to match larger bike and board height
  playerLights[1] = new THREE.PointLight(P1_COLOR, 3, 15);
  // Pedestal: placement + visibility - light positioned above raised board surface
  playerLights[1].position.y = BOARD_SURFACE_Y + 2.5;
  scene.add(playerLights[1]);

  // Player 2 bike (orange)
  playerBikes[2] = createBikeMesh(P2_COLOR, P2_EMISSIVE, P2_DARK);
  playerBikes[2].userData.wasAlive = undefined; // Initialize for death detection
  playerDirections[2] = "LEFT";
  scene.add(playerBikes[2]);

  // Player 2 light - raised to match larger bike and board height
  playerLights[2] = new THREE.PointLight(P2_COLOR, 3, 15);
  // Pedestal: placement + visibility - light positioned above raised board surface
  playerLights[2].position.y = BOARD_SURFACE_Y + 2.5;
  scene.add(playerLights[2]);

  // Create boost visual effects for both players
  createBoostEffects();
}

// =============================================================================
// BOOST VISUAL EFFECTS
// Dramatic aura and particle effects when player is near opponent's trail
// =============================================================================

function createBoostEffects() {
  // Remove existing boost effects
  for (const id of [1, 2]) {
    if (boostAuras[id]) scene.remove(boostAuras[id]);
    if (boostParticles[id]) scene.remove(boostParticles[id]);
  }

  for (const id of [1, 2]) {
    const color = id === 1 ? P1_COLOR : P2_COLOR;

    // 1) BOOST AURA - glowing ring around the bike
    const auraGeom = new THREE.RingGeometry(1.2, 1.8, 32);
    const auraMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    const aura = new THREE.Mesh(auraGeom, auraMat);
    aura.rotation.x = -Math.PI / 2; // Flat on XZ plane
    aura.visible = false;
    scene.add(aura);
    boostAuras[id] = aura;

    // 2) SPEED PARTICLES - trailing sparks behind bike
    const particleCount = 20;
    const positions = new Float32Array(particleCount * 3);
    const velocities = [];

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      velocities.push({
        life: 0,
        maxLife: 300 + Math.random() * 200,
        vx: 0,
        vy: 0,
        vz: 0,
      });
    }

    const particleGeom = new THREE.BufferGeometry();
    particleGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3)
    );

    const particleMat = new THREE.PointsMaterial({
      color: color,
      size: 0.4,
      transparent: true,
      opacity: 0,
    });

    const particles = new THREE.Points(particleGeom, particleMat);
    particles.userData.velocities = velocities;
    particles.userData.baseX = 0;
    particles.userData.baseZ = 0;
    particles.visible = false;
    scene.add(particles);
    boostParticles[id] = particles;
  }
}

/**
 * Updates boost visual effects each frame
 * @param {number} elapsed - Time elapsed since start
 * @param {number} deltaMs - Time since last frame in ms
 */
function updateBoostEffects(elapsed, deltaMs) {
  for (const id of [1, 2]) {
    const bike = playerBikes[id];
    if (!bike || !bike.visible) {
      if (boostAuras[id]) boostAuras[id].visible = false;
      if (boostParticles[id]) boostParticles[id].visible = false;
      continue;
    }

    const isBoosted = bike.userData.boosted || false;
    const aura = boostAuras[id];
    const particles = boostParticles[id];

    if (!aura || !particles) continue;

    // Update aura
    aura.position.x = bike.position.x;
    aura.position.y = BOARD_SURFACE_Y + 0.1;
    aura.position.z = bike.position.z;

    if (isBoosted) {
      aura.visible = true;
      // Pulsing, rotating aura
      const pulse = 0.4 + Math.sin(elapsed * 15) * 0.2;
      aura.material.opacity = pulse;
      aura.rotation.z = elapsed * 3; // Spin effect
      const scale = 1.0 + Math.sin(elapsed * 10) * 0.15;
      aura.scale.set(scale, scale, 1);
    } else {
      // Fade out when not boosted
      aura.material.opacity *= 0.9;
      if (aura.material.opacity < 0.01) {
        aura.visible = false;
      }
    }

    // Update speed particles
    particles.position.x = bike.position.x;
    particles.position.y = BOARD_SURFACE_Y + 0.3;
    particles.position.z = bike.position.z;

    if (isBoosted) {
      particles.visible = true;
      particles.material.opacity = 0.8;

      // Get direction vector for particle emission
      const dir = playerDirections[id] || "RIGHT";
      const vec = {
        UP: { x: 0, z: -1 },
        DOWN: { x: 0, z: 1 },
        LEFT: { x: -1, z: 0 },
        RIGHT: { x: 1, z: 0 },
      }[dir];

      const positions = particles.geometry.attributes.position.array;
      const vels = particles.userData.velocities;

      for (let i = 0; i < vels.length; i++) {
        vels[i].life += deltaMs;

        if (vels[i].life >= vels[i].maxLife) {
          // Reset particle at bike position, trailing behind
          vels[i].life = 0;
          vels[i].maxLife = 300 + Math.random() * 200;
          // Emit from behind the bike
          vels[i].vx =
            -vec.x * (0.02 + Math.random() * 0.02) +
            (Math.random() - 0.5) * 0.01;
          vels[i].vz =
            -vec.z * (0.02 + Math.random() * 0.02) +
            (Math.random() - 0.5) * 0.01;
          vels[i].vy = 0.005 + Math.random() * 0.005;
          positions[i * 3] = -vec.x * 0.5 + (Math.random() - 0.5) * 0.3;
          positions[i * 3 + 1] = 0;
          positions[i * 3 + 2] = -vec.z * 0.5 + (Math.random() - 0.5) * 0.3;
        } else {
          // Move particle
          positions[i * 3] += vels[i].vx * deltaMs;
          positions[i * 3 + 1] += vels[i].vy * deltaMs;
          positions[i * 3 + 2] += vels[i].vz * deltaMs;
        }
      }
      particles.geometry.attributes.position.needsUpdate = true;
    } else {
      // Fade out particles when not boosted
      particles.material.opacity *= 0.92;
      if (particles.material.opacity < 0.01) {
        particles.visible = false;
      }
    }
  }
}

// =============================================================================
// TRAIL SEGMENTS - CONTINUOUS LIGHT RIBBON VISUALS
// =============================================================================
// Trail segments are stretched slightly along the movement axis so adjacent
// segments visually overlap, creating the perception of a continuous neon
// ribbon rather than individual grid-aligned blocks. The underlying grid
// data remains unchanged - this is purely a visual enhancement.
// =============================================================================

let trailMaterials = {};

// Trail geometry constants for continuity effect
const TRAIL_WIDTH = 0.55; // Thinner than bike footprint
const TRAIL_LENGTH = 1.15; // Overlap adjacent segments more generously
const TRAIL_HEIGHT_VISUAL = 0.35; // Lower than bikes for visual hierarchy
const CORNER_SIZE = 1.0; // Large square corner pieces to fully connect turns

// Cached geometries for horizontal (X-axis), vertical (Z-axis), and corners
let trailGeomHorizontal = null; // Stretched along X
let trailGeomVertical = null; // Stretched along Z
let trailGeomCorner = null; // Square piece for turns

// Track last direction and position per player to detect turns
let lastTrailDirection = { 1: null, 2: null };
let lastTrailPosition = { 1: null, 2: null };

function getTrailGeometryHorizontal() {
  if (!trailGeomHorizontal) {
    // Trail continuity: Stretched along X-axis for LEFT/RIGHT movement
    trailGeomHorizontal = new THREE.BoxGeometry(
      TRAIL_LENGTH,
      TRAIL_HEIGHT_VISUAL,
      TRAIL_WIDTH
    );
  }
  return trailGeomHorizontal;
}

function getTrailGeometryVertical() {
  if (!trailGeomVertical) {
    // Trail continuity: Stretched along Z-axis for UP/DOWN movement
    trailGeomVertical = new THREE.BoxGeometry(
      TRAIL_WIDTH,
      TRAIL_HEIGHT_VISUAL,
      TRAIL_LENGTH
    );
  }
  return trailGeomVertical;
}

function getTrailGeometryCorner() {
  if (!trailGeomCorner) {
    // Corner piece: Large square geometry to fill gaps at turns
    // Size matches TRAIL_LENGTH to ensure full overlap with adjacent segments
    trailGeomCorner = new THREE.BoxGeometry(
      CORNER_SIZE,
      TRAIL_HEIGHT_VISUAL,
      CORNER_SIZE
    );
  }
  return trailGeomCorner;
}

/**
 * Creates a NEW trail material for each segment (required for per-segment opacity fade).
 * Each segment needs its own material instance to support independent opacity animation.
 * @param {number} playerId - Player 1 or 2
 * @returns {THREE.MeshStandardMaterial} - New material instance
 */
function createTrailMaterial(playerId) {
  const color = playerId === 1 ? P1_TRAIL_COLOR : P2_TRAIL_COLOR;
  const emissive = playerId === 1 ? P1_EMISSIVE : P2_EMISSIVE;

  // Emissive continuity: Strong glow with low roughness makes segment
  // boundaries less visible, reinforcing the continuous ribbon effect
  return new THREE.MeshStandardMaterial({
    color: color,
    emissive: emissive,
    emissiveIntensity: 0.85, // Higher emissive for stronger glow
    roughness: 0.15, // Lower roughness for even light distribution
    metalness: 0.7,
    transparent: true,
    opacity: 0.92, // Starting opacity (will fade over time)
  });
}

// Legacy function for compatibility - now just creates new material
function getTrailMaterial(playerId) {
  return createTrailMaterial(playerId);
}

/**
 * Creates a trail segment with orientation-aware stretching and fade timing.
 * The segment is stretched along the player's current movement direction
 * to create visual overlap with adjacent segments, producing the illusion
 * of a continuous light ribbon.
 *
 * At turns (direction changes), BOTH the previous segment AND the new segment
 * use corner geometry to ensure seamless visual continuity at corners.
 *
 * Each segment stores its spawnTime for per-segment opacity fade animation.
 *
 * @param {number} playerId - Player 1 or 2
 * @param {number} x - Grid X coordinate
 * @param {number} y - Grid Y coordinate
 * @param {string} [direction] - Optional direction override (UP/DOWN/LEFT/RIGHT)
 * @param {number} [spawnTick] - Server tick when segment was created (for fade sync)
 */
function createTrailSegment(playerId, x, y, direction, spawnTick) {
  const key = `${x},${y}`;
  if (trailMeshes[playerId].has(key)) return;

  // Orientation-aware stretching: Use player's current direction to determine
  // whether to stretch along X (horizontal) or Z (vertical) axis
  const dir = direction || playerDirections[playerId] || "RIGHT";
  const isHorizontal = dir === "LEFT" || dir === "RIGHT";

  // Detect turns: if direction changed from last segment, this is a corner
  const lastDir = lastTrailDirection[playerId];
  const wasHorizontal = lastDir === "LEFT" || lastDir === "RIGHT";
  const wasVertical = lastDir === "UP" || lastDir === "DOWN";
  const isCorner =
    lastDir !== null &&
    ((isHorizontal && wasVertical) || (!isHorizontal && wasHorizontal));

  // When a turn is detected, upgrade the PREVIOUS segment to a corner piece
  // This ensures both ends of the turn connect seamlessly
  if (isCorner && lastTrailPosition[playerId]) {
    const prevKey = lastTrailPosition[playerId];
    const prevMesh = trailMeshes[playerId].get(prevKey);
    if (prevMesh && !prevMesh.userData.isCorner) {
      // Replace previous segment geometry with corner, preserving spawnTime
      const prevPos = prevMesh.position.clone();
      const prevSpawnTime = prevMesh.userData.spawnTime;
      scene.remove(prevMesh);
      if (prevMesh.material) prevMesh.material.dispose();

      const cornerMat = createTrailMaterial(playerId);
      const cornerMesh = new THREE.Mesh(getTrailGeometryCorner(), cornerMat);
      cornerMesh.position.copy(prevPos);
      cornerMesh.userData.direction = lastDir;
      cornerMesh.userData.isCorner = true;
      cornerMesh.userData.spawnTime = prevSpawnTime; // Preserve fade timing
      cornerMesh.userData.playerId = playerId;

      scene.add(cornerMesh);
      trailMeshes[playerId].set(prevKey, cornerMesh);
    }
  }

  // Update tracking for next segment
  lastTrailDirection[playerId] = dir;
  lastTrailPosition[playerId] = key;

  // Select geometry: corner piece for turns, stretched piece for straight segments
  let geometry;
  if (isCorner) {
    // Corner: use square geometry to fill the gap at turns
    geometry = getTrailGeometryCorner();
  } else {
    // Straight: use directionally stretched geometry
    geometry = isHorizontal
      ? getTrailGeometryHorizontal()
      : getTrailGeometryVertical();
  }

  // Create mesh with its own material instance for independent opacity fade
  const material = createTrailMaterial(playerId);
  const mesh = new THREE.Mesh(geometry, material);
  const worldPos = gridToWorld(x, y);
  // Pedestal: placement + visibility - trails positioned above raised board surface
  mesh.position.set(
    worldPos.x,
    BOARD_SURFACE_Y + TRAIL_HEIGHT_VISUAL / 2,
    worldPos.z
  );

  // Store the direction and spawn time for fade animation
  mesh.userData.direction = dir;
  mesh.userData.isCorner = isCorner;
  mesh.userData.playerId = playerId;

  // Calculate spawn time from server tick (or use current time if not provided)
  // This keeps fade timing synchronized with server's trail expiration
  if (spawnTick !== undefined && serverTickOffset > 0) {
    // Convert server tick to local time
    mesh.userData.spawnTime =
      serverTickOffset + spawnTick * trailTiming.tickInterval;
  } else {
    // Fallback: use current time (for segments created before sync established)
    mesh.userData.spawnTime = performance.now();
  }

  scene.add(mesh);
  trailMeshes[playerId].set(key, mesh);
}

/**
 * Removes all trail meshes and disposes their materials.
 * Called on new round to ensure clean slate.
 */
function clearAllTrails() {
  for (const playerId of [1, 2]) {
    for (const mesh of trailMeshes[playerId].values()) {
      scene.remove(mesh);
      // Dispose individual material to prevent memory leak
      if (mesh.material) {
        mesh.material.dispose();
      }
    }
    trailMeshes[playerId].clear();
    // Reset tracking for new round
    lastTrailDirection[playerId] = null;
    lastTrailPosition[playerId] = null;
  }
}

// =============================================================================
// TELEPORTATION PORTALS
// Rendered as glowing rings on the board surface
// =============================================================================

// Portal visual constants
const PORTAL_RADIUS = 1.2;
const PORTAL_TUBE_RADIUS = 0.15;
const PORTAL_COLOR_A = 0xff00ff; // Magenta for portal A
const PORTAL_COLOR_B = 0x00ffaa; // Cyan-green for portal B
const PORTAL_HEIGHT = BOARD_SURFACE_Y + 0.3; // Slightly above board

/**
 * Creates or updates portal meshes based on server data.
 * Each portal pair has two torus rings with matching colors.
 * @param {Array} portals - Array of portal pairs from server
 */
function updatePortals(portals) {
  // Clear existing portals if data changed
  if (JSON.stringify(portals) === JSON.stringify(portalData)) {
    return; // No change
  }

  clearAllPortals();
  portalData = portals || [];

  for (let i = 0; i < portalData.length; i++) {
    const pair = portalData[i];

    // Create portal A
    const portalA = createPortalMesh(PORTAL_COLOR_A, i * 2);
    const worldPosA = gridToWorld(pair.a.x, pair.a.y);
    portalA.position.set(worldPosA.x, PORTAL_HEIGHT, worldPosA.z);
    scene.add(portalA);
    portalMeshes.push(portalA);

    // Create portal B
    const portalB = createPortalMesh(PORTAL_COLOR_B, i * 2 + 1);
    const worldPosB = gridToWorld(pair.b.x, pair.b.y);
    portalB.position.set(worldPosB.x, PORTAL_HEIGHT, worldPosB.z);
    scene.add(portalB);
    portalMeshes.push(portalB);

    console.log(
      `[Portals] Created pair ${i}: A(${pair.a.x},${pair.a.y}) B(${pair.b.x},${pair.b.y})`
    );
  }
}

/**
 * Creates a single portal mesh (glowing torus ring).
 * @param {number} color - Portal color
 * @param {number} index - Unique index for animation offset
 * @returns {THREE.Group} - Portal mesh group
 */
function createPortalMesh(color, index) {
  const group = new THREE.Group();
  group.userData.portalIndex = index;

  // Main torus ring
  const torusGeom = new THREE.TorusGeometry(
    PORTAL_RADIUS,
    PORTAL_TUBE_RADIUS,
    16,
    32
  );
  const torusMat = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.8,
    roughness: 0.2,
    metalness: 0.8,
    transparent: true,
    opacity: 0.9,
  });
  const torus = new THREE.Mesh(torusGeom, torusMat);
  torus.rotation.x = Math.PI / 2; // Lay flat on the board
  group.add(torus);

  // Inner glow ring (smaller, brighter)
  const innerGeom = new THREE.TorusGeometry(
    PORTAL_RADIUS * 0.6,
    PORTAL_TUBE_RADIUS * 0.5,
    12,
    24
  );
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: color,
    emissiveIntensity: 1.2,
    roughness: 0.1,
    metalness: 0.9,
    transparent: true,
    opacity: 0.7,
  });
  const inner = new THREE.Mesh(innerGeom, innerMat);
  inner.rotation.x = Math.PI / 2;
  inner.position.y = 0.05;
  group.add(inner);

  // Point light for glow effect
  const light = new THREE.PointLight(color, 2, 8);
  light.position.y = 0.5;
  group.add(light);

  // Store materials for animation
  group.userData.torusMat = torusMat;
  group.userData.innerMat = innerMat;
  group.userData.light = light;

  return group;
}

/**
 * Clears all portal meshes from the scene.
 */
function clearAllPortals() {
  for (const portal of portalMeshes) {
    scene.remove(portal);
    // Dispose geometries and materials
    portal.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }
  portalMeshes = [];
  portalData = [];
}

/**
 * Animates portals (rotation and pulsing glow).
 * Called each frame in the animation loop.
 * @param {number} elapsed - Time elapsed since start (seconds)
 */
function animatePortals(elapsed) {
  for (const portal of portalMeshes) {
    const index = portal.userData.portalIndex || 0;
    const offset = index * Math.PI * 0.5; // Phase offset per portal

    // Rotate the portal
    portal.rotation.y = elapsed * 0.5 + offset;

    // Pulse the glow
    const pulse = 0.7 + Math.sin(elapsed * 3 + offset) * 0.3;
    if (portal.userData.torusMat) {
      portal.userData.torusMat.emissiveIntensity = 0.6 + pulse * 0.4;
    }
    if (portal.userData.innerMat) {
      portal.userData.innerMat.emissiveIntensity = 1.0 + pulse * 0.4;
    }
    if (portal.userData.light) {
      portal.userData.light.intensity = 1.5 + pulse;
    }

    // Subtle bob
    portal.position.y = PORTAL_HEIGHT + Math.sin(elapsed * 2 + offset) * 0.05;
  }
}

// =============================================================================
// TRON-STYLE ENERGY EXPLOSION
// Visual effect when a player dies - energy discharge, not fire/smoke
// =============================================================================

/**
 * Triggers a Tron-style explosion at the specified position
 * @param {number} playerId - Player ID (1 or 2) for color
 * @param {number} x - World X position
 * @param {number} z - World Z position
 */
function triggerExplosion(playerId, x, z) {
  // Tron-style energy explosion
  console.log(
    "[Explosion] Player " +
      playerId +
      " died at (" +
      x.toFixed(1) +
      ", " +
      z.toFixed(1) +
      ")"
  );

  const color = playerId === 1 ? P1_COLOR : P2_COLOR;
  const emissiveColor = playerId === 1 ? P1_EMISSIVE : P2_EMISSIVE;
  const y = BOARD_SURFACE_Y + 0.5; // Slightly above board
  const now = performance.now();

  const explosion = {
    playerId,
    startTime: now,
    objects: [],
  };

  // ==========================================================================
  // Explosion tuning: more pronounced
  // - Core flash: bright and noticeable (250ms)
  // - Rings: large expansion, longer duration (800ms) for dramatic effect
  // - Sparks: more particles, longer travel (850ms)
  // - Total effect: ~850ms so explosion is clearly visible before game over banner
  // ==========================================================================

  // 1) CORE FLASH - large bright sphere, immediate impact
  // Explosion tuning: more pronounced - larger starting size
  const coreGeom = new THREE.SphereGeometry(0.6, 16, 16);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
  });
  const core = new THREE.Mesh(coreGeom, coreMat);
  core.position.set(x, y, z);
  // Explosion tuning: more pronounced - longer duration for readability
  core.userData = { type: "core", duration: 250 };
  scene.add(core);
  explosion.objects.push(core);

  // 2) PRIMARY ENERGY RING - large, dramatic expansion
  // Explosion tuning: more pronounced - thicker ring geometry
  const ringGeom = new THREE.RingGeometry(0.5, 1.2, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: 1.0,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.set(x, y, z);
  ring.rotation.x = -Math.PI / 2; // Flat on XZ plane
  // Explosion tuning: more pronounced - longer duration (800ms)
  ring.userData = { type: "ring", duration: 800 };
  scene.add(ring);
  explosion.objects.push(ring);

  // Secondary ring - emissive accent, slightly faster
  // Explosion tuning: more pronounced - thicker secondary ring
  const ring2Geom = new THREE.RingGeometry(0.3, 0.8, 32);
  const ring2Mat = new THREE.MeshBasicMaterial({
    color: emissiveColor,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  const ring2 = new THREE.Mesh(ring2Geom, ring2Mat);
  ring2.position.set(x, y + 0.2, z);
  ring2.rotation.x = -Math.PI / 2;
  // Explosion tuning: more pronounced - duration 700ms
  ring2.userData = { type: "ring2", duration: 700 };
  scene.add(ring2);
  explosion.objects.push(ring2);

  // Tertiary inner ring - bright white/color blend for extra energy
  const ring3Geom = new THREE.RingGeometry(0.2, 0.5, 32);
  const ring3Mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
  });
  const ring3 = new THREE.Mesh(ring3Geom, ring3Mat);
  ring3.position.set(x, y + 0.1, z);
  ring3.rotation.x = -Math.PI / 2;
  ring3.userData = { type: "ring3", duration: 500 };
  scene.add(ring3);
  explosion.objects.push(ring3);

  // 3) SPARKS - more particles for energetic dispersal
  // Explosion tuning: more pronounced - increased spark count
  const sparkCount = 24;
  const sparkPositions = new Float32Array(sparkCount * 3);
  const sparkVelocities = [];

  for (let i = 0; i < sparkCount; i++) {
    sparkPositions[i * 3] = x;
    sparkPositions[i * 3 + 1] = y;
    sparkPositions[i * 3 + 2] = z;

    // Explosion tuning: more pronounced - faster, more varied velocities
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.02 + Math.random() * 0.04; // Varied speed
    const upSpeed = 0.005 + Math.random() * 0.015;
    sparkVelocities.push({
      vx: Math.cos(angle) * speed,
      vy: upSpeed,
      vz: Math.sin(angle) * speed,
    });
  }

  const sparkGeom = new THREE.BufferGeometry();
  sparkGeom.setAttribute(
    "position",
    new THREE.BufferAttribute(sparkPositions, 3)
  );

  const sparkMat = new THREE.PointsMaterial({
    color: color,
    size: 0.4, // Larger sparks for visibility
    transparent: true,
    opacity: 1.0,
  });

  const sparks = new THREE.Points(sparkGeom, sparkMat);
  sparks.userData = {
    type: "sparks",
    // Explosion tuning: more pronounced - longer duration (850ms)
    duration: 850,
    velocities: sparkVelocities,
    basePositions: { x, y, z },
  };
  scene.add(sparks);
  explosion.objects.push(sparks);

  activeExplosions.push(explosion);
}

/**
 * Updates all active explosions each frame
 * @param {number} now - Current time from performance.now()
 */
function updateExplosions(now) {
  // Tron-style energy explosion animation
  for (let i = activeExplosions.length - 1; i >= 0; i--) {
    const explosion = activeExplosions[i];
    const elapsed = now - explosion.startTime;
    let allComplete = true;

    for (const obj of explosion.objects) {
      const duration = obj.userData.duration;
      const progress = Math.min(elapsed / duration, 1);

      if (progress < 1) {
        allComplete = false;
      }

      // =======================================================================
      // Explosion tuning: more pronounced - animation scaling
      // - Core: large bright flash with smooth fade
      // - Rings: dramatic expansion (scale 10-12x) over longer duration
      // - Sparks: travel farther, fade smoothly
      // =======================================================================

      if (obj.userData.type === "core") {
        // Core: bright flash that expands and fades
        // Ease-out quart for fast initial expansion
        const eased = 1 - Math.pow(1 - progress, 4);
        // Explosion tuning: more pronounced - larger scale (up to 4x)
        const scale = 0.8 + eased * 3.5;
        obj.scale.set(scale, scale, scale);
        // Fade with slight persistence at start for impact
        obj.material.opacity = Math.pow(1 - progress, 1.8);
      } else if (obj.userData.type === "ring") {
        // Primary ring: large dramatic expansion
        // Ease-out cubic for smooth, readable expansion
        const eased = 1 - Math.pow(1 - progress, 3);
        // Explosion tuning: more pronounced - scale up to 12x for dramatic effect
        const scale = 1 + eased * 11;
        obj.scale.set(scale, scale, 1);
        // Smooth fade that lingers slightly then disappears cleanly
        obj.material.opacity = Math.pow(1 - progress, 1.2) * 0.95;
      } else if (obj.userData.type === "ring2") {
        // Secondary ring: slightly faster, accent color
        const eased = 1 - Math.pow(1 - progress, 3);
        // Explosion tuning: more pronounced - scale up to 10x
        const scale = 1 + eased * 9;
        obj.scale.set(scale, scale, 1);
        obj.material.opacity = Math.pow(1 - progress, 1.3) * 0.9;
      } else if (obj.userData.type === "ring3") {
        // Tertiary inner ring: fastest, brightest accent
        const eased = 1 - Math.pow(1 - progress, 4);
        const scale = 1 + eased * 7;
        obj.scale.set(scale, scale, 1);
        obj.material.opacity = Math.pow(1 - progress, 2) * 0.8;
      } else if (obj.userData.type === "sparks") {
        // Sparks: travel outward with minimal gravity
        const positions = obj.geometry.attributes.position.array;
        const vels = obj.userData.velocities;
        const base = obj.userData.basePositions;

        for (let j = 0; j < vels.length; j++) {
          const t = elapsed; // Time in ms
          positions[j * 3] = base.x + vels[j].vx * t;
          // Very light gravity so sparks float slightly
          positions[j * 3 + 1] = base.y + vels[j].vy * t - 0.000008 * t * t;
          positions[j * 3 + 2] = base.z + vels[j].vz * t;
        }
        obj.geometry.attributes.position.needsUpdate = true;
        // Explosion tuning: more pronounced - smooth fade over longer duration
        obj.material.opacity = Math.pow(1 - progress, 1.2);
      }
    }

    // Explosion cleanup - remove completed explosions
    if (allComplete) {
      for (const obj of explosion.objects) {
        scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      }
      activeExplosions.splice(i, 1);
      console.log(
        "[Explosion] Cleanup complete for player " + explosion.playerId
      );
    }
  }
}

/**
 * Clears all active explosions immediately (e.g., on new round)
 */
function clearAllExplosions() {
  for (const explosion of activeExplosions) {
    for (const obj of explosion.objects) {
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
  }
  activeExplosions = [];
}

// =============================================================================
// TRAIL FADING SYSTEM
// Per-segment opacity fade based on spawn time
// =============================================================================

/**
 * Updates trail segment opacity and removes fully faded segments.
 * Called every frame in the animation loop.
 *
 * Fade timeline per segment:
 * - 0 to solidMs: Full opacity (0.92)
 * - solidMs to (solidMs + fadeMs): Linear fade from 0.92 to 0
 * - After (solidMs + fadeMs): Remove segment
 *
 * @param {number} now - Current time from performance.now()
 */
function updateTrailFade(now) {
  const { solidMs, fadeMs } = trailTiming;
  const totalMs = solidMs + fadeMs;
  const baseOpacity = 0.92; // Match createTrailMaterial starting opacity

  // Track segments to remove (can't modify Map while iterating)
  const toRemove = [];

  for (const playerId of [1, 2]) {
    for (const [key, mesh] of trailMeshes[playerId]) {
      const spawnTime = mesh.userData.spawnTime;
      if (!spawnTime) continue; // Safety check

      const age = now - spawnTime;

      if (age >= totalMs) {
        // Segment expired - mark for removal
        toRemove.push({ playerId, key, mesh });
      } else if (age > solidMs) {
        // In fade phase - compute opacity
        const fadeProgress = (age - solidMs) / fadeMs; // 0 to 1
        const opacity = baseOpacity * (1 - fadeProgress);

        // Update material opacity and emissive intensity
        if (mesh.material) {
          mesh.material.opacity = Math.max(0, opacity);
          // Fade emissive glow proportionally for natural fade-out
          mesh.material.emissiveIntensity = 0.85 * (1 - fadeProgress);
        }
      }
      // else: age <= solidMs, keep full opacity (already set at creation)
    }
  }

  // Remove expired segments
  for (const { playerId, key, mesh } of toRemove) {
    scene.remove(mesh);
    if (mesh.material) mesh.material.dispose();
    trailMeshes[playerId].delete(key);
  }
}

// =============================================================================
// COUNTDOWN DROP-IN ANIMATION
// Bikes descend from above during countdown, landing as game starts
// =============================================================================

/**
 * Creates landing glow meshes (subtle circles beneath bikes during descent)
 */
function createLandingGlows() {
  const glowMat1 = new THREE.MeshBasicMaterial({
    color: P1_COLOR,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const glowMat2 = new THREE.MeshBasicMaterial({
    color: P2_COLOR,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });

  const glowGeom = new THREE.CircleGeometry(1.5, 32);

  landingGlows[1] = new THREE.Mesh(glowGeom, glowMat1);
  landingGlows[1].rotation.x = -Math.PI / 2; // Flat on ground
  landingGlows[1].position.y = BOARD_SURFACE_Y + 0.02; // Just above board
  landingGlows[1].visible = false;
  scene.add(landingGlows[1]);

  landingGlows[2] = new THREE.Mesh(glowGeom.clone(), glowMat2);
  landingGlows[2].rotation.x = -Math.PI / 2;
  landingGlows[2].position.y = BOARD_SURFACE_Y + 0.02;
  landingGlows[2].visible = false;
  scene.add(landingGlows[2]);
}

/**
 * Starts the drop-in animation when countdown begins
 */
function startDropAnimation() {
  // FIX: countdown drop-in animation visibility
  console.log(
    "[DropAnim] Starting drop-in animation from Y=" +
      DROP_START_Y +
      " to Y=" +
      DROP_REST_Y
  );
  dropAnimation.active = true;
  dropAnimation.startTime = performance.now();
  dropAnimation.lastLoggedProgress = -1; // Reset progress logging

  // Create landing glows if they don't exist
  if (!landingGlows[1]) {
    createLandingGlows();
  }

  // Immediately position bikes at elevated start height and show landing glows
  for (const id of [1, 2]) {
    const bike = playerBikes[id];
    if (bike) {
      // Elevate bike to start position for drop animation
      bike.position.y = DROP_START_Y;
      // Make bike visible for the animation
      bike.visible = true;
      console.log(
        "[DropAnim] Bike " +
          id +
          " at X=" +
          bike.position.x.toFixed(1) +
          " Z=" +
          bike.position.z.toFixed(1) +
          " elevated to Y=" +
          DROP_START_Y
      );
    }
    if (landingGlows[id]) {
      landingGlows[id].visible = true;
      if (bike) {
        landingGlows[id].position.x = bike.position.x;
        landingGlows[id].position.z = bike.position.z;
      }
      landingGlows[id].material.opacity = 0;
    }
  }
}

/**
 * Ends the drop-in animation when game starts running
 */
function endDropAnimation() {
  // FIX: countdown drop-in animation visibility
  console.log(
    "[DropAnim] Ending drop-in animation, bikes at rest Y=" + DROP_REST_Y
  );
  dropAnimation.active = false;

  // Ensure bikes are at rest position
  for (const id of [1, 2]) {
    const bike = playerBikes[id];
    if (bike) {
      bike.position.y = DROP_REST_Y;
    }
    // Hide landing glows
    if (landingGlows[id]) {
      landingGlows[id].visible = false;
      landingGlows[id].material.opacity = 0;
    }
  }
}

/**
 * Easing function: ease-out cubic for smooth deceleration
 * @param {number} t - Progress 0 to 1
 * @returns {number} - Eased value 0 to 1
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Linear interpolation
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Updates the drop animation each frame
 * @param {number} now - Current time from performance.now()
 */
function updateDropAnimation(now) {
  if (!dropAnimation.active) return;

  const elapsed = now - dropAnimation.startTime;
  const rawProgress = Math.min(elapsed / DROP_DURATION_MS, 1);
  const easedProgress = easeOutCubic(rawProgress);

  // Calculate current Y position
  // DEBUG: prevent Y override during countdown - animation controls Y
  const currentY = lerp(DROP_START_Y, DROP_REST_Y, easedProgress);

  // Log progress periodically (every 10%)
  const progressPercent = Math.floor(rawProgress * 10);
  if (progressPercent !== dropAnimation.lastLoggedProgress) {
    console.log(
      "[DropAnim] Progress: " +
        (rawProgress * 100).toFixed(0) +
        "%, Y=" +
        currentY.toFixed(2)
    );
    dropAnimation.lastLoggedProgress = progressPercent;
  }

  // Apply to both bikes (don't check visibility - we control that during countdown)
  for (const id of [1, 2]) {
    const bike = playerBikes[id];
    if (bike) {
      // Override Y position with animation (X/Z remain server-authoritative)
      bike.position.y = currentY;

      // Update landing glow
      if (landingGlows[id]) {
        // Glow gets brighter as bike approaches
        const glowIntensity = easedProgress * 0.4; // Max 0.4 opacity
        landingGlows[id].material.opacity = glowIntensity;
        landingGlows[id].position.x = bike.position.x;
        landingGlows[id].position.z = bike.position.z;

        // Scale glow based on proximity (bigger when closer)
        const scale = 0.5 + easedProgress * 0.5;
        landingGlows[id].scale.set(scale, scale, 1);
      }
    }
  }

  // Add subtle "settle" bounce at the very end
  if (rawProgress >= 0.95 && rawProgress < 1) {
    const bouncePhase = (rawProgress - 0.95) / 0.05; // 0 to 1 in last 5%
    const bounce = Math.sin(bouncePhase * Math.PI) * 0.08; // Tiny bounce
    for (const id of [1, 2]) {
      const bike = playerBikes[id];
      if (bike) {
        bike.position.y = DROP_REST_Y - bounce; // Slight overshoot down then up
      }
    }
  }
}

// =============================================================================
// ANIMATION LOOP
// =============================================================================

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  const now = performance.now();

  // =========================================================================
  // TRAIL FADING
  // Update per-segment opacity fade and cleanup expired segments
  // Only process during running/gameOver states (trails exist)
  // =========================================================================
  if (gameStatus === "running" || gameStatus === "gameOver") {
    updateTrailFade(now);
  }

  // =========================================================================
  // COUNTDOWN DROP-IN ANIMATION
  // Bikes descend from sky during countdown - updates Y position
  // =========================================================================
  updateDropAnimation(now);

  // =========================================================================
  // TRON-STYLE EXPLOSIONS
  // Update any active death explosions
  // =========================================================================
  updateExplosions(now);

  // =========================================================================
  // GAMEOVER OVERLAY DELAY
  // GameOver overlay delay to showcase explosion - show banner after delay
  // =========================================================================
  if (gameOverAtMs !== null && pendingGameOverMsg !== null) {
    const timeSinceGameOver = now - gameOverAtMs;
    if (timeSinceGameOver >= GAMEOVER_OVERLAY_DELAY_MS) {
      // Delay elapsed - now show the game over overlay
      const msg = pendingGameOverMsg;
      gameoverOverlay.style.display = "block";
      if (msg.winner === "draw") {
        winnerText.textContent = "DRAW!";
        winnerText.className = "draw";
      } else if (msg.winner === 1) {
        winnerText.textContent = "PLAYER 1 WINS!";
        winnerText.className = "p1-win";
      } else if (msg.winner === 2) {
        winnerText.textContent = "PLAYER 2 WINS!";
        winnerText.className = "p2-win";
      }
      // Clear pending state so we don't repeat
      pendingGameOverMsg = null;
      console.log(
        "[GameOver] Overlay now displayed after " +
          timeSinceGameOver.toFixed(0) +
          "ms delay"
      );
    }
  }

  // =========================================================================
  // PORTAL ANIMATIONS
  // Rotate and pulse portal effects
  // =========================================================================
  animatePortals(elapsed);

  // =========================================================================
  // BOOST VISUAL EFFECTS
  // Aura and speed particles when near opponent's trail
  // =========================================================================
  updateBoostEffects(elapsed, 16); // ~60fps frame time approximation

  // =========================================================================
  // BIKE VISUAL EFFECTS
  // =========================================================================

  for (const id of [1, 2]) {
    const bike = playerBikes[id];
    if (bike && bike.visible) {
      // Only apply normal Y positioning if drop animation is not active
      // During drop animation, Y is controlled by updateDropAnimation()
      if (!dropAnimation.active) {
        // Pedestal: placement + visibility - bikes positioned above raised board surface
        // Subtle hover bob on top of base height
        const bob = Math.sin(elapsed * 4 + id * Math.PI) * 0.02;
        bike.position.y = BOARD_SURFACE_Y + bob;
      }

      // Pulse accent glow - MUCH stronger and faster when boosted (proximity speed-up)
      const isBoosted = bike.userData.boosted || false;
      const pulseSpeed = isBoosted ? 20 : 5; // Much faster pulse when boosted
      const pulseBase = isBoosted ? 2.0 : 0.8; // Much brighter base when boosted
      const pulseRange = isBoosted ? 1.0 : 0.4; // Much more variation when boosted
      const pulse =
        pulseBase + Math.sin(elapsed * pulseSpeed + id * Math.PI) * pulseRange;

      if (bike.userData.accentMat) {
        bike.userData.accentMat.emissiveIntensity = pulse;
      }
      if (bike.userData.wheelMat) {
        const wheelPulse = isBoosted ? 1.0 : 0.2;
        const wheelRange = isBoosted ? 0.5 : 0.15;
        bike.userData.wheelMat.emissiveIntensity =
          wheelPulse +
          Math.sin(elapsed * pulseSpeed + id * Math.PI) * wheelRange;
      }

      // Bike scale effect - slightly larger when boosted for "power-up" feel
      const targetScale = isBoosted ? 1.15 : 1.0;
      const currentScale = bike.scale.x;
      const newScale = currentScale + (targetScale - currentScale) * 0.15; // Smooth transition
      bike.scale.set(newScale, newScale, newScale);

      // Update point light - MUCH brighter when boosted
      const light = playerLights[id];
      if (light) {
        light.position.x = bike.position.x;
        light.position.z = bike.position.z;
        const baseLightIntensity = isBoosted ? 6 : 1.5;
        const lightRange = isBoosted ? 2 : 0.5;
        light.intensity =
          baseLightIntensity +
          Math.sin(elapsed * pulseSpeed + id * Math.PI) * lightRange;
        // Larger light radius when boosted
        light.distance = isBoosted ? 25 : 15;
      }
    }
  }

  // =========================================================================
  // BACKGROUND ANIMATION (very subtle)
  // =========================================================================

  // Slow star field rotation (barely perceptible)
  if (starField) {
    starField.rotation.y = elapsed * 0.005;
  }

  // =========================================================================
  // GAME STATE VISUAL FEEDBACK
  // Lighting adjustments scaled for brighter overall scene
  // =========================================================================

  if (gameStatus === "gameOver") {
    // Dim slightly but remain readable - not overly dark
    if (ambientLight) ambientLight.intensity = 0.35;
    if (mainLight) mainLight.intensity = 0.7;
    if (backgroundGroup) backgroundGroup.visible = true;
  } else if (gameStatus === "countdown") {
    // Moderate brightness during countdown
    if (ambientLight) ambientLight.intensity = 0.45;
    if (mainLight) mainLight.intensity = 0.9;
  } else if (gameStatus === "running") {
    // Full brightness during gameplay - clean and readable
    if (ambientLight) ambientLight.intensity = 0.55;
    if (mainLight) mainLight.intensity = 1.1;
  }

  renderer.render(scene, camera);
}

// =============================================================================
// PLAYER DIRECTION UPDATE
// =============================================================================

function updatePlayerDirection(playerId, dir) {
  const bike = playerBikes[playerId];
  if (!bike) return;

  playerDirections[playerId] = dir;

  // Rotate bike to face movement direction
  // Bike model faces -Z by default (forward)
  const rotations = {
    UP: Math.PI, // Face -Z
    DOWN: 0, // Face +Z
    LEFT: -Math.PI / 2, // Face -X
    RIGHT: Math.PI / 2, // Face +X
  };

  bike.rotation.y = rotations[dir] || 0;
}

// =============================================================================
// WEBSOCKET (UNCHANGED)
// =============================================================================

function connect() {
  console.log("[WebSocket] Connecting to:", WS_URL);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[WebSocket] Connected successfully");
    connectionStatus.textContent =
      "Connected - Waiting for player assignment...";
    connectionStatus.className = "status connected";
  };

  ws.onclose = () => {
    console.log("Disconnected from server");
    connectionStatus.textContent = "Disconnected - Refresh to reconnect";
    connectionStatus.className = "status disconnected";
    joinScreen.style.display = "block";
    gameHud.style.display = "none";
  };

  ws.onerror = (err) => {
    console.error("[WebSocket] Connection error:", err);
    console.error("[WebSocket] Failed to connect to:", WS_URL);
    connectionStatus.textContent = "Connection error - check console";
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// =============================================================================
// MESSAGE HANDLING (UNCHANGED LOGIC)
// =============================================================================

function handleMessage(msg) {
  switch (msg.type) {
    case "assign":
      handleAssign(msg);
      break;
    case "state":
      handleState(msg);
      break;
    case "countdown":
      handleCountdown(msg);
      break;
    case "error":
      console.error("Server error:", msg.message);
      connectionStatus.textContent = `Error: ${msg.message}`;
      connectionStatus.className = "status disconnected";
      joinScreen.style.display = "block";
      break;
  }
}

function handleAssign(msg) {
  myPlayerId = msg.playerId;
  gridSize = msg.grid;

  console.log(
    `Assigned as Player ${myPlayerId}, grid: ${gridSize.w}x${gridSize.h}`
  );

  joinScreen.style.display = "none";
  gameHud.style.display = "block";
  playerLabel.textContent = `Player ${myPlayerId}`;
  playerLabel.className = myPlayerId === 2 ? "p2" : "";

  createBoard();
  createPlayerBikes();
}

function handleState(msg) {
  const prevStatus = gameStatus;
  gameStatus = msg.status;

  // =========================================================================
  // TRAIL TIMING SYNC
  // Update local timing constants from server for accurate fade calculation
  // =========================================================================
  if (msg.trailTiming) {
    trailTiming.tickInterval = msg.trailTiming.tickInterval || 50;
    trailTiming.solidMs = msg.trailTiming.solidMs || 2000;
    trailTiming.fadeMs = msg.trailTiming.fadeMs || 1000;
  }

  // Calculate server tick offset for converting spawnTick to local time
  // serverTickOffset + (tick * tickInterval) = performance.now() at that tick
  // So: serverTickOffset = now - (tick * tickInterval)
  const now = performance.now();
  serverTickOffset = now - msg.tick * trailTiming.tickInterval;

  const isNewRound =
    msg.tick < lastTick ||
    (prevStatus === "countdown" && gameStatus === "running") ||
    (prevStatus === "gameOver" && gameStatus === "ready");

  if (isNewRound) {
    console.log("New round detected, clearing trails and portals");
    clearAllTrails();
    clearAllExplosions(); // Cleanup any lingering explosions
    clearAllPortals(); // Clear portals for fresh generation
    // Reset wasAlive tracking for new round
    if (playerBikes[1]) playerBikes[1].userData.wasAlive = undefined;
    if (playerBikes[2]) playerBikes[2].userData.wasAlive = undefined;
    myReadyState = false;
    // GameOver overlay delay to showcase explosion - reset delay state on new round
    gameOverAtMs = null;
    pendingGameOverMsg = null;
    // Reset tick offset for new round
    serverTickOffset = now;
  }

  // =========================================================================
  // PORTAL SYNC
  // Update portal positions from server (only changes on new round)
  // =========================================================================
  if (msg.portals) {
    updatePortals(msg.portals);
  }

  lastTick = msg.tick;

  gameStatusEl.textContent = gameStatus;

  if (msg.score) {
    scoreP1.textContent = msg.score[1] || 0;
    scoreP2.textContent = msg.score[2] || 0;
  }

  // Update bike positions and directions FIRST (before animation logic)
  for (const p of msg.players || []) {
    if (playerBikes[p.id]) {
      const worldPos = gridToWorld(p.x, p.y);

      // Always update X/Z from server - bike follows its trail on the board
      // The Y position is animated separately during the drop animation
      playerBikes[p.id].position.x = worldPos.x;
      playerBikes[p.id].position.z = worldPos.z;

      // Explosion trigger on death - detect alive transition
      const wasAlive = playerBikes[p.id].userData.wasAlive;
      if (wasAlive === true && p.alive === false) {
        // Player just died - trigger explosion at their position
        triggerExplosion(
          p.id,
          playerBikes[p.id].position.x,
          playerBikes[p.id].position.z
        );
      }
      playerBikes[p.id].userData.wasAlive = p.alive;

      // Determine bike visibility based on game state:
      // - running: visible if alive (or if drop animation is active)
      // - waiting/ready/countdown/gameOver: hidden (clean presentation)
      let shouldBeVisible = false;
      if (gameStatus === "running") {
        shouldBeVisible = p.alive || dropAnimation.active;
      }
      playerBikes[p.id].visible = shouldBeVisible;

      updatePlayerDirection(p.id, p.dir);

      // Proximity speed-up visual indicator
      // Store boosted state for animation loop to use
      playerBikes[p.id].userData.boosted = p.boosted || false;

      if (playerLights[p.id]) {
        playerLights[p.id].visible = shouldBeVisible;
        // Boost visual: brighter light when boosted
        playerLights[p.id].intensity = p.boosted ? 5 : 3;
      }

      // Update boost indicator UI (DEBUG)
      const boostEl = p.id === 1 ? boostP1 : boostP2;
      if (boostEl) {
        if (p.boosted && p.alive) {
          boostEl.classList.add("active");
        } else {
          boostEl.classList.remove("active");
        }
      }
    }
  }

  // Show/hide boost indicator panel based on game state
  if (boostIndicator) {
    boostIndicator.style.display = gameStatus === "running" ? "flex" : "none";
  }

  // =========================================================================
  // COUNTDOWN DROP-IN ANIMATION - Trigger when game starts running
  // FIX: We start the animation when transitioning TO "running" because
  // that's when the server sends the correct starting positions.
  // The bikes have already been positioned above (lines 1734-1736), so
  // now we elevate them and start the drop animation.
  // =========================================================================
  if (
    gameStatus === "running" &&
    prevStatus === "countdown" &&
    !dropAnimation.active
  ) {
    console.log(
      "[State] Game starting - triggering drop animation at correct positions"
    );

    // Bikes are now at correct X/Z positions from server
    // Start the drop animation (bikes will be elevated then descend)
    startDropAnimation();
  }

  // =========================================================================
  // GAME OVER CLEANUP - Hide bikes and reset visual state
  // =========================================================================
  if (gameStatus === "gameOver") {
    // End any active animation
    if (dropAnimation.active) {
      endDropAnimation();
    }
    // Hide bikes on game over for clean presentation
    for (const id of [1, 2]) {
      if (playerBikes[id]) {
        playerBikes[id].visible = false;
      }
      if (playerLights[id]) {
        playerLights[id].visible = false;
      }
    }
  }

  // Handle trails (now with spawnTick for fade timing)
  if (msg.trailsFull) {
    for (const playerId of [1, 2]) {
      const serverTrails = msg.trailsFull[playerId] || [];
      const serverKeys = new Set(serverTrails.map((c) => `${c.x},${c.y}`));

      // Remove segments no longer in server trail
      for (const [key, mesh] of trailMeshes[playerId]) {
        if (!serverKeys.has(key)) {
          scene.remove(mesh);
          if (mesh.material) mesh.material.dispose();
          trailMeshes[playerId].delete(key);
        }
      }

      // Create/update segments with spawnTick for fade sync
      for (const cell of serverTrails) {
        createTrailSegment(playerId, cell.x, cell.y, undefined, cell.spawnTick);
      }
    }
  } else if (msg.trailsDelta) {
    for (const playerId of [1, 2]) {
      const delta = msg.trailsDelta[playerId];
      if (delta) {
        // FIX: Handle both single cell AND array of cells (when boosted)
        // Server sends array when player moved multiple cells in one tick
        const cells = Array.isArray(delta) ? delta : [delta];
        for (const cell of cells) {
          createTrailSegment(
            playerId,
            cell.x,
            cell.y,
            undefined,
            cell.spawnTick
          );
        }
      }
    }
  }

  updateUIForStatus(msg);
}

function updateUIForStatus(msg) {
  readyPanel.style.display = "none";
  countdownOverlay.style.display = "none";
  gameoverOverlay.style.display = "none";

  switch (gameStatus) {
    case "waiting":
      readyPanel.style.display = "block";
      startBtn.disabled = true;
      readyP1.textContent = "Waiting...";
      readyP2.textContent = "Waiting...";
      break;

    case "ready":
      readyPanel.style.display = "block";
      for (const p of msg.players || []) {
        const el = p.id === 1 ? readyP1 : readyP2;
        el.textContent = p.ready ? "Ready!" : "Not Ready";
        if (p.id === myPlayerId) {
          myReadyState = p.ready;
        }
      }
      startBtn.disabled = myReadyState;
      break;

    case "countdown":
      break;

    case "running":
      break;

    case "gameOver":
      // GameOver overlay delay to showcase explosion
      // Don't show overlay immediately - wait for explosion to play
      if (gameOverAtMs === null) {
        // First time detecting gameOver - start the delay timer
        gameOverAtMs = performance.now();
        pendingGameOverMsg = msg;
        console.log(
          "[GameOver] Death detected, delaying overlay by " +
            GAMEOVER_OVERLAY_DELAY_MS +
            "ms"
        );
      }
      // The actual overlay display is handled in the animate loop
      // after GAMEOVER_OVERLAY_DELAY_MS has elapsed
      break;
  }
}

function handleCountdown(msg) {
  countdownOverlay.style.display = "block";
  readyPanel.style.display = "none";

  // IMPORTANT: Set gameStatus to "countdown" so that when handleState receives
  // the first "running" state, prevStatus will be "countdown" and trigger the animation
  if (gameStatus !== "countdown") {
    console.log(
      "[Countdown] Setting gameStatus to 'countdown' (was: " + gameStatus + ")"
    );
  }
  gameStatus = "countdown";

  // NOTE: We do NOT start the drop animation during countdown because
  // the server hasn't sent the correct starting positions yet.
  // The drop animation triggers when we first receive "running" state
  // with actual starting positions (see handleState).

  if (msg.secondsLeft > 0) {
    countdownText.textContent = msg.secondsLeft;
  } else {
    countdownText.textContent = "GO!";
    setTimeout(() => {
      if (gameStatus === "running") {
        countdownOverlay.style.display = "none";
      }
    }, 500);
  }

  countdownText.style.animation = "none";
  countdownText.offsetHeight;
  countdownText.style.animation = "pulse 0.5s ease-in-out";
}

// =============================================================================
// INPUT HANDLING (UNCHANGED)
// =============================================================================

function setupInputHandlers() {
  startBtn.addEventListener("click", () => {
    if (!myReadyState) {
      send({ type: "start" });
      myReadyState = true;
      startBtn.disabled = true;

      // If user had music enabled (from localStorage), start it on this gesture
      // This respects autoplay rules - we need a user interaction to start audio
      if (
        localStorage.getItem(BGM_STORAGE_KEY) === "true" &&
        !musicInitialized
      ) {
        initBackgroundMusic();
        musicEnabled = true;
        updateMusicUI();
        startMusic();
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.repeat) return;

    const dirMap = {
      ArrowUp: "UP",
      ArrowDown: "DOWN",
      ArrowLeft: "LEFT",
      ArrowRight: "RIGHT",
      w: "UP",
      W: "UP",
      s: "DOWN",
      S: "DOWN",
      a: "LEFT",
      A: "LEFT",
      d: "RIGHT",
      D: "RIGHT",
    };

    if (dirMap[e.key]) {
      e.preventDefault();
      if (gameStatus === "running") {
        send({ type: "input", dir: dirMap[e.key] });
      }
      return;
    }

    if (e.key === "r" || e.key === "R") {
      if (gameStatus === "gameOver") {
        send({ type: "reset" });
      }
    }
  });
}

// =============================================================================
// INIT
// =============================================================================

function init() {
  initThree();
  setupInputHandlers();
  connect();
}

init();
