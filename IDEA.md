# Claudeye — The Idea

## What it is

Claudeye is a **personal behavioral layer for AI work**. The system observes how a person works with an AI assistant, finds patterns they do not see themselves, and proposes concrete automations with a ready implementation.

Not "memory for Claude Code". Not "Datadog for dev". It is a different category — **behavioral analytics + actionable advisor** that over time turns into a model of a specific user.

## What already works

Claude Code is the first surface. Hooks capture every interaction (tool calls, prompts, decisions), compress it with AI, and store it in a local SQLite database with FTS5 + vector search.

On top of that:
- **Memory** — the foundation, not the product. Context from past sessions is injected automatically where it is relevant. Anthropic will commoditize this within a year; we do not treat it as defensible value.
- **Rule-based insights** — friction scores, hotspots, repeat fixes, quota burn, session length, hook health. A daily scheduler writes alerts.
- **Behavioral Advisor (core)** — a Claude-powered module analyzes 7-30 days of behavior and produces concrete advice structured as _observation → why it matters → proposed automation → implementation draft → confidence_. Deduplicated through an observation hash, with memory of dismissed/accepted items so it does not repeat itself.
- **Automation Advisor** — ROI-scored recommendations for automating the whole workflow (task management, code review, monitoring, docs, communications).

## Product ladder

Four steps, one end goal.

**1. Observe** (done) — the telemetry layer. Hooks see everything.

**2. Advise** (done) — the advisor finds patterns and proposes automations with an implementation. The user accepts or dismisses; the system learns from that.

**3. Act** — the advisor does not just propose, it **does**: writes the hook, opens the PR, configures the scheduler, and the user accepts or rejects with one click. The person becomes a pilot rather than someone writing code. The leverage is huge: 80% of the work is already in the implementation draft; if the system closes the remaining 20%, the developer's role inside the tool changes.

**4. Learn** — the feedback loop. The system sees which advice you accepted, which you dismissed, which accepted changes actually worked and which were rolled back. The advisor becomes **personalized** within 2-3 weeks. Your advisor is not another user's advisor.

**Endgame: Model** — the Digital Twin. Months of behavioral data about a person — patterns, decisions, preferences, pace, strengths and weaknesses — add up to a model of that specific person. And it becomes an **infrastructure layer**: any future AI assistant can plug into that model and work _as this person_ or _with awareness of their particular traits_.

The endgame is why everything else makes sense. We are not building a separate tool for Claude Code; we are building the personal layer a person carries with them through every AI tool that comes next.

## Why it is defensible

- **Anthropic will not do it:** with 100M+ users, per-person personalization is not a priority. They ship the average, not the individual.
- **Cursor/Copilot will not do it:** they have a conflict of interest around model choice and usage observability. They hide metrics behind seats.
- **OSS memory tools will not do it:** they have no telemetry foundation — they only solve the retrieval layer.

The moat is not in memory. The moat is in (a) **behavioral data aggregated across sessions, projects and time**, (b) **an advisor with implementation drafts** that turns advice into a ready merge, and (c) **local-first privacy** — raw data never leaves the machine; only aggregated signals go up.

## Scaling: teams

The same principles work at the team level. Every developer keeps raw data locally on their machine. Only aggregated metrics go up: friction, models, plugins, patterns.

A tech lead sees where the team gets stuck, which tools _actually_ work (as opposed to being paid for), and what can be standardized. The narrative for the buyer: "we pay $30/seat for Copilot — what do we get for it?" Neither Cursor nor Copilot answers that. Claudeye does.

A team is not a separate product; it is an aggregation of the same personal layer. A hierarchical CLAUDE.md (global → team → project → personal), a shared knowledge base with privacy-first exchange, onboarding via `npx claudeye join <token>`.

## Scaling: beyond developers

Claude is already more than a dev tool. PMs, writers, researchers, lawyers, analysts and consultants use it daily. Cowork mode is positioned as consumer productivity.

**The behavioral layer applies to all of these roles in the same way.** The infrastructure is identical (telemetry, advisor, feedback loop). Only the UI and the vocabulary of patterns change:
- PM: "you edit the same brief 15 times — here is a template"
- Writer: "you keep asking Claude to rewrite the same passage — there is a structural problem here"
- Researcher: "you ask similar questions in different chats — here is a consolidated answer base"

If Anthropic opens extensions for Claude Desktop / Cowork, Claudeye becomes "analytics for your work with Claude" for ~10-100M people. TAM ×1000 compared with Claude Code alone.

## Monetization — three vectors

**Solo (foothold, not destination).** OSS core + a paid tier at $5-10/month for cloud sync, the advanced advisor and an email digest. Used as a distribution channel and a source of feedback on the advisor. Market ceiling around $120k-3M ARR at 1-5% conversion of 100-500k serious Claude Code users.

**Teams (B2B money).** $20-40/seat. The audience is engineering managers / CTOs looking for an answer to "are we effective with AI or not". 6-12 months of work on team features plus SOC2-ish compliance. Launch through 5-10 design partners, not a broad release.

**Non-devs (asymmetric bet).** If an extensions API for Claude Desktop / Cowork opens up — retool the UI, keep the infrastructure. TAM ×100-1000. This is a Series A question and the "behavioral layer for AI work" story for the mass market.

## Strategy

_observe → advise → act → learn → model_

Step by step. Today: **advise** works and we are entering the **act** phase through the autopilot. In parallel: solo usage and early team design partners. The non-dev pivot comes when the surface opens up.

Open-source core. Monetization on the advisor layer and team aggregation. Raw data always local. Aggregation always optional.

Principle: **privacy-first, insight-driven, not surveillance**.
