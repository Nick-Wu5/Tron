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

const WS_URL = `ws://${window.location.host}`;

// =============================================================================
// VISUAL CONSTANTS - TRON NEON AESTHETIC
// =============================================================================

// Board/background contrast - Board is lighter to stand out from dark background
const BOARD_COLOR = 0x12121f; // Lighter gray-blue for better contrast
const BOARD_EMISSIVE = 0x151525; // Subtle emissive to lift the surface
const GRID_COLOR = 0x2a2a4a; // Brighter grid lines visible on lighter board
const WALL_COLOR = 0x3a3a5a; // Walls slightly lighter to frame board
const WALL_EMISSIVE = 0x5555bb; // Stronger wall glow

// Player 1: Cyan / Electric Blue
const P1_COLOR = 0x00ffff;
const P1_EMISSIVE = 0x00ccff;
const P1_TRAIL_COLOR = 0x00ddff;
const P1_DARK = 0x003344;

// Player 2: Orange / Hot Magenta
const P2_COLOR = 0xff6600;
const P2_EMISSIVE = 0xff4400;
const P2_TRAIL_COLOR = 0xff5500;
const P2_DARK = 0x442200;

// Geometry sizes
// Bike scale tweak - bikes are prominently larger than trails
const BIKE_SCALE = 3.5;
// Note: Trail dimensions are defined in  the TRAIL SEGMENTS section

// Background - kept darker for contrast with lighter board
const BG_COLOR = 0x010108;
const HORIZON_GRID_COLOR = 0x151530; // Slightly darker to not compete with board
const STAR_COUNT = 800;

// =============================================================================
// STATE
// =============================================================================

let ws = null;
let myPlayerId = null;
let gridSize = { w: 80, h: 60 };
let gameStatus = "waiting";
let lastTick = -1;
let myReadyState = false;

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
// THREE.JS SETUP
// =============================================================================

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);
  scene.fog = new THREE.FogExp2(BG_COLOR, 0.008);

  clock = new THREE.Clock();

  // Camera
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 55, 45);
  camera.lookAt(0, 0, 0);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.insertBefore(renderer.domElement, document.body.firstChild);

  // =========================================================================
  // LIGHTING
  // =========================================================================

  ambientLight = new THREE.AmbientLight(0x1a1a3a, 0.25);
  scene.add(ambientLight);

  mainLight = new THREE.DirectionalLight(0x6666aa, 0.7);
  mainLight.position.set(0, 80, 20);
  scene.add(mainLight);

  const fillLight = new THREE.DirectionalLight(0x2222aa, 0.15);
  fillLight.position.set(0, -20, 0);
  scene.add(fillLight);

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
  // Large plane below arena with fading grid lines
  // Board/background contrast - Horizon kept darker to make board stand out
  // =========================================================================

  const horizonSize = 400;
  const horizonY = -5; // Below the arena

  // Dark horizon plane - darker than board for contrast
  const horizonGeom = new THREE.PlaneGeometry(horizonSize, horizonSize);
  const horizonMat = new THREE.MeshBasicMaterial({
    color: 0x010108, // Very dark, matches BG_COLOR
    transparent: true,
    opacity: 0.9,
  });
  const horizonPlane = new THREE.Mesh(horizonGeom, horizonMat);
  horizonPlane.rotation.x = -Math.PI / 2;
  horizonPlane.position.y = horizonY;
  backgroundGroup.add(horizonPlane);

  // Grid lines on horizon (subtle, doesn't compete with board)
  const gridSpacing = 10;
  const gridLineMat = new THREE.LineBasicMaterial({
    color: HORIZON_GRID_COLOR,
    transparent: true,
    opacity: 0.2, // Reduced opacity so board grid is more prominent
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
  // Low-detail buildings in far background
  // Board/background contrast - Buildings darker to not compete with arena
  // =========================================================================

  const buildingMat = new THREE.MeshBasicMaterial({
    color: 0x060610, // Darker buildings
    transparent: true,
    opacity: 0.5, // More transparent
  });

  const buildingEdgeMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a66, // Subtler edge glow
    transparent: true,
    opacity: 0.2, // Reduced edge visibility
  });

  // Create buildings around the perimeter
  const buildingConfigs = [];
  const buildingDistance = 120;

  // Generate random building positions around the arena
  for (let angle = 0; angle < Math.PI * 2; angle += 0.15) {
    const dist = buildingDistance + Math.random() * 60;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const width = 3 + Math.random() * 8;
    const height = 10 + Math.random() * 40;
    const depth = 3 + Math.random() * 8;
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

    // Add subtle edge glow (top edge)
    const edgeGeom = new THREE.BoxGeometry(
      cfg.width + 0.2,
      0.3,
      cfg.depth + 0.2
    );
    const edge = new THREE.Mesh(edgeGeom, buildingEdgeMat);
    edge.position.set(cfg.x, cfg.height + horizonY, cfg.z);
    backgroundGroup.add(edge);
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

    // Vary star colors (blues and purples)
    const colorChoice = Math.random();
    if (colorChoice < 0.5) {
      // Blue
      starColors[i * 3] = 0.3 + Math.random() * 0.3;
      starColors[i * 3 + 1] = 0.3 + Math.random() * 0.3;
      starColors[i * 3 + 2] = 0.8 + Math.random() * 0.2;
    } else if (colorChoice < 0.8) {
      // Cyan
      starColors[i * 3] = 0.2 + Math.random() * 0.3;
      starColors[i * 3 + 1] = 0.7 + Math.random() * 0.3;
      starColors[i * 3 + 2] = 0.8 + Math.random() * 0.2;
    } else {
      // Purple
      starColors[i * 3] = 0.5 + Math.random() * 0.3;
      starColors[i * 3 + 1] = 0.2 + Math.random() * 0.2;
      starColors[i * 3 + 2] = 0.7 + Math.random() * 0.3;
    }
  }

  starGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(starPositions, 3)
  );
  starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3));

  const starMat = new THREE.PointsMaterial({
    size: 1.5,
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
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
  // to clearly distinguish it from the darker background environment
  const boardGeom = new THREE.BoxGeometry(gridSize.w, 0.3, gridSize.h);
  const boardMat = new THREE.MeshStandardMaterial({
    color: BOARD_COLOR,
    emissive: BOARD_EMISSIVE,
    emissiveIntensity: 0.15, // Slightly stronger emissive
    roughness: 0.7, // Less rough = more reflective surface
    metalness: 0.5, // More metallic for better light response
  });
  const board = new THREE.Mesh(boardGeom, boardMat);
  board.position.y = -0.15;
  arenaGroup.add(board);

  // Grid lines - brighter to remain visible on lighter board
  const gridMat = new THREE.LineBasicMaterial({
    color: GRID_COLOR,
    transparent: true,
    opacity: 0.5, // Increased opacity for visibility
  });

  for (let i = 0; i <= gridSize.h; i += 5) {
    const points = [
      new THREE.Vector3(-gridSize.w / 2, 0.02, i - gridSize.h / 2),
      new THREE.Vector3(gridSize.w / 2, 0.02, i - gridSize.h / 2),
    ];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
    arenaGroup.add(new THREE.Line(lineGeom, gridMat));
  }

  for (let i = 0; i <= gridSize.w; i += 5) {
    const points = [
      new THREE.Vector3(i - gridSize.w / 2, 0.02, -gridSize.h / 2),
      new THREE.Vector3(i - gridSize.w / 2, 0.02, gridSize.h / 2),
    ];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
    arenaGroup.add(new THREE.Line(lineGeom, gridMat));
  }

  // Walls
  const wallHeight = 1.5;
  const wallThickness = 0.15;
  const wallMat = new THREE.MeshStandardMaterial({
    color: WALL_COLOR,
    emissive: WALL_EMISSIVE,
    emissiveIntensity: 0.6,
    roughness: 0.3,
    metalness: 0.7,
    transparent: true,
    opacity: 0.7,
  });

  const wallConfigs = [
    {
      w: gridSize.w,
      h: wallHeight,
      d: wallThickness,
      x: 0,
      z: -gridSize.h / 2 - wallThickness / 2,
    },
    {
      w: gridSize.w,
      h: wallHeight,
      d: wallThickness,
      x: 0,
      z: gridSize.h / 2 + wallThickness / 2,
    },
    {
      w: wallThickness,
      h: wallHeight,
      d: gridSize.h + wallThickness * 2,
      x: -gridSize.w / 2 - wallThickness / 2,
      z: 0,
    },
    {
      w: wallThickness,
      h: wallHeight,
      d: gridSize.h + wallThickness * 2,
      x: gridSize.w / 2 + wallThickness / 2,
      z: 0,
    },
  ];

  wallConfigs.forEach((cfg) => {
    const wallGeom = new THREE.BoxGeometry(cfg.w, cfg.h, cfg.d);
    const wall = new THREE.Mesh(wallGeom, wallMat);
    wall.position.set(cfg.x, cfg.h / 2, cfg.z);
    arenaGroup.add(wall);
  });

  // Corner lights
  const corners = [
    [-gridSize.w / 2, gridSize.h / 2],
    [gridSize.w / 2, gridSize.h / 2],
    [-gridSize.w / 2, -gridSize.h / 2],
    [gridSize.w / 2, -gridSize.h / 2],
  ];
  corners.forEach(([x, z]) => {
    const light = new THREE.PointLight(0x4444ff, 0.5, 15);
    light.position.set(x, 2, z);
    arenaGroup.add(light);
  });

  scene.add(arenaGroup);
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
  // =========================================================================

  // Dark body material
  const bodyMat = new THREE.MeshStandardMaterial({
    color: darkColor,
    roughness: 0.4,
    metalness: 0.8,
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
  playerDirections[1] = "RIGHT";
  scene.add(playerBikes[1]);

  // Player 1 light - raised to match larger bike
  playerLights[1] = new THREE.PointLight(P1_COLOR, 3, 15);
  playerLights[1].position.y = 2.5;
  scene.add(playerLights[1]);

  // Player 2 bike (orange)
  playerBikes[2] = createBikeMesh(P2_COLOR, P2_EMISSIVE, P2_DARK);
  playerDirections[2] = "LEFT";
  scene.add(playerBikes[2]);

  // Player 2 light - raised to match larger bike
  playerLights[2] = new THREE.PointLight(P2_COLOR, 3, 15);
  playerLights[2].position.y = 2.5;
  scene.add(playerLights[2]);
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
const TRAIL_WIDTH = 0.5; // Thinner than bike footprint
const TRAIL_LENGTH = 1.08; // Slightly > 1.0 to overlap adjacent segments
const TRAIL_HEIGHT_VISUAL = 0.35; // Lower than bikes for visual hierarchy
const CORNER_SIZE = 0.65; // Square corner pieces to connect turns

// Cached geometries for horizontal (X-axis), vertical (Z-axis), and corners
let trailGeomHorizontal = null; // Stretched along X
let trailGeomVertical = null; // Stretched along Z
let trailGeomCorner = null; // Square piece for turns

// Track last direction per player to detect turns
let lastTrailDirection = { 1: null, 2: null };

function getTrailGeometryHorizontal() {
  if (!trailGeomHorizontal) {
    // Trail continuity: Stretched along X-axis for LEFT/RIGHT movement
    // Length (X) is 1.08 units to overlap with adjacent segments
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
    // Length (Z) is 1.08 units to overlap with adjacent segments
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
    // Corner piece: Square geometry to fill gaps at turns
    // Slightly larger than TRAIL_WIDTH to ensure overlap with both directions
    trailGeomCorner = new THREE.BoxGeometry(
      CORNER_SIZE,
      TRAIL_HEIGHT_VISUAL,
      CORNER_SIZE
    );
  }
  return trailGeomCorner;
}

function getTrailMaterial(playerId) {
  if (!trailMaterials[playerId]) {
    const color = playerId === 1 ? P1_TRAIL_COLOR : P2_TRAIL_COLOR;
    const emissive = playerId === 1 ? P1_EMISSIVE : P2_EMISSIVE;

    // Emissive continuity: Strong glow with low roughness makes segment
    // boundaries less visible, reinforcing the continuous ribbon effect
    trailMaterials[playerId] = new THREE.MeshStandardMaterial({
      color: color,
      emissive: emissive,
      emissiveIntensity: 0.85, // Higher emissive for stronger glow
      roughness: 0.15, // Lower roughness for even light distribution
      metalness: 0.7,
      transparent: true,
      opacity: 0.92, // Slight transparency helps blend segment edges
    });
  }
  return trailMaterials[playerId];
}

/**
 * Creates a trail segment with orientation-aware stretching.
 * The segment is stretched along the player's current movement direction
 * to create visual overlap with adjacent segments, producing the illusion
 * of a continuous light ribbon.
 *
 * At turns (direction changes), a square corner piece is used to ensure
 * visual continuity between horizontal and vertical segments.
 *
 * @param {number} playerId - Player 1 or 2
 * @param {number} x - Grid X coordinate
 * @param {number} y - Grid Y coordinate
 * @param {string} [direction] - Optional direction override (UP/DOWN/LEFT/RIGHT)
 */
function createTrailSegment(playerId, x, y, direction) {
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

  // Update last direction for next segment
  lastTrailDirection[playerId] = dir;

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

  const mesh = new THREE.Mesh(geometry, getTrailMaterial(playerId));
  const worldPos = gridToWorld(x, y);
  mesh.position.set(worldPos.x, TRAIL_HEIGHT_VISUAL / 2, worldPos.z);

  // Store the direction used for this segment (useful for debugging)
  mesh.userData.direction = dir;
  mesh.userData.isCorner = isCorner;

  scene.add(mesh);
  trailMeshes[playerId].set(key, mesh);
}

function clearAllTrails() {
  for (const playerId of [1, 2]) {
    for (const mesh of trailMeshes[playerId].values()) {
      scene.remove(mesh);
    }
    trailMeshes[playerId].clear();
    // Reset direction tracking for new round
    lastTrailDirection[playerId] = null;
  }
}

// =============================================================================
// ANIMATION LOOP
// =============================================================================

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();

  // =========================================================================
  // BIKE VISUAL EFFECTS
  // =========================================================================

  for (const id of [1, 2]) {
    const bike = playerBikes[id];
    if (bike && bike.visible) {
      // Subtle hover bob
      const bob = Math.sin(elapsed * 4 + id * Math.PI) * 0.02;
      bike.position.y = bob;

      // Pulse accent glow
      const pulse = 0.8 + Math.sin(elapsed * 5 + id * Math.PI) * 0.4;
      if (bike.userData.accentMat) {
        bike.userData.accentMat.emissiveIntensity = pulse;
      }
      if (bike.userData.wheelMat) {
        bike.userData.wheelMat.emissiveIntensity =
          0.2 + Math.sin(elapsed * 5 + id * Math.PI) * 0.15;
      }

      // Update point light
      const light = playerLights[id];
      if (light) {
        light.position.x = bike.position.x;
        light.position.z = bike.position.z;
        light.intensity = 1.5 + Math.sin(elapsed * 5 + id * Math.PI) * 0.5;
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
  // =========================================================================

  if (gameStatus === "gameOver") {
    if (ambientLight) ambientLight.intensity = 0.12;
    if (mainLight) mainLight.intensity = 0.35;
    // Dim background during game over
    if (backgroundGroup) backgroundGroup.visible = true;
  } else if (gameStatus === "countdown") {
    if (ambientLight) ambientLight.intensity = 0.2;
    if (mainLight) mainLight.intensity = 0.5;
  } else if (gameStatus === "running") {
    if (ambientLight) ambientLight.intensity = 0.25;
    if (mainLight) mainLight.intensity = 0.7;
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
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("Connected to server");
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
    console.error("WebSocket error:", err);
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

  const isNewRound =
    msg.tick < lastTick ||
    (prevStatus === "countdown" && gameStatus === "running") ||
    (prevStatus === "gameOver" && gameStatus === "ready");

  if (isNewRound) {
    console.log("New round detected, clearing trails");
    clearAllTrails();
    myReadyState = false;
  }
  lastTick = msg.tick;

  gameStatusEl.textContent = gameStatus;

  if (msg.score) {
    scoreP1.textContent = msg.score[1] || 0;
    scoreP2.textContent = msg.score[2] || 0;
  }

  // Update bike positions and directions
  for (const p of msg.players || []) {
    if (playerBikes[p.id]) {
      const worldPos = gridToWorld(p.x, p.y);
      playerBikes[p.id].position.x = worldPos.x;
      playerBikes[p.id].position.z = worldPos.z;
      playerBikes[p.id].visible = p.alive;

      updatePlayerDirection(p.id, p.dir);

      if (playerLights[p.id]) {
        playerLights[p.id].visible = p.alive;
      }
    }
  }

  // Handle trails
  if (msg.trailsFull) {
    for (const playerId of [1, 2]) {
      const serverTrails = msg.trailsFull[playerId] || [];
      const serverKeys = new Set(serverTrails.map((c) => `${c.x},${c.y}`));

      for (const [key, mesh] of trailMeshes[playerId]) {
        if (!serverKeys.has(key)) {
          scene.remove(mesh);
          trailMeshes[playerId].delete(key);
        }
      }

      for (const cell of serverTrails) {
        createTrailSegment(playerId, cell.x, cell.y);
      }
    }
  } else if (msg.trailsDelta) {
    for (const playerId of [1, 2]) {
      const delta = msg.trailsDelta[playerId];
      if (delta) {
        createTrailSegment(playerId, delta.x, delta.y);
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
      break;
  }
}

function handleCountdown(msg) {
  countdownOverlay.style.display = "block";
  readyPanel.style.display = "none";

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
