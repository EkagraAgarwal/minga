import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("retry policy honors the boundary and an explicit zero cap", async () => {
  const { canRetry } = await import("../src/policy");
  expect(canRetry(0)).toBe(true);
  expect(canRetry(2)).toBe(true);
  expect(canRetry(3)).toBe(false);
  expect(canRetry(3, 4)).toBe(true);
  expect(canRetry(0, 0)).toBe(false);
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => canRetry(invalid)).toThrow(RangeError);
    expect(() => canRetry(0, invalid)).toThrow(RangeError);
  }
});
