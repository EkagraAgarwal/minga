import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("summary includes only positive totals in descending order", async () => {
  const { summarize } = await import("../src/summary");
  expect(summarize(["low 1", "zero 0", "high 4", "negative -1", "high 3"])).toEqual([
    { sku: "high", total: 7 },
    { sku: "low", total: 1 },
  ]);
});

labTest("the feed breaks ties by descending raw SKU order (case-sensitive, no locale collation)", async () => {
  const { summarize } = await import("../src/summary");
  expect(summarize(["A 2", "z 2", "a 2", "Z 2"]).map(({ sku }) => sku)).toEqual(["z", "a", "Z", "A"]);
});
