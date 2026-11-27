import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("tokenize separates spaces and tabs and preserves SKU spelling", async () => {
  const { tokenize } = await import("../src/tokens");
  expect(tokenize(" \t Ab-1\t\t +04  ")).toEqual(["Ab-1", "+04"]);
  expect(tokenize(" \t ")).toEqual([]);
  expect(tokenize("single")).toEqual(["single"]);
});
