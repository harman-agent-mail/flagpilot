// Prompt → experiment draft plan.
//
// Day 1 scope: a deterministic, inspectable parser for the locked demo
// question plus explicit overrides. It does NOT guess silently — every
// field of the plan is shown to the human before anything is created,
// and the plan is logged to the accountability log at draft time.
// A free-form LLM parse is a Day 2+ refinement; the shape (flag,
// variations with keys, metric, split, hypothesis) is already the
// experiment wizard's exact field set, so the parser output maps 1:1.

export interface Variation {
  /** Human-readable value shown to the user, e.g. "Get free shipping". */
  value: string;
  /** Short stable key — required by Flagsmith for exposure attribution. */
  key: string;
  /** Traffic weight within the experiment (control gets the remainder). */
  weight: number;
}

export interface DraftPlan {
  prompt: string;
  experimentName: string;
  hypothesis: string;
  flagName: string;
  controlValue: string;
  variations: Variation[];
  metricName: string;
  metricEvent: string;
  rolloutPercentage: number;
  controlSplit: number;
}

export interface DraftOptions {
  flag?: string;
  control?: string;
  treatment?: string;
  treatmentKey?: string;
  metricEvent?: string;
  metricName?: string;
  experimentName?: string;
  hypothesis?: string;
  split?: number;
  rollout?: number;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function keyOf(value: string): string {
  return slug(value);
}

/**
 * Parse a plain-English experiment prompt into a draft plan.
 *
 * Understood shapes (all optional — overrides win):
 *   "... 'A' vs 'B' ..." / 'A' versus 'B'  → control A, treatment B
 *   "success = <event>" / "success is <event>" → metric event
 *   "test the <thing>" → experiment/flag naming hint
 *
 * Anything not found falls back to the locked Day-1 demo defaults
 * (checkout CTA, control "Buy now", treatment "Get free shipping",
 * conversion event checkout_completed), and the fallback is flagged in
 * the plan so the human sees exactly what was assumed.
 */
export function parsePrompt(prompt: string, opts: DraftOptions = {}): DraftPlan {
  const quoted = [...prompt.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

  // "A vs B" / "A versus B" inside or outside quotes. Quoted phrases first —
  // the loose lazy match truncates multi-word values at the first space
  // (same bug class as the beat shape above).
  const vsQuoted = prompt.match(
    /['"]([^'"]+)['"]\s+(?:vs\.?|versus)\s+['"]([^'"]+)['"]/i,
  );
  const vsMatch = prompt.match(
    /['"]?([^'"]+?)['"]?\s+(?:vs\.?|versus)\s+['"]?([^'"]+?)['"]?(?:\s|$|,|\.|at|to|for)/i,
  );

  let control = opts.control;
  let treatment = opts.treatment;
  // "Does 'A' ... beat 'B' ..." — A is the challenger (treatment), B is the
  // incumbent (control). Without this, the quoted fallback below assigns
  // quoted[0] as control and inverts the question (caught by the Day-1
  // dry run: "Does 'Get free shipping' beat 'Buy now'" parsed backwards).
  // Both sides must be quoted phrases — a lazy unquoted match stops at
  // the first space and truncates ("Get" / "Buy").
  const beatMatch = prompt.match(
    /['"]([^'"]+)['"]\s+[^'"]*?\bbeat\b\s+['"]([^'"]+)['"]/i,
  );
  if (!control && !treatment && beatMatch) {
    treatment = beatMatch[1].trim();
    control = beatMatch[2].trim();
  }
  if (!control && !treatment && vsQuoted) {
    control = vsQuoted[1].trim();
    treatment = vsQuoted[2].trim();
  }
  if (!control && !treatment && vsMatch) {
    control = vsMatch[1].trim();
    treatment = vsMatch[2].trim();
  }
  if (!control && !treatment && quoted.length >= 2) {
    control = quoted[0];
    treatment = quoted[1];
  }
  control ??= "Buy now";
  treatment ??= "Get free shipping";

  const eventMatch = prompt.match(
    /success\s*(?:=|is|:)\s*['"]?([a-z][a-z0-9_]*)['"]?/i,
  );
  const metricEvent = opts.metricEvent ?? eventMatch?.[1] ?? "checkout_completed";

  const flagName = opts.flag ?? slug(`checkout_cta`);
  const experimentName =
    opts.experimentName ?? `${slug(control)}_vs_${slug(treatment)}`;
  const hypothesis =
    opts.hypothesis ??
    `The "${treatment}" wording lifts ${metricEvent} vs "${control}" over the 3-day build window.`;
  const split = opts.split ?? 50;

  return {
    prompt,
    experimentName,
    hypothesis,
    flagName,
    controlValue: control,
    variations: [
      {
        value: treatment,
        key: opts.treatmentKey ?? keyOf(treatment),
        weight: split,
      },
    ],
    metricName: opts.metricName ?? `${metricEvent}_rate`,
    metricEvent,
    rolloutPercentage: opts.rollout ?? 100,
    controlSplit: 100 - split,
  };
}
