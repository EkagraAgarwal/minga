import { test } from "bun:test";
import { resolve } from "node:path";

// The repository-wide Bun suite discovers these fixtures before they have solutions.
export const labTest = process.cwd() === resolve(import.meta.dir, "..") ? test : test.skip;
