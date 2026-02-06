/**
 * Tron Lightcycles - Authoritative Server
 *
 * HTTP + WebSocket server setup, connection management, and message routing.
 * All game logic delegated to game.js
 *
 * Run: npm install ws && node server.js
 * Then visit: http://localhost:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const Game = require("./game.js");

// =============================================================================
// PORT CONFIGURATION (RENDER-COMPATIBLE)
// Render assigns a dynamic port via process.env.PORT
// Fallback to 3000 for local development
// =============================================================================
const PORT = process.env.PORT || 3000;

// Create HTTP server to serve static files
const httpServer = http.createServer((req, res) => {
  // Serve index.html for root path
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, "client", filePath);

  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
    res.end(data);
  });
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server: httpServer });

// Single game instance (supports exactly 2 players)
const game = new Game();

// Start HTTP server
// Bind to 0.0.0.0 for cloud platforms (Render requires this)
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Tron server running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Open two browser tabs to play!`);
});

wss.on("connection", (ws) => {
  // Reject third connection
  if (game.getPlayerCount() >= 2) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Server full. Only 2 players allowed.",
      })
    );
    ws.close();
    return;
  }

  // Assign player to game
  const playerId = game.addPlayer(ws);
  console.log(`Player ${playerId} connected`);

  // Send assignment message with grid dimensions
  ws.send(
    JSON.stringify({
      type: "assign",
      playerId: playerId,
      grid: game.getGridSize(),
    })
  );

  // Broadcast updated state to all players
  game.broadcastState();

  // Handle incoming messages
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    // Route message to game logic
    switch (msg.type) {
      case "start":
        // Player clicked ready/start button
        game.handleStart(playerId);
        break;

      case "input":
        // Movement input
        if (!msg.dir || !["UP", "DOWN", "LEFT", "RIGHT"].includes(msg.dir)) {
          ws.send(
            JSON.stringify({ type: "error", message: "Invalid direction" })
          );
          return;
        }
        game.handleInput(playerId, msg.dir);
        break;

      case "reset":
        // Reset request (only valid in gameOver state)
        game.handleReset(playerId);
        break;

      default:
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Unknown message type: ${msg.type}`,
          })
        );
    }
  });

  // Handle disconnection
  ws.on("close", () => {
    console.log(`Player ${playerId} disconnected`);
    game.removePlayer(playerId);
  });

  ws.on("error", (err) => {
    console.error(`Player ${playerId} WebSocket error:`, err.message);
  });
});
