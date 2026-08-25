import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { matchesRouter } from './routes/matches.js';
import { registerSocketHandlers } from './sockets/index.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', healthRouter);
app.use('/api', matchesRouter);

const httpServer = createServer(app);

// A local LAN deployment, so CORS is wide open here by design — see
// "Set 02 — Architecture" for why there's no external network boundary
// to defend beyond the umpire token / admin password already enforced
// above the socket and route layers.
const io = new Server(httpServer, { cors: { origin: '*' } });
registerSocketHandlers(io);

httpServer.listen(config.port, () => {
  console.log(`Courtside Scoreboard server listening on port ${config.port}`);
});
