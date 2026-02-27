# Anomalisa

## Code Style

Avoid commenting unless necessary. No jsdoc. Typings and variable names should
do the documenting.

Prefer functional programming, use gamla functions when applicable. Prefer point
free pipelines using gamla `pipe` if applicable over chaining dot notation or
reassigning.

Constant naming should be in normal case, e.g. `const myConstant = 1;`

Avoid `let`, prefer `const`.

Avoid `as`, `any`, `unknown`, null asserting operator (`!`) and @ts-ignore or
@ts-expect-error.

Use arrow functions instead of the `function` keyword. Prefer arrow functions
without braces if possible.

Avoid nesting functions, prefer putting in the module level, possible with
currying.

Factor out logic, preferrable to module level functions. When adding logic,
function bodies typically should not enlarge. New logic can be encapsulated in a
new function.

Avoid dynamic imports, use static imports instead.

Place imports at the top of the file.

Don't use `export default`, prefer `export const` (exception: instant.schema.ts
which requires default export for the CLI).

Avoid default values for parameters. If something is recurring use currying or a
constant instead.

Avoid using `try`/`catch` unless necessary.

Avoid for loops, while loops, and classes. Use gamla's `map`, `filter`, `reduce`
and so on, or `each` if you need just to cause side effects per item.

Avoid duplication when adding new logic, or copying existing patterns.
Especially avoid duplicating constants or string literals.

Prefer destructuring in function signature, especially over one letter
variables.

Prefer ternary over `if (x) { return y; } else { return z; };`.

Prefer `empty` and `nonempty` from gamla over `array.length === 0` or similar.

If a type is inferrable from the function, prefer not to annotate it.

Variables that are used only once should be inlined. If their RHS is too large
to inline, make them a function.

No defensive programming, assume inputs are correct unless there is a good
reason not to. Prefer typing inputs strictly.

# Deno stuff

This is a deno project. Deps are in deno.json, there is no package.json.

Deployed to Deno Deploy at `https://anomalisa.deno.dev`. Published to JSR as
`@uri/anomalisa`.

To deploy a new version, update the version in deno.json and push to main.

# Architecture

## Overview

Anomalisa is an event-tracking service with anomaly detection. Users send events
via the client SDK, the server detects anomalies using hourly bucketing and
Welford's online algorithm (z-score > 2), and sends email alerts via Forward
Email.

## API

Uses `@uri/typed-api` (JSON-RPC style). Request body is `{ endpoint, payload }`.
Two endpoints:

- `sendEvent` — records an event, returns anomaly if detected
- `getAnomalies` — returns all recorded anomalies for a project

Both take `token` (not `projectId`) — the server looks up the project by token
in InstantDB.

## Database

- **Deno KV** — event counts (hourly buckets, 7d TTL), running stats
  (mean/variance via Welford's), detected anomalies (30d TTL)
- **InstantDB** — user accounts (magic code auth), projects (name + token),
  project-owner links. Schema in `instant.schema.ts`.

## Email

Forward Email from domain `f0mo.com`. API key and domain are env vars in `.env`.

## Web

Three static HTML pages served by `src/server.ts`:

- `/` — landing page (`web/index.html`)
- `/app` — dashboard with auth, project CRUD, anomaly viewer (`web/app.html`)
- `/docs` — SDK documentation (`web/docs.html`)
- `/config` — returns `{ instantdbAppId }` as JSON

The app uses InstantDB client SDK from CDN for auth (magic codes) and project
management.

## Key Files

| File                | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `mod.ts`            | Client SDK (sendEvent, getAnomalies)      |
| `src/api.ts`        | Zod-validated API definition              |
| `src/server.ts`     | HTTP server, auth, routing, web serving   |
| `src/anomaly.ts`    | Deno KV anomaly detection engine          |
| `src/db.ts`         | InstantDB admin client, token lookup      |
| `src/email.ts`      | Forward Email client for anomaly alerts   |
| `instant.schema.ts` | InstantDB schema (projects, users, links) |
| `web/index.html`    | Landing page                              |
| `web/app.html`      | Dashboard app (auth, projects, anomalies) |
| `web/docs.html`     | SDK documentation                         |

## Env Vars (in .env, gitignored)

- `INSTANTDB_APP_ID` — InstantDB app identifier
- `INSTANTDB_ADMIN_TOKEN` — InstantDB admin token
- `FORWARD_EMAIL_API_KEY` — Forward Email API key
- `EMAIL_DOMAIN` — domain for sending emails (e.g. `f0mo.com`)
