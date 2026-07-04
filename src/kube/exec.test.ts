import { test, expect } from "bun:test";
import {
  EXEC_CHANNEL,
  KUBE_EXEC_SUBPROTOCOL,
  encodeStdinChannel,
  encodeResizeChannel,
  parseChannelFrame,
  exitCodeFromStatus,
} from "./exec.ts";

// ---- v4.channel.k8s.io channel framing (J3) — pure, no cluster --------------------------------

test("the subprotocol is v4.channel.k8s.io", () => {
  expect(KUBE_EXEC_SUBPROTOCOL).toBe("v4.channel.k8s.io");
});

test("encodeStdinChannel prefixes the stdin channel byte (0)", () => {
  const framed = encodeStdinChannel(Buffer.from("ls -la\n"));
  expect(framed[0]).toBe(EXEC_CHANNEL.stdin); // 0
  expect(framed.subarray(1).toString()).toBe("ls -la\n");
});

test("encodeResizeChannel is channel 4 + JSON {Width,Height} (kube's field names)", () => {
  const framed = encodeResizeChannel(120, 40);
  expect(framed[0]).toBe(EXEC_CHANNEL.resize); // 4
  expect(JSON.parse(framed.subarray(1).toString())).toEqual({ Width: 120, Height: 40 });
});

test("parseChannelFrame splits stdout(1)/stderr(2)/error(3) messages", () => {
  const stdout = Buffer.concat([Buffer.from([1]), Buffer.from("out")]);
  const stderr = Buffer.concat([Buffer.from([2]), Buffer.from("err")]);
  const err = Buffer.concat([Buffer.from([3]), Buffer.from("{}")]);
  expect(parseChannelFrame(stdout)).toEqual({ channel: 1, data: Buffer.from("out") });
  expect(parseChannelFrame(stderr)).toEqual({ channel: 2, data: Buffer.from("err") });
  expect(parseChannelFrame(err)).toEqual({ channel: 3, data: Buffer.from("{}") });
});

test("parseChannelFrame: an empty payload yields channel -1 (ignored, never throws)", () => {
  expect(parseChannelFrame(Buffer.alloc(0))).toEqual({ channel: -1, data: Buffer.alloc(0) });
});

test("parseChannelFrame preserves binary stdout bytes", () => {
  const bin = Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0x00, 0xff]);
  const framed = Buffer.concat([Buffer.from([EXEC_CHANNEL.stdout]), bin]);
  expect(parseChannelFrame(framed).data.equals(bin)).toBe(true);
});

// ---- exit-code extraction from the channel-3 metav1.Status JSON --------------------------------

test("exitCodeFromStatus: Success → 0", () => {
  expect(exitCodeFromStatus(JSON.stringify({ status: "Success" }))).toBe(0);
});

test("exitCodeFromStatus: a non-zero exit → the ExitCode cause value", () => {
  const status = { status: "Failure", reason: "NonZeroExitCode", details: { causes: [{ reason: "ExitCode", message: "137" }] } };
  expect(exitCodeFromStatus(JSON.stringify(status))).toBe(137);
});

test("exitCodeFromStatus: a Failure without an ExitCode cause → 1", () => {
  expect(exitCodeFromStatus(JSON.stringify({ status: "Failure", message: "command terminated" }))).toBe(1);
});

test("exitCodeFromStatus: garbage / non-status → null (never throws)", () => {
  expect(exitCodeFromStatus("not json")).toBeNull();
  expect(exitCodeFromStatus(JSON.stringify({ hello: "world" }))).toBeNull();
});
