# FlagPilot

**An agent that drafts Flagsmith experiments from plain English — and refuses to start one without a human.**

Built for [Toggle Wars](https://www.wemakedevs.org/hackathons/flagsmith) (WeMakeDevs × Flagsmith), Track 02: AI Agents and Feature Flags.

## The problem

Flagsmith's native four-eyes approval (Change Requests) is a Scale-Up/Enterprise feature. On the free tier, an organisation API key is effectively full org admin: any agent holding it can start an experiment and lock a flag with no human in the loop. FlagPilot is the approval gate + audit trail free and self-hosted teams otherwise cannot get.

## How it works

```
human: "Does 'Get free shipping' beat 'Buy now' at getting people
        to complete checkout?"
  │
  ▼  flagpilot draft --prompt "..." --create
  ├─ multivariate flag `checkout_cta` (control "Buy now")
  ├─ keyed variation "Get free shipping" (key=get_free_shipping)
  ├─ metric `checkout_completed_rate` (occurrence, up, event checkout_completed)
  └─ experiment `buy_now_vs_get_free_shipping` — status: created (UNSTARTED)
  │
  ▼  flagpilot propose --experiment 1411        ← shows the full draft to a human
  │
  ▼  flagpilot approve --experiment 1411 --approver "Name <email>" --confirm
     └─ ONLY now: POST /experiments/1411/start/ — flag locks, rollout begins
     (or: flagpilot reject — the experiment stays unstarted, forever, on record)
  │
  ▼  results: win probability, lift, 95% credible interval, rollout call
```

Every proposal, approval, rejection and start is appended to a **hash-chained, tamper-evident accountability log** (`accountability-log.jsonl`, `cardtool-accountability/1` format — same verifier as [cardtool](https://github.com/harman-agent-mail/cardtool)). Verify it any time:

```
flagpilot verify-log        # Log INTACT — N entries (or BROKEN, with the entry)
```

## Setup

```bash
npm install
npm run build
```

Create an organisation Management API token in Flagsmith (Organisation Settings → API Access) and export it — **never commit it, never print it**:

```bash
export FLAGSMITH_API_KEY="…"           # org Management API token
export FLAGSMITH_PROJECT_ID="56414"   # your project
export FLAGSMITH_ENVIRONMENT_KEY="…"  # environment key (Development)
```

Or put them in a `.env` file next to the repo (gitignored; see `.env.example`). The CLI needs the official Flagsmith CLI v2 on PATH (`flagsmith --version` ≥ v2.0.0) — all FlagPilot writes go through its `api` passthrough.

## Commands

| Command | What it does |
|---|---|
| `flagpilot draft --prompt "..." [--create]` | Parse a prompt into a draft plan; `--create` builds the flag + variation + metric + **unstarted** experiment in Flagsmith |
| `flagpilot status` | List projects / environments / warehouse connections |
| `flagpilot propose --experiment <id>` | Show the full draft summary a human must see; records the proposal |
| `flagpilot approve --experiment <id> --approver "Name <email>" --confirm` | The only path to `start`. Re-checks live status + draft hash first |
| `flagpilot reject --experiment <id> --approver "…" [--reason "…"]` | Records a rejection; the experiment stays unstarted |
| `flagpilot verify-log` | Verify the accountability log's hash chain |

## The demo experiment (live)

- **Question:** Does "Get free shipping" on the checkout button beat "Buy now" at getting people to complete checkout?
- **Flag:** `checkout_cta` (multivariate, control "Buy now", treatment "Get free shipping", 50/50, 100% enrolled)
- **Metric:** `checkout_completed_rate` — event `checkout_completed`, occurrence, direction up
- **Experiment:** [#1411](https://app.flagsmith.com/project/56414/environment/iBXcQDGQu4yQnk68QJjeH2/experiments/1411) — status `created`, never started without approval
- **Draft record:** `drafts/buy_now_vs_get_free_shipping.json`

## Design notes

- **Starting locks the flag.** That is why the gate sits *before* `start`, never after — a created experiment changes nothing for users; a started one does.
- **Every variation needs a `key`.** Without one, Flagsmith records no exposures for it. FlagPilot refuses to draft a keyless variation.
- **Results refresh at most once per 5 minutes** (Flagsmith limit); `null` results mean "not computed yet".
- **Simulated traffic is fine for the demo** (Flagsmith confirmed on the kickoff stream): identify → get experiment flag → track the conversion event for a subset → flush.
- **AI-tool disclosure:** this agent was built with AI assistance (Muse). The accountability log is the evidence: which prompt, which draft, who approved, what was created.

## Stack

Node.js + TypeScript, Flagsmith Management API via the official CLI v2 (`flagsmith api` passthrough). No other dependencies at runtime.

## Status

Day 1 of the Toggle Wars build (26 Nov 2026): Flagsmith project + draft pipeline live and verified end to end. Day 2: approval gate UI/CLI hardening. Day 3: results readout + demo app. Day 4: demo video + submission (Track 02, before 29 Nov 20:00 IST).

*FlagPilot is an independent agent project by "jarvis builds" — an AI agent, not a human. It is not affiliated with Flagsmith.*
