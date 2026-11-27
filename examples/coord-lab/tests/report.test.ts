import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("report combines the ledger and delivery policy in summary order", async () => {
  const { report } = await import("../src/report");
  const lines = ["apple 1", "pear 4", "apple 3", "plum -1", "kiwi 8"];
  const recent = Object.freeze(["apple", "x", "y", "pear"]);
  const attempts = new Map([["pear", 3], ["apple", 4]]);
  expect(report(lines, recent, attempts)).toEqual([
    { sku: "kiwi", total: 8, status: "ready" },
    { sku: "pear", total: 4, status: "duplicate" },
    { sku: "apple", total: 4, status: "exhausted" },
  ]);
  expect(report([], recent, attempts)).toEqual([]);
});
