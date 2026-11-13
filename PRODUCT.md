# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React (Vite) frontend, Python FastAPI backend, Chromium via Playwright, SQLite; runs locally with `docker compose up` (see `docs/superpowers/specs/2026-11-13-nmck-agent-design.md`). Design mockups are standalone static HTML under `design/`.

## Users

Procurement staff at MIPT (МФТИ). They receive a technical specification (ТЗ) for a purchase and must justify the initial maximum contract price (НМЦК) by the comparable market prices method. Secondary audience: hackathon jury evaluating the tool, who may run it without passing captchas.

## Product Purpose

An AI agent that takes a ТЗ, searches open sources for comparable offers, selects the relevant ones, normalizes prices to the ТЗ unit, excludes anomalies and computes НМЦК per position and in total. Success: a report from which anyone can reconstruct the path from the ТЗ to the final price, every price tied to a source link.

## Positioning

LLM extracts and compares; deterministic code computes. The same sample always yields the same price, the formulas are shown, and the system warns instead of producing a price when data is insufficient or heterogeneous (fewer than 3 prices, coefficient of variation above 33 %).

## Operating Context

- Local internal tool, no accounts, no multi-user mode. The user's own OpenRouter key lives in settings.
- Main screen: chat with the agent plus a report panel; a live browser window appears when a source needs login or captcha.
- Purchases list (past research, new purchase from an uploaded ТЗ); report versions on every data change; export DOCX/PDF.
- Demo ТЗ: paper (3 positions, SvetoCopy), cytokines (5 positions, per-µg normalization), 3D printer (one model).
- Source cascade: level 1 ЕИС contracts + manufacturer/distributor catalogs; level 2 marketplaces when fewer than 3 relevant prices remain.

## Capabilities and Constraints

- Report sections: subject of purchase, where we searched, included offers, excluded offers (with reason), calculation, warnings.
- Clarifying questions in chat always carry a default answer; unanswered defaults are marked in the report.
- Rules (outlier rule, CV threshold, minimum prices) live in config and change only after user confirmation.
- Interface language: Russian.

## Brand Commitments

- Lockup: "Co7 × МФТИ". Co7 is the team name; МФТИ uses the official logo file the team will add to the repository (not yet present; until then a labeled placeholder).
- Visual direction pinned by the team: white, minimalist, "expensive".
- No account or profile UI.

## Evidence on Hand

- Case description, source list and three sample ТЗ in `docs/*.docx`.
- No real search results yet: mockup data is illustrative and must be labeled as such where it could be mistaken for real prices.

## Product Principles

1. Traceability over persuasion: every number links back to a source and a formula.
2. Honest insufficiency: a warning beats an unjustified price.
3. The agent proposes, the user confirms: rule changes and exclusions are visible and reversible via versions.
4. Works unattended: defaults keep the pipeline moving; human input improves but never blocks.
