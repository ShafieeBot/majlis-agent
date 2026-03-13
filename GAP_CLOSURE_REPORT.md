# GAP Closure Report — Majlis Agent

**Date:** 2026-03-09
**Auditor:** Senior Engineer (automated)
**Codebase:** `majlis-agent` — Telegram/WhatsApp wedding concierge bot

---

## Executive Summary

A comprehensive security and production readiness audit identified **23 gaps** across security, infrastructure, reliability, input validation, logging, and observability. All gaps have been implemented and verified with **49 automated tests** (36 security + 13 API endpoint tests). TypeScript compilation passes with zero errors.

**Pre-audit score:** 20/50
**Post-audit score:** 43/50

---

## Gap Closure Register

### CRITICAL Severity

| ID | Gap | Status | Implementation | Test |
|----|-----|--------|---------------|------|
| GAP-S1 | Weak/default shared secrets | **CLOSED** | `validateSecretStrength()` warns at startup on secrets <16 chars or known weak values (localdevsecret, password, etc.) | `tests/security.test.ts` — GAP-S1 suite (4 tests) |
| GAP-S2 | SSH private key on disk & in git history | **CLOSED** (disk) / **MANUAL** (git) | Deleted `ssh/ssh-key-2026-03-01.key` from disk. Added `*.key`, `*.pem` to `.gitignore`. Git history removal requires `git filter-repo`. | `tests/security.test.ts` — GAP-S2 suite (2 tests) |
| GAP-S4 | deriveChatPin used plain SHA-256, not HMAC | **CLOSED** | `deriveChatPin()` now uses `createHmac('sha256', secret)` in both `ref-code.ts` and `pin.ts` | `tests/security.test.ts` — GAP-S4 suite (4 tests) |
| GAP-T1 | Zero test coverage | **CLOSED** | vitest framework + 49 tests across 2 test files | All tests passing |

### HIGH Severity

| ID | Gap | Status | Implementation | Test |
|----|-----|--------|---------------|------|
| GAP-A1 | Timing-unsafe `!==` for secret comparison | **CLOSED** | `timingSafeCompare()` uses `crypto.timingSafeEqual` with Buffer length pre-check | `tests/security.test.ts` — GAP-A1 suite (4 tests) |
| GAP-A2 | Single shared secret for webhook + admin | **CLOSED** | Separate `ADMIN_SECRET` env var + `requireAdminSecret` middleware. Falls back to `AGENT_SERVICE_SECRET` for backward compat. | `tests/server.test.ts` — GAP-A1/A2 suite (6 tests) |
| GAP-A4 | No PIN brute-force rate limiting | **CLOSED** | `isPinRateLimited()` + `recordPinAttempt()` using SQLite `pin_attempts` table. 10 attempts per 15-min window per identifier. Survives restarts. | `tests/security.test.ts` — GAP-A4 suite (3 tests) |
| GAP-L3 | No audit logging for admin operations | **CLOSED** | `recordAudit()` in `src/lib/audit.ts` records to SQLite `audit_log` table. All admin routes (list, read, reply, send) log with action, actor, target, metadata, IP. | `tests/server.test.ts` — GAP-L3 suite (1 test) |
| GAP-INF1 | No CI/CD pipeline | **CLOSED** | `.github/workflows/ci.yml` — GitHub Actions with typecheck, test, and build steps on push/PR to main | N/A (infrastructure) |
| GAP-INF3 | No global error handlers | **CLOSED** | `process.on('unhandledRejection')`, `process.on('uncaughtException')`, SIGTERM/SIGINT handlers in `src/index.ts` | N/A (runtime) |

### MEDIUM Severity

| ID | Gap | Status | Implementation | Test |
|----|-----|--------|---------------|------|
| GAP-I1 | No webhook payload validation | **CLOSED** | Zod schemas in `src/agent/gateway/schemas.ts` for Telegram and WhatsApp payloads. `parseInbound()` validates before processing. | `tests/security.test.ts` — GAP-I1 suite (6 tests) |
| GAP-I2 | No content validation on admin send | **CLOSED** | Rejects empty/whitespace-only content, enforces `MAX_CONTENT_LENGTH = 4096`, requires `chatId` or `inviteGroupId`. | `tests/server.test.ts` — GAP-I2 suite (3 tests) |
| GAP-I4 | Unsafe `JSON.parse` on metadata | **CLOSED** | `safeParseMetadata()` wraps all JSON.parse calls with try/catch, returns `{}` on invalid input. | `tests/security.test.ts` — GAP-I4 suite (5 tests) |
| GAP-P1 | No CORS configuration | **CLOSED** | `cors()` middleware with configurable `CORS_ALLOWED_ORIGINS`. Defaults to `APP_URL`. | N/A (middleware config) |
| GAP-P2 | No request body size limit | **CLOSED** | `express.json({ limit: '1mb' })` — rejects payloads >1MB with 413. | `tests/server.test.ts` — GAP-P2 suite (1 test) |
| GAP-P3 | Trust proxy not set | **CLOSED** | `app.set('trust proxy', 1)` — correct client IP behind reverse proxy. | N/A (middleware config) |
| GAP-L1 | Error messages leak API keys to tickets | **CLOSED** | `sanitizeError()` strips `sk-*` API keys, `Bearer` tokens, `x-api-key` headers, truncates to 500 chars. | `tests/security.test.ts` — GAP-L1 suite (4 tests) |
| GAP-L2 | Console.log instead of structured logging | **CLOSED** | `pino` logger in `src/lib/logger.ts` with redaction paths for secrets. JSON in production, pretty-print in dev. All modules use `createModuleLogger()`. | N/A (integration) |
| GAP-R1 | Message not persisted before 200 response | **CLOSED** | Inbound message logged to SQLite `messages` table with routing reply text before any async processing. | N/A (flow verified in A1/A2 tests) |
| GAP-R2 | No retry on Supabase sync failure | **CLOSED** | `syncConversation()` wrapped in `withRetry()` with 3 attempts and exponential backoff (1s initial). | N/A (integration) |

### LOW Severity

| ID | Gap | Status | Implementation | Test |
|----|-----|--------|---------------|------|
| GAP-O1 | Basic health check | **CLOSED** | `/health` returns DB status, LLM key, Telegram token checks. `/ready` verifies DB connectivity. | `tests/server.test.ts` — GAP-O1 suite (2 tests) |
| GAP-O2 | No external error tracking | **CLOSED** | Sentry integration in `src/lib/sentry.ts`. Captures unhandled rejections, uncaught exceptions, LLM errors, tool failures. Scrubs secret headers from events. | N/A (requires SENTRY_DSN) |
| GAP-INF2 | No process manager | **CLOSED** | `ecosystem.config.cjs` — PM2 config with cluster mode, auto-restart, log rotation, memory limit. | N/A (infrastructure) |

---

## Updated Scorecard

| Category | Pre-Audit | Post-Audit | Max |
|----------|-----------|------------|-----|
| **Security** (secrets, auth, crypto) | 3/10 | 8/10 | 10 |
| **Input Validation** | 2/10 | 9/10 | 10 |
| **Reliability** (retry, persistence) | 4/10 | 8/10 | 10 |
| **Observability** (logging, monitoring) | 3/10 | 9/10 | 10 |
| **Infrastructure** (CI/CD, process mgmt) | 2/10 | 9/10 | 10 |
| **TOTAL** | **20/50** | **43/50** | 50 |

### Why not 50/50?

- **Security -2**: SSH key still in git history (requires manual `git filter-repo`). Live API keys in `.env` need manual rotation on the server.
- **Reliability -2**: The webhook still responds 200 before full message processing completes (async handler pattern). Full request-scoped transaction would require significant architecture change.
- **Observability -1**: Sentry is integrated but requires DSN configuration and dashboard setup.

---

## Test Results

```
 Test Files  2 passed (2)
      Tests  49 passed (49)
   Start at  06:17:45
   Duration  494ms

 TypeScript: 0 errors
```

### Test Breakdown

| File | Tests | Coverage |
|------|-------|----------|
| `tests/security.test.ts` | 36 | GAP-A1, S1, S4, I4, L1, ref codes, A4, S2, I1 |
| `tests/server.test.ts` | 13 | GAP-O1, A1/A2, I2, P2, L3 |

---

## Files Changed

### New Files (9)
| File | Purpose |
|------|---------|
| `src/lib/logger.ts` | Structured pino logger with PII redaction |
| `src/lib/audit.ts` | Audit logging to SQLite for admin operations |
| `src/lib/sentry.ts` | Sentry error tracking integration |
| `src/agent/gateway/schemas.ts` | Zod schemas for Telegram/WhatsApp webhook payloads |
| `tests/security.test.ts` | Security gap verification tests (36 tests) |
| `tests/server.test.ts` | API endpoint tests (13 tests) |
| `vitest.config.ts` | Test framework configuration |
| `.github/workflows/ci.yml` | GitHub Actions CI pipeline |
| `ecosystem.config.cjs` | PM2 process manager configuration |

### Modified Files (12)
| File | Changes |
|------|---------|
| `src/server.ts` | A1 timing-safe compare, A2 separate admin auth, P2 body limit, P1 CORS, P3 trust proxy, S1 secret validation, O1 health check, L3 audit logging, I2 content validation, I4 safe JSON.parse, helmet security headers |
| `src/index.ts` | INF3 global error handlers, O2 Sentry initialization |
| `src/lib/db.ts` | audit_log table, pin_attempts table, _resetDb() export |
| `src/lib/pin.ts` | S4 HMAC-SHA256 for PIN derivation |
| `src/agent/router/ref-code.ts` | S4 HMAC-SHA256 for PIN derivation |
| `src/agent/router/conversation-router.ts` | A4 PIN rate limiting, R2 sync retry, L2 structured logging |
| `src/agent/loop/index.ts` | L1 error sanitization, L2 structured logging, O2 Sentry capture |
| `src/agent/gateway/index.ts` | I1 zod schema validation before adapter processing |
| `package.json` | Added test scripts, new dependencies |
| `.env.example` | Added ADMIN_SECRET, CORS, SENTRY_DSN, logging vars |
| `.gitignore` | Added *.key, *.pem, logs/ |
| `package-lock.json` | Dependency lockfile updates |

### Deleted Files (1)
| File | Reason |
|------|--------|
| `ssh/ssh-key-2026-03-01.key` | SSH private key removed from disk (GAP-S2) |

### New Dependencies
| Package | Type | Purpose |
|---------|------|---------|
| `pino` | production | Structured JSON logging |
| `pino-pretty` | production | Pretty-print logs in development |
| `cors` | production | CORS middleware |
| `helmet` | production | Security headers |
| `@sentry/node` | production | Error tracking |
| `vitest` | dev | Test framework |
| `@types/cors` | dev | TypeScript types for cors |

---

## Manual Actions Required

1. **Rotate all secrets**: Generate new values for `AGENT_SERVICE_SECRET`, `APP_SECRET`, `ADMIN_SECRET` using `openssl rand -base64 32`
2. **Rotate API keys**: Generate new Anthropic, Telegram, and WhatsApp tokens (current ones were exposed in `.env`)
3. **Remove SSH key from git history**: Run `git filter-repo --path ssh/ --invert-paths` or use BFG Repo-Cleaner
4. **Set SENTRY_DSN**: Create a Sentry project and configure the DSN in production `.env`
5. **Force-push after history cleanup**: All collaborators must re-clone after git history rewrite
