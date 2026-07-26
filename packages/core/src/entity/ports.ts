export interface Clock {
  now(): Date;
}

/** Supplies untrusted identifier text that a domain-specific factory must validate and brand. */
export interface IdSource {
  next(): string;
}
