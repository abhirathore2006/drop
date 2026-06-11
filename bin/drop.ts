#!/usr/bin/env node
import { buildProgram } from "../src/cli/commands.ts";

buildProgram()
  .parseAsync(process.argv)
  .catch((e) => {
    console.error("error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
