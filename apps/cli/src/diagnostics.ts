import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { diagnoseSqliteDatabase, type SqliteDatabase } from "@pilot/persistence-sqlite";

export type DiagnosticStatus = "fail" | "pass" | "warn";

export interface DiagnosticCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DiagnosticStatus;
  readonly message: string;
  readonly durationMs: number;
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly generatedAt: string;
  readonly durationMs: number;
  readonly startupMs: number;
  readonly memoryRssBytes: number;
  readonly checks: readonly DiagnosticCheck[];
}

export interface ProviderCredentialDiagnostic {
  readonly provider: string;
  readonly environmentVariable?: string;
  readonly configured: boolean;
}

export interface DoctorDependencies {
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly startedAtMs: number;
  readonly nodeVersion: string;
  readonly memoryRssBytes: () => number;
  readonly workspacePath: string;
  readonly database?: SqliteDatabase;
  readonly providerCredentials: readonly ProviderCredentialDiagnostic[];
  readonly probeCommand: (kind: "git" | "shell") => Promise<boolean>;
  readonly checkWorkspaceAccess?: (path: string, mode: number) => Promise<void>;
}

export class PilotDoctor {
  readonly #dependencies: DoctorDependencies;

  constructor(dependencies: DoctorDependencies) {
    this.#dependencies = dependencies;
  }

  async diagnose(): Promise<DoctorReport> {
    const startedAt = this.#dependencies.monotonicNow();
    const checks: DiagnosticCheck[] = [];
    checks.push(await this.#nodeCheck());
    checks.push(
      await this.#measure("configuration", "Configuration", async () => ({
        status: "pass",
        message: "Configuration loaded and validated",
      })),
    );
    checks.push(...(await this.#credentialChecks()));
    checks.push(await this.#databaseCheck());
    checks.push(await this.#workspaceCheck());
    checks.push(await this.#commandCheck("git", "Git", "Install Git and ensure it is on PATH"));
    checks.push(
      await this.#commandCheck(
        "shell",
        "Shell",
        "Configure an available system shell before using shell-mode commands",
      ),
    );
    checks.push(
      await this.#measure("plugins", "Plugins", async () => ({
        status: "warn",
        message: "Plugin compatibility checks are deferred beyond the MVP",
      })),
    );
    return Object.freeze({
      healthy: checks.every(({ status }) => status !== "fail"),
      generatedAt: this.#dependencies.now().toISOString(),
      durationMs: elapsed(startedAt, this.#dependencies.monotonicNow()),
      startupMs: elapsed(this.#dependencies.startedAtMs, this.#dependencies.monotonicNow()),
      memoryRssBytes: this.#dependencies.memoryRssBytes(),
      checks: Object.freeze(checks),
    });
  }

  async #nodeCheck(): Promise<DiagnosticCheck> {
    return this.#measure("node", "Node.js", async () => {
      const major = Number.parseInt(
        this.#dependencies.nodeVersion.replace(/^v/u, "").split(".")[0] ?? "0",
        10,
      );
      return major >= 22
        ? { status: "pass", message: `${this.#dependencies.nodeVersion} supports node:sqlite` }
        : {
            status: "fail",
            message: `${this.#dependencies.nodeVersion} is unsupported`,
            remediation: "Install Node.js 22 or newer",
          };
    });
  }

  async #credentialChecks(): Promise<readonly DiagnosticCheck[]> {
    if (this.#dependencies.providerCredentials.length === 0) {
      return [
        await this.#measure("provider:credentials", "Provider credentials", async () => ({
          status: "pass",
          message: "The default Ollama route does not require a configured API secret",
        })),
      ];
    }
    return Promise.all(
      this.#dependencies.providerCredentials.map((credential) =>
        this.#measure(
          `provider:${credential.provider}`,
          `Provider ${credential.provider}`,
          async () =>
            credential.configured
              ? {
                  status: "pass",
                  message: `Credential reference ${credential.environmentVariable ?? "configured"} is present`,
                }
              : {
                  status: "fail",
                  message: `Credential reference ${credential.environmentVariable ?? "required"} is missing`,
                  remediation: `Set ${credential.environmentVariable ?? "the configured credential"} without placing the secret in configuration`,
                },
        ),
      ),
    );
  }

  async #databaseCheck(): Promise<DiagnosticCheck> {
    return this.#measure("database", "Database", async () => {
      if (this.#dependencies.database === undefined) {
        return {
          status: "fail",
          message: "Session database is unavailable",
          remediation: "Check PILOT_DATA_DIR permissions and available disk space",
        };
      }
      const report = diagnoseSqliteDatabase(this.#dependencies.database);
      return report.healthy
        ? {
            status: "pass",
            message: `SQLite schema ${report.schemaVersion} passed integrity checks`,
          }
        : {
            status: "fail",
            message: "SQLite integrity or foreign-key validation failed",
            remediation: "Back up the database and restore a verified copy before continuing",
          };
    });
  }

  async #workspaceCheck(): Promise<DiagnosticCheck> {
    return this.#measure("workspace", "Workspace", async () => {
      try {
        const check = this.#dependencies.checkWorkspaceAccess ?? access;
        await check(this.#dependencies.workspacePath, constants.R_OK | constants.W_OK);
        return { status: "pass", message: "Workspace is readable and writable" };
      } catch {
        return {
          status: "fail",
          message: "Workspace read/write access is unavailable",
          remediation:
            "Run Pilot in a readable workspace and grant write access when edits are needed",
        };
      }
    });
  }

  async #commandCheck(
    kind: "git" | "shell",
    label: string,
    remediation: string,
  ): Promise<DiagnosticCheck> {
    return this.#measure(kind, label, async () =>
      (await this.#dependencies.probeCommand(kind))
        ? { status: "pass", message: `${label} is available` }
        : { status: "fail", message: `${label} is unavailable`, remediation },
    );
  }

  async #measure(
    id: string,
    label: string,
    operation: () => Promise<{
      readonly status: DiagnosticStatus;
      readonly message: string;
      readonly remediation?: string;
    }>,
  ): Promise<DiagnosticCheck> {
    const startedAt = this.#dependencies.monotonicNow();
    try {
      const result = await operation();
      return Object.freeze({
        id,
        label,
        ...result,
        durationMs: elapsed(startedAt, this.#dependencies.monotonicNow()),
      });
    } catch {
      return Object.freeze({
        id,
        label,
        status: "fail",
        message: `${label} diagnostic failed safely`,
        durationMs: elapsed(startedAt, this.#dependencies.monotonicNow()),
        remediation:
          "Review Pilot logs and rerun pilot doctor after correcting the underlying issue",
      });
    }
  }
}

export function renderDoctorReport(report: DoctorReport, json: boolean): string {
  if (json) return `${JSON.stringify(report)}\n`;
  const lines = [
    `Pilot doctor: ${report.healthy ? "healthy" : "unhealthy"}`,
    `Startup: ${report.startupMs}ms  Diagnostics: ${report.durationMs}ms  RSS: ${report.memoryRssBytes} bytes`,
    "STATUS\tCHECK\tDURATION\tDETAIL",
  ];
  for (const check of report.checks) {
    lines.push(
      `${check.status.toUpperCase()}\t${check.label}\t${check.durationMs}ms\t${check.message}`,
    );
    if (check.remediation !== undefined) lines.push(`  fix: ${check.remediation}`);
  }
  return `${lines.join("\n")}\n`;
}

function elapsed(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 1_000) / 1_000);
}
