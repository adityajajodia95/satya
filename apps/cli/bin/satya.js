#!/usr/bin/env node
// Runs the TypeScript CLI directly from source (tsx), so `npx satya` never uses a stale build.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
