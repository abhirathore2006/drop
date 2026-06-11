#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcp } from "../src/mcp/server.ts";

const server = buildMcp();
await server.connect(new StdioServerTransport());
