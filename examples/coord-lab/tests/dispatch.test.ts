import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("dispatch prioritizes duplicates over retry exhaustion", async () => {
  const { classify } = await import("../src/dispatch");
  expect(classify(["id"], "id", 5)).toBe("duplicate");
  expect(classify(["id"], "id", -1)).toBe("duplicate");
  expect(classify(["id", "x", "y", "z"], "id", 2)).toBe("ready");
  expect(classify([], "id", 3)).toBe("exhausted");
});
