import { createServer } from "node:http";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ArenaRoom } from "./ArenaRoom";
import { loadTuning, tuningPath } from "./tuningLoader";

const PORT = Number(process.env.PORT ?? 2567);

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

// This port speaks WebSocket, not HTML. Landing here in a browser is a common
// wrong turn, so say where the game actually is instead of a bare 404.
app.get("/", (_req, res) => {
  res.status(200).type("html").send(
    `<body style="font:14px ui-monospace,monospace;background:#070b14;color:#e2e8f0;padding:40px">
       <p>This is the SHITSTORM <b>game server</b> (WebSocket only).</p>
       <p>The game is at <a style="color:#38bdf8" href="http://localhost:5173/">http://localhost:5173/</a> &mdash; run <code>npm run dev:client</code> if it is not up.</p>
     </body>`,
  );
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("arena", ArenaRoom);

const tuning = loadTuning();
gameServer.listen(PORT).then(() => {
  console.log(`SHITSTORM server on ws://localhost:${PORT}`);
  console.log(`tuning loaded from ${tuningPath()} (${tuning.net.tickHz}Hz / ${tuning.net.patchHz}Hz)`);
});
