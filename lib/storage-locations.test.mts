import test from "node:test";
import assert from "node:assert/strict";

import { SHOP_STORAGE_LOCATIONS, PRINTER_LOCATIONS, STORAGE_LOCATIONS, canUseOnRobotLocation, storageLocationSchema, isPrintingOperation } from "./storage-locations.ts";

test("storage locations contain the 51 shop locations, five printers, and guarded robot location", () => {
  const expected = [
    ...Array.from({ length: 8 }, (_, index) => `Clarke ${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Kwolek 1-${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Kwolek 2-${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Hopper ${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Jemison 1-${index + 1}`),
    ...Array.from({ length: 8 }, (_, index) => `Jemison 2-${index + 1}`),
    ...Array.from({ length: 3 }, (_, index) => `Shelf ${index + 1}`),
  ];
  assert.equal(SHOP_STORAGE_LOCATIONS.length, 51);
  assert.deepEqual([...SHOP_STORAGE_LOCATIONS], expected);
  assert.equal(STORAGE_LOCATIONS.length, 57);
  assert.equal(new Set(STORAGE_LOCATIONS).size, 57);
  assert.equal(STORAGE_LOCATIONS.at(-1), "On Robot");
});

test("all physical printers are canonical locations and only printing manufacturing has shared completion", () => {
  assert.deepEqual([...PRINTER_LOCATIONS], ["Bambu X1C #1", "Bambu X1C #2", "Bambu X1C #3", "Bambu H2D", "Bambu X1C Pit"]);
  for (const location of PRINTER_LOCATIONS) assert.equal(storageLocationSchema.parse(location), location);
  assert.equal(isPrintingOperation({ machine: "Bambu 3D Printer", workType: "Manufacturing" }), true);
  assert.equal(isPrintingOperation({ machine: "3D Printing", workType: "Manufacturing" }), true);
  assert.equal(isPrintingOperation({ machine: "Bambu 3D Printer", workType: "CAM" }), false);
  assert.equal(isPrintingOperation({ machine: "Haas CNC", workType: "Manufacturing" }), false);
});

test("storage location validation accepts canonical choices and null but rejects arbitrary strings", () => {
  const nullableLocation = storageLocationSchema.nullable();
  assert.equal(nullableLocation.parse("Jemison 2-8"), "Jemison 2-8");
  assert.equal(nullableLocation.parse(null), null);
  assert.equal(nullableLocation.parse("On Robot"), "On Robot");
  assert.equal(nullableLocation.safeParse("Tool crib").success, false);
});

test("On Robot requires both passed QC and completed finishing", () => {
  assert.equal(canUseOnRobotLocation(true, true), true);
  assert.equal(canUseOnRobotLocation(true, false), false);
  assert.equal(canUseOnRobotLocation(false, true), false);
});
