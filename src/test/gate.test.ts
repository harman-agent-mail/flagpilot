// Gate + accountability-log tests — all offline, no Flagsmith API calls.
// Run: npm test  (compiles first: npm run build)
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendEntry, verifyLog } from "../accountability.js";
import { approve, buildSummary, draftSummaryHash, reject } from "../gate.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "flagpilot-test-"));
}

const SUMMARY_INPUT = {
  experimentId: 1,
  experimentName: "buy_now_vs_get_free_shipping",
  hypothesis: 'The "Get free shipping" wording lifts checkout_completed vs "Buy now" over the 3-day build window.',
  flagName: "checkout_cta",
  controlValue: "Buy now",
  variations: [{ value: "Get free shipping", key: "get_free_shipping", weight: 50 }],
  controlSplit: 50,
  metricName: "checkout_completed_rate",
  metricEvent: "checkout_completed",
  rolloutPercentage: 100,
  status: "created",
  dashboard: "https://app.flagsmith.com/project/56414/environment/x/experiments/1",
};

test("draft summary is deterministic and names the gated action", () => {
  const a = buildSummary(SUMMARY_INPUT);
  const b = buildSummary(SUMMARY_INPUT);
  assert.equal(draftSummaryHash(a), draftSummaryHash(b));
  assert.match(a, /checkout_cta/);
  assert.match(a, /Get free shipping/);
  assert.match(a, /checkout_completed/);
  assert.match(a, /POST \/experiments\/1\/start\//);
  assert.match(a, /LOCK the flag/);
});

test("log: append → verify INTACT; tamper → verify BROKEN", () => {
  const root = tmpRoot();
  const log = join(root, "log.jsonl");
  appendEntry(log, "experiment-start-proposed", JSON.stringify({ experiment_id: 1 }));
  appendEntry(log, "experiment-start-rejected", JSON.stringify({ experiment_id: 1 }));
  appendEntry(log, "experiment-start-proposed", JSON.stringify({ experiment_id: 1 }));
  appendEntry(log, "experiment-start-approved", JSON.stringify({ experiment_id: 1 }));
  appendEntry(log, "experiment-started", JSON.stringify({ experiment_id: 1, status: "running" }));
  assert.deepEqual(verifyLog(log), { ok: true, entries: 5 });

  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[1].detail = JSON.stringify({ experiment_id: 1, approver: "Mallory" });
  writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = verifyLog(log);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /entry 2: hash mismatch/);
});

test("approve refuses without a proposal — no start call is reachable", async () => {
  const root = tmpRoot();
  const log = join(root, "log.jsonl");
  await assert.rejects(
    approve(root, log, "envkey", 999, "Test <test@example.com>"),
    /No proposal on file for experiment #999/,
  );
  // Nothing was logged and no proposal file appeared: the gate stopped
  // before any API call, so no experiment could have started.
  assert.deepEqual(verifyLog(log), { ok: true, entries: 0 });
});

test("reject refuses without a proposal", async () => {
  const root = tmpRoot();
  const log = join(root, "log.jsonl");
  await assert.rejects(
    reject(root, log, "envkey", 999, "Test <test@example.com>", "nope"),
    /No proposal on file for experiment #999/,
  );
  assert.deepEqual(verifyLog(log), { ok: true, entries: 0 });
});
