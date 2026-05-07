export interface KnownProject {
  readonly id: string;
  readonly displayName: string;
  readonly officialDomains: readonly string[];
}

export const knownProjects = [
  {
    id: "fragment",
    displayName: "Fragment",
    officialDomains: ["fragment.com"],
  },
  {
    id: "tonkeeper",
    displayName: "Tonkeeper",
    officialDomains: ["tonkeeper.com"],
  },
  {
    id: "mytonwallet",
    displayName: "MyTonWallet",
    officialDomains: ["mytonwallet.io"],
  },
  {
    id: "stonfi",
    displayName: "STON.fi",
    officialDomains: ["ston.fi"],
  },
  {
    id: "dedust",
    displayName: "DeDust",
    officialDomains: ["dedust.io"],
  },
  {
    id: "telegram-wallet",
    displayName: "Wallet",
    officialDomains: ["wallet.tg"],
  },
  {
    id: "ton",
    displayName: "TON",
    officialDomains: ["ton.org"],
  },
  {
    id: "getgems",
    displayName: "Getgems",
    officialDomains: ["getgems.io"],
  },
] as const satisfies readonly KnownProject[];

export type KnownProjectId = (typeof knownProjects)[number]["id"];
