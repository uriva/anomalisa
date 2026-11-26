# anomalisa

You're shipping fast. Multiple projects, lots of moving parts. Something breaks
or spikes at 2am and you find out the next morning from a user complaint.

Anomalisa watches your event streams and emails you when something weird
happens. A sudden spike in signups, a drop in purchases, one user hammering your
API 100x more than normal. You send events, it learns what's normal, and it
tells you when things aren't.

No dashboards to check. No thresholds to configure. Just email alerts when the
math says something is off.

**Try it now at [anomalisa.uriv.me](https://anomalisa.uriv.me)**

This is also fully open source. Run it yourself, fork it, rip it apart.

## how it works

You send events with a project token and user id. Anomalisa counts them in
hourly buckets (`YYYY-MM-DDTHH`) and maintains a decaying Welford's online
algorithm baseline (`statsDecay = 0.98`, `minDataPoints = 3`,
`minColdStartCount = 5`) per event.

It tracks four metrics independently:

- **`totalCount`**: Uses a two-sided Poisson test (`p < 1e-3`, encoding
  `-log10(p)` in `zScore`) when variance is near-Poisson, falling back to `3σ`
  (`zScoreThreshold = 3`) when overdispersed (`stdDev > max(1, sqrt(mean))`).
  Includes cold-start burst detection (`count >= 5` when `n < 3`), live
  mid-hour spike checks, and per-hour-of-day (`byHour:<HH>`) seasonality.
- **`percentageSpike`**: Fires when an hourly count is `>100%` above the
  rolling mean (`diff >= 3`, `mean >= 10`, `z >= 2.5`) and is not explained by
  `byHour:<HH>` seasonality.
- **`percentageDrop`**: Fires on a single-hour `>50%` drop (`mean >= 30`,
  `diff >= 3`, `z >= 1.05`) or a rolling 2h/6h/24h drop against the prior 3-6
  days (`z >= 2.5`; skipped for error/failure events).
- **`userSpike`**: Tracks `max_user_counts` (the highest single-user count per
  hourly bucket) into a per-event `"perUser"` Welford baseline (`0.98` decay),
  and alerts when any single user's current-hour count exceeds it by `> 3.5σ`
  (`minDataPoints = 3`, `count >= 3`, and `count >= 5` if `0 < mean < 1`).

No configuration needed. It learns from the data, applies a 48-hour directional
cooldown to prevent alert spam unless an anomaly escalates by >2x, and stays
quiet during the initial cold start (`minDataPoints = 3`) unless a rare burst
(`count >= 5`) occurs.

## quickstart

Install with npm:

```
npm i anomalisa
```

Or with Deno:

```
deno add npm:anomalisa
```

Send events from your app:

```ts
import { sendEvent } from "anomalisa";

await sendEvent({
  token: "your-project-token",
  userId: "user-123",
  eventName: "purchase",
});
```

Get your token by signing up at [anomalisa.uriv.me](https://anomalisa.uriv.me),
creating a project, and copying the token.

Check detected anomalies:

```ts
import { getAnomalies } from "anomalisa";

const { anomalies } = await getAnomalies({ token: "your-project-token" });
```

Each anomaly looks like:

```json
{
  "projectId": "abc-123",
  "eventName": "purchase",
  "bucket": "2026-02-23T14",
  "expected": 48.5,
  "actual": 3,
  "zScore": 4.21,
  "metric": "totalCount",
  "detectedAt": "2026-02-23T15:00:01.234Z"
}
```

`metric` can be `"totalCount"`, `"percentageSpike"`, `"percentageDrop"`, or
`"userSpike"`. For per-user spikes, `metric` is `"userSpike"` and `userId` is
included.

## self-hosting

Clone the repo and create a `.env`:

```
TURSO_DATABASE_URL=your-turso-database-url
TURSO_AUTH_TOKEN=your-turso-auth-token
INSTANTDB_APP_ID=your-instantdb-app-id
INSTANTDB_ADMIN_TOKEN=your-instantdb-admin-token
AGENTMAIL_API_KEY=your-agentmail-api-key
# Optional: enables automatic GitHub issue triage via @uriv/chaff
GEMINI_API_KEY=your-gemini-api-key
```

You'll need a [Turso](https://turso.tech) database for event counts, Welford
baselines, and anomalies, an [InstantDB](https://instantdb.com) app for
user/project management, and an [AgentMail](https://theagentmail.net) account
for email alerts (`GEMINI_API_KEY` is optional for automatic GitHub issue
triage).

Push the schema and permissions:

```
npx instant-cli push schema --app $INSTANTDB_APP_ID --token $INSTANTDB_ADMIN_TOKEN
npx instant-cli push perms --app $INSTANTDB_APP_ID --token $INSTANTDB_ADMIN_TOKEN
```

Run locally:

```
deno run --allow-net --allow-env --allow-read src/server.ts
```

## license

MIT
