// The tiny drop-internal framing carried INSIDE the CLI↔API WebSocket for `drop exec` (J3). This is
// DISTINCT from the kube `v4.channel.k8s.io` protocol on the API↔kubelet leg (src/kube/exec.ts): the
// bridge translates between the two. Kept minimal and pure so both ends (the server bridge in
// src/api/exec-bridge.ts and the CLI client in src/cli/exec.ts) agree on exactly one wire format,
// tested once.
//
// Direction & shape:
//   • server → client, BINARY frame: first byte is a STREAM MARKER, rest is the bytes. One WS binary
//     channel carries both stdout and stderr back, split by the marker (1=stdout, 2=stderr). A final
//     3=exit frame carries the remote process's exit code as ASCII digits so the CLI can mirror it.
//   • client → server, BINARY frame: raw stdin bytes, NO marker — stdin is the only inbound stream.
//   • client → server, TEXT frame: a JSON resize `{"cols":N,"rows":M}` → the kube resize channel (4).

/** Server→client stream markers (the first byte of a binary frame). */
export const EXEC_STREAM = { stdout: 1, stderr: 2, exit: 3 } as const;

/** Prefix a server→client chunk with its stream marker. Pure. */
export function encodeExecChunk(marker: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([marker]), data]);
}

/** Split a server→client binary frame into {marker, data}. An empty frame → marker -1 (ignored). Pure. */
export function decodeExecChunk(payload: Buffer): { marker: number; data: Buffer } {
  if (payload.length === 0) return { marker: -1, data: Buffer.alloc(0) };
  return { marker: payload[0]!, data: payload.subarray(1) };
}

/** The client→server resize control message (a TEXT frame body). Pure. */
export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ cols, rows });
}

/** Parse a resize TEXT frame body, or null if it isn't a well-formed `{cols,rows}`. Pure. */
export function parseResize(s: string): { cols: number; rows: number } | null {
  try {
    const o = JSON.parse(s) as { cols?: unknown; rows?: unknown };
    if (typeof o.cols === "number" && typeof o.rows === "number" && o.cols > 0 && o.rows > 0) {
      return { cols: Math.floor(o.cols), rows: Math.floor(o.rows) };
    }
  } catch {
    /* not JSON → not a resize */
  }
  return null;
}
