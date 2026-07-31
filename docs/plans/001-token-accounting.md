# Plan 001 — Correct token accounting

## The complaint

> The Ollama usage is not high compared with our calculations. How do I make the context token
> calculation correct? I want the feature like opencode that calculates tokens correctly.

Both halves of that comparison are wrong, in opposite directions. Pilot's number is wrong because it
measures the wrong thing with a crude ruler. Ollama's number is wrong because `prompt_eval_count` is
not a prompt size. They disagree because they are both broken, not because one is the truth.

## Part 1 — Why the numbers disagree

### 1.1 Three independent estimators that were never reconciled

| # | Where | What it counts |
| --- | --- | --- |
| 1 | `Utf8HeuristicTokenEstimator` (`packages/agent-runtime/src/context-engine.ts:236`) | `ceil(utf8Bytes / 4) + 4` over one candidate's wire text |
| 2 | `snapshot.composedTokens` (`packages/agent-runtime/src/prompt-composition.ts:123`) | estimator #1 summed over *selected context candidates* |
| 3 | `estimateModelCall` (`apps/cli/src/cli.ts:1235`) | estimator #1 summed over `request.messages` |
| 4 | provider `usage.updated` (`packages/provider-openai-compatible/src/openai-compatible-language-model.ts:348`) | `prompt_tokens ?? prompt_eval_count` |

A comment in `cli.ts:1232` claims the shared estimator ended the drift. It ended drift *between the
estimators*, not drift from reality — because all of them count the same incomplete payload.

### 1.2 The tool schemas are never counted — measured 23 KB

`createChatCompletionsRequest` (`packages/provider-openai-compatible/src/request.ts:63`) serializes
`request.tools` into the `tools` array on **every** request. No estimator looks at `request.tools`.

Measured against the current registry (`apps/cli/src/cli.ts:1111`), converted through
`toolToModelDefinition` (`z.toJSONSchema`) and serialized exactly as the adapter sends them
(`{type, function:{name, description, parameters}}`):

```
               bytes  tokens                    bytes  tokens
  list_files    1401     425    apply_patch      1669     506
  glob          1643     498    edit             1969     597
  git_diff      1302     395    write_file       1332     404
  git_status     858     260    todo_write       1743     529
  grep          2329     706    todo_read         428     130
  read_file     2301     698    question         2031     616
                               web_fetch         1143     347
                               run_command       3025     917
  ----------------------------------------------------------
  14 tools, 23,189 bytes = 7,027 tokens, re-sent on every request
```

So on a 128k window, Pilot is blind to roughly **5.5% of the window before the conversation
starts**, and blind to it *every single request*. `web_search` and `diagnostics` add more when a
Tavily key or a language server is present.

This is also why the run budget's reservation is systematically low, which weakens
`RunBudget.maxInputTokens` as a safety net.

### 1.3 `bytes / 4` is the wrong ratio for code, and a flat ratio is the wrong shape

Real BPE tokenizers on the content Pilot actually sends:

| Content | Bytes/token (Llama/Qwen/GLM class) | `/4` error |
| --- | --- | --- |
| English prose | 4.0 – 4.4 | roughly right |
| TypeScript / Python source | 3.0 – 3.6 | **under-counts 10–25%** |
| Minified JSON, diffs, base64 | 2.2 – 3.0 | **under-counts 30–45%** |
| CJK text | 1.0 – 2.0 | under-counts 2–4× |

Pilot's traffic is mostly the middle two rows. The flat `+4` framing constant does not rescue it.

### 1.4 The chat template is applied server-side and is not modelled

`agentMessageWireText` (`packages/core/src/domain/message/message-wire-text.ts`) joins role, text,
tool names, and arguments with newlines. What Ollama actually feeds the model is that content run
through the model's Jinja chat template:

- per-message delimiters (`<|im_start|>assistant\n` … `<|im_end|>` — 3–6 tokens **per message**)
- the tool block rendered into the system turn, often with extra prose scaffolding
- a `tool_call_id` / `name` envelope per tool result
- the trailing generation prompt

On a 60-message conversation that is another 200–400 tokens of pure framing that no estimator sees.

`agentMessageWireText` also collapses an image to `"data:<mime>;base64"` — about 6 tokens for
something a vision model charges hundreds or thousands for.

### 1.5 Ollama's `prompt_tokens` is not the prompt size

Ollama's OpenAI-compatibility layer maps `PromptEvalCount → prompt_tokens`. `PromptEvalCount` is the
number of prompt tokens the runner actually **evaluated**. When the KV cache already holds the
conversation prefix — which is the normal case for turn 2 onward of a coding session — the evaluated
count collapses to just the new suffix. It has been reported as returning `0` outright on a cache hit
([ollama#5370](https://github.com/ollama/ollama/issues/5370),
[ollama#3427](https://github.com/ollama/ollama/issues/3427)); the exact behaviour is
version-dependent and has changed more than once.

Critically, Ollama sends no `prompt_tokens_details.cached_tokens`, so Pilot cannot reconstruct the
real prompt size from the response. The adapter already reads `prompt_tokens_details.cached_tokens`
(line 364) — it will simply never be present on Ollama.

**This is the direct answer to the question.** The low Ollama figure is cache-excluded evaluation
work. It is a useful throughput number. It is not context occupancy, and treating it as such is what
makes the two numbers look irreconcilable.

### 1.6 The provider number silently and permanently wins

```ts
// apps/cli/src/cli.ts:1265
if (!providerUsageSeen) { /* emit composed estimate */ }
```

`providerUsageSeen` latches `true` on the first provider report (line 1287) and never resets. From
that moment the footer shows only Ollama's cache-excluded number. The visible symptom: `ctx` reads
`~42k/128k` on turn one, then drops to `ctx 3k/128k` on turn two *while the conversation grew*.

### 1.7 One field, two incompatible meanings

`TokenUsage.inputTokens` is used as:

- a **level** — how full the window is (the footer, `terminal-ui-state.ts:99` documents this intent)
- a **flow** — what the provider billed for this call (`run-budget.ts`, cost, logs)

`RunBudget` correctly `max`es input across calls and sums output (`run-budget.ts:397`). That is right
for a budget and wrong for a display, and the two are reading the same field.

### 1.8 Two different denominators

- The footer divides by `capabilities.maxContextTokens` (`apps/cli/src/cli.ts:1431`).
- The context engine clamps to `min(config.context.maxInputTokens ?? 120_000, modelContextTokens)`
  (`cli.ts:1249`, `context-engine.ts:resolveContextBudget`).

On a 128k model with the default 120k config, admission stops at 120k − 4k reserved output = 116k
while the footer still reports out of 128k. The percentage is wrong even when the numerator is right.

## Part 2 — What "correct" means, and what opencode actually does

opencode's status line historically computed:

```
total = input + output + reasoning + cache.read + cache.write
percent = total / model.limit.context
```

which can exceed 100% — that was filed as
[opencode#7025](https://github.com/anomalyco/opencode/issues/7025), and the suggested correction is:

```
used = input + cache.read
```

The important lesson is not the formula. It is that **opencode gets away with a simple formula
because its primary providers report exact, cache-attributed prompt tokens.** For Anthropic and
OpenAI, `input + cache_read` *is* the prompt size. opencode falls back to `chars / 4` only when no
provider number exists.

Pilot's primary provider does not report that. So Pilot cannot copy opencode's approach; **Pilot has
to compute occupancy locally and treat the provider number as a cross-check.** That inversion is the
core of this plan.

Two numbers, never conflated again:

- **Context occupancy** — locally computed over the exact bytes the adapter will send, including tool
  schemas and template framing. Authoritative for the footer, `/context`, compaction, and admission.
- **Billed usage** — provider-reported. Authoritative for cost and throughput. Never drives the
  `ctx` display on a provider whose prompt count is evaluation-only.

## Part 3 — The plan

Seven phases. Phases 1–2 fix the number; 3–5 make it trustworthy; 6–7 surface and defend it.
Each phase is independently shippable.

### Phase 1 — Count the whole payload, by construction

The bug class is "the estimator and the serializer disagree about what is sent". Fix it structurally:
make the thing that serializes also be the thing that measures.

1. Add to the `LanguageModel` port in `packages/core/src/domain/model/language-model.ts`:

   ```ts
   /** The exact text that will be tokenized by the server for this request, in template order. */
   describeRequestPayload(request: ModelRequest): RequestPayloadDescription;

   interface RequestPayloadDescription {
     readonly segments: readonly RequestPayloadSegment[]; // kind + text
     readonly perMessageOverheadTokens: number;           // chat-template framing
     readonly generationPromptTokens: number;
   }
   type RequestPayloadSegmentKind =
     | "system" | "tool-definitions" | "message" | "tool-result" | "image" | "response-format";
   ```

2. Implement it in `packages/provider-openai-compatible` by reusing
   `createChatCompletionsRequest` — serialize the request, then walk it. Zero drift possible:
   the schemas, the `tool_calls` envelope, `tool_call_id`, and `response_format` are all included
   because they are all in the object being sent.

3. New `RequestTokenAccountant` in `packages/agent-runtime/src/token-accounting.ts`:

   ```ts
   interface ContextOccupancy {
     readonly totalTokens: number;
     readonly bySegment: Readonly<Record<RequestPayloadSegmentKind, number>>;
     readonly method: string;         // which counter produced it
     readonly confidence: "exact" | "calibrated" | "heuristic";
   }
   ```

4. Replace `estimateModelCall` (`cli.ts:1235`) with the accountant. The run-budget reservation
   immediately becomes correct-ish instead of low by ~7k.

5. Correct the tool-definition reservation. `ConversationModelRequestContextPreparer` already passes
   `reservedInputTokens`, but it prices `JSON.stringify(request.tools)` — the *domain* shape, which
   carries an `outputSchema` that never crosses the wire and omits the `{type, function}` envelope
   that does — through the flat byte heuristic. Price the wire shape instead, and surface the figure
   on the snapshot so a breakdown can show it.

**Done when:** occupancy for a fixed recorded request equals a reference tokenizer's count of the
adapter's serialized body within ±2%, and the tool schemas appear as a non-zero `bySegment` entry.

### Phase 2 — A real tokenizer, pluggable and cached

```ts
// packages/core/src/domain/model/token-counter.ts
interface TokenCounter {
  readonly id: string;
  readonly confidence: "exact" | "heuristic";
  count(text: string): number;
}
```

Implementations, in resolution order per model:

1. **`OllamaTokenizeCounter`** — probe `POST /api/tokenize` on the configured base URL once at
   startup. Where the daemon supports it this is ground truth for the model actually loaded. LRU
   cache keyed by `sha256(text)`; only used for large stable segments (system prompt, tool
   definitions, committed messages) so the request rate stays low. Degrade silently on 404.
2. **`TokenizerJsonCounter`** — a Hugging Face `tokenizer.json` (Llama, Qwen, GLM, DeepSeek,
   Mistral). Path configurable per model; optional peer dependency so the base install stays light.
3. **`TiktokenCounter`** — `js-tiktoken` for OpenAI-family models.
4. **`ScriptAwareHeuristicCounter`** — replaces the flat `/4`. Segments text by class and applies
   per-class ratios rather than one divisor:

   | Class | Detection | Bytes/token |
   | --- | --- | --- |
   | CJK / non-Latin | Unicode script ranges | 1.5 |
   | Structured (JSON, diff, base64-ish) | punctuation density > 0.25 | 2.8 |
   | Source code | indentation + symbol density | 3.3 |
   | Prose | default | 4.2 |

   Plus the per-message template overhead from Phase 1 instead of a flat `+4`.

Wiring:

- `capabilities.tokenizer?: { kind: "ollama-api" | "tokenizer-json" | "tiktoken" | "heuristic"; path?: string; encoding?: string }`
  on `ModelDescriptor`.
- `pilot models add --tokenizer <kind>[:<path>]`, persisted to `models.json`.
- Counting runs on a `node:worker_threads` worker when a segment exceeds ~256 KB, so a large paste
  cannot stall the TUI event loop.
- `pilot doctor` reports the active counter and confidence per model.

**Done when:** `pilot doctor` shows `exact` for a model with a tokenizer configured, and the
heuristic counter's error on a code-heavy fixture drops below 8% (from ~20%).

### Phase 3 — Calibration, for when only the heuristic is available

Keep a per-model EWMA of `providerPromptTokens / ourEstimate`, applied to **heuristic counters only**
— never to an exact counter.

Sample admission rules (this is where it gets dangerous, so be strict):

- Accept a sample only when the provider's number is plausibly the full prompt: the **first** model
  call of a process against that model, or a call where `prompt_tokens_details.cached_tokens` is
  present, or a call where `prompt_tokens ≥ 0.9 × ourEstimate`.
- **Reject** any sample where `prompt_tokens` fell while the conversation grew — the Ollama cache
  artifact.
- Reject ratios outside `[0.5, 2.0]` as noise.
- EWMA `α = 0.2`, minimum 3 accepted samples before the factor is applied at all.

Persist to `<data-dir>/token-calibration.json`, keyed by model key, with the sample count and the
observed spread. `pilot doctor --tokens` prints the table.

**Done when:** after a handful of turns on a fresh Ollama model, the persisted factor puts the
heuristic within 5% of a reference count, and no cache-hit sample has been accepted.

### Phase 4 — Declare what the provider's number is worth

```ts
// on ModelDescriptor.capabilities
usageTrust?: {
  /** "exact": prompt_tokens is the prompt size. "eval-only": it excludes the cached prefix. */
  readonly promptTokens: "exact" | "eval-only" | "unknown";
};
```

- Ollama models default to `"eval-only"`.
- OpenAI/Anthropic-compatible endpoints default to `"exact"`.
- Overridable with `pilot models add --usage-trust <kind>`.

Then:

1. **Delete the `providerUsageSeen` latch** (`cli.ts:1265`, `1287`). Emit locally computed occupancy
   on **every** `onContextPrepared`, unconditionally.
2. Split the event payload so the two numbers can coexist:
   `usage.updated` carries `{ occupancy, billed }` rather than one overloaded `inputTokens`.
3. The footer renders `occupancy` always. `billed` feeds cost, logs, and the run budget.
4. When `promptTokens === "exact"`, prefer the provider figure for occupancy and use the local
   estimate as a drift check (log a warning above 10% divergence — that is how estimator regressions
   get caught).

**Done when:** the `ctx` figure is monotonically non-decreasing within a session that has not
compacted, on Ollama.

### Phase 5 — One denominator

Compute `effectiveContextTokens = min(model.maxContextTokens, config.context.maxInputTokens)` **once**
in the runtime, publish it on `chat.started` and on model change, and have the footer, the compaction
trigger, and `resolveContextBudget` all divide by that same value.

Footer becomes:

```
ctx 41.2k/116k (36%)          — exact counter
ctx ~41.2k/116k (36%)         — heuristic
ctx ≈41.2k/116k (36%)         — calibrated heuristic
```

Three distinct markers, so the number never lies about how well it is known.

### Phase 6 — Surface the breakdown, then use it

1. **`/context` command.** `PromptCompositionSnapshot` is already produced and already reaches the
   TUI as `state.context` — it is simply never rendered. Render it:

   ```
   Context  41.2k / 116k  (36%)          ollama/glm-5.2:cloud
   ████████░░░░░░░░░░░░░░░░░░░░░░░░
     system prompt        1.4k   1%
     tool definitions     9.3k   8%   ← 15 tools
     AGENTS.md            2.1k   2%
     conversation        19.8k  17%
     tool results         8.6k   7%
     reserved output      4.0k   3%
     free                70.8k  61%
   ```

   Excluded candidates and their reasons are in the snapshot too — show them under `--verbose`.

2. **Wire compaction.** `ConversationCompaction` is built and tested and imported nowhere in
   `apps/cli`. Trigger it at `context.compactionThreshold` (default `0.8`) of
   `effectiveContextTokens`, using the Phase 1 occupancy. Announce it in the transcript.

3. **Trim the tool block.** 9k tokens of schemas on every request is worth attacking once it is
   visible: shorter descriptions, and optionally gating rarely-used tools (`web_search`,
   `question`, `diagnostics`) behind config. `run_command` alone is 5.6 KB — its description is the
   single largest fixed cost in the window.

### Phase 7 — Lock it down with tests

| Test | Location | Asserts |
| --- | --- | --- |
| Payload completeness | `packages/provider-openai-compatible/test/` | every field of the serialized body appears in exactly one `describeRequestPayload` segment |
| Reference agreement | `packages/agent-runtime/test/token-accounting.test.ts` | recorded fixtures counted within ±2% of a checked-in reference tokenizer |
| Tool-schema regression | same | tool-definition tokens are non-zero and within 5% of a recorded baseline; **fails the build when a tool description grows silently** |
| Calibration safety | same | a synthetic cache-hit sample (`prompt_tokens` drops while messages grow) is rejected |
| Monotonicity | property test | occupancy never decreases across cycles of one uncompacted turn |
| Live drift eval | `evals/` | against a real Ollama daemon, first-call `prompt_tokens` vs. our count, per registered model |

## Part 4 — What changes where

| File | Change |
| --- | --- |
| `packages/core/src/domain/model/language-model.ts` | add `describeRequestPayload` |
| `packages/core/src/domain/model/token-counter.ts` | **new** — `TokenCounter` port |
| `packages/core/src/domain/model/token-usage.ts` | split occupancy from billed; add `confidence` |
| `packages/core/src/domain/model/model-descriptor.ts` | add `tokenizer`, `usageTrust` |
| `packages/provider-openai-compatible/src/request.ts` | expose segment walk over the serialized body |
| `packages/provider-openai-compatible/src/openai-compatible-language-model.ts` | implement `describeRequestPayload`; tag usage with trust |
| `packages/agent-runtime/src/token-accounting.ts` | **new** — `RequestTokenAccountant`, counters, calibration |
| `packages/agent-runtime/src/context-engine.ts` | `Utf8HeuristicTokenEstimator` → `ScriptAwareHeuristicCounter`; accept an injected `TokenCounter` |
| `packages/agent-runtime/src/prompt-composition.ts` | include tool definitions in `composedTokens` |
| `packages/agent-runtime/src/conversation-compaction.ts` | wire a threshold trigger |
| `apps/cli/src/cli.ts` | drop `providerUsageSeen`; use the accountant; single denominator; `/context` |
| `apps/cli/src/tui/components/footer.ts` | render occupancy with a confidence marker |
| `apps/cli/src/tui/components/context-panel.ts` | **new** — the `/context` breakdown |

## Part 5 — Sequencing

| Phase | Effort | Depends on | Ship value |
| --- | --- | --- | --- |
| 1 Payload accounting | M | — | fixes the ~7k blind spot; biggest single correction |
| 2 Pluggable tokenizer | M | 1 | exact counts where a tokenizer exists |
| 3 Calibration | S | 1, 2 | good numbers with no tokenizer installed |
| 4 Usage trust | S | 1 | stops the footer collapsing after turn one |
| 5 One denominator | S | — | percentage stops lying; can ship first |
| 6 `/context` + compaction | M | 1, 5 | long sessions stop dying; the 9k tool cost becomes visible |
| 7 Tests | S | all | prevents silent regrowth |

Phase 5 is the smallest and independently correct — worth landing first as a warm-up. Phases 1 and 4
together are what actually resolve the reported symptom.

## Sources

- [ollama#5370 — OpenAI Chat Compatibility Incorrect Prompt Eval](https://github.com/ollama/ollama/issues/5370)
- [ollama#3427 — prompt_eval_count in api is broken](https://github.com/ollama/ollama/issues/3427)
- [Ollama API usage documentation](https://docs.ollama.com/api/usage)
- [opencode#7025 — Over 100% context usage](https://github.com/anomalyco/opencode/issues/7025)
