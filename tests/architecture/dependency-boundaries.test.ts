import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface LayerRule {
  readonly packageName: string;
  readonly sourceDirectory: string;
  readonly allowedPilotImports: ReadonlySet<string>;
  readonly allowNodeBuiltins: boolean;
}

const workspaceRoot = path.resolve(import.meta.dirname, "../..");

const layerRules: readonly LayerRule[] = [
  {
    packageName: "@pilotrun/core",
    sourceDirectory: path.join(workspaceRoot, "packages/core/src"),
    allowedPilotImports: new Set(),
    allowNodeBuiltins: false,
  },
  {
    packageName: "@pilotrun/agent-runtime",
    sourceDirectory: path.join(workspaceRoot, "packages/agent-runtime/src"),
    allowedPilotImports: new Set(["@pilotrun/core"]),
    allowNodeBuiltins: false,
  },
  {
    packageName: "@pilotrun/testkit",
    sourceDirectory: path.join(workspaceRoot, "packages/testkit/src"),
    allowedPilotImports: new Set(["@pilotrun/core"]),
    allowNodeBuiltins: false,
  },
  {
    packageName: "@pilotrun/provider-openai-compatible",
    sourceDirectory: path.join(workspaceRoot, "packages/provider-openai-compatible/src"),
    allowedPilotImports: new Set(["@pilotrun/core"]),
    allowNodeBuiltins: true,
  },
  {
    packageName: "@pilotrun/tools-builtin",
    sourceDirectory: path.join(workspaceRoot, "packages/tools-builtin/src"),
    allowedPilotImports: new Set(["@pilotrun/core"]),
    allowNodeBuiltins: true,
  },
];

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return findTypeScriptFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );

  return nestedFiles.flat();
}

function importedSpecifiers(sourceText: string, filePath: string): string[] {
  const staticImportPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']/gu;
  const specifiers = [
    ...sourceText.matchAll(staticImportPattern),
    ...sourceText.matchAll(dynamicImportPattern),
  ].map((match) => match[1]);

  const malformedMatch = specifiers.find((specifier) => specifier === undefined);
  expect(malformedMatch, `Could not parse an import in ${filePath}`).toBeUndefined();

  return specifiers.filter((specifier): specifier is string => specifier !== undefined);
}

describe("package dependency boundaries", () => {
  for (const rule of layerRules) {
    it(`${rule.packageName} imports only allowed layers`, async () => {
      const violations: string[] = [];

      for (const filePath of await findTypeScriptFiles(rule.sourceDirectory)) {
        const sourceText = await readFile(filePath, "utf8");

        for (const specifier of importedSpecifiers(sourceText, filePath)) {
          if (specifier.startsWith("node:") && !rule.allowNodeBuiltins) {
            violations.push(`${path.relative(workspaceRoot, filePath)} imports ${specifier}`);
          }

          if (specifier.startsWith("@pilotrun/") && !rule.allowedPilotImports.has(specifier)) {
            violations.push(`${path.relative(workspaceRoot, filePath)} imports ${specifier}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  }
});
