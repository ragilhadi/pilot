# Agent harness vs. Pilot

## What "agent harness" means

An *agent harness* is the non-model half of a coding agent: the program that decides what the model
sees, what it is allowed to do, and what happens to the results. The model contributes token
prediction. Everything else — the loop, the context, the tools, the approvals, the persistence, the
rendering — is harness.

Pilot **is** an agent harness. The question is not "harness or Pilot", it is "how does Pilot compare
to a mature harness like Claude Code". That is what this document answers.

## Anatomy, side by side

| Concern | Claude Code (mature harness) | Pilot today |
| --- | --- | --- |
| Agent loop | Streaming turn loop with tool-call cycles, interrupt/queue, per-turn budgets | `ApplicationRunner` + `RunStateMachine` + `ToolCallScheduler`, cycle-based, with `RunBudget` and `RunInterruptionQueue` — same shape |
| Provider coupling | Anthropic-first, single tokenizer, single usage contract | Provider-neutral `LanguageModel` port; one OpenAI-compatible adapter; Ollama primary |
| Context assembly | Implicit, model-tuned; auto-compaction; `/context` breakdown | Explicit `ContextEngine` with sources, priorities, per-source budgets, dedup, provenance + trust labels. **More principled than the incumbent.** |
| Compaction | Automatic at a context threshold | `ConversationCompaction` exists in `packages/agent-runtime` but is **not wired into the CLI** |
| Tools | ~15 built-ins + MCP + user-defined | 15 built-ins (`packages/tools-builtin`), no MCP, no user-defined tools |
| Permissions | Modes (`default`/`acceptEdits`/`plan`/`bypass`), rule allowlists, per-tool matchers | `PermissionPolicyEngine` + `PermissionCoordinator`, rule-based, interactive prompts, risk classification in `command-risk.ts`. Modes are narrower — CLI hardcodes `permissionMode: "interactive"` |
| Subagents | First-class, parallel, isolated context, own tool sets | None |
| Extensibility | Hooks, MCP servers, skills, slash commands, plugins, settings hierarchy | Config file + `AGENTS.md` discovery (`InstructionDiscovery`). No hooks, no MCP, no skills. |
| Persistence | Session resume, transcript history | SQLite (`packages/persistence-sqlite`), sessions + tool activity + run checkpoints. Comparable. |
| Tokens | Provider usage is exact and cache-attributed | Three disagreeing estimates — see [`plans/001-token-accounting.md`](plans/001-token-accounting.md) |
| Terminal UI | Inline, append-only, native scrollback preserved | Full-transcript live buffer that destroys scrollback on resize — see [`plans/002-inline-tui.md`](plans/002-inline-tui.md) |
| Failure handling | Retries, truncation recovery, tool repair | `RetryExecutor`, `ToolRecovery`, `ModelStreamAccumulator` for truncated/empty responses. Strong. |
| Testing | Internal | `vitest` unit + golden-frame TUI tests + `evals/` harness. Genuinely better factored for testing. |

## Where Pilot is actually ahead

These are not consolation prizes; they are architectural bets that a model-coupled harness cannot
easily make.

1. **The context engine is a real engine.** Candidates carry `relevance`, `mandatory`, a
   `deduplicationKey`, and a `ContextProvenance` with an explicit `trust: "trusted" | "untrusted"`
   label. Selection is budgeted per source and produces a `PromptCompositionSnapshot` with what was
   selected, what was excluded, and why. Most harnesses assemble the prompt with string
   concatenation and have no artifact to inspect afterwards.
2. **Trust is typed, not implied.** `untrusted` provenance on tool output and fetched web content is
   the correct primitive for prompt-injection defence. It is declared at the type level, so it
   cannot be silently lost.
3. **Budgets are first class.** `RunBudget` bounds wall clock, tokens, and cost per turn, with
   reservation-then-settle accounting. Most harnesses bound only turn count.
4. **Provider neutrality is real.** `LanguageModel` is a port, and the OpenAI-compatible adapter is
   an adapter. Ollama, a local llama.cpp server, and a hosted endpoint are the same code path.
5. **The domain is schema-validated.** Zod at every boundary (`ModelResponseSchema`,
   `AgentMessageSchema`, `TokenUsageSchema`) with `.strict()` and refinements. Malformed provider
   output fails loudly at the edge rather than corrupting state three layers in.
6. **Deterministic tests exist.** Golden TUI frames, a `testkit` package, and an `evals/` runner
   separate from unit tests.

## Where the gap is real

Ordered by how much they cost a user per session.

### 1. Token accounting is wrong in three places at once (highest impact)

Pilot maintains three independent numbers that all claim to be "tokens":

- `Utf8HeuristicTokenEstimator` — `bytes / 4 + 4` (`packages/agent-runtime/src/context-engine.ts:236`)
- `snapshot.composedTokens` — the estimator summed over selected context candidates
- provider `usage.updated` — `prompt_tokens ?? prompt_eval_count`
  (`packages/provider-openai-compatible/src/openai-compatible-language-model.ts:348`)

None of them counts the tool JSON schemas, which are sent on **every** request. Measured on the
current tool set: **23,189 bytes = 7,027 tokens**, invisible to the estimator behind the run
budget and to the figure in the footer. And
Ollama's `prompt_tokens` is `PromptEvalCount`, which under-reports when the KV prefix is cached.
Full analysis and fix: [`plans/001-token-accounting.md`](plans/001-token-accounting.md).

### 2. The TUI owns the whole screen and eats scrollback

`PilotScreen.render()` returns the entire transcript every frame
(`apps/cli/src/tui/components/screen.ts:66`). Any terminal resize makes `pi-tui` issue
`\x1b[2J\x1b[H\x1b[3J` — and `3J` erases the scrollback buffer, taking the user's pre-launch history
with it. Fix: [`plans/002-inline-tui.md`](plans/002-inline-tui.md).

### 3. Compaction is built but not connected

`packages/agent-runtime/src/conversation-compaction.ts` exists, is tested, and is referenced nowhere
in `apps/cli`. Long sessions therefore fail on context exhaustion instead of compacting. This is a
wiring task, not a design task — but it depends on trustworthy occupancy numbers (gap 1) to know
*when* to fire.

### 4. No subagents

Every token of every file read lands in the one conversation. A subagent that searches a large
repository and returns three paragraphs is the single largest context lever a harness has, and Pilot
has no equivalent. The `ContextProvenanceKind` union already reserves `"subagent-result"`, so the
intent is recorded.

### 5. No extension surface

No MCP client, no hooks, no user-defined tools, no skills. Practically this means Pilot can only do
what ships in `tools-builtin`. For a provider-neutral harness, an MCP client is the highest-leverage
addition, because it makes the tool surface community-extensible without shipping code.

### 6. Permission modes are narrower than the engine supports

`apps/cli/src/cli.ts` hardcodes `permissionMode: "interactive"`. The policy engine can express more.
A plan-only mode and an accept-edits mode are mostly plumbing.

## Honest summary

Pilot's *core* is, in several respects, better engineered than the harness it is being compared to:
the context engine, the trust labels, the run budgets, and the provider port are all things a mature
harness typically retrofits with difficulty. What Pilot lacks is (a) accurate measurement, (b) an
output surface that respects the terminal, and (c) breadth — subagents, MCP, hooks.

Measurement first. Everything else — compaction thresholds, subagent budgets, context pruning — is
built on knowing how many tokens are actually in the window, and right now Pilot does not.

## Suggested order of work

1. Token accounting (`plans/001-token-accounting.md`) — unblocks 3, and makes 4 measurable.
2. Inline TUI (`plans/002-inline-tui.md`) — independent, user-visible, self-contained.
3. Wire compaction to the corrected occupancy figure.
4. MCP client.
5. Subagents with their own context budget.
6. Permission modes.
