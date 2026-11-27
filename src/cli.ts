// FlagPilot CLI — Day 1 draft pipeline + Day 2 human-approval gate.
//   flagpilot draft --prompt "..." [--create]
//   flagpilot status
//   flagpilot verify-log
//   flagpilot propose --experiment <id> [--project N] [--env KEY]
//   flagpilot approve --experiment <id> --approver "Name <email>" --confirm
//   flagpilot reject --experiment <id> --approver "Name <email>" [--reason "..."]
//
// The draft pipeline turns a plain-English prompt into a Flagsmith
// experiment DRAFT: multivariate flag + keyed variation + metric +
// experiment in an UNSTARTED state. Nothing here starts an experiment —
// starting is the human-gated action (Day 2): `propose` shows the full
// draft summary to a human and records the proposal; `approve` (explicit
// --confirm + approver identity) is the ONLY path to the start call;
// `reject` leaves the experiment unstarted and records the rejection.
// Every proposal, approval, rejection and start is appended to the
// hash-chained accountability log (accountability-log.jsonl,
// cardtool-accountability/1 format).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEntry, readLog, verifyLog } from "./accountability.js";
import { parsePrompt, type DraftPlan } from "./draft.js";
import {
  addVariation,
  createExperiment,
  createMetric,
  createMultivariateFeature,
  getFeature,
  listEnvironments,
  listExperiments,
  listProjects,
  listWarehouseConnections,
} from "./flagsmith.js";
import { approve, propose, reject } from "./gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(ROOT, "accountability-log.jsonl");
const DRAFTS_DIR = join(ROOT, "drafts");

// --- tiny .env loader (no dependency; .env is gitignored, never committed)
// Loads flagpilot/.env first, then the lab-level
// ~/workspace/jarvis-lab/projects/toggle-wars/.env where the real token
// lives (outside the repo, per the build plan).
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function loadEnv(): void {
  loadEnvFile(join(ROOT, ".env"));
  loadEnvFile(join(ROOT, "..", ".env"));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : undefined;
}

async function cmdStatus(): Promise<void> {
  const projects = await listProjects();
  console.log(`Projects (${projects.length}):`);
  for (const p of projects) {
    console.log(`  #${p.id} ${p.name}`);
    const envs = await listEnvironments(p.id);
    for (const e of envs) {
      const wh = await listWarehouseConnections(e.api_key);
      console.log(
        `    env ${e.name} key=${e.api_key} warehouse_connections=${wh.length}`,
      );
    }
  }
}

async function cmdDraft(): Promise<void> {
  const prompt = arg("--prompt");
  if (!prompt) {
    throw new Error('Usage: flagpilot draft --prompt "..." [--create]');
  }
  const plan: DraftPlan = parsePrompt(prompt, {
    flag: arg("--flag"),
    control: arg("--control"),
    treatment: arg("--treatment"),
    treatmentKey: arg("--treatment-key"),
    metricEvent: arg("--metric-event"),
    metricName: arg("--metric-name"),
    experimentName: arg("--experiment-name"),
    hypothesis: arg("--hypothesis"),
    split: arg("--split") ? Number(arg("--split")) : undefined,
    rollout: arg("--rollout") ? Number(arg("--rollout")) : undefined,
  });

  console.log("Draft plan (nothing created yet):");
  console.log(JSON.stringify(plan, null, 2));

  const projectId = arg("--project") ? Number(arg("--project")) : envInt("FLAGSMITH_PROJECT_ID");
  const envKey = arg("--env") ?? process.env.FLAGSMITH_ENVIRONMENT_KEY;
  if (!has("--create")) {
    console.log("\nDry run — pass --create to create the flag, metric and unstarted experiment in Flagsmith.");
    return;
  }
  if (!projectId || !envKey) {
    throw new Error(
      "Creating needs --project <id> and --env <environment key> (or FLAGSMITH_PROJECT_ID / FLAGSMITH_ENVIRONMENT_KEY in .env).",
    );
  }

  // 1. Warehouse prerequisite — experiments cannot exist without one.
  const wh = await listWarehouseConnections(envKey);
  if (wh.length === 0) {
    throw new Error(
      "No warehouse connection on this environment. Enable the managed Flagsmith warehouse first (Environment Settings → Warehouse → Flagsmith → Enable). Refusing to draft without it.",
    );
  }

  // 2. Guard: a flag already in another experiment cannot be reused.
  const existing = await listExperiments(envKey);
  const flag = await getFeature(projectId, plan.flagName).catch(() => null);
  if (flag) {
    const clash = existing.find((e) => e.feature === flag.id);
    if (clash) {
      throw new Error(
        `Flag ${plan.flagName} is already in experiment #${clash.id} (${clash.name}). Flagsmith blocks reuse — pick a different flag.`,
      );
    }
  }

  const createdFlag =
    flag ??
    (await createMultivariateFeature(
      projectId,
      plan.flagName,
      `FlagPilot draft: ${plan.experimentName}`,
      plan.controlValue,
    ));
  console.log(`Flag: ${createdFlag.name} (id ${createdFlag.id})`);

  // 3. Keyed variation(s) — every variation needs a key for exposures.
  for (const v of plan.variations) {
    await addVariation(projectId, plan.flagName, v.value, v.key, v.weight);
    console.log(`Variation: key=${v.key} value="${v.value}" weight=${v.weight}`);
  }

  // 4. Metric (occurrence, direction up, case-sensitive event name).
  const metric = await createMetric(envKey, plan.metricName, plan.metricEvent);
  console.log(`Metric: ${metric.name} (id ${metric.id}) event=${plan.metricEvent}`);

  // 5. Experiment — created, NOT started. Starting locks the flag and is
  // the human-gated action (Day 2); this run never calls start.
  // Variation ids come from the flag's multivariate options; re-read the
  // flag via the CLI to get them.
  const { cli } = await import("./flagsmith.js");
  const flagJson = await cli([
    "feature",
    "get",
    plan.flagName,
    "--project",
    String(projectId),
    "--json",
  ]);
  const flagDetail = JSON.parse(flagJson) as {
    multivariate_options?: { id: number; string_value: string }[];
  };
  const allocations = (flagDetail.multivariate_options ?? [])
    .filter((o) => plan.variations.some((v) => v.value === o.string_value))
    .map((o) => ({
      multivariate_feature_option: o.id,
      percentage_allocation:
        plan.variations.find((v) => v.value === o.string_value)?.weight ?? 50,
    }));
  if (allocations.length !== plan.variations.length) {
    throw new Error(
      `Could not resolve variation ids for the experiment (found ${allocations.length}/${plan.variations.length}). Flag and metric exist; experiment not created.`,
    );
  }

  const experiment = await createExperiment(envKey, {
    name: plan.experimentName,
    hypothesis: plan.hypothesis,
    featureId: createdFlag.id,
    metricId: metric.id,
    rolloutPercentage: plan.rolloutPercentage,
    allocations,
  });
  console.log(`Experiment: ${experiment.name} (id ${experiment.id}) status=${experiment.status} — UNSTARTED (draft only)`);

  // 6. Record the draft + everything created in the accountability log.
  const dashboard = `https://app.flagsmith.com/project/${projectId}/environment/${envKey}/experiments/${experiment.id}`;
  mkdirSync(DRAFTS_DIR, { recursive: true });
  const draftPath = join(DRAFTS_DIR, `${plan.experimentName}.json`);
  writeFileSync(
    draftPath,
    JSON.stringify({ plan, flag: createdFlag, metric, experiment, dashboard }, null, 2),
  );
  const e1 = appendEntry(
    LOG_PATH,
    "experiment-draft-proposed",
    JSON.stringify({ prompt: plan.prompt, experiment: plan.experimentName, flag: plan.flagName, metric: plan.metricEvent, dashboard }),
  );
  const e2 = appendEntry(
    LOG_PATH,
    "experiment-draft-created",
    JSON.stringify({ experiment_id: experiment.id, flag_id: createdFlag.id, metric_id: metric.id, status: experiment.status, dashboard }),
  );
  console.log(`\nDraft saved: ${draftPath}`);
  console.log(`Dashboard: ${dashboard}`);
  console.log(`Accountability log: seq ${e1.seq} + ${e2.seq} appended (head ${e2.hash.slice(0, 12)}…)`);
  console.log("NOT STARTED — a human must approve before anything goes live (Day 2 gate).");
}

function envKeyOrArg(): string {
  const k = arg("--env") ?? process.env.FLAGSMITH_ENVIRONMENT_KEY;
  if (!k) {
    throw new Error("--env <environment key> or FLAGSMITH_ENVIRONMENT_KEY is required.");
  }
  return k;
}

function projectIdOrArg(): number {
  const id = arg("--project") ? Number(arg("--project")) : envInt("FLAGSMITH_PROJECT_ID");
  if (!id) {
    throw new Error("--project <id> or FLAGSMITH_PROJECT_ID is required.");
  }
  return id;
}

async function cmdPropose(): Promise<void> {
  const id = arg("--experiment") ? Number(arg("--experiment")) : NaN;
  if (!Number.isFinite(id)) {
    throw new Error('Usage: flagpilot propose --experiment <id> [--project N] [--env KEY]');
  }
  const proposal = await propose(ROOT, LOG_PATH, envKeyOrArg(), projectIdOrArg(), id);
  console.log("Proposal for a human approver — nothing has started:");
  console.log("─".repeat(72));
  console.log(proposal.summary);
  console.log("─".repeat(72));
  console.log(`Draft hash: ${proposal.draftHash}`);
  console.log(`Logged: experiment-start-proposed (proposal ${proposal.experimentId}.json)`);
  console.log(`\nTo approve: flagpilot approve --experiment ${id} --approver "Name <email>" --confirm`);
  console.log(`To reject:  flagpilot reject --experiment ${id} --approver "Name <email>" --reason "..."`);
}

async function cmdApprove(): Promise<void> {
  const id = arg("--experiment") ? Number(arg("--experiment")) : NaN;
  if (!Number.isFinite(id)) {
    throw new Error('Usage: flagpilot approve --experiment <id> --approver "Name <email>" --confirm');
  }
  if (!has("--confirm")) {
    throw new Error(
      "Approval needs an explicit --confirm flag. Read the proposal summary first (flagpilot propose), then re-run with --confirm.",
    );
  }
  const approver = arg("--approver");
  if (!approver) {
    throw new Error('Approval needs an approver identity: --approver "Name <email>".');
  }
  const { proposal, started } = await approve(ROOT, LOG_PATH, envKeyOrArg(), id, approver);
  console.log(`APPROVED by ${approver} — experiment #${id} (${proposal.experimentName}) is now ${started.status.toUpperCase()}.`);
  console.log(`Dashboard: ${proposal.dashboard}`);
  console.log("Logged: experiment-start-approved + experiment-started (hash-chained).");
}

async function cmdReject(): Promise<void> {
  const id = arg("--experiment") ? Number(arg("--experiment")) : NaN;
  if (!Number.isFinite(id)) {
    throw new Error('Usage: flagpilot reject --experiment <id> --approver "Name <email>" [--reason "..."]');
  }
  const approver = arg("--approver");
  if (!approver) {
    throw new Error('Rejection needs an approver identity: --approver "Name <email>".');
  }
  const { proposal, liveStatus } = await reject(
    ROOT,
    LOG_PATH,
    envKeyOrArg(),
    id,
    approver,
    arg("--reason") ?? "",
  );
  console.log(`REJECTED by ${approver} — experiment #${id} (${proposal.experimentName}) stays ${liveStatus.toUpperCase()} (unstarted).`);
  console.log(`Reason: ${proposal.reason}`);
  console.log("Logged: experiment-start-rejected (hash-chained). Re-propose to start over.");
}

async function main(): Promise<void> {
  loadEnv();
  const cmd = process.argv[2];
  if (cmd === "draft") await cmdDraft();
  else if (cmd === "status") await cmdStatus();
  else if (cmd === "propose") await cmdPropose();
  else if (cmd === "approve") await cmdApprove();
  else if (cmd === "reject") await cmdReject();
  else if (cmd === "verify-log") {
    const r = verifyLog(LOG_PATH);
    if (r.ok) {
      const counts: Record<string, number> = {};
      for (const e of readLog(LOG_PATH)) counts[e.action] = (counts[e.action] ?? 0) + 1;
      console.log(`Log INTACT — ${r.entries} entries`);
      for (const [action, n] of Object.entries(counts).sort()) {
        console.log(`  ${action}: ${n}`);
      }
    } else {
      console.log(`Log BROKEN — ${r.error}`);
      process.exitCode = 1;
    }
  } else {
    console.log("Usage: flagpilot <draft|status|propose|approve|reject|verify-log>");
    console.log('  draft --prompt "..." [--create] [--project N] [--env KEY]');
    console.log("  propose --experiment <id> [--project N] [--env KEY]");
    console.log('  approve --experiment <id> --approver "Name <email>" --confirm');
    console.log('  reject --experiment <id> --approver "Name <email>" [--reason "..."]');
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && (err as { cause?: unknown }).cause !== undefined) {
    console.error(`Cause: ${String((err as { cause?: unknown }).cause)}`);
  }
  process.exitCode = 1;
});
