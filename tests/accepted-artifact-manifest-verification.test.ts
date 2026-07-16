import { describe, expect, it, vi } from "vitest";
import {
  inspectAcceptedArtifactManifestAtHead,
  type AcceptedArtifactWorktreePathObservation,
  type AcceptedArtifactManifestVerificationFailure,
} from "../src/core/AcceptedArtifactManifestVerification.js";
import type { ArtifactFileManifestEntry } from "../src/core/types.js";

const artifactPath = "tests/expected-red.test.ts";
const blobSha = "a".repeat(40);

describe("accepted artifact manifest verification", () => {
  it("checks worktree dirt before accepting the reviewed HEAD blob", async () => {
    const runGit = vi.fn(async (args: string[]) =>
      args[0] === "status"
        ? ` M ${artifactPath}\0`
        : `100644 blob ${blobSha}\t${artifactPath}\0`,
    );

    await expect(verify(addedManifest(), runGit)).resolves.toEqual({
      kind: "worktree_dirty",
    });
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(runGit.mock.calls[0]?.[0]).toContain(`:(literal)${artifactPath}`);
    expect(runGit.mock.calls[0]?.[0]).toContain("--ignored=matching");
  });

  it("accepts only the exact reviewed blob at current HEAD", async () => {
    await expect(
      verify(
        addedManifest(),
        exactBlobGit(blobSha.toUpperCase(), blobSha.toUpperCase()),
      ),
    ).resolves.toBeNull();

    await expect(
      verify(
        addedManifest(),
        exactBlobGit("b".repeat(40), "b".repeat(40)),
      ),
    ).resolves.toEqual({ kind: "blob_mismatch", path: artifactPath });
  });

  it("hashes the actual worktree file even when status reports it clean", async () => {
    await expect(
      verify(addedManifest(), exactBlobGit(blobSha, "b".repeat(40))),
    ).resolves.toEqual({ kind: "worktree_dirty" });
  });

  it("accepts an exact clean symlink blob without following the link target", async () => {
    const target = "../fixtures/reviewed-target";
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === "status") return "";
      if (args[0] === "ls-tree") {
        return `120000 blob ${blobSha}\t${artifactPath}\0`;
      }
      if (args[0] === "cat-file") return target;
      throw new Error("clean symlink verification must not hash the dereferenced path");
    });

    await expect(
      verify(
        addedManifest("120000"),
        runGit,
        async () => ({ kind: "symlink", target }),
      ),
    ).resolves.toBeNull();
    expect(runGit).toHaveBeenCalledTimes(3);
  });

  it("rejects a committed regular-file to symlink type change with the same blob", async () => {
    await expect(
      verify(
        addedManifest("100644"),
        async (args) => {
          if (args[0] === "status") return "";
          return `120000 blob ${blobSha}\t${artifactPath}\0`;
        },
        async () => ({ kind: "symlink", target: "reviewed contents" }),
      ),
    ).resolves.toEqual({ kind: "mode_mismatch", path: artifactPath });
  });

  it("rejects a symlink target mutation hidden from git status", async () => {
    await expect(
      verify(
        addedManifest("120000"),
        async (args) => {
          if (args[0] === "status") return "";
          if (args[0] === "ls-tree") {
            return `120000 blob ${blobSha}\t${artifactPath}\0`;
          }
          if (args[0] === "cat-file") return "reviewed-target";
          return null;
        },
        async () => ({ kind: "symlink", target: "mutated-target" }),
      ),
    ).resolves.toEqual({ kind: "worktree_dirty" });
  });

  it("accepts an absent reviewed deletion and rejects its restoration", async () => {
    const deleted = deletedManifest();

    await expect(
      verify(deleted, async () => ""),
    ).resolves.toBeNull();
    await expect(
      verify(deleted, async (args) =>
        args[0] === "status"
          ? ""
          : `100644 blob ${blobSha}\t${artifactPath}\0`,
      ),
    ).resolves.toEqual({ kind: "deleted_path_present", path: artifactPath });

    await expect(
      verify(
        deleted,
        async (args) => {
          if (args[0] === "status" || args[0] === "ls-tree") return "";
          return blobSha;
        },
        async () => ({ kind: "file", executable: false }),
      ),
    ).resolves.toEqual({ kind: "worktree_dirty" });
  });

  it("fails closed on malformed tree output even for a reviewed deletion", async () => {
    await expect(
      verify(deletedManifest(), async (args) =>
        args[0] === "status" ? "" : "malformed non-empty tree output",
      ),
    ).resolves.toEqual({ kind: "tree_inspection_failed", path: artifactPath });
  });

  it.each([
    {
      name: "a non-array manifest",
      manifest: null,
      message: "must be an array",
    },
    {
      name: "a non-record entry",
      manifest: [null],
      message: "entry 0 is invalid",
    },
    {
      name: "an unsafe path",
      manifest: [{ path: "../escape", status: "added", blobSha }],
      message: "entry 0 has an invalid path",
    },
    {
      name: "the repository root",
      manifest: [{ path: ".", status: "added", blobSha }],
      message: "entry 0 has an invalid path",
    },
    {
      name: "an unknown status",
      manifest: [{ path: artifactPath, status: "unexpected", blobSha }],
      message: "has an invalid status",
    },
    {
      name: "a deletion with a blob",
      manifest: [{ path: artifactPath, status: "deleted", blobSha }],
      message: "must have a null blob SHA",
    },
    {
      name: "a deletion with a Git mode",
      manifest: [{ path: artifactPath, status: "deleted", blobSha: null, mode: "100644" }],
      message: "must have a null Git mode",
    },
    {
      name: "a non-string blob",
      manifest: [{ path: artifactPath, status: "added", blobSha: 42 }],
      message: "must have a full blob SHA",
    },
    {
      name: "an invalid Git mode",
      manifest: [{ path: artifactPath, status: "added", blobSha, mode: "100664" }],
      message: "has an invalid Git mode",
    },
  ])("rejects $name before running git", async ({ manifest, message }) => {
    const runGit = vi.fn(async () => "");

    const failure = await verify(
      manifest as unknown as ArtifactFileManifestEntry[],
      runGit,
    );

    expect(failure).toMatchObject({ kind: "invalid_manifest" });
    expect((failure as Extract<AcceptedArtifactManifestVerificationFailure, { kind: "invalid_manifest" }>).message)
      .toContain(message);
    expect(runGit).not.toHaveBeenCalled();
  });
});

function addedManifest(
  mode: NonNullable<ArtifactFileManifestEntry["mode"]> = "100644",
): ArtifactFileManifestEntry[] {
  return [{ path: artifactPath, status: "added", blobSha, mode }];
}

function deletedManifest(): ArtifactFileManifestEntry[] {
  return [{ path: artifactPath, status: "deleted", blobSha: null, mode: null }];
}

function verify(
  manifest: ArtifactFileManifestEntry[],
  runGit: (args: string[]) => Promise<string | null>,
  inspectWorktreePath: (
    filePath: string,
  ) => Promise<AcceptedArtifactWorktreePathObservation> = async () =>
    manifest[0]?.status === "deleted"
      ? { kind: "missing" }
      : {
          kind: "file",
          executable: manifest[0]?.mode === "100755",
        },
): Promise<AcceptedArtifactManifestVerificationFailure | null> {
  return inspectAcceptedArtifactManifestAtHead({
    manifest,
    runGit,
    inspectWorktreePath,
  });
}

function exactBlobGit(
  headBlobSha: string,
  worktreeBlobSha: string,
  mode = "100644",
): (args: string[]) => Promise<string | null> {
  return async (args) => {
    if (args[0] === "status") return "";
    if (args[0] === "hash-object") return worktreeBlobSha;
    return `${mode} blob ${headBlobSha}\t${artifactPath}\0`;
  };
}
