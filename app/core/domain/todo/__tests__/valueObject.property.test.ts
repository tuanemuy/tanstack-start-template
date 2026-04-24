import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isBusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "../errorCode";
import { TodoId, TodoTitle } from "../valueObject";

/**
 * Property-based tests for value objects.
 *
 * Complements the example-based tests in `valueObject.test.ts` by asserting
 * invariants over broad input distributions — length boundaries, whitespace
 * normalization, UUIDv7 uniqueness.
 */

const TODO_TITLE_MAX_LENGTH = 140;

describe("TodoTitle.create (property)", () => {
  it("accepts any string whose trimmed length is in [1, 140]", () => {
    fc.assert(
      fc.property(
        // Generator yields a string whose length after trimming lands in
        // [1, 140]. Use printable non-space characters for the core plus
        // random whitespace padding, trim the result, then shape the
        // length explicitly.
        fc
          .tuple(
            fc.integer({ min: 1, max: TODO_TITLE_MAX_LENGTH }),
            fc.string({
              minLength: TODO_TITLE_MAX_LENGTH,
              maxLength: TODO_TITLE_MAX_LENGTH,
              unit: "grapheme-ascii",
            }),
          )
          .map(([len, s]) => {
            const body = s.replace(/\s/g, "a").slice(0, len);
            // sanity: body's length is `len`, body has no whitespace
            return body;
          })
          .filter((s) => s.trim().length >= 1 && s.trim().length <= 140),
        (raw) => {
          const title = TodoTitle.create(raw);
          const s = title as unknown as string;
          expect(s.length).toBeGreaterThanOrEqual(1);
          expect(s.length).toBeLessThanOrEqual(TODO_TITLE_MAX_LENGTH);
          // Factory output is always trimmed.
          expect(s).toBe(s.trim());
        },
      ),
    );
  });

  it("rejects empty / whitespace-only strings with TitleEmpty", () => {
    fc.assert(
      fc.property(
        // Pure whitespace (including the empty string via `minLength: 0`).
        // fast-check has no built-in "whitespace-only" arbitrary, so build
        // one from a whitespace character set.
        fc
          .array(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 10,
          })
          .map((chars) => chars.join("")),
        (raw) => {
          try {
            TodoTitle.create(raw);
            expect.fail(
              `expected throw for empty title: ${JSON.stringify(raw)}`,
            );
          } catch (error) {
            expect(isBusinessRuleError(error)).toBe(true);
            if (isBusinessRuleError(error)) {
              expect(error.code).toBe(TodoErrorCode.TitleEmpty);
            }
          }
        },
      ),
    );
  });

  it("rejects strings whose trimmed length exceeds 140 with TitleTooLong", () => {
    fc.assert(
      fc.property(
        // Pick an over-length integer and build a string of that many
        // non-whitespace characters. Trimming does not shrink it below 141.
        fc.integer({ min: 141, max: 500 }),
        (len) => {
          const raw = "a".repeat(len);
          try {
            TodoTitle.create(raw);
            expect.fail(`expected throw for len=${len}`);
          } catch (error) {
            expect(isBusinessRuleError(error)).toBe(true);
            if (isBusinessRuleError(error)) {
              expect(error.code).toBe(TodoErrorCode.TitleTooLong);
            }
          }
        },
      ),
    );
  });

  it("normalizes surrounding whitespace (trim is idempotent)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,50}$/),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (body, left, right) => {
          const padded = `${" ".repeat(left)}${body}${" ".repeat(right)}`;
          const title = TodoTitle.create(padded);
          expect(title as unknown as string).toBe(body);
        },
      ),
    );
  });
});

describe("TodoId.generate / create (property)", () => {
  it("generates values that round-trip through TodoId.create", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (_n) => {
        const generated = TodoId.generate();
        // Must survive a round-trip without throwing.
        const reparsed = TodoId.create(generated);
        expect(reparsed).toBe(generated);
      }),
    );
  });

  it("produces unique ids across a batch", () => {
    // UUIDv7 encodes a millisecond timestamp plus a random payload, so
    // `1000` calls in a row are astronomically unlikely to collide. This
    // property protects against accidental regressions such as "freeze
    // the randomness source" in a future refactor.
    const count = 1000;
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      seen.add(TodoId.generate());
    }
    expect(seen.size).toBe(count);
  });

  it("matches the UUIDv7 pattern (version 7 nibble, RFC4122 variant)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (_n) => {
        const id = TodoId.generate() as unknown as string;
        // Version nibble is at position 14 (0-indexed) of the canonical form.
        expect(id[14]).toBe("7");
        // Variant nibble at position 19 must be one of 8, 9, a, b.
        expect(["8", "9", "a", "b"]).toContain(id[19]?.toLowerCase());
      }),
    );
  });
});
