declare const verifiedWorkspacePath: unique symbol;

export type WorkspaceAccess = "read" | "write";

/**
 * A path that a WorkspaceBoundary has lexically and physically verified. Concrete filesystem
 * operations must revalidate it immediately before access to narrow symlink race windows.
 */
export interface WorkspacePath {
  readonly [verifiedWorkspacePath]: true;
  readonly access: WorkspaceAccess;
  readonly rootPath: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly realPath?: string;
  readonly exists: boolean;
}

export interface WorkspaceBoundary {
  readonly rootPath: string;
  resolve(requestedPath: string, access: WorkspaceAccess): Promise<WorkspacePath>;
  revalidate(path: WorkspacePath): Promise<WorkspacePath>;
}
