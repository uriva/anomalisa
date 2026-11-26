# Anomalisa

## Code Style & Testing

- Minimal comments and no JSDoc; rely on types and variable names.
- Functional style with `gamla` (`pipe`, `map`, `filter`, `reduce`, `each`,
  `empty`, `nonempty`). Avoid `for`/`while` loops, classes, and `let`.
- Avoid `as`, `any`, `unknown`, non-null assertions (`!`), `@ts-ignore`, and
  `@ts-expect-error`. Trust strict types; no defensive programming.
- Use arrow functions (without braces when possible), destructure in signatures,
  prefer ternaries over `if/else` returns, and inline single-use variables.
- Keep functions at the module level (use currying instead of default parameter
  values or nested functions). Do not enlarge existing functions when adding
  logic.
- Static imports at top of file; `export const` instead of `export default`
  (except `instant.schema.ts`).
- Avoid `try`/`catch` unless necessary, and never duplicate constants or string
  literals.
- **Always write a failing test before fixing a quality issue.**
- **Threshold tuning:** Compute actual stats (mean, stdDev, z-score) from real
  production data before choosing detection thresholds — never eyeball numbers.

## Deno & Deployment

- Dependencies live in `deno.json` (no root `package.json`).
- **Auto-deploy on push to `main`:** Pushing to `main` automatically triggers
  `.github/workflows/deploy-worker.yml`, which runs `deno task check` and
  `deno task deploy` (`npx wrangler deploy`) to deploy to Cloudflare Workers
  (`https://anomalisa.uriv.me`).
- **Auto-publish to npm:** Pushing a bumped `version` in `deno.json` to `main`
  automatically runs `.github/workflows/publish.yml`, which builds the
  zero-dependency ESM + `.d.ts` package via `deno task build:npm` and publishes
  `anomalisa` to npm.

## Architecture

- **API (`src/api.ts`, `mod.ts`):** Uses `@uri/typed-api`
  (`{ endpoint, payload }`) with `sendEvent` and `getAnomalies`, authenticated
  via project `token`.
- **Storage:**
  - **Turso (`src/turso.ts`, `src/anomaly.ts`):** Hourly event count buckets,
    Welford's online running stats (z-score > 2), detected anomalies, cooldowns,
    rate limits.
  - **InstantDB (`src/db.ts`, `instant.schema.ts`):** Users (magic code auth)
    and projects (`name`, `token`).
- **Email & Auto-Issues (`src/email.ts`, `src/autoIssue.ts`):** Sends alerts via
  AgentMail (`anomalisa@theagentmail.net`, `AGENTMAIL_API_KEY`) with `/feedback`
  and `/investigate` ("Create GitHub issue") links (`src/feedback.ts`,
  `src/investigate.ts`, `src/github.ts`), automatically opening GitHub issues
  via the `@uriv/chaff` decision model (`GEMINI_API_KEY`) when warranted and
  reflecting opened issues in the alert email.
- **Billing & Plan Gating (`src/billing.ts`, `src/webhook.ts`):** Stripe Pro
  ($15/mo) subscriptions (`GET /api/billing/status`, `POST /api/billing/checkout`,
  `POST /api/billing/portal`, `POST /api/billing/sync`,
  `POST /api/stripe/webhook`, `POST /project-settings`). Enforces monthly event
  quotas (Free: 100k/mo, Pro: 1M/mo) and gates team multi-email alerts, signed
  webhooks with delivery retries (`X-Anomalisa-Signature`), and automated AI
  GitHub issue investigation to Pro.
- **Web (`src/server.ts`, `web/`):** Serves `/` (`web/index.html`), `/app`
  (`web/app.html`), `/docs` (`web/docs.html`), `/feedback`, `/investigate`, and
  `/config`.
- **Required `.env` vars:** `INSTANTDB_APP_ID`, `INSTANTDB_ADMIN_TOKEN`,
  `AGENTMAIL_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
  `GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRO_PRICE_ID` (optional; falls back to inline $15/mo recurring price).
