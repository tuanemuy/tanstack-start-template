import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
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
  it("throws InvalidId for an empty string", () => {
    try {
      TodoId.create("");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.InvalidId);
      }
    }
  });

  it("throws InvalidId for a whitespace-only string", () => {
    try {
      TodoId.create("   ");
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.InvalidId);
      }
    }
  });

  // Domain treats the id as opaque — generator format (UUIDv7 in this
  // template) is enforced by storage adapters on rehydration, not by the
  // value-object factory. So a non-UUID-shaped non-empty string is
  // intentionally accepted at this layer.
  it("accepts any non-empty string and returns a branded TodoId", () => {
    const raw = "01950000-0000-7000-8000-000000000001";
    const created = TodoId.create(raw);
    expect(created as unknown as string).toBe(raw);

    const opaque = TodoId.create("not-a-uuid");
    expect(opaque as unknown as string).toBe("not-a-uuid");
  });

  it("trims surrounding whitespace from the returned value", () => {
    const created = TodoId.create("  01950000-0000-7000-8000-000000000001  ");
    expect(created as unknown as string).toBe(
      "01950000-0000-7000-8000-000000000001",
    );
  });
});
