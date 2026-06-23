import { test, expect } from "bun:test";
import { buildArgs } from "./build-push.ts";

test("buildArgs: default Dockerfile (no -f) — context dir last", () => {
  expect(buildArgs("drop.local/app:b1", "./app")).toEqual(["build", "-t", "drop.local/app:b1", "./app"]);
});

test("buildArgs: custom Dockerfile inserts -f <path> before the context dir", () => {
  expect(buildArgs("drop.local/app:b1", "./app", "Dockerfile.prod")).toEqual([
    "build",
    "-t",
    "drop.local/app:b1",
    "-f",
    "Dockerfile.prod",
    "./app",
  ]);
});
