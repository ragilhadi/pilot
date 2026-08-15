import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { repositoryRoot } from "./package-versions.mjs";

// Asserts every relative Markdown link resolves to something a reader will actually receive.
//
// Existence on disk is the wrong question on its own. `/docs/` is ignored, so a link into it
// resolves for whoever wrote it and 404s for everyone reading the same file on GitHub or on npm —
// which is exactly how README.md came to link a user guide that was never published. A target
// counts only if git tracks it, or if it is present and not ignored (a file staged in the same
// change as the link to it).
const run = promisify(execFile);

async function git(args) {
  const { stdout } = await run("git", args, { cwd: repositoryRoot });
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

const tracked = new Set(await git(["ls-files", "-z"]));
const trackedDirectories = new Set(
  [...tracked].flatMap((entry) => {
    const segments = entry.split("/").slice(0, -1);
    return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  }),
);

async function isPublished(relativePath) {
  if (tracked.has(relativePath) || trackedDirectories.has(relativePath)) return true;
  try {
    await access(path.join(repositoryRoot, relativePath));
  } catch {
    return false;
  }
  // `check-ignore --quiet` exits 0 when the path is ignored and 1 when it is not, and execFile
  // reports both non-zero exits and a failure to run git the same way — so the exit code is
  // checked rather than assumed, and anything else is rethrown instead of read as "fine".
  try {
    await run("git", ["check-ignore", "--quiet", "--", relativePath], { cwd: repositoryRoot });
    return false;
  } catch (error) {
    if (error.code === 1) return true;
    throw error;
  }
}

// [text](target) and [text]: target. Images are left out: a broken one is visible on the page.
const inlineLink = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
const referenceLink = /^\s*\[[^\]]+\]:\s*(\S+)/gmu;

const problems = [];
for (const file of await git(["ls-files", "-z", "*.md"])) {
  const content = await readFile(path.join(repositoryRoot, file), "utf8");
  const targets = [...content.matchAll(inlineLink), ...content.matchAll(referenceLink)].map(
    ([, target]) => target,
  );
  for (const target of targets) {
    // Absolute URLs, protocol-relative URLs, and same-document anchors are somebody else's problem.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(target)) continue;
    const [linkPath] = target.split("#");
    if (linkPath === undefined || linkPath.length === 0) continue;
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(file), linkPath))
      .replace(/\/$/u, "");
    if (!(await isPublished(resolved))) {
      problems.push(`${file}: ${target} does not resolve to a published file`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.stderr.write("Link to a committed file, or inline the content.\n");
  process.exitCode = 1;
} else {
  process.stdout.write("All relative Markdown links resolve to published files\n");
}
