/**
 * How much a token count can be trusted.
 *
 * - `exact` — produced by the model's own tokenizer.
 * - `calibrated` — a heuristic corrected against observed provider counts.
 * - `heuristic` — a structural estimate with no ground truth behind it.
 *
 * The display layer renders each differently, so a figure never claims more precision than it has.
 */
export type TokenCountConfidence = "exact" | "calibrated" | "heuristic";

/**
 * Counts tokens for a piece of text.
 *
 * Deliberately narrower than a tokenizer: implementations need not be able to produce token IDs,
 * only a count, so a byte heuristic, a bundled BPE table, and a remote `/api/tokenize` endpoint can
 * all satisfy it.
 */
export interface TokenCounter {
  /** Stable identifier used in diagnostics, e.g. `script-heuristic` or `ollama-api`. */
  readonly id: string;
  readonly confidence: TokenCountConfidence;
  count(text: string): number;
}
