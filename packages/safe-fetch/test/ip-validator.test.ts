import { describe, expect, it } from "vitest";
import { BlockedIpError, validateIp } from "../src/ip-validator.ts";

const expectBlocked = (address: string, family: 4 | 6): void => {
  expect(() => validateIp(address, family)).toThrow(BlockedIpError);
};

const expectAllowed = (address: string, family: 4 | 6): void => {
  expect(() => validateIp(address, family)).not.toThrow();
};

describe("validateIp IPv4", () => {
  it("blocks private and loopback ranges", () => {
    expectBlocked("10.0.0.1", 4);
    expectBlocked("127.0.0.1", 4);
    expectBlocked("172.16.0.1", 4);
    expectBlocked("192.168.1.1", 4);
  });

  it("blocks metadata, CGNAT, multicast, and broadcast ranges", () => {
    expectBlocked("100.100.100.200", 4);
    expectBlocked("169.254.169.254", 4);
    expectBlocked("224.0.0.1", 4);
    expectBlocked("255.255.255.255", 4);
  });

  it("allows public IPv4 addresses", () => {
    expectAllowed("1.1.1.1", 4);
    expectAllowed("8.8.8.8", 4);
  });
});

describe("validateIp IPv6", () => {
  it("blocks loopback, unspecified, unique-local, link-local, mapped, and multicast ranges", () => {
    expectBlocked("::", 6);
    expectBlocked("::1", 6);
    expectBlocked("::ffff:192.168.1.1", 6);
    expectBlocked("fc00::1", 6);
    expectBlocked("fd12:3456::1", 6);
    expectBlocked("fe80::1", 6);
    expectBlocked("ff02::1", 6);
  });

  it("allows public IPv6 addresses", () => {
    expectAllowed("2001:4860:4860::8888", 6);
    expectAllowed("2606:4700:4700::1111", 6);
  });
});
