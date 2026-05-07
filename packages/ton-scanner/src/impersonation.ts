import { parse as parseDomain } from "tldts";
import { knownProjects } from "./data/known-projects.ts";
import type { KnownProject } from "./data/known-projects.ts";

export interface ImpersonationMatch {
  readonly project: KnownProject;
  readonly matchKind: "exact_name" | "lookalike_name" | "lookalike_domain" | "domain_contains";
  readonly confidence: "high" | "medium";
}

const CONFUSABLE_MAP: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "b",
  "7": "t",
  а: "a",
  е: "e",
  і: "i",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  А: "a",
  Е: "e",
  І: "i",
  О: "o",
  Р: "p",
  С: "c",
  Т: "t",
  У: "u",
  Х: "x",
  α: "a",
  ε: "e",
  ν: "n",
  ο: "o",
  ρ: "p",
};

export const normalizeForComparison = (input: string): string => {
  const decomposed = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const mapped = decomposed.replace(/./gsu, (char) => CONFUSABLE_MAP[char] ?? char);

  return mapped.toLowerCase().replace(/[^a-z0-9]/g, "");
};

export const normalizeHostname = (hostname: string): string =>
  parseDomain(hostname).hostname?.toLowerCase() ?? hostname.toLowerCase();

export const getRegistrableDomain = (hostname: string): string | null =>
  parseDomain(hostname).domain?.toLowerCase() ?? null;

export const getDomainLabel = (hostname: string): string => {
  const parsed = parseDomain(hostname);

  return (
    parsed.domainWithoutSuffix?.toLowerCase() ?? hostname.split(".")[0]?.toLowerCase() ?? hostname
  );
};

export const isOfficialHostname = (hostname: string, project: KnownProject): boolean => {
  const normalizedHostname = normalizeHostname(hostname);

  return project.officialDomains.some((domain) => {
    const officialDomain = domain.toLowerCase();

    return (
      normalizedHostname === officialDomain || normalizedHostname.endsWith(`.${officialDomain}`)
    );
  });
};

const levenshtein = (a: string, b: string): number => {
  if (a.length === 0) {
    return b.length;
  }

  if (b.length === 0) {
    return a.length;
  }

  let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 0; i < a.length; i += 1) {
    const currentRow = new Array<number>(b.length + 1);
    currentRow[0] = i + 1;

    for (let j = 0; j < b.length; j += 1) {
      const deleteCost = (previousRow[j + 1] ?? 0) + 1;
      const insertCost = (currentRow[j] ?? 0) + 1;
      const replaceCost = (previousRow[j] ?? 0) + (a[i] === b[j] ? 0 : 1);
      currentRow[j + 1] = Math.min(deleteCost, insertCost, replaceCost);
    }

    previousRow = currentRow;
  }

  return previousRow[b.length] ?? 0;
};

export const detectDomainImpersonation = (hostname: string): ImpersonationMatch | null => {
  const domainLabel = getDomainLabel(hostname);
  const normalizedLabel = normalizeForComparison(domainLabel);

  for (const project of knownProjects) {
    if (isOfficialHostname(hostname, project)) {
      continue;
    }

    for (const officialDomain of project.officialDomains) {
      const officialLabel = getDomainLabel(officialDomain);
      const normalizedOfficial = normalizeForComparison(officialLabel);

      if (normalizedLabel === normalizedOfficial) {
        return { confidence: "high", matchKind: "lookalike_domain", project };
      }

      if (
        normalizedOfficial.length >= 5 &&
        normalizedLabel.length >= 4 &&
        levenshtein(normalizedLabel, normalizedOfficial) <= 2
      ) {
        return { confidence: "medium", matchKind: "lookalike_domain", project };
      }

      if (
        normalizedOfficial.length >= 5 &&
        normalizedLabel.length > normalizedOfficial.length &&
        normalizedLabel.includes(normalizedOfficial)
      ) {
        return { confidence: "medium", matchKind: "domain_contains", project };
      }
    }
  }

  return null;
};

export const detectNameImpersonation = (
  appName: string,
  hostingHostname: string,
): ImpersonationMatch | null => {
  const normalizedName = normalizeForComparison(appName);

  for (const project of knownProjects) {
    if (isOfficialHostname(hostingHostname, project)) {
      continue;
    }

    const normalizedDisplay = normalizeForComparison(project.displayName);

    if (normalizedName === normalizedDisplay) {
      return { confidence: "high", matchKind: "exact_name", project };
    }

    if (normalizedName.length >= 4 && levenshtein(normalizedName, normalizedDisplay) <= 2) {
      return { confidence: "medium", matchKind: "lookalike_name", project };
    }
  }

  return null;
};
