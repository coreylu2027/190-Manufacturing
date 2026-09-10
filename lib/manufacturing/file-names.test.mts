import assert from "node:assert/strict";
import test from "node:test";

import { manufacturingContentDisposition, safeManufacturingFileName } from "./file-names.ts";

test("drawing responses preserve the full manufacturing filename", () => {
  const name = "P-190B-260765 - Gearbox Plate Drawing 1 - REV B.pdf";
  assert.equal(safeManufacturingFileName(name, "P-190B-260765.pdf"), name);
  assert.equal(
    manufacturingContentDisposition("inline", name),
    `inline; filename="${name}"; filename*=UTF-8''P-190B-260765%20-%20Gearbox%20Plate%20Drawing%201%20-%20REV%20B.pdf`,
  );
});

test("drawing filenames cannot inject headers or retain source paths", () => {
  assert.equal(safeManufacturingFileName("folder\\P-190B-1.pdf\r\nX-Test: bad", "part.pdf"), "P-190B-1.pdfX-Test: bad");
  assert.match(manufacturingContentDisposition("inline", "Café bracket.pdf"), /filename\*=UTF-8''Caf%C3%A9%20bracket\.pdf$/);
});
