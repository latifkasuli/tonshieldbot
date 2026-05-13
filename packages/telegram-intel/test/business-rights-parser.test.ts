import { describe, expect, it } from "vitest";
import {
  DANGEROUS_RIGHTS,
  includesDangerousRight,
  parseBusinessRights,
  type BusinessRight,
} from "../src/business-rights-parser.ts";

const asSet = (values: readonly BusinessRight[]): ReadonlySet<BusinessRight> => new Set(values);

describe("parseBusinessRights — empty / null input", () => {
  it("returns empty recognised set for null", () => {
    const r = parseBusinessRights(null);
    expect(r.recognised.size).toBe(0);
    expect(r.unknown).toEqual([]);
    expect(r.raw).toBe("");
  });

  it("returns empty recognised set for empty string", () => {
    const r = parseBusinessRights("");
    expect(r.recognised.size).toBe(0);
  });
});

describe("parseBusinessRights — letter-table decoding", () => {
  it("decodes a packed flag string", () => {
    // r=reply, m=read, s=transfer_stars, t=transfer_and_upgrade_gifts
    const r = parseBusinessRights("rmst");
    expect(r.recognised).toEqual(
      asSet([
        "can_reply",
        "can_read_messages",
        "can_transfer_stars",
        "can_transfer_and_upgrade_gifts",
      ]),
    );
    expect(r.unknown).toEqual([]);
  });

  it("preserves case sensitivity — D and d are distinct rights", () => {
    const r = parseBusinessRights("dD");
    expect(r.recognised).toEqual(
      asSet(["can_delete_outgoing_messages", "can_delete_all_messages"]),
    );
  });

  it("collects unknown letters in `unknown` rather than failing", () => {
    const r = parseBusinessRights("rXYzZ");
    expect(r.recognised.has("can_reply")).toBe(true);
    expect(r.unknown).toEqual(expect.arrayContaining(["X", "Y", "z", "Z"]));
  });
});

describe("parseBusinessRights — field-name decoding (fallback)", () => {
  it("decodes a comma-separated field-name list", () => {
    const r = parseBusinessRights("can_reply,can_transfer_stars");
    expect(r.recognised).toEqual(asSet(["can_reply", "can_transfer_stars"]));
  });

  it("decodes a plus-separated field-name list", () => {
    const r = parseBusinessRights("can_read_messages+can_manage_stories");
    expect(r.recognised).toEqual(asSet(["can_read_messages", "can_manage_stories"]));
  });

  it("recognises every canonical field name when listed explicitly", () => {
    const allFields: readonly BusinessRight[] = [
      "can_reply",
      "can_read_messages",
      "can_delete_outgoing_messages",
      "can_delete_all_messages",
      "can_edit_name",
      "can_edit_bio",
      "can_edit_profile_photo",
      "can_edit_username",
      "can_change_gift_settings",
      "can_view_gifts_and_stars",
      "can_convert_gifts_to_stars",
      "can_transfer_and_upgrade_gifts",
      "can_transfer_stars",
      "can_manage_stories",
    ];
    const r = parseBusinessRights(allFields.join(","));
    expect(r.recognised.size).toBe(14);
    for (const field of allFields) {
      expect(r.recognised.has(field)).toBe(true);
    }
  });

  it("does not leak field-name characters into unknown letters", () => {
    // Without the field-name pass, the letter scan would see `c`, `a`,
    // `n`, etc. and mistakenly mark them. The field-name pass removes
    // them first.
    const r = parseBusinessRights("can_transfer_stars");
    expect(r.recognised).toEqual(asSet(["can_transfer_stars"]));
    expect(r.unknown).toEqual([]);
  });
});

describe("parseBusinessRights — mixed formats", () => {
  it("recognises rights from both strategies together", () => {
    // Field name + letter `r` on the same payload.
    const r = parseBusinessRights("can_transfer_stars+r");
    expect(r.recognised).toEqual(asSet(["can_transfer_stars", "can_reply"]));
  });
});

describe("parseBusinessRights — raw value preserved", () => {
  it("returns the original payload in `raw`", () => {
    const raw = "rmSt";
    const r = parseBusinessRights(raw);
    expect(r.raw).toBe(raw);
  });
});

describe("includesDangerousRight", () => {
  it("returns true when any dangerous right is recognised", () => {
    expect(includesDangerousRight(parseBusinessRights("s"))).toBe(true); // can_transfer_stars
    expect(includesDangerousRight(parseBusinessRights("t"))).toBe(true); // can_transfer_and_upgrade_gifts
    expect(includesDangerousRight(parseBusinessRights("D"))).toBe(true); // can_delete_all_messages
  });

  it("returns false when only benign rights are recognised", () => {
    expect(includesDangerousRight(parseBusinessRights("r"))).toBe(false); // can_reply
    expect(includesDangerousRight(parseBusinessRights("m"))).toBe(false); // can_read_messages
    expect(includesDangerousRight(parseBusinessRights("rmb"))).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(includesDangerousRight(parseBusinessRights(null))).toBe(false);
  });
});

describe("DANGEROUS_RIGHTS — public contract", () => {
  it("matches the documented set", () => {
    expect(DANGEROUS_RIGHTS).toEqual(
      new Set<BusinessRight>([
        "can_transfer_stars",
        "can_transfer_and_upgrade_gifts",
        "can_convert_gifts_to_stars",
        "can_delete_all_messages",
        "can_edit_username",
        "can_manage_stories",
      ]),
    );
  });
});
