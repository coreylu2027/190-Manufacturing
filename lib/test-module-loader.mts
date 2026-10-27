import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/**
 * Runs a TypeScript module in a fresh context so tests can stub its imports.
 * Importing anything not in `dependencies` fails the test, and the module sees
 * only the given globals.
 */
export function loadModule<T>(url: URL, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { ...globals, exports, require: (name: string) => {
    assert.ok(name in dependencies, `Unexpected import ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}
