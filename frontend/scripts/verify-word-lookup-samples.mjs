import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const rootDir = resolve(process.cwd(), "frontend");
const helperPath = join(rootDir, "src/lib/wordLookup.ts");
const tscPath = join(rootDir, "node_modules/.bin/tsc");
const samplePath = join(rootDir, "scripts/word-lookup-samples.json");
const tempDir = mkdtempSync(join(tmpdir(), "word-lookup-"));

try {
  execFileSync(tscPath, [
    helperPath,
    "--target", "es2020",
    "--module", "commonjs",
    "--outDir", tempDir,
  ], {
    cwd: rootDir,
    stdio: "pipe",
  });

  const require = createRequire(import.meta.url);
  const helper = require(join(tempDir, "wordLookup.js"));
  const samples = JSON.parse(readFileSync(samplePath, "utf8"));

  for (const sample of samples) {
    if (sample.kind === "click_ratio") {
      assert.equal(
        helper.getLookupWordFromText(sample.text, sample.ratio),
        sample.expected,
        sample.note,
      );
    } else if (sample.kind === "segments") {
      assert.deepEqual(
        helper.getLookupSegments(sample.text).map((item) => item.normalized),
        sample.expected,
        sample.note,
      );
    } else {
      throw new Error(`Unsupported sample kind: ${sample.kind}`);
    }
  }

  console.log("wordLookup sample regression checks passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
