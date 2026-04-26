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
 * normalization, UUIDv7 acceptance.
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

describe("TodoId.create (property)", () => {
  // Hex digit arbitrary used to assemble valid UUIDv7 strings.
  const hexArb = fc.stringMatching(/^[0-9a-f]$/);

  function buildUuidV7(rest: string[], variantNibble: string): string {
    // Canonical form: 8-4-4-4-12 with version `7` at the start of the third
    // group and variant `8|9|a|b` at the start of the fourth.
    const seg = (n: number, start: number) =>
      rest.slice(start, start + n).join("");
    return [
      seg(8, 0),
      seg(4, 8),
      `7${seg(3, 12)}`,
      `${variantNibble}${seg(3, 15)}`,
      seg(12, 18),
    ].join("-");
  }

  it("accepts any well-formed UUIDv7 string", () => {
    fc.assert(
      fc.property(
        fc.array(hexArb, { minLength: 30, maxLength: 30 }),
        fc.constantFrom("8", "9", "a", "b"),
        (rest, variant) => {
          const raw = buildUuidV7(rest, variant);
          const id = TodoId.create(raw);
          // Brand erases at runtime, value round-trips.
          expect(id as unknown as string).toBe(raw);
        },
      ),
    );
  });

  it("rejects UUIDs with the wrong version nibble", () => {
    fc.assert(
      fc.property(
        fc.array(hexArb, { minLength: 30, maxLength: 30 }),
        fc.constantFrom("8", "9", "a", "b"),
        // Anything in 0..f except '7'.
        fc.constantFrom(
          "0",
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "8",
          "9",
          "a",
          "b",
          "c",
          "d",
          "e",
          "f",
        ),
        (rest, variant, badVersion) => {
          // Same shape as buildUuidV7 but with a forced wrong version nibble.
          const seg = (n: number, start: number) =>
            rest.slice(start, start + n).join("");
          const raw = [
            seg(8, 0),
            seg(4, 8),
            `${badVersion}${seg(3, 12)}`,
            `${variant}${seg(3, 15)}`,
            seg(12, 18),
          ].join("-");
          try {
            TodoId.create(raw);
            expect.fail(`expected throw for version=${badVersion}`);
          } catch (error) {
            expect(isBusinessRuleError(error)).toBe(true);
            if (isBusinessRuleError(error)) {
              expect(error.code).toBe(TodoErrorCode.InvalidId);
            }
          }
        },
      ),
    );
  });
});
