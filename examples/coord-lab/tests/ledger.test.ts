import { expect } from "bun:test";
import { labTest } from "./lab";

labTest("ledger keeps zero totals, insertion order and inherited-property SKUs", async () => {
  const { buildLedger } = await import("../src/ledger");
  const ledger = buildLedger(["constructor 2", "__proto__ 5", "normal -2", "constructor -2", "toString 4"]);
  expect(ledger).toBeInstanceOf(Map);
  expect([...ledger]).toEqual([["constructor", 0], ["__proto__", 5], ["normal", -2], ["toString", 4]]);
  expect([...buildLedger([])]).toEqual([]);
  expect(() => buildLedger(["normal nope"])).toThrow();
});
