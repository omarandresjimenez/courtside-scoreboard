import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import { Server as SocketIoServer } from 'socket.io';
import { config } from './config.js';
import { courtsRouter } from './routes/courts.js';
import { healthRouter } from './routes/health.js';
import { matchesRouter, setMatchesSocketServer } from './routes/matches.js';
import { tournamentsRouter } from './routes/tournaments.js';
import { tournamentPlayersRouter } from './routes/tournament-players.js';
import { umpiresRouter } from './routes/umpires.js';
import { turnRouter } from './routes/turn.js';
import { registerSocketHandlers } from './sockets/index.js';
import { registerStreamSocketHandlers } from './sockets/stream.js';
import { initializeCloudServices } from './integrations/cloud-sync.js';

export interface CourtsideApp {
  app: Express;
  httpServer: HttpServer;
  io: SocketIoServer;
}

export interface CreateAppOptions {
  /** Overrides config.clientDistPath — mainly so tests can point at a fixture dir. */
  clientDistPath?: string;
}

/**
 * Builds the whole server (Express app + HTTP server + Socket.io) without
 * binding a port, so index.ts can `.listen()` it for real while tests can
 * exercise it directly (e.g. via supertest, or a real socket.io-client
 * against an ephemeral port) — see Set 07 / Set 08 of the design spec for
 * why CORS is wide open here: this is a LAN-only deployment.
 *
 * When the client has been built (`npm run build --workspace packages/client`),
 * this same server also hosts it as static files, with any unmatched GET
 * falling back to index.html — so umpire and TV devices only ever need one
 * address on the LAN, and refreshing a deep link like /umpire/:matchId
 * still resolves correctly. See "Running this for a real match" in the README.
 */
export function createApp(options: CreateAppOptions = {}): CourtsideApp {
  // Initialize cloud services (Firebase) if credentials are available
  initializeCloudServices();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api', healthRouter);
  app.use('/api', matchesRouter);
  app.use('/api', courtsRouter);
  app.use('/api', tournamentsRouter);
  app.use('/api', tournamentPlayersRouter);
  app.use('/api', umpiresRouter);
  app.use('/api', turnRouter);

  const clientDistPath = options.clientDistPath ?? config.clientDistPath;
  if (existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  } else {
    // Expected during local development, where the client runs on its own
    // Vite dev server instead — see packages/client/vite.config.ts.
    console.warn(
      `No client build found at ${clientDistPath} — serving API/Socket.io only. ` +
        'Run "npm run build --workspace packages/client" to host the UI from this server too.',
    );
  }

  const httpServer = createServer(app);
  const io = new SocketIoServer(httpServer, { cors: { origin: '*' } });
  registerSocketHandlers(io);
  registerStreamSocketHandlers(io);
  setMatchesSocketServer(io);

  return { app, httpServer, io };
}
