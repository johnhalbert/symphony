import { promises as fs } from "node:fs";
import path from "node:path";
import type { ArtifactFileManifestEntry } from "./types.js";

export type AcceptedArtifactManifestVerificationFailure =
  | { kind: "empty_manifest" }
  | { kind: "invalid_manifest"; message: string }
  | { kind: "worktree_inspection_failed" }
  | { kind: "worktree_dirty" }
  | { kind: "tree_inspection_failed"; path: string }
  | { kind: "deleted_path_present"; path: string }
  | { kind: "mode_mismatch"; path: string }
  | { kind: "blob_mismatch"; path: string };

export type AcceptedArtifactWorktreePathObservation =
  | { kind: "missing" }
  | { kind: "file"; executable: boolean }
  | { kind: "symlink"; target: string }
  | { kind: "other" };

export interface AcceptedArtifactManifestAtHeadInput {
  manifest: ArtifactFileManifestEntry[];
  runGit(args: string[]): Promise<string | null>;
  inspectWorktreePath(
    filePath: string,
  ): Promise<AcceptedArtifactWorktreePathObservation>;
}

export async function inspectAcceptedArtifactManifestAtHead(
  input: AcceptedArtifactManifestAtHeadInput,
): Promise<AcceptedArtifactManifestVerificationFailure | null> {
  const invalid = validateManifest(input.manifest);
  if (invalid !== null) return invalid;

  const literalPaths = input.manifest.map((entry) => literalPathspec(entry.path));
  let status: string | null;
  try {
    status = await input.runGit([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--",
      ...literalPaths,
    ]);
  } catch {
    return { kind: "worktree_inspection_failed" };
  }
  if (status === null) return { kind: "worktree_inspection_failed" };
  if (status.length > 0) return { kind: "worktree_dirty" };

  for (const entry of input.manifest) {
    let treeEntry: string | null;
    try {
      treeEntry = await input.runGit([
        "ls-tree",
        "-z",
        "HEAD",
        "--",
        literalPathspec(entry.path),
      ]);
    } catch {
      return { kind: "tree_inspection_failed", path: entry.path };
    }
    if (treeEntry === null) {
      return { kind: "tree_inspection_failed", path: entry.path };
    }
    const parsedTreeEntry = parseTreeEntry(treeEntry, entry.path);
    if (parsedTreeEntry.kind === "invalid") {
      return { kind: "tree_inspection_failed", path: entry.path };
    }
    if (entry.status === "deleted") {
      if (parsedTreeEntry.kind === "present") {
        return { kind: "deleted_path_present", path: entry.path };
      }
      const observation = await worktreePathObservation(input, entry.path);
      if (observation === null) {
        return { kind: "worktree_inspection_failed" };
      }
      if (observation.kind !== "missing") {
        return { kind: "worktree_dirty" };
      }
      continue;
    }
    if (
      parsedTreeEntry.kind !== "present" ||
      parsedTreeEntry.objectType !== "blob" ||
      parsedTreeEntry.objectSha.toLowerCase() !== entry.blobSha?.toLowerCase()
    ) {
      return { kind: "blob_mismatch", path: entry.path };
    }
    if (entry.mode !== undefined && parsedTreeEntry.mode !== entry.mode) {
      return { kind: "mode_mismatch", path: entry.path };
    }
    const observation = await worktreePathObservation(input, entry.path);
    if (observation === null) {
      return { kind: "worktree_inspection_failed" };
    }
    if (parsedTreeEntry.mode === "120000") {
      if (observation.kind !== "symlink") {
        return { kind: "worktree_dirty" };
      }
      const expectedTarget = await gitBlobContents(
        input,
        parsedTreeEntry.objectSha,
      );
      if (expectedTarget === null) {
        return { kind: "tree_inspection_failed", path: entry.path };
      }
      if (observation.target !== expectedTarget) {
        return { kind: "worktree_dirty" };
      }
      continue;
    }
    if (
      (parsedTreeEntry.mode !== "100644" &&
        parsedTreeEntry.mode !== "100755") ||
      observation.kind !== "file" ||
      observation.executable !== (parsedTreeEntry.mode === "100755") ||
      (await worktreeObjectSha(input, entry.path))?.toLowerCase() !==
        entry.blobSha?.toLowerCase()
    ) {
      return { kind: "worktree_dirty" };
    }
  }
  return null;
}

function validateManifest(
  manifest: ArtifactFileManifestEntry[],
): AcceptedArtifactManifestVerificationFailure | null {
  if (!Array.isArray(manifest)) {
    return {
      kind: "invalid_manifest",
      message: "Accepted-artifact manifest must be an array",
    };
  }
  if (manifest.length === 0) return { kind: "empty_manifest" };
  const seen = new Set<string>();
  for (const [index, value] of manifest.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {
        kind: "invalid_manifest",
        message: `Accepted-artifact manifest entry ${index} is invalid`,
      };
    }
    const entry = value as ArtifactFileManifestEntry;
    if (typeof entry.path !== "string" || !isRepositoryRelativePath(entry.path)) {
      return {
        kind: "invalid_manifest",
        message: `Accepted-artifact manifest entry ${index} has an invalid path`,
      };
    }
    if (!isArtifactFileStatus(entry.status)) {
      return {
        kind: "invalid_manifest",
        message: `Accepted-artifact manifest path ${entry.path} has an invalid status`,
      };
    }
    if (seen.has(entry.path)) {
      return {
        kind: "invalid_manifest",
        message: `Accepted-artifact manifest repeats path ${entry.path}`,
      };
    }
    seen.add(entry.path);
    if (entry.status === "deleted") {
      if (entry.blobSha !== null) {
        return {
          kind: "invalid_manifest",
          message: `Deleted accepted-artifact path ${entry.path} must have a null blob SHA`,
        };
      }
      if (entry.mode !== undefined && entry.mode !== null) {
        return {
          kind: "invalid_manifest",
          message: `Deleted accepted-artifact path ${entry.path} must have a null Git mode`,
        };
      }
      continue;
    }
    if (
      typeof entry.blobSha !== "string" ||
      !/^[0-9a-f]{40,64}$/i.test(entry.blobSha)
    ) {
      return {
        kind: "invalid_manifest",
        message: `Accepted-artifact path ${entry.path} must have a full blob SHA`,
      };
    }
    if (entry.mode !== undefined && !isArtifactFileMode(entry.mode)) {
      return {
        kind: "invalid_manifest",
        message: `Accepted-artifact path ${entry.path} has an invalid Git mode`,
      };
    }
  }
  return null;
}

function isArtifactFileMode(
  value: unknown,
): value is NonNullable<ArtifactFileManifestEntry["mode"]> {
  return value === "100644" || value === "100755" || value === "120000";
}

function isArtifactFileStatus(
  value: unknown,
): value is ArtifactFileManifestEntry["status"] {
  return (
    value === "added" ||
    value === "modified" ||
    value === "deleted" ||
    value === "renamed"
  );
}

function isRepositoryRelativePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    filePath !== "." &&
    !filePath.includes("\0") &&
    !path.posix.isAbsolute(filePath) &&
    !path.posix.normalize(filePath).startsWith("../") &&
    path.posix.normalize(filePath) === filePath
  );
}

async function worktreeObjectSha(
  input: AcceptedArtifactManifestAtHeadInput,
  filePath: string,
): Promise<string | null> {
  try {
    const result = await input.runGit([
      "hash-object",
      `--path=${filePath}`,
      "--",
      filePath,
    ]);
    const objectSha = result?.trim() ?? "";
    return objectSha.length > 0 ? objectSha : null;
  } catch {
    return null;
  }
}

async function worktreePathObservation(
  input: AcceptedArtifactManifestAtHeadInput,
  filePath: string,
): Promise<AcceptedArtifactWorktreePathObservation | null> {
  try {
    return await input.inspectWorktreePath(filePath);
  } catch {
    return null;
  }
}

async function gitBlobContents(
  input: AcceptedArtifactManifestAtHeadInput,
  objectSha: string,
): Promise<string | null> {
  try {
    return await input.runGit(["cat-file", "blob", objectSha]);
  } catch {
    return null;
  }
}

export async function inspectAcceptedArtifactWorktreePath(
  workspacePath: string,
  filePath: string,
): Promise<AcceptedArtifactWorktreePathObservation> {
  const absolutePath = path.join(workspacePath, filePath);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", target: await fs.readlink(absolutePath) };
  }
  if (stat.isFile()) {
    return { kind: "file", executable: (stat.mode & 0o100) !== 0 };
  }
  return { kind: "other" };
}

function literalPathspec(filePath: string): string {
  return `:(literal)${filePath}`;
}

type ParsedTreeEntry =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; mode: string; objectType: string; objectSha: string };

function parseTreeEntry(treeEntry: string, expectedPath: string): ParsedTreeEntry {
  if (treeEntry.length === 0) return { kind: "absent" };
  const records = treeEntry.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length !== 1) return { kind: "invalid" };
  const record = records[0]!;
  const tab = record.indexOf("\t");
  if (tab < 0 || record.slice(tab + 1) !== expectedPath) {
    return { kind: "invalid" };
  }
  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/i.exec(
    record.slice(0, tab),
  );
  if (match === null) return { kind: "invalid" };
  return {
    kind: "present",
    mode: match[1]!,
    objectType: match[2]!.toLowerCase(),
    objectSha: match[3]!,
  };
}
