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
  it("recognises tg://addBusinessBot?bot=<bot>&rights=<flags>", () => {
    const result = parse("tg://addBusinessBot?bot=somebot&rights=can_reply,can_transfer_stars");

    expect(result.kind).toBe("deeplink");
    if (result.kind === "deeplink") {
      expect(result.action).toBe("addBusinessBot");
      expect(result.target).toBe("somebot");
      expect(result.payload).toBe("can_reply,can_transfer_stars");
      expect(result.extras.rights).toBe("can_reply,can_transfer_stars");
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

  it("captures `mode=fullscreen` as extras on a startapp link", () => {
    const result = parse("https://t.me/somebot?startapp=&mode=fullscreen");
    expect(result.kind).toBe("deeplink");
    if (result.kind === "deeplink") {
      expect(result.payload).toBeNull();
      expect(result.extras.mode).toBe("fullscreen");
    }
  });
});
