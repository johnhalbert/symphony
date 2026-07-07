export interface CtrlCInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export function installCtrlCInterceptor(input: CtrlCInput, onInterrupt: () => void): () => void {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") return () => undefined;
  const wasRaw = input.isRaw === true;
  let installed = true;
  const onData = (chunk: Buffer | string): void => {
    if (containsCtrlC(chunk)) onInterrupt();
  };
  input.setRawMode(true);
  input.resume?.();
  input.on("data", onData);
  return () => {
    if (!installed) return;
    installed = false;
    input.off("data", onData);
    input.setRawMode?.(wasRaw);
  };
}

function containsCtrlC(chunk: Buffer | string): boolean {
  if (typeof chunk === "string") return chunk.includes("\x03");
  return chunk.includes(3);
}
