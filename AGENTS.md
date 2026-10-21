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

- Dependencies live in `deno.json` (no `package.json`).
- Deployed to Deno Deploy (`https://anomalisa.uriva.deno.net`) and published to
  JSR (`@uri/anomalisa`) automatically on push to `main` (bump `version` in
  `deno.json` to publish a new JSR version).

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
- **Email (`src/email.ts`):** Sends alerts via AgentMail
  (`anomalisa@theagentmail.net`, `AGENTMAIL_API_KEY`) with `/feedback` and
  `/investigate` links (`src/feedback.ts`, `src/investigate.ts`).
- **Web (`src/server.ts`, `web/`):** Serves `/` (`web/index.html`), `/app`
  (`web/app.html`), `/docs` (`web/docs.html`), `/feedback`, `/investigate`, and
  `/config`.
- **Required `.env` vars:** `INSTANTDB_APP_ID`, `INSTANTDB_ADMIN_TOKEN`,
  `AGENTMAIL_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
