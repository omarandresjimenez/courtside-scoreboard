import { createApp } from './app.js';
import { config } from './config.js';

const { httpServer } = createApp();

httpServer.listen(config.port, () => {
  console.log(`Courtside Scoreboard server listening on port ${config.port}`);
});
