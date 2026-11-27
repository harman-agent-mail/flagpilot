// Human-approval gate — Day 2.
//
// The one rule FlagPilot exists to enforce: a proposed experiment start
// is presented to a human (approver identity + the FULL draft summary),
// and the gated call `POST /experiments/{id}/start/` may only fire after
// an explicit approval for that exact draft. Rejection leaves the
// experiment unstarted and is recorded.
//
// State lives in two places, deliberately redundant:
//   1. proposals/<experiment-id>.json — the machine-readable gate state
//      (status: proposed | approved | rejected, approver, draft hash).
//      startExperiment() is only ever reached when this file says
//      `approved` for the exact draft hash being started.
//   2. accountability-log.jsonl — every transition (propose / approve /
//      reject / started) is appended to the hash-chained log, so the
//      approval chain is verifiable after the fact (verify-log).
//
// The gate is enforced in code, not by convention: the CLI has no other
// path to startExperiment(), and approve() re-checks the live experiment
// status (must still be unstarted) and the draft hash (must match what
// was proposed) immediately before firing the start call. A stale or
// tampered proposal cannot start anything.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEntry } from "./accountability.js";
import { getExperiment, startExperiment, type Experiment } from "./flagsmith.js";

export type ProposalStatus = "proposed" | "approved" | "rejected";

export interface Proposal {
  experimentId: number;
  experimentName: string;
  status: ProposalStatus;
  /** sha256 of the canonical draft summary the human was shown. */
  draftHash: string;
  summary: string;
  approver?: string;
  reason?: string;
  proposedAt: string;
  decidedAt?: string;
  dashboard: string;
}

export function draftSummaryHash(summary: string): string {
  return createHash("sha256").update(summary, "utf8").digest("hex");
}

/** The exact text a human is shown before approving or rejecting. */
export function buildSummary(input: {
  experimentId: number;
  experimentName: string;
  hypothesis: string;
  flagName: string;
  controlValue: string;
  variations: { value: string; key: string; weight: number }[];
  controlSplit: number;
  metricName: string;
  metricEvent: string;
  rolloutPercentage: number;
  status: string;
  dashboard: string;
}): string {
  const lines = [
    `Experiment #${input.experimentId}: ${input.experimentName}`,
    `Status in Flagsmith: ${input.status} (must be unstarted to approve)`,
    `Hypothesis: ${input.hypothesis}`,
    `Flag: ${input.flagName} (control value "${input.controlValue}")`,
    `Variations: ${input.variations
      .map((v) => `"${v.value}" key=${v.key} weight=${v.weight}%`)
      .join("; ")}; control split ${input.controlSplit}%`,
    `Metric: ${input.metricName} — event ${input.metricEvent}, occurrence, direction up`,
    `Rollout: ${input.rolloutPercentage}% enrolled`,
    `Dashboard: ${input.dashboard}`,
    `Approving will START this experiment (POST /experiments/${input.experimentId}/start/) and LOCK the flag values. Rejecting leaves it unstarted.`,
  ];
  return lines.join("\n");
}

function proposalsDir(root: string): string {
  return join(root, "proposals");
}

export function proposalPath(root: string, experimentId: number): string {
  return join(proposalsDir(root), `${experimentId}.json`);
}

export function readProposal(root: string, experimentId: number): Proposal | null {
  const p = proposalPath(root, experimentId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Proposal;
}

export function writeProposal(root: string, proposal: Proposal): void {
  mkdirSync(proposalsDir(root), { recursive: true });
  writeFileSync(proposalPath(root, proposal.experimentId), JSON.stringify(proposal, null, 2));
}

/** Find the local draft JSON saved by `flagpilot draft --create`. */
export function findDraft(root: string, experimentId: number): Record<string, unknown> | null {
  const dir = join(root, "drafts");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    const exp = d.experiment as { id?: number } | undefined;
    if (exp?.id === experimentId) return d;
  }
  return null;
}

export function dashboardUrl(projectId: number, envKey: string, experimentId: number): string {
  return `https://app.flagsmith.com/project/${projectId}/environment/${envKey}/experiments/${experimentId}`;
}

export async function propose(
  root: string,
  logPath: string,
  envKey: string,
  projectId: number,
  experimentId: number,
): Promise<Proposal> {
  const experiment: Experiment = await getExperiment(envKey, experimentId);
  if (experiment.status === "running") {
    throw new Error(
      `Experiment #${experimentId} is already running — nothing to propose.`,
    );
  }
  const draft = findDraft(root, experimentId);
  const plan = draft?.plan as
    | {
        hypothesis?: string;
        flagName?: string;
        controlValue?: string;
        variations?: { value: string; key: string; weight: number }[];
        controlSplit?: number;
        metricName?: string;
        metricEvent?: string;
        rolloutPercentage?: number;
      }
    | undefined;
  const summary = buildSummary({
    experimentId,
    experimentName: experiment.name,
    hypothesis: plan?.hypothesis ?? experiment.hypothesis,
    flagName: plan?.flagName ?? `feature #${experiment.feature}`,
    controlValue: plan?.controlValue ?? "control",
    variations: plan?.variations ?? [],
    controlSplit: plan?.controlSplit ?? 50,
    metricName: plan?.metricName ?? `metric`,
    metricEvent: plan?.metricEvent ?? "unknown",
    rolloutPercentage: plan?.rolloutPercentage ?? 100,
    status: experiment.status,
    dashboard: dashboardUrl(projectId, envKey, experimentId),
  });
  const proposal: Proposal = {
    experimentId,
    experimentName: experiment.name,
    status: "proposed",
    draftHash: draftSummaryHash(summary),
    summary,
    proposedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    dashboard: dashboardUrl(projectId, envKey, experimentId),
  };
  writeProposal(root, proposal);
  appendEntry(
    logPath,
    "experiment-start-proposed",
    JSON.stringify({
      experiment_id: experimentId,
      experiment: experiment.name,
      status: experiment.status,
      draft_hash: proposal.draftHash,
      dashboard: proposal.dashboard,
    }),
  );
  return proposal;
}

export async function approve(
  root: string,
  logPath: string,
  envKey: string,
  experimentId: number,
  approver: string,
): Promise<{ proposal: Proposal; started: Experiment }> {
  if (!approver.trim()) {
    throw new Error("Approval needs an approver identity: --approver \"Name <email>\".");
  }
  const proposal = readProposal(root, experimentId);
  if (!proposal) {
    throw new Error(
      `No proposal on file for experiment #${experimentId}. Run 'flagpilot propose' first — nothing starts without a proposal a human has seen.`,
    );
  }
  if (proposal.status === "approved") {
    throw new Error(
      `Experiment #${experimentId} was already approved by ${proposal.approver} — refusing to start twice.`,
    );
  }
  if (proposal.status === "rejected") {
    throw new Error(
      `Experiment #${experimentId} was REJECTED by ${proposal.approver} (${proposal.reason ?? "no reason given"}) — a rejection is final for this proposal. Re-propose to start over.`,
    );
  }
  // Re-verify live state immediately before the gated call: the experiment
  // must still be unstarted, and it must still be the same experiment the
  // human was shown (same name + hypothesis). The draft content itself
  // (flag, variations, metric, split) is locked in the proposal file under
  // its hash — the approver saw exactly that text, and approve() never
  // re-drafts it, so a changed draft cannot slip under an old approval.
  const live: Experiment = await getExperiment(envKey, experimentId);
  if (live.status === "running") {
    throw new Error(
      `Experiment #${experimentId} is already running — refusing to start again.`,
    );
  }
  if (live.name !== proposal.experimentName) {
    throw new Error(
      `Experiment #${experimentId} was renamed since it was proposed ("${proposal.experimentName}" → "${live.name}") — re-propose before approving.`,
    );
  }
  if (live.hypothesis !== proposal.summary.match(/^Hypothesis: (.*)$/m)?.[1]) {
    throw new Error(
      `Experiment #${experimentId} hypothesis changed since it was proposed — re-propose before approving.`,
    );
  }

  const started = await startExperiment(envKey, experimentId);
  if (started.status !== "running") {
    throw new Error(
      `Start call returned status=${started.status}, expected "running". Check the Flagsmith dashboard — the experiment may not have started.`,
    );
  }
  proposal.status = "approved";
  proposal.approver = approver;
  proposal.decidedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeProposal(root, proposal);
  appendEntry(
    logPath,
    "experiment-start-approved",
    JSON.stringify({
      experiment_id: experimentId,
      experiment: live.name,
      approver,
      draft_hash: proposal.draftHash,
      dashboard: proposal.dashboard,
    }),
  );
  appendEntry(
    logPath,
    "experiment-started",
    JSON.stringify({
      experiment_id: experimentId,
      experiment: live.name,
      status: started.status,
      approved_by: approver,
      dashboard: proposal.dashboard,
    }),
  );
  return { proposal, started };
}

export async function reject(
  root: string,
  logPath: string,
  envKey: string,
  experimentId: number,
  approver: string,
  reason: string,
): Promise<{ proposal: Proposal; liveStatus: string }> {
  if (!approver.trim()) {
    throw new Error("Rejection needs an approver identity: --approver \"Name <email>\".");
  }
  const proposal = readProposal(root, experimentId);
  if (!proposal) {
    throw new Error(
      `No proposal on file for experiment #${experimentId}. Run 'flagpilot propose' first.`,
    );
  }
  if (proposal.status !== "proposed") {
    throw new Error(
      `Experiment #${experimentId} proposal is already ${proposal.status} — refusing to re-decide it.`,
    );
  }
  // Verify the experiment is still unstarted — a rejection must never be
  // recorded against something that already started.
  const live: Experiment = await getExperiment(envKey, experimentId);
  if (live.status === "running") {
    throw new Error(
      `Experiment #${experimentId} is already running — it cannot be rejected now.`,
    );
  }
  proposal.status = "rejected";
  proposal.approver = approver;
  proposal.reason = reason || "no reason given";
  proposal.decidedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeProposal(root, proposal);
  appendEntry(
    logPath,
    "experiment-start-rejected",
    JSON.stringify({
      experiment_id: experimentId,
      experiment: live.name,
      approver,
      reason: proposal.reason,
      status_after: live.status,
      dashboard: proposal.dashboard,
    }),
  );
  return { proposal, liveStatus: live.status };
}
