import { parseAgentMessage, type AgentMessage } from "@pilot/core";
import type { RunAbortReason } from "./run-state-machine.js";

export type RunInterruption =
  | {
      readonly type: "cancel";
      readonly reason: Exclude<RunAbortReason, "budget-exhausted">;
    }
  | { readonly type: "follow-up"; readonly message: AgentMessage };

export type RunInterruptionListener = (interruption: RunInterruption) => void;
export type UnsubscribeRunInterruption = () => void;

/** A synchronous FIFO signal queue; session assembly consumes follow-ups in the next lesson. */
export class RunInterruptionQueue {
  readonly #items: RunInterruption[] = [];
  readonly #listeners = new Set<RunInterruptionListener>();

  get size(): number {
    return this.#items.length;
  }

  enqueue(input: RunInterruption): RunInterruption {
    const interruption = snapshotInterruption(input);
    this.#items.push(interruption);
    for (const listener of this.#listeners) {
      listener(interruption);
    }
    return interruption;
  }

  peek(): RunInterruption | undefined {
    return this.#items[0];
  }

  dequeue(): RunInterruption | undefined {
    return this.#items.shift();
  }

  subscribe(listener: RunInterruptionListener): UnsubscribeRunInterruption {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function snapshotInterruption(input: RunInterruption): RunInterruption {
  if (input.type === "cancel") {
    return Object.freeze({ type: "cancel", reason: input.reason });
  }
  return Object.freeze({ type: "follow-up", message: parseAgentMessage(input.message) });
}
