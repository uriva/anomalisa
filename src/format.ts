import type { Anomaly } from "./anomaly.ts";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const hourLabel = (h: number) =>
  h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

export const formatBucket = (bucket: string) => {
  const d = new Date(`${bucket}:00:00Z`);
  const h = d.getUTCHours();
  return `${days[d.getUTCDay()]} ${
    months[d.getUTCMonth()]
  } ${d.getUTCDate()}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)} UTC`;
};

export const metricLabel = (metric: Anomaly["metric"]) =>
  metric === "userSpike"
    ? "User Spike"
    : metric === "percentageSpike"
    ? "Percentage Spike"
    : metric === "percentageDrop"
    ? "Percentage Drop"
    : "Total Count";
