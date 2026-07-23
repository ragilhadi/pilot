import type { LineReader } from "../src/index.js";

/**
 * Drives a chat turn that needs a fixed number of permission approvals, without
 * racing fixed millisecond delays against however long the model/tool cycle
 * actually takes under CI load (spawning a real subprocess is notably variable
 * on hosted Windows runners). Waits for the next "[approval required" marker to
 * actually appear in rendered output before answering it, and waits for the
 * fake model's script queue to drain before sending /exit, so a slow run never
 * gets cancelled mid-flight by an /exit arriving too early.
 */
export function approvalAwareLines(options: {
  readonly initialLine: string;
  readonly approvalCount: number;
  readonly output: { readonly text: () => string };
  readonly remainingScripts: () => number;
  readonly pollIntervalMs?: number;
  readonly exitTimeoutMs?: number;
}): LineReader {
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const exitTimeoutMs = options.exitTimeoutMs ?? 20_000;
  let stage: "initial" | "approvals" | "exit" | "done" = "initial";
  let approvalsSent = 0;

  const countApprovalPrompts = () => options.output.text().split("[approval required").length - 1;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    async readLine() {
      if (stage === "initial") {
        stage = options.approvalCount > 0 ? "approvals" : "exit";
        return options.initialLine;
      }
      if (stage === "approvals") {
        const target = approvalsSent + 1;
        while (countApprovalPrompts() < target) {
          await sleep(pollIntervalMs);
        }
        approvalsSent += 1;
        if (approvalsSent >= options.approvalCount) stage = "exit";
        return "allow once";
      }
      if (stage === "exit") {
        stage = "done";
        const deadline = Date.now() + exitTimeoutMs;
        while (options.remainingScripts() > 0 && Date.now() < deadline) {
          await sleep(pollIntervalMs);
        }
        return "/exit";
      }
      return undefined;
    },
  } satisfies LineReader;
}
