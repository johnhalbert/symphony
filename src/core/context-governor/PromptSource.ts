import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type PromptSourceKind = "file" | "stdin" | "inline";

export interface PromptSource {
  kind: PromptSourceKind;
  label: string;
  text: string;
  sha256: string;
  charCount: number;
  byteCount: number;
  lineCount: number;
}

export async function loadPromptFromFile(filePath: string): Promise<PromptSource> {
  const resolved = path.resolve(filePath);
  const text = await fs.readFile(resolved, "utf8");
  return promptSourceFromText({ kind: "file", label: resolved, text });
}

export function promptSourceFromText(input: { kind: PromptSourceKind; label: string; text: string }): PromptSource {
  const byteCount = Buffer.byteLength(input.text, "utf8");
  return {
    kind: input.kind,
    label: input.label,
    text: input.text,
    sha256: createHash("sha256").update(input.text).digest("hex"),
    charCount: [...input.text].length,
    byteCount,
    lineCount: input.text.length === 0 ? 0 : input.text.split(/\r?\n/).length,
  };
}

export async function readPromptFromStdin(input: NodeJS.ReadStream = process.stdin): Promise<PromptSource> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return promptSourceFromText({ kind: "stdin", label: "stdin", text: Buffer.concat(chunks).toString("utf8") });
}
