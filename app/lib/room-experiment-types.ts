export type ExperimentStatus = "queued" | "preparing" | "generating" | "reviewing" | "ready" | "failed";
export type ExperimentView = {
  id: string;
  status: ExperimentStatus;
  message: string;
  attempt: number;
  assetUrl: string | null;
  error: string | null;
  review: { verdict: "matched" | "mismatch" | "unreviewed"; observedActions: string; reasons: string[] } | null;
};
