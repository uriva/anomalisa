import { empty } from "gamla";
import type { Anomaly } from "./anomaly.ts";
import { formatBucket, metricLabel } from "./email.ts";
import {
  type AlertFeedbackRecord,
  getAlertFeedback,
  renderDetails,
} from "./feedback.ts";
import { centerPageStyles, escapeHtml, renderPage } from "./page.ts";

type HistorySnapshot = {
  counts: number[];
  buckets: { bucket: string; count: number }[];
};

const anomalyLine = (anomaly: Anomaly) =>
  `- ${
    metricLabel(anomaly.metric)
  }: expected ${anomaly.expected}, actual ${anomaly.actual}, z-score ${anomaly.zScore}${
    anomaly.userId ? `, user ${anomaly.userId}` : ""
  }${anomaly.trend ? `, trend: ${anomaly.trend}` : ""}`;

export const buildAgentPrompt = (
  record: AlertFeedbackRecord,
  projectName: string,
): string => {
  const anomalies = JSON.parse(record.anomaliesJson) as Anomaly[];
  const history = JSON.parse(record.historyJson) as Partial<HistorySnapshot>;
  const counts = history.counts ?? [];
  const buckets = history.buckets ?? [];
  const anomalyLines = empty(anomalies)
    ? [
      `- ${record.metric}: expected ${record.expected}, actual ${record.actual}, z-score ${record.zScore}`,
    ]
    : anomalies.map(anomalyLine);
  return `Investigate this Anomalisa anomaly and report the most likely cause, with evidence and next steps.

Project: ${projectName || record.projectId}
Project ID: ${record.projectId}
Event: ${record.eventName}
Bucket: ${record.bucket} (${formatBucket(record.bucket)})
Metric: ${record.metric}
Expected: ${record.expected}
Actual: ${record.actual}
Z-score: ${record.zScore}
User: ${record.userId === "_" ? "(none)" : record.userId}
Detected at: ${anomalies[0]?.detectedAt ?? "unknown"}

Recent hourly counts, oldest to newest:
${empty(counts) ? "(no history snapshot)" : counts.join(", ")}

Recent buckets:
${
    empty(buckets)
      ? "(no history snapshot)"
      : buckets.map(({ bucket, count }) => `${bucket}: ${count}`).join("\n")
  }

Anomalies in this bucket:
${anomalyLines.join("\n")}

Running stats:
${record.statsJson ?? "(none)"}

What to check:
- Find where the "${record.eventName}" event is emitted and whether a recent deploy or config change affects that path.
- Check upstream services, databases, and third-party APIs used around this bucket.
- Check whether a single user, bot, or traffic source explains the change.
- Compare adjacent hours and the same hour on previous days.
`;
};

const investigateStyles = `
    body { padding: 1.5rem 1rem; }
    .card { max-width: 760px; text-align: left; }
    .subtitle { font-size: 0.9rem; color: #a1a1aa; margin: 0 0 1.25rem 0; line-height: 1.4; }
    .prompt-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
    .copy-btn { display: inline-block; width: auto; font-family: inherit; cursor: pointer; }
    .hint { font-size: 0.8rem; color: #71717a; line-height: 1.45; margin: 0 0 1rem 0; }
    .prompt { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; line-height: 1.55; color: #d4d4d8; background: #0f0f0f; border: 1px solid #27272a; border-radius: 8px; padding: 1rem; max-height: 60vh; overflow: auto; }
    @media (max-width: 480px) {
      .prompt { font-size: 0.72rem; padding: 0.75rem; }
    }
`;

const copyScript = `<script>
  const copyButton = document.getElementById("copy-agent");
  const promptText = document.getElementById("agent-prompt");
  const copyLabel = "Copy text for agent";
  const flashCopied = () => {
    copyButton.textContent = "Copied!";
    setTimeout(() => {
      copyButton.textContent = copyLabel;
    }, 1800);
  };
  const copyWithTextarea = (text) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    flashCopied();
  };
  const copyPrompt = () => {
    const text = promptText.textContent ?? "";
    if (!navigator.clipboard) {
      copyWithTextarea(text);
      return;
    }
    navigator.clipboard.writeText(text).then(flashCopied).catch(() => copyWithTextarea(text));
  };
  copyButton.addEventListener("click", copyPrompt);
</script>`;

export const renderInvestigateHtml = (
  record: AlertFeedbackRecord | null,
  projectName: string,
): string =>
  !record
    ? renderPage({
      title: "Alert Details Not Found — Anomalisa",
      styles: centerPageStyles,
      body: `<div class="card">
    <h1>Alert Details Not Found</h1>
    <p>This alert link is invalid or has expired.</p>
    <p style="margin-top: 1.5rem;"><a href="/app">Go to Anomalisa Dashboard</a></p>
  </div>`,
    })
    : renderPage({
      title: `Investigate ${record.eventName} — Anomalisa`,
      styles: investigateStyles,
      script: copyScript,
      body: `<div class="card">
    <div class="brand">Anomalisa · Agent handoff</div>
    <h1>Investigate this anomaly</h1>
    <p class="subtitle">${
        escapeHtml(projectName || record.projectId)
      } — <code>${escapeHtml(record.eventName)}</code></p>
    ${renderDetails(record)}
    <div class="prompt-actions">
      <button class="btn-primary copy-btn" id="copy-agent" type="button">Copy text for agent</button>
      <a class="home-link" href="/app">Go to Dashboard</a>
    </div>
    <p class="hint">Email apps can't access the clipboard, so the copy button lives here. The prompt includes the alert details and investigation starting points.</p>
    <pre class="prompt" id="agent-prompt">${
        escapeHtml(buildAgentPrompt(record, projectName))
      }</pre>
  </div>`,
    });

export const handleInvestigate = async (
  url: URL,
  resolveProjectName: (projectId: string) => Promise<string>,
): Promise<{ html: string; status: number }> => {
  const token = url.searchParams.get("token");
  if (!token) return { html: renderInvestigateHtml(null, ""), status: 404 };
  const record = await getAlertFeedback(token);
  if (!record) return { html: renderInvestigateHtml(null, ""), status: 404 };
  return {
    html: renderInvestigateHtml(
      record,
      await resolveProjectName(record.projectId),
    ),
    status: 200,
  };
};
