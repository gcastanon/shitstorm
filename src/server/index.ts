import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ArenaRoom } from "./ArenaRoom";
import { loadTuning, tuningPath } from "./tuningLoader";

const PORT = Number(process.env.PORT ?? 2567);

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Serve the built client from the same port as the game, when there is one.
 *
 * This is what makes deploying it one process on one port: the page and the
 * WebSocket share an origin, so the client needs no configured endpoint, TLS is
 * inherited from however the page was served, and there is nothing for a reverse
 * proxy to stitch together. Without it a deployment needs two listeners and a
 * proxy just to introduce them to each other.
 *
 * In development there is no build — Vite serves the page on 5173 and proxies
 * nothing — so the old "you are on the wrong port" note stands in, which is a
 * common enough wrong turn to be worth keeping.
 */
const CLIENT_DIR = join(process.cwd(), "dist", "client");
const HAS_CLIENT = existsSync(join(CLIENT_DIR, "index.html"));

if (HAS_CLIENT) {
  app.use(express.static(CLIENT_DIR));
  // One page, so anything unrecognised is still the game.
  app.get("*", (_req, res) => res.sendFile(join(CLIENT_DIR, "index.html")));
} else {
  app.get("/", (_req, res) => {
    res.status(200).type("html").send(
      `<body style="font:14px ui-monospace,monospace;background:#070b14;color:#e2e8f0;padding:40px">
         <p>This is the SHITSTORM <b>game server</b>, and no client build was found.</p>
         <p>In development the game is at <a style="color:#38bdf8" href="http://localhost:5173/">http://localhost:5173/</a> &mdash; run <code>npm run dev</code>.</p>
         <p>To serve the game from this port instead, run <code>npm run build</code> and restart.</p>
       </body>`,
    );
  });
}

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("arena", ArenaRoom);

const tuning = loadTuning();
gameServer.listen(PORT).then(() => {
  console.log(`SHITSTORM server on ws://localhost:${PORT}`);
  console.log(
    HAS_CLIENT
      ? `serving the client from ${CLIENT_DIR} — open http://localhost:${PORT}/`
      : `no client build at ${CLIENT_DIR}; run npm run build, or npm run dev for the dev server`,
  );
  console.log(`tuning loaded from ${tuningPath()} (${tuning.net.tickHz}Hz / ${tuning.net.patchHz}Hz)`);
});
