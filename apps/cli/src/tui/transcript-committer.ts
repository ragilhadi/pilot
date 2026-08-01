import type { TranscriptBlock } from "./terminal-ui-state.js";

/**
 * Whether a block can no longer change, and can therefore be handed to the terminal's scrollback.
 *
 * Getting this wrong in one direction leaves finished output redrawing forever; in the other it
 * freezes a block mid-stream. Only terminal statuses qualify — a `streaming` assistant message and a
 * `running` tool call are still moving.
 */
export function isBlockFinal(block: TranscriptBlock): boolean {
  switch (block.kind) {
    case "user":
    case "notice":
    case "summary":
      return true;
    case "assistant":
      return block.status !== "streaming";
    case "tool":
      return block.status !== "running";
  }
}

/**
 * How many blocks from the start of the transcript are final.
 *
 * Commit order has to match transcript order — scrollback is append-only, so a block cannot be
 * committed while an earlier one is still moving. A streaming assistant message therefore holds back
 * everything after it, which is correct: those blocks are still being drawn below it.
 */
export function committableBlockCount(
  blocks: readonly TranscriptBlock[],
  alreadyCommitted: number,
): number {
  let count = alreadyCommitted;
  while (count < blocks.length) {
    const block = blocks[count];
    if (block === undefined || !isBlockFinal(block)) break;
    count += 1;
  }
  return count;
}
