// Browser-side mirror of the drop-internal exec framing (src/ws/exec-protocol.ts), reimplemented over
// Uint8Array / TextEncoder instead of Node `Buffer` so it runs inside the console bundle. The console
// can't import the real module at runtime (it uses Node `Buffer`), so — exactly like validateName.ts /
// status.ts mirror their server counterparts — this file re-states the wire format and a lockstep test
// (exec-stream.test.ts) pins it BYTE-FOR-BYTE to src/ws/exec-protocol.ts.
//
// The browser `WebSocket` handles RFC-6455 masking/framing for us (unlike the CLI, which hand-rolls it),
// so this adapter only concerns the INNER exec framing carried inside each WS message:
//   • server → client, BINARY message: [marker(1)] + bytes — 1=stdout, 2=stderr, 3=exit(ascii code).
//   • client → server, BINARY message: raw stdin bytes, NO marker (stdin is the only inbound stream).
//   • client → server, TEXT message: a JSON `{cols,rows}` resize.
// Everything here is pure so it table-tests without a DOM or a socket; the TerminalPanel wires xterm's
// onData/onResize into these and routes inbound messages through decodeServerFrame.

/** Server→client stream markers (the first byte of a binary frame). Mirrors EXEC_STREAM in the server. */
export const EXEC_STREAM = { stdout: 1, stderr: 2, exit: 3 } as const;

/** A decoded server→client frame: a stdout/stderr chunk, the process exit, or an ignorable empty frame. */
export type ServerFrame =
  | { kind: "stdout" | "stderr"; data: Uint8Array }
  | { kind: "exit"; code: number }
  | { kind: "ignore" };

/** Split a server→client binary frame into a typed event. Mirrors decodeExecChunk over Uint8Array; an
 *  empty frame (or an unknown marker) is `ignore`. The exit code is ASCII digits after the marker. Pure. */
export function decodeServerFrame(payload: Uint8Array): ServerFrame {
  if (payload.length === 0) return { kind: "ignore" };
  const marker = payload[0]!;
  const data = payload.subarray(1);
  if (marker === EXEC_STREAM.stdout) return { kind: "stdout", data };
  if (marker === EXEC_STREAM.stderr) return { kind: "stderr", data };
  if (marker === EXEC_STREAM.exit) return { kind: "exit", code: Number(new TextDecoder().decode(data)) || 0 };
  return { kind: "ignore" };
}

/** Encode xterm keystroke data (its onData string) as a raw-stdin up-frame — UTF-8 bytes, NO marker,
 *  matching what the CLI sends from process.stdin. Pure. */
export function encodeStdin(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

/** Encode a terminal resize as the JSON body of a TEXT up-frame. Mirrors encodeResize in the server so
 *  the real parseResize accepts it verbatim (asserted in the lockstep test). Pure. */
export function encodeResizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ cols, rows });
}

/** Normalize a browser WebSocket binary payload (ArrayBuffer or a typed-array view) into a Uint8Array.
 *  A string (only ever a stray TEXT frame server-side, which the protocol never sends down) → empty. */
export function toBytes(data: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof data === "string") return new Uint8Array(0);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
