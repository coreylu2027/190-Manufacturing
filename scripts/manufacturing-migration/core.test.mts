import test from "node:test";
import assert from "node:assert/strict";
import { canonical, digest, readBaserowPages, sqlLiteral, validateQc, validateTables, type SourceTable } from "./core.mts";

const fixture = (): SourceTable[] => [
  { id: 1169282, fields: [{ id: 100, name: "Production Requirement", type: "link_row", link_row_table_id: 1119642 }],
    rows: [{ id: 1, "Production Requirement": [{ id: 20, value: "Part" }],
      "Quantity Ledger": '[{"userId":"legacy:A","name":"A","claimed":2,"completed":3}]',
      "Started At": "2026-08-31T12:01:02.123456Z", "Completed At": null, "Claimed Quantity": "2" }] },
  { id: 1119642, fields: [], rows: [{ id: 20, Status: { id: 5, value: "In Progress" }, order: "1.00000000000000000000" }] },
];

test("snapshot canonicalization preserves raw values, array order, timestamp precision, and ledger strings", () => {
  const tables = fixture();
  const before = structuredClone(tables);
  assert.equal(validateTables(tables).length, 1);
  assert.deepEqual(tables, before);
  assert.equal(canonical(JSON.parse(canonical(tables))), canonical(tables));
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.notEqual(digest({ n: "2" }), digest({ n: 2 }));
  assert.notEqual(digest({ n: null }), digest({}));
});

test("all links are checked, including secondary links; duplicates and dangling rows fail", () => {
  const tables = fixture();
  tables[0].rows[0]["Production Requirement"] = [{ id: 20 }, { id: 21 }];
  assert.throws(() => validateTables(tables), /Dangling link/);
  tables[1].rows.push({ id: 21 });
  assert.equal(validateTables(tables).length, 2);
  tables[1].rows.push({ id: 21 });
  assert.throws(() => validateTables(tables), /Duplicate row/);
});

test("only explicit exclusions may retain unresolved external references", () => {
  const tables = fixture();
  tables[0].fields.push({ id: 101, name: "Location", type: "link_row", link_row_table_id: 1119643 });
  tables[0].rows[0].Location = [{ id: 7 }];
  assert.throws(() => validateTables(tables), /Missing linked table/);
  const links = validateTables(tables, [1119643, 1126322]);
  assert.equal(links[1].external, true);
  assert.equal(links[0].external, false);
  assert.equal(links[1].target_row_id, 7);
});

test("QC preserves direct and historical identity without modifying existing reviews", () => {
  const reviews = [{ id: 8, operation_id: 1, production_requirement_id: null },
    { id: 9, operation_id: 999, production_requirement_id: 20 }];
  const before = structuredClone(reviews);
  const mapped = validateQc(fixture(), reviews, 1169282, 1119642);
  assert.equal(mapped[0].requirement_id, 20);
  assert.equal(mapped[1].legacy_operation_id, 999);
  assert.equal(mapped[1].historical_operation_missing, true);
  assert.deepEqual(reviews, before);
  assert.throws(() => validateQc(fixture(), [{ id: 10, operation_id: 999 }], 1169282, 1119642), /Unresolved QC/);
  const tables = fixture();
  tables[1].rows.push({ id: 21 });
  assert.throws(() => validateQc(tables, [{ id: 10, operation_id: 1, production_requirement_id: 21 }], 1169282, 1119642), /Conflicting QC/);
});

test("Baserow paging exhausts the count and rejects changing, duplicate, and truncated pages", async () => {
  const pages = [{ count: 3, results: [{ id: 3 }, { id: 1 }] }, { count: 3, results: [{ id: 2 }] }];
  assert.deepEqual(await readBaserowPages(async (page) => pages[page - 1]), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  await assert.rejects(readBaserowPages(async (page) => page === 1 ? pages[0] : { count: 4, results: [{ id: 2 }] }), /count changed/);
  await assert.rejects(readBaserowPages(async () => ({ count: 2, results: [{ id: 1 }, { id: 1 }] })), /Duplicate/);
  await assert.rejects(readBaserowPages(async () => ({ count: 2, results: [] })), /before the advertised count/);
  assert.deepEqual(await readBaserowPages(async () => ({ count: 0, results: [] })), []);
});

test("SQL literals safely preserve quotes, backslashes, and dollar delimiters in production text", () => {
  const value = { notes: "O'Brien \\ $import$; DROP TABLE public.quality_control; --\nnext" };
  const encoded = sqlLiteral(value);
  assert.ok(!encoded.includes("$import$"));
  assert.ok(!encoded.includes("DROP TABLE"));
  const encodedPayload = encoded.match(/^convert_from\(decode\('([A-Za-z0-9+/=]+)', 'base64'\), 'UTF8'\)::jsonb$/)?.[1];
  assert.ok(encodedPayload);
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, "base64").toString("utf8")), value);
});
