import { describe, expect, it } from "vitest";
import { UuidV7Generator } from "../idGenerator";

describe("UuidV7Generator", () => {
  it("parses every id it mints", () => {
    for (let i = 0; i < 100; i += 1) {
      const id = UuidV7Generator.next();
      expect(UuidV7Generator.parse(id)).toBe(id);
    }
  });

  it.each([
    ["empty", ""],
    ["free text", "not-a-uuid"],
    ["uuid v4", "9b2f6f0e-6c0a-4c55-9f0e-3a1d2b4c5d6e"],
    ["wrong variant", "0193e7d0-0001-7000-c000-100000000000"],
    ["padded", " 0193e7d0-0001-7000-8000-100000000000"],
    ["trailing newline", "0193e7d0-0001-7000-8000-100000000000\n"],
  ])("rejects an id it would not mint: %s", (_label, raw) => {
    expect(UuidV7Generator.parse(raw)).toBeNull();
  });
});
