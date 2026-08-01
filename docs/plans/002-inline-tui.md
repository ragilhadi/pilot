# Plan 002 — Inline TUI that preserves terminal scrollback

## The complaint

> I want the TUI when open to be the full terminal, not just a new app. I can scroll back to my old
> terminal history. Create a new one.

Two requirements that sound contradictory and are not:

1. **Full terminal** — use the whole width and height, not a boxed pane.
2. **Scrollback works** — the terminal's own scroll (mouse wheel, `Shift+PgUp`, tmux copy-mode)
   reaches both the earlier session transcript *and* whatever was on screen before `pilot` launched.

Requirement 2 rules out the alternate screen buffer. What satisfies both is **inline append-only
rendering**: completed output is committed to the terminal's real scrollback and never repainted;
only a small live region at the bottom is redrawn.

## Part 1 — Why scrollback is being destroyed today

### 1.1 Pilot is *already* not using the alternate screen

`@earendil-works/pi-tui` never emits `\x1b[?1049h`. It does inline differential rendering. So the
problem is not "it opened a new screen" — the problem is what the inline renderer is being asked to
render.

### 1.2 The entire transcript is the live buffer

```ts
// apps/cli/src/tui/components/screen.ts:66
render(width: number): string[] {
  const lines = [header, divider, ""];
  for (const block of state.blocks) {         // ← every block, every frame
    lines.push(...this.#renderBlockCached(block, width, ...), "");
  }
  ...
}
```

`PilotScreen` returns the whole session on every frame. The header is line 0 of every frame. `pi-tui`
then diffs that array against the previous one. Consequences follow directly.

### 1.3 `\x1b[3J` on resize erases the scrollback

`pi-tui`'s `doRender` calls `fullRender(true)` on a width change, and on a height change outside
Termux. `fullRender(true)` writes:

```
\x1b[2J\x1b[H\x1b[3J     // clear viewport, home, then CLEAR SCROLLBACK
```

`ED 3` is *the* escape sequence for discarding the scrollback buffer. So:

- widening or narrowing the window → the user's pre-`pilot` history is gone
- so is every transcript line that had scrolled above the viewport
- and the whole session is then replayed into the viewport

That replay is exactly what reads as "a new app took over my terminal".

Because `PilotScreen` renders everything, `pi-tui` *has* to full-render on resize — a partial diff
cannot fix rows that have scrolled out of reach. The `3J` is a symptom of the full-transcript design,
not an independent bug.

### 1.4 What does land in scrollback is not clean history

Lines scroll off while the transcript is still being rewritten in place, so what the terminal captures
is a snapshot of streaming intermediate states — half-written assistant text, a spinner frame, a tool
row that later changed. Scrollback is polluted even in the runs where it survives.

### 1.5 Frame cost grows with session length

`doRender`'s diff loop runs over `max(newLines.length, previousLines.length)` every frame
(`tui.js` — the `maxLines` loop). `#blockCache` in `screen.ts:94` avoids re-*rendering* unchanged
blocks but not re-*comparing* them. A 3,000-line transcript diffs 3,000 lines per token of streamed
output.

### 1.6 Shrinking content leaves debris

`clearOnShrink` defaults to **off** (`PI_CLEAR_ON_SHRINK`), so when a block collapses — a tool detail
folding away, an overlay closing — stale rows stay on screen until something else overwrites them.

## Part 2 — Design: commit-and-live split

Split the frame into two regions with different lifetimes.

```
 ┌─ terminal scrollback ─────────────────────────────┐
 │  $ ls          ← the user's history, untouched    │
 │  $ pilot chat                                     │
 │  ◆ PILOT  ~/pilot  main  glm-5.2:cloud            │  ← banner, printed once
 │  › explain the context engine                     │
 │  ● read_file  packages/…/context-engine.ts        │  } COMMITTED
 │  The context engine selects candidates…           │  } written once, never
 │  › now fix the estimator                          │  } repainted, owned by
 │  ● grep  "bytesPerToken"                          │  } the terminal
 ├───────────────────────────────────────────────────┤
 │  ● edit  context-engine.ts   ⋯ 2.1s               │  ┐
 │  Replacing the flat divisor with…                 │  │ LIVE REGION
 │  ─────────────────────────────────────────────    │  │ diffed each frame,
 │  ready  ctx 41.2k/116k (36%)  Enter send          │  │ bounded height
 │  › ▌                                              │  ┘
 └───────────────────────────────────────────────────┘
```

**Committed region** — append-only. Rendered once at the current width, written with plain
`terminal.write(lines.join("\r\n") + "\r\n")`, then forgotten. The terminal scrolls it into
scrollback the same way it scrolls `git log` output. No sequence Pilot emits ever touches it again.

**Live region** — the only thing `pi-tui` diffs. Contains the in-progress assistant/tool block, the
activity indicator, the footer, the composer, and any overlay. Height bounded to
`max(8, rows - 2)`.

A block becomes committable when it can no longer change:

| Block | Committable when |
| --- | --- |
| user message | immediately on submit |
| assistant message | `response.completed` / turn ends |
| tool call | `tool.completed` / `tool.failed` |
| turn summary | on emit |
| error | on emit |

The two invariants that make it work:

1. **Committed rows are written exactly once.** No cursor movement ever goes above the live region's
   first row.
2. **`\x1b[3J` is never emitted.** A resize clears only the live region's own rows
   (`\x1b[<n>A\r\x1b[J`) and repaints them. Committed rows are left exactly as any other terminal
   output would be.

### Reflow policy — state it and accept it

Committed lines keep the width they were written at. On a resize, older output stays wrapped for the
old width. This is how `cat`, `git log`, and every append-only tool behave, and it is the necessary
price of real scrollback: to reflow committed output you would have to rewrite it, which requires
`3J`, which is the bug. Document it in the README; do not try to be clever.

## Part 3 — Implementation

### Step 1 — `ScrollbackWriter`

`apps/cli/src/tui/scrollback.ts`

```ts
export interface ScrollbackWriter {
  /** Append finished lines above the live region. Never repaints. */
  commit(lines: readonly string[]): void;
  /** Rows committed so far, for tests and diagnostics. */
  readonly committedRowCount: number;
}
```

Wraps writes in synchronized output (`\x1b[?2026h` / `\x1b[?2026l`) so a commit cannot tear against a
live-region repaint. Takes the `Terminal` port, so the fake terminal in tests records every byte.

### Step 2 — Split `PilotScreen`

- **`TranscriptCommitter`** — subscribes to state transitions, decides finality per the table above,
  renders the block once at the current width, hands it to `ScrollbackWriter`.
- **`LiveRegion`** (a `pi-tui` `Component`) — renders *only* uncommitted blocks plus activity, and
  nothing else. This is the component registered with `TUI`.

The existing per-block renderers (`renderTool`, the markdown renderer, `summarizeToolCall`) are reused
unchanged — this is a re-partition, not a rewrite of the drawing code. `#blockCache` becomes
unnecessary for committed blocks and shrinks to the live set.

### Step 3 — The reducer owns commit state

Add `committedBlockCount: number` to `TerminalUiState` (`terminal-ui-state.ts`). The reducer advances
it; the view reads it. Keeps the renderer pure and keeps commit decisions inside the existing
golden-frame test surface rather than hiding them in imperative view code.

### Step 4 — Bound the live region and stream-commit long blocks

`maxLiveRows = max(8, rows - 2)`. A single streaming assistant message can exceed that. Handle it by
committing the **stable prefix**: everything up to the last `\n` that markdown rendering guarantees
will not change (i.e. not inside an open fence, table, or list continuation). The tail stays live.
This is the one genuinely fiddly part — a conservative rule (commit only complete top-level blocks
outside any open fence) is correct and sufficient.

### Step 5 — Own the clearing behaviour

- `tui.setClearOnShrink(false)` — the live region handles its own clearing, so `pi-tui`'s
  shrink heuristic (which full-renders) must not fire.
- On `SIGWINCH`: clear and repaint the live region only.
- If `pi-tui` still reaches `fullRender(true)` from a path we do not control, drop `TUI` for the live
  region and drive `Terminal` directly — `write`, `moveBy`, `clearLine`, `clearFromCursor` are
  sufficient for a bounded, known-height region, and the live region is small enough that a
  hand-rolled diff is a modest amount of code. Treat this as the fallback, not the starting point.

### Step 6 — `--ui inline` as the new default, `--ui fullscreen` as opt-in

- `inline` (default) — this design.
- `fullscreen` — the current behaviour plus an explicit `\x1b[?1049h` / `\x1b[?1049l` pair, for
  people who genuinely want an app-like pane that restores the shell on exit. Ironically this is
  *better* than today: entering the alternate screen properly means exiting restores the original
  screen and its scrollback intact.
- `plain`, `json`, `--screen-reader` unchanged.

Making it a flag keeps the change reversible and gives a bisect target if someone's terminal
misbehaves.

### Step 7 — Startup and exit

- **Startup:** print the banner once into the committed region. Never call `clearScreen()`. The
  user's prompt and prior output stay visible directly above.
- **Exit:** clear only the live region, commit a final summary line, leave everything else on screen.
  The transcript is still there and still scrollable after `pilot` exits — which today it is not.

## Part 4 — Tests

The fake terminal already used by `terminal-ui-golden-frames.test.ts` records writes, so most of this
is assertions on the recorded byte stream.

| Test | Asserts |
| --- | --- |
| no scrollback destruction | `\x1b[3J` never appears in any recorded write, in any scenario including resize |
| no alternate screen in inline mode | `\x1b[?1049h` never appears when `--ui inline` |
| write-once | each committed row's bytes appear exactly once across the whole stream |
| resize safety | a `SIGWINCH` re-emits only live-region rows; committed row count is unchanged |
| bounded frame cost | with 2,000 transcript blocks, bytes written per streamed token stay under a fixed ceiling (extends `terminal-ui-performance.test.ts`) |
| stream-commit correctness | committing a stable prefix mid-stream produces byte-identical final output to committing the whole block at the end |
| real-pty scrollback | `node-pty` (already a devDependency): write marker lines, launch, resize, then read the pty's scrollback and assert the markers survive |

## Part 5 — Files

| File | Change |
| --- | --- |
| `apps/cli/src/tui/scrollback.ts` | **new** — `ScrollbackWriter` |
| `apps/cli/src/tui/components/live-region.ts` | **new** — bounded live component |
| `apps/cli/src/tui/components/transcript-committer.ts` | **new** — finality + commit |
| `apps/cli/src/tui/components/screen.ts` | reduced to shared block renderers |
| `apps/cli/src/tui/terminal-ui-state.ts` | add `committedBlockCount` |
| `apps/cli/src/tui/terminal-chat-presentation.ts` | wire the split; `setClearOnShrink(false)`; no `clearScreen` |
| `apps/cli/src/presentation/presentation-mode.ts` | add `inline` / `fullscreen` modes |
| `apps/cli/src/cli.ts` | `--ui inline\|fullscreen\|plain\|json` |
| `apps/cli/test/terminal-ui-golden-frames.test.ts` | escape-sequence assertions |
| `apps/cli/test/terminal-ui-performance.test.ts` | bounded per-frame cost |
| `apps/cli/test/scrollback-pty.test.ts` | **new** — real-pty scrollback survival |
| `README.md` | document the modes and the reflow policy |

## Part 6 — Sequencing and risk

| Step | Effort | Risk |
| --- | --- | --- |
| 1 `ScrollbackWriter` | S | low |
| 2 Split `PilotScreen` | M | low — reuses existing renderers |
| 3 Reducer commit state | S | low |
| 4 Bound + stream-commit | M | **medium** — the stable-prefix rule for streaming markdown |
| 5 Own the clearing | S | **medium** — depends on `pi-tui` not force-full-rendering |
| 6 `--ui` modes | S | low |
| 7 Startup/exit | S | low |
| Tests | M | low |

Steps 1–3 alone already remove the `3J` on resize, because once the live region is bounded `pi-tui`
no longer has a reason to full-render. That is the smallest change that fixes the reported symptom,
and it is worth landing as its own commit before step 4.

The main open risk is step 5: `pi-tui` decides on its own when to full-render. Step 5's fallback —
driving `Terminal` directly for a bounded region — removes that dependency entirely and should be
taken as soon as the first forced full-render shows up in the golden-frame stream, rather than
worked around.
