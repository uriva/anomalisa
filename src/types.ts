export type Metric =
  | "totalCount"
  | "userSpike"
  | "percentageSpike"
  | "percentageDrop";

export type Anomaly = {
  projectId: string;
  eventName: string;
  bucket: string;
  expected: number;
  actual: number;
  zScore: number;
  detectedAt: string;
  metric: Metric;
  userId?: string;
  trend?: string;
};
