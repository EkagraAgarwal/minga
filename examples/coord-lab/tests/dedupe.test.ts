import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("dedupe uses the shared policy and scans only the newest entries", async () => {
  const { dedupeWindow } = await import("../src/policy");
  const { isDuplicate } = await import("../src/dedupe");
  expect(dedupeWindow).toBe(3);
  const recent = Object.freeze(["old", "first", "second", "new"]);
  expect(isDuplicate(recent, "old")).toBe(false);
  expect(isDuplicate(recent, "first")).toBe(true);
  expect(isDuplicate(recent, "new")).toBe(true);
  expect(isDuplicate(recent, "NEW")).toBe(false);
  expect(isDuplicate(["x"], "x")).toBe(true);
  expect(isDuplicate([], "x")).toBe(false);
});
