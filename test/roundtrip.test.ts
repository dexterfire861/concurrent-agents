/**
 * Plan section 14, item 2: every configs/*.yaml parses, and survives a
 * serialize/parse cycle unchanged.
 *
 * This one PASSES today. It has no dependency on src/ — it guards the fixtures
 * themselves, catching a corpus file that silently loses data (an unquoted
 * `no` read as false, a number that became a string) before any of the
 * assertions built on top of it can be trusted.
 *
 * The stronger version in the plan — "serializes back to IDENTICAL YAML" —
 * needs the emitter in src/spec/schema.ts, which does not exist yet. What is
 * asserted here is the part that does not depend on it: no data is lost.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";

import { ADVERSARIAL_DIR, GOLDEN_DIR, CONFIGS_DIR, listFixtures } from "./boundary.js";

const corpora = [
  ["configs", CONFIGS_DIR],
  ["configs/golden", GOLDEN_DIR],
  ["configs/adversarial", ADVERSARIAL_DIR],
] as const;

describe("fixture round-trip", () => {
  for (const [label, dir] of corpora) {
    it(`${label}: every file survives parse -> stringify -> parse unchanged`, () => {
      const fixtures = listFixtures(dir);
      assert.ok(fixtures.length > 0, `${label} is empty`);
      for (const f of fixtures) {
        const again = parse(stringify(f.spec)) as unknown;
        assert.deepEqual(again, f.spec, `${label}/${f.name} lost data on a round trip`);
      }
    });
  }

  it("metadata ids are unique across both corpora", () => {
    const ids = [...listFixtures(GOLDEN_DIR), ...listFixtures(ADVERSARIAL_DIR)].map(
      (f) => f.spec.metadata.id,
    );
    assert.equal(new Set(ids).size, ids.length, `duplicate metadata.id in ${ids.join(", ")}`);
  });
});
