import { describe, expect, it } from "vitest";
import { parseTelegramUrl } from "../src/deeplink-parser.ts";

const parse = (url: string) => parseTelegramUrl(new URL(url));

describe("parseTelegramUrl — t.me deep links", () => {
  it("recognises t.me/<bot>?start=<payload>", () => {
    const result = parse("https://t.me/somebot?start=abc");

    expect(result).toEqual({
      kind: "deeplink",
      action: "start",
      target: "somebot",
      appShortName: null,
      payload: "abc",
      extras: {},
    });
  });

  it("recognises t.me/<bot>?startapp=<payload>&mode=fullscreen", () => {
    const result = parse("https://t.me/somebot?startapp=foo&mode=fullscreen");

    expect(result).toEqual({
      kind: "deeplink",
      action: "startapp",
      target: "somebot",
      appShortName: null,
      payload: "foo",
      extras: { mode: "fullscreen" },
    });
  });

  it("recognises t.me/<bot>/<app>?startapp=<payload>", () => {
    const result = parse("https://t.me/somebot/someapp?startapp=foo");

    expect(result).toEqual({
      kind: "deeplink",
      action: "startapp",
      target: "somebot",
      appShortName: "someapp",
      payload: "foo",
      extras: {},
    });
  });

  it("recognises t.me/<bot>/<app> with no startapp query as a deep link with empty payload", () => {
    // Telegram launches the Mini App with empty payload — still a Mini
    // App invocation, distinct from a plain handle reference.
    const result = parse("https://t.me/somebot/someapp");

    expect(result).toEqual({
      kind: "deeplink",
      action: "startapp",
      target: "somebot",
      appShortName: "someapp",
      payload: null,
      extras: {},
    });
  });

  it("recognises t.me/<bot>?startgroup=<payload>&admin=manage_chat", () => {
    const result = parse("https://t.me/somebot?startgroup=foo&admin=manage_chat");

    expect(result).toEqual({
      kind: "deeplink",
      action: "startgroup",
      target: "somebot",
      appShortName: null,
      payload: "foo",
      extras: { admin: "manage_chat" },
    });
  });

  it("recognises t.me/<peer>?attach=<bot> as startattach with the peer as target", () => {
    const result = parse("https://t.me/somepeer?attach=somebot&startattach=foo");

    expect(result).toEqual({
      kind: "deeplink",
      action: "startattach",
      target: "somepeer",
      appShortName: null,
      payload: "foo",
      extras: { attach: "somebot" },
    });
  });

  it("recognises t.me/nft/<slug> as a Fragment NFT reference", () => {
    const result = parse("https://t.me/nft/CrystalBall-42");

    expect(result).toEqual({
      kind: "nft",
      slug: "CrystalBall-42",
    });
  });

  it("treats a bare t.me/<handle> with no query as a plain_handle", () => {
    const result = parse("https://t.me/durov");

    expect(result).toEqual({ kind: "plain_handle", handle: "durov" });
  });

  it("normalises target/handle case to lowercase", () => {
    const result = parse("https://t.me/SomeBot?start=ABC");

    expect(result.kind).toBe("deeplink");
    if (result.kind === "deeplink") {
      expect(result.target).toBe("somebot");
      // Payload casing is preserved (it's data, not an identifier).
      expect(result.payload).toBe("ABC");
    }
  });

  it("treats t.me/nft with no slug as not_deeplink (defensive)", () => {
    const result = parse("https://t.me/nft/");

    expect(result.kind).toBe("not_deeplink");
  });
});

describe("parseTelegramUrl — tg:// scheme", () => {
  it("recognises tg://addBusinessBot?bot=<bot>&rights=<flags> and keeps rights on payload only", () => {
    const result = parse(
      "tg://addBusinessBot?bot=somebot&rights=can_reply,can_transfer_stars&campaign=summer",
    );

    expect(result.kind).toBe("deeplink");
    if (result.kind === "deeplink") {
      expect(result.action).toBe("addBusinessBot");
      expect(result.target).toBe("somebot");
      // `rights` is the primary action argument — lives on payload only.
      expect(result.payload).toBe("can_reply,can_transfer_stars");
      // Not duplicated into extras. `bot` is the target, also excluded.
      expect(result.extras).not.toHaveProperty("rights");
      expect(result.extras).not.toHaveProperty("bot");
      // Unrelated params land in extras so the cache key captures them.
      expect(result.extras.campaign).toBe("summer");
    }
  });

  it("rewrites tg://resolve?domain=<bot>&start=<x> as t.me/<bot>?start=<x>", () => {
    const result = parse("tg://resolve?domain=somebot&start=foo");

    expect(result).toEqual({
      kind: "deeplink",
      action: "start",
      target: "somebot",
      appShortName: null,
      payload: "foo",
      extras: {},
    });
  });

  it("treats unknown tg:// verbs as not_deeplink", () => {
    const result = parse("tg://nonsense?foo=bar");
    expect(result.kind).toBe("not_deeplink");
  });
});

describe("parseTelegramUrl — non-Telegram and edge cases", () => {
  it("returns not_telegram for non-t.me hostnames", () => {
    const result = parse("https://example.com/somebot?start=foo");

    expect(result.kind).toBe("not_telegram");
  });

  it("recognises telegram.me and telegram.dog as alternate Telegram hosts", () => {
    expect(parse("https://telegram.me/somebot?start=foo").kind).toBe("deeplink");
    expect(parse("https://telegram.dog/somebot?start=foo").kind).toBe("deeplink");
  });

  it("returns not_deeplink for t.me/ with no path", () => {
    expect(parse("https://t.me/").kind).toBe("not_deeplink");
  });

  it("returns not_deeplink for t.me/<segment> when the segment violates username rules", () => {
    // 3 chars is below the 4-char minimum (basic usernames are 5+; Fragment
    // allows 4-char collectibles; we accept 4 to admit Fragment links).
    expect(parse("https://t.me/abc").kind).toBe("not_deeplink");
    // Contains a hyphen — not allowed in handles.
    expect(parse("https://t.me/some-bot").kind).toBe("not_deeplink");
  });

  it("accepts a 4-char handle (Fragment collectible minimum)", () => {
    // Telegram itself rejects 4-char basic-tier registration but Fragment
    // sells 4-char collectibles. Accepting 4 here keeps the t.me URL path
    // segment validator and the bare @handle classifier symmetric, so a
    // 4-char Fragment handle classifies the same way in either form.
    expect(parse("https://t.me/abcd").kind).toBe("plain_handle");
  });

  it("returns not_deeplink for reserved t.me prefixes (no scannable handle)", () => {
    // These all fail the username regex on the first path segment and
    // surface as not_deeplink. The classifier then treats them as
    // `telegram_url` with `handle: null`, which `basic-scan.ts` maps onto
    // `TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED` so the user sees an
    // explicit skip rather than a falsely-clean report.
    expect(parse("https://t.me/c/12345/67").kind).toBe("not_deeplink");
    expect(parse("https://t.me/joinchat/AAAAA").kind).toBe("not_deeplink");
    expect(parse("https://t.me/+abcdefg").kind).toBe("not_deeplink");
  });

  it("captures `mode=fullscreen` as extras on a startapp link", () => {
    const result = parse("https://t.me/somebot?startapp=&mode=fullscreen");
    expect(result.kind).toBe("deeplink");
    if (result.kind === "deeplink") {
      expect(result.payload).toBeNull();
      expect(result.extras.mode).toBe("fullscreen");
    }
  });
});
