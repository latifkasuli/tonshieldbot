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
    expect(r.recognised).toEqual(asSet(["can_delete_sent_messages", "can_delete_all_messages"]));
  });

  it("collects unknown letters in `unknown` rather than failing", () => {
    const r = parseBusinessRights("rXYzZ");
    expect(r.recognised.has("can_reply")).toBe(true);
    expect(r.unknown).toEqual(expect.arrayContaining(["X", "Y", "z", "Z"]));
  });

  it("does NOT run the letter decoder when the input contains separators (regression: read_messages)", () => {
    // Pre-fix bug: `read_messages` decoded into `r,a,d,m,e,s,a,g,e,s` via
    // the letter table and produced a spurious `can_transfer_stars`.
    // The packed-pattern gate now skips letter decoding for any input
    // containing underscores or other non-letter chars.
    const r = parseBusinessRights("read_messages");
    expect(r.recognised).toEqual(asSet(["can_read_messages"]));
    expect(includesDangerousRight(r)).toBe(false);
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
      "can_delete_sent_messages",
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

describe("parseBusinessRights — MTProto-style aliases", () => {
  it("maps `transfer_stars` to can_transfer_stars (dangerous)", () => {
    const r = parseBusinessRights("transfer_stars");
    expect(r.recognised).toEqual(asSet(["can_transfer_stars"]));
    expect(includesDangerousRight(r)).toBe(true);
  });

  it("maps `sell_gifts` to can_transfer_and_upgrade_gifts (dangerous neighbour)", () => {
    const r = parseBusinessRights("sell_gifts");
    expect(r.recognised).toEqual(asSet(["can_transfer_and_upgrade_gifts"]));
    expect(includesDangerousRight(r)).toBe(true);
  });

  it("maps `delete_sent_messages` to can_delete_sent_messages (NOT dangerous)", () => {
    const r = parseBusinessRights("delete_sent_messages");
    expect(r.recognised).toEqual(asSet(["can_delete_sent_messages"]));
    expect(includesDangerousRight(r)).toBe(false);
  });

  it("maps `delete_received_messages` to can_delete_all_messages (dangerous neighbour)", () => {
    const r = parseBusinessRights("delete_received_messages");
    expect(r.recognised).toEqual(asSet(["can_delete_all_messages"]));
    expect(includesDangerousRight(r)).toBe(true);
  });

  it("maps the legacy `can_delete_outgoing_messages` to the current can_delete_sent_messages", () => {
    const r = parseBusinessRights("can_delete_outgoing_messages");
    expect(r.recognised).toEqual(asSet(["can_delete_sent_messages"]));
  });

  it("handles a comma-separated MTProto-style list", () => {
    const r = parseBusinessRights("read_messages,transfer_stars,sell_gifts");
    expect(r.recognised).toEqual(
      asSet(["can_read_messages", "can_transfer_stars", "can_transfer_and_upgrade_gifts"]),
    );
    expect(includesDangerousRight(r)).toBe(true);
  });
});

describe("parseBusinessRights — tokenised input skips the letter decoder", () => {
  it("does NOT fall back to letter decoding when input contains an underscore", () => {
    // `foo_bar` has no alias match. The original buggy parser would
    // letter-decode `f`,`o`,`o`,`b`,`a`,`r` and produce `can_reply` etc.
    // The gated parser puts both tokens into `unknown` instead.
    const r = parseBusinessRights("foo_bar");
    expect(r.recognised.size).toBe(0);
    expect(r.unknown).toEqual(expect.arrayContaining(["foo", "bar"]));
  });

  it("does NOT fall back to letter decoding when input contains a comma", () => {
    const r = parseBusinessRights("xyz,abc");
    expect(r.recognised.size).toBe(0);
    expect(r.unknown).toEqual(expect.arrayContaining(["xyz", "abc"]));
  });

  it("preserves the alias-matched right even when the rest is unknown", () => {
    const r = parseBusinessRights("transfer_stars,nonsense");
    expect(r.recognised).toEqual(asSet(["can_transfer_stars"]));
    expect(r.unknown).toEqual(expect.arrayContaining(["nonsense"]));
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
