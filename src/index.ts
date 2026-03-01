/**
 * Majlis Agent Service — entry point
 *
 * Starts the Express HTTP server and the cron scheduler.
 * Copy .env.example → .env and fill in the values before running.
 */

import { startServer } from './server';
import { startScheduler } from './scheduler';

const PORT = Number(process.env.PORT) || 3001;

startServer(PORT);
startScheduler();
