import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("parse accepts signed decimal and rejects malformed or unsafe amounts", async () => {
  const { parse } = await import("../src/parse");
  expect(parse(" SKU-1\t-007 ")).toEqual({ sku: "SKU-1", delta: -7 });
  expect(parse("sku +9")).toEqual({ sku: "sku", delta: 9 });
  expect(parse("sku 9007199254740991")).toEqual({ sku: "sku", delta: Number.MAX_SAFE_INTEGER });
  for (const line of ["", "sku", "sku +", "sku 1e2", "sku 0x10", "sku 1.2", "sku 4 more", "sku 9007199254740992"]) {
    expect(() => parse(line)).toThrow();
  }
});
