import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { describe, expect, it } from "vitest";
import { AppServerError } from "../errorResponse";
import { parseGeneratedId } from "../validator";

describe("parseGeneratedId", () => {
  it("returns an id the generator minted", () => {
    const id = UuidV7Generator.next();
    expect(parseGeneratedId(UuidV7Generator, "id", id)).toBe(id);
  });

  it("rejects any other id as a validation error on the named field", () => {
    let thrown: unknown;
    try {
      parseGeneratedId(UuidV7Generator, "id", "not-a-uuid");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppServerError);
    expect((thrown as AppServerError).serialized).toMatchObject({
      kind: "validation",
      code: "INVALID_INPUT",
      fieldErrors: { id: ["Invalid id"] },
    });
  });
});
