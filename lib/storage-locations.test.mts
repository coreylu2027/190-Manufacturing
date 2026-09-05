import test from "node:test";
import assert from "node:assert/strict";

import { STORAGE_LOCATIONS, storageLocationSchema } from "./storage-locations.ts";

test("storage locations contain the 51 unique shop locations in canonical order", () => {
  const expected = [
    ...Array.from({ length: 8 }, (_, index) => `Clarke ${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Kwolek 1-${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Kwolek 2-${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Hopper ${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Jemison 1-${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Jemison 2-${index + 1}`),
    ...Array.from({ length: 3 }, (_, index) => `Shelf ${index + 1}`),
  ];
  assert.equal(STORAGE_LOCATIONS.length, 51);
  assert.equal(new Set(STORAGE_LOCATIONS).size, 51);
  assert.deepEqual([...STORAGE_LOCATIONS], expected);
});

test("storage location validation accepts canonical choices and null but rejects arbitrary strings", () => {
  const nullableLocation = storageLocationSchema.nullable();
  assert.equal(nullableLocation.parse("Jemison 2-8"), "Jemison 2-8");
  assert.equal(nullableLocation.parse(null), null);
  assert.equal(nullableLocation.safeParse("Tool crib").success, false);
});
