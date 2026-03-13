/**
 * Majlis Agent Service — entry point
 *
 * Starts the Express HTTP server and the cron scheduler.
 * Copy .env.example → .env and fill in the values before running.
 *
 * GAP-INF3 CLOSED: Global unhandled rejection and uncaught exception handlers.
 * GAP-O2 CLOSED: Sentry error tracking initialized before anything else.
 */

import { initSentry, captureException } from '@/lib/sentry';
import { createModuleLogger } from '@/lib/logger';
import { startServer } from './server';
import { startScheduler } from './scheduler';

// GAP-O2 CLOSED: Initialize Sentry before anything else runs
initSentry();

const log = createModuleLogger('main');

// ── GAP-INF3 CLOSED: Global error handlers ────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  log.error({ reason, promise: String(promise) }, 'Unhandled promise rejection');
  captureException(reason, { type: 'unhandledRejection' });
});

process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'Uncaught exception — process will exit');
  captureException(error, { type: 'uncaughtException' });
  // Give the logger time to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT received — shutting down gracefully');
  process.exit(0);
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3001;

startServer(PORT);
startScheduler();
