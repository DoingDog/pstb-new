import { diffLines } from "diff";

export type DiffLineKind = "add" | "delete" | "same";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export type DiffId = number | string;

export interface DiffRequest {
  type: "diff";
  id: DiffId;
  previous: string;
  current: string;
}

export type DiffResponse =
  | { type: "result"; id: DiffId; lines: DiffLine[] }
  | { type: "error"; id: DiffId; message: string };

function splitLines(value: string): string[] {
  const lines: string[] = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      lines.push(value.slice(start, index + 1));
      start = index + 1;
    }
  }

  if (start < value.length) lines.push(value.slice(start));
  return lines;
}

export function diffResponse(request: DiffRequest): DiffResponse {
  try {
    const lines = diffLines(request.previous, request.current).flatMap((change) => {
      const kind: DiffLineKind = change.added ? "add" : change.removed ? "delete" : "same";
      return splitLines(change.value).map((text) => ({ kind, text }));
    });
    return { type: "result", id: request.id, lines };
  } catch (error) {
    return {
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : "Unable to calculate diff",
    };
  }
}

function isDiffRequest(value: unknown): value is DiffRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<DiffRequest>;
  return (
    request.type === "diff" &&
    (typeof request.id === "string" || typeof request.id === "number") &&
    typeof request.previous === "string" &&
    typeof request.current === "string"
  );
}

const workerScope = globalThis as unknown as {
  addEventListener?: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
  postMessage?: (message: DiffResponse) => void;
};

if (typeof workerScope.addEventListener === "function" && typeof workerScope.postMessage === "function") {
  workerScope.addEventListener("message", (event) => {
    if (!isDiffRequest(event.data)) return;
    workerScope.postMessage?.(diffResponse(event.data));
  });
}
