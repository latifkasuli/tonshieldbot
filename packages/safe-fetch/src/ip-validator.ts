export class BlockedIpError extends Error {
  constructor(readonly address: string) {
    super(`Blocked IP address: ${address}`);
    this.name = "BlockedIpError";
  }
}

const ipv4ToUint32 = (ip: string): number =>
  ip.split(".").reduce((acc, octet) => ((acc << 8) | Number.parseInt(octet, 10)) >>> 0, 0);

const inIPv4Cidr = (ip: number, cidr: string): boolean => {
  const slash = cidr.indexOf("/");
  const base = ipv4ToUint32(cidr.slice(0, slash));
  const prefixLength = Number.parseInt(cidr.slice(slash + 1), 10);
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;

  return (ip & mask) === (base & mask);
};

const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
] as const;

const BLOCKED_IPV6_PATTERNS: readonly RegExp[] = [
  /^::$/,
  /^::1$/,
  /^::ffff:/i,
  /^64:ff9b:/i,
  /^100::/i,
  /^2001:db8:/i,
  /^fc/i,
  /^fd/i,
  /^fe[89ab]/i,
  /^ff/i,
];

export const validateIp = (address: string, family: 4 | 6): void => {
  const blocked =
    family === 4
      ? BLOCKED_IPV4_CIDRS.some((cidr) => inIPv4Cidr(ipv4ToUint32(address), cidr))
      : BLOCKED_IPV6_PATTERNS.some((pattern) => pattern.test(address));

  if (blocked) {
    throw new BlockedIpError(address);
  }
};
