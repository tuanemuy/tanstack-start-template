import { describe, expect, it } from "vitest";
import { isBusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "../errorCode";
import { TodoId, TodoTitle } from "../valueObject";

describe("TodoTitle", () => {
  it("throws TitleEmpty when raw input is empty", () => {
    try {
      TodoTitle.create("");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.TitleEmpty);
      }
    }
  });

  it("throws TitleEmpty when input is only whitespace (trimmed empty)", () => {
    try {
      TodoTitle.create("   ");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.TitleEmpty);
      }
    }
  });

  it("throws TitleTooLong when length exceeds 140", () => {
    const raw = "a".repeat(141);
    try {
      TodoTitle.create(raw);
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.TitleTooLong);
      }
    }
  });

  it("accepts a title exactly 140 characters long", () => {
    const raw = "a".repeat(140);
    const title = TodoTitle.create(raw);
    // Brand types erase to string at runtime, length reflects trimmed value
    expect((title as unknown as string).length).toBe(140);
  });

  it("trims surrounding whitespace from the title", () => {
    const title = TodoTitle.create("  hello  ");
    expect(title as unknown as string).toBe("hello");
    expect((title as unknown as string).length).toBe(5);
  });
});

describe("TodoId", () => {
  it("throws InvalidId for a non-UUID string", () => {
    try {
      TodoId.create("invalid-id");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.InvalidId);
      }
    }
  });

  it("throws InvalidId for a UUID that is not version 7", () => {
    // Version nibble here is 1, not 7 (and variant nibble is 8).
    try {
      TodoId.create("12345678-1234-1234-8123-123456789012");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.InvalidId);
      }
    }
  });

  it("accepts a valid UUIDv7 string and returns a branded TodoId", () => {
    const raw = "01950000-0000-7000-8000-000000000001";
    const created = TodoId.create(raw);
    // Brand types erase to string at runtime — the underlying value is preserved.
    expect(created as unknown as string).toBe(raw);
  });
});
