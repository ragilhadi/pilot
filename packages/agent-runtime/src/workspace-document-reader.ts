/**
 * The shared port for reading text documents that live beside the code: `AGENTS.md` instruction
 * files, skill definitions, and prompt templates.
 *
 * Every one of them is bounded, UTF-8, and either inside the workspace or under the user's own
 * data directory, so they share one request/result shape. The runtime never touches a file system
 * itself; the host adapter decides what "inside the workspace" means and enforces it.
 */

export type DocumentOrigin = "global" | "workspace";

export type DocumentRejectionReason = "outside-workspace" | "read-failed" | "too-large";

export interface DocumentReadRequest {
  readonly kind: DocumentOrigin;
  readonly path: string;
  readonly maximumBytes: number;
}

export type DocumentReadResult =
  | { readonly status: "missing" }
  | {
      readonly status: "rejected";
      readonly reason: DocumentRejectionReason;
      readonly detail: string;
    }
  | {
      readonly status: "found";
      readonly displayPath: string;
      readonly realPath: string;
      readonly content: string;
      readonly bytes: number;
    };

export interface DocumentReader {
  read(request: DocumentReadRequest): Promise<DocumentReadResult>;
}

export interface DocumentDirectoryRequest {
  readonly kind: DocumentOrigin;
  readonly path: string;
}

export interface DocumentDirectoryEntry {
  /** A single path segment; never a nested path. */
  readonly name: string;
  readonly kind: "file" | "directory";
}

export type DocumentListResult =
  | { readonly status: "missing" }
  | {
      readonly status: "rejected";
      readonly reason: DocumentRejectionReason;
      readonly detail: string;
    }
  | { readonly status: "listed"; readonly entries: readonly DocumentDirectoryEntry[] };

/** A reader that can also enumerate a directory, which name-addressed catalogues require. */
export interface DocumentDirectoryReader extends DocumentReader {
  list(request: DocumentDirectoryRequest): Promise<DocumentListResult>;
}
