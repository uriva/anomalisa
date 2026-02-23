# anomalisa

You're shipping fast. Multiple projects, lots of moving parts. Something breaks or spikes at 2am and you find out the next morning from a user complaint.

Anomalisa watches your event streams and emails you when something weird happens. A sudden spike in signups, a drop in purchases, one user hammering your API 100x more than normal. You send events, it learns what's normal, and it tells you when things aren't.

No dashboards to check. No thresholds to configure. Just email alerts when the math says something is off.

**Try it now at [anomalisa.deno.dev](https://anomalisa.deno.dev)**

This is also fully open source. Run it yourself, fork it, rip it apart.

## how it works

You send events with a project token and user id. Anomalisa counts them in hourly buckets and builds a statistical model using Welford's online algorithm. When the current hour's count deviates more than 2 standard deviations from the running mean, you get an email.

It tracks two things:

**Total event count anomalies.** Your signup event usually gets ~50/hour. Suddenly it's 200. Or 3. You'll know.

**Per-user spike detection.** One user is generating 100x more events than the typical user in the same time window. Could be a bot, abuse, or a bug on their end.

No configuration needed. It learns from the data and stays quiet until something is genuinely unusual. The first few hours are a cold start period where it collects baseline data without alerting.

## quickstart

Install from JSR:

```
deno add jsr:@uri/anomalisa
```

Send events from your app:

```ts
import { sendEvent } from "@uri/anomalisa";

await sendEvent({
  token: "your-project-token",
  userId: "user-123",
  eventName: "purchase",
});
```

Get your token by signing up at [anomalisa.deno.dev](https://anomalisa.deno.dev), creating a project, and copying the token.

Check detected anomalies:

```ts
import { getAnomalies } from "@uri/anomalisa";

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

For per-user spikes, `metric` will be `"userSpike"` and `userId` will be included.

## self-hosting

Clone the repo and create a `.env`:

```
INSTANTDB_APP_ID=your-instantdb-app-id
INSTANTDB_ADMIN_TOKEN=your-instantdb-admin-token
FORWARD_EMAIL_API_KEY=your-forward-email-api-key
EMAIL_DOMAIN=your-domain.com
```

You'll need an [InstantDB](https://instantdb.com) app for user/project management and a [Forward Email](https://forwardemail.net) account for alerts.

Push the schema and permissions:

```
npx instant-cli push schema --app $INSTANTDB_APP_ID --token $INSTANTDB_ADMIN_TOKEN
npx instant-cli push perms --app $INSTANTDB_APP_ID --token $INSTANTDB_ADMIN_TOKEN
```

Run locally:

```
deno run --unstable-kv --allow-net --allow-env --allow-read src/server.ts
```

## license

MIT
