// Flagsmith Management API client (REST, organisation API key) + CLI v2
// wrapper for the one job the REST shape is least documented for
// (adding keyed multivariate variations — the official agent guide does
// it via `flagsmith feature variant add`).
//
// Base URL: https://api.flagsmith.com (Cloud SaaS). Auth:
//   Authorization: Api-Key <organisation Management API token>
// The token is read ONLY from FLAGSMITH_API_KEY (env var). It is never
// printed, never logged, never committed.
// Free-tier note: an org API key is effectively full org admin, so this
// client is deliberately draft-only by default — it creates flags, metrics
// and experiments in an UNSTARTED state. Starting an experiment
// (POST .../experiments/{id}/start/) is the gated action and lives behind
// the human-approval gate (gate.ts): startExperiment() may only be called
// from there, after an explicit approval is recorded. Nothing else in
// this codebase calls it.
//
// Payload shapes verified against Flagsmith's official agent guide:
// https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent
// (read 2026-11-26).

// (child_process spawn is imported dynamically inside cli())

const API_BASE = process.env.FLAGSMITH_API_URL ?? "https://api.flagsmith.com";
export const CLI_PATH =
  process.env.FLAGSMITH_CLI_PATH ?? `${process.env.HOME}/.local/bin/flagsmith`;

export function apiKey(): string {
  const key = process.env.FLAGSMITH_API_KEY;
  if (!key) {
    throw new Error(
      "FLAGSMITH_API_KEY is not set. Create an organisation Management API " +
        "token in the Flagsmith dashboard (Organisation Settings → API Access) " +
        "and export it as an env var — never put it in the repo.",
    );
  }
  return key;
}

export async function api<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  // Transport retries (2026-11-26: undici pooled connections closed by the
  // other side mid-request, "SocketError: other side closed", on the live
  // API). Retry the request on transport errors only — HTTP error
  // responses are real answers and are NOT retried. `Connection: close`
  // avoids reusing a stale pooled connection.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Api-Key ${apiKey()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Connection: "close",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      const cause =
        err instanceof Error ? (err.cause ?? err.message) : String(err);
      throw new Error(
        `Flagsmith API ${method} ${path} → fetch failed: ${cause}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Flagsmith API ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw lastErr;
}

/**
 * Write to the Management API via the CLI's `api` passthrough
 * (`flagsmith api <path> --input -`, POST implied).
 *
 * WHY: outbound HTTP POSTs from this VM's Node/curl die at the socket
 * ("other side closed" / exec session killed) — verified 2026-11-26
 * against both api.flagsmith.com and httpbin.org, while GETs are fine.
 * The Go CLI's POSTs go through fine, so all FlagPilot writes ride the
 * CLI. Reads stay on plain fetch (GETs work). If the VM's egress ever
 * stops killing POSTs, this can switch back to direct fetch.
 */
export async function apiWrite<T>(path: string, body: unknown): Promise<T> {
  const out = await cli(["api", `/api/v1${path}`, "--input", "-"], JSON.stringify(body));
  return JSON.parse(out) as T;
}
export async function cli(args: string[], stdin?: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, args, {
      env: { ...process.env, FLAGSMITH_API_KEY: apiKey() },
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `flagsmith ${args.join(" ")} → exit ${code}: ${(stderr || stdout).slice(0, 400)}`,
          ),
        );
        return;
      }
      if (stderr.trim() && !stdout.trim()) {
        // CLI writes progress to stderr on some commands; only surface it
        // if stdout is empty (i.e. the command produced no result).
        resolve(stderr);
        return;
      }
      resolve(stdout);
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

// --- Types (subset of the Management API shapes we use) -------------------

export interface Project {
  id: number;
  name: string;
  organisation: number;
}

export interface Environment {
  id: number;
  name: string;
  api_key: string;
  project: number;
}

export interface Feature {
  id: number;
  name: string;
  project: number;
  description?: string;
  type: string;
  default_enabled: boolean;
  initial_value: string | null;
}

export interface MultivariateOption {
  id: number;
  multivariate_feature: number;
  type: string;
  string_value: string;
  default_percentage_allocation: number;
}

export interface ExperimentMetric {
  id: number;
  name: string;
  aggregation: string;
  direction: string;
  definition: { version: number; event: string };
}

export interface Experiment {
  id: number;
  name: string;
  hypothesis: string;
  status: string;
  feature: number;
  experiment_rollout: {
    rollout_percentage: number;
    percentage_allocation: { multivariate_feature_option: number; percentage_allocation: number }[];
  };
}

// --- Reads -----------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  return api<Project[]>("/projects/");
}

export async function listEnvironments(projectId: number): Promise<Environment[]> {
  return api<Environment[]>(`/projects/${projectId}/environments/`);
}

export async function listWarehouseConnections(
  environmentKey: string,
): Promise<unknown[]> {
  return api<unknown[]>(`/environments/${environmentKey}/warehouse-connections/`);
}

export async function listFeatures(projectId: number): Promise<Feature[]> {
  return api<Feature[]>(`/projects/${projectId}/features/`);
}

export async function getFeature(projectId: number, name: string): Promise<Feature> {
  return api<Feature>(`/projects/${projectId}/features/${name}/`);
}

export async function listExperiments(environmentKey: string): Promise<Experiment[]> {
  return api<Experiment[]>(`/environments/${environmentKey}/experiments/`);
}

export async function getExperiment(
  environmentKey: string,
  experimentId: number,
): Promise<Experiment> {
  return api<Experiment>(`/environments/${environmentKey}/experiments/${experimentId}/`);
}

/**
 * Start an experiment — POST /environments/{env_key}/experiments/{id}/start/.
 * Status becomes "running" and the flag locks.
 *
 * GATED ACTION: this function must only ever be called from the human-
 * approval gate (gate.ts / `flagpilot approve`), after an explicit
 * approval has been recorded for this exact experiment id in the
 * accountability log AND in the proposal store. Nothing else in this
 * codebase calls it — grep for `startExperiment` to prove it. Calling
 * it directly bypasses the gate and the accountability log, so do not.
 */
export async function startExperiment(
  environmentKey: string,
  experimentId: number,
): Promise<Experiment> {
  // Bodiless POST via the CLI passthrough (same VM egress reason as
  // apiWrite: Node fetch POSTs die on this VM).
  const out = await cli([
    "api",
    `/api/v1/environments/${environmentKey}/experiments/${experimentId}/start/`,
    "-X",
    "POST",
  ]);
  return JSON.parse(out) as Experiment;
}

// --- Draft creation (all safe: nothing created here is live) ---------------

export async function createMultivariateFeature(
  projectId: number,
  name: string,
  description: string,
  controlValue: string,
): Promise<Feature> {
  // Writes go through the CLI passthrough (apiWrite): Node fetch POSTs
  // die on this VM (see apiWrite). Verified live 2026-11-26.
  return apiWrite<Feature>(`/projects/${projectId}/features/`, {
    name,
    description,
    type: "MULTIVARIATE",
    default_enabled: true,
    initial_value: controlValue,
  });
}

/**
 * Add one variation to a multivariate flag via the official CLI v2
 * (`flagsmith feature variant add <flag> --value <v> --key <k> --weight <w>`).
 * Every variation MUST carry a `key` — without one Flagsmith records no
 * exposures for it (official agent guide). `control` is reserved for the
 * flag's own value, so variations are the challengers only.
 */
export async function addVariation(
  projectId: number,
  flagName: string,
  value: string,
  key: string,
  weight: number,
): Promise<void> {
  await cli([
    "feature",
    "variant",
    "add",
    flagName,
    "--project",
    String(projectId),
    "--value",
    value,
    "--key",
    key,
    "--weight",
    String(weight),
  ]);
}

export async function createMetric(
  environmentKey: string,
  name: string,
  event: string,
): Promise<ExperimentMetric> {
  return apiWrite<ExperimentMetric>(
    `/environments/${environmentKey}/experiment-metrics/`,
    {
      name,
      aggregation: "occurrence",
      direction: "up",
      definition: { version: 1, event },
    },
  );
}

export interface DraftExperimentInput {
  name: string;
  hypothesis: string;
  featureId: number;
  metricId: number;
  rolloutPercentage: number;
  // percentage allocation per challenger variation id (control gets the rest)
  allocations: { multivariate_feature_option: number; percentage_allocation: number }[];
}

export async function createExperiment(
  environmentKey: string,
  input: DraftExperimentInput,
): Promise<Experiment> {
  // Creates the experiment in a DRAFT / unstarted state. It does NOT start
  // it — starting locks the flag and turns on the rollout, and only happens
  // after a human approves (Day 2 gate). Payload shape verbatim from the
  // official agent guide.
  return apiWrite<Experiment>(`/environments/${environmentKey}/experiments/`, {
    feature: input.featureId,
    name: input.name,
    hypothesis: input.hypothesis,
    metrics: [{ metric: input.metricId, expected_direction: "increase" }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: input.rolloutPercentage,
      feature_state_value: { type: "string", value: "control" },
      multivariate_feature_state_values: input.allocations,
    },
  });
}
