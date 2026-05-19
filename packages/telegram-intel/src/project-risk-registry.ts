import { z } from "zod";
import riskProjectsRaw from "../data/known-risk-projects.json" with { type: "json" };

export interface KnownRiskProjectEntry {
  readonly project: string;
  readonly handles: readonly string[];
  readonly risk: string;
  readonly severity: "medium" | "high" | "critical";
  readonly notes?: string;
}

const normaliseHandle = (raw: string): string => raw.trim().replace(/^@/, "").toLowerCase();

const handleSchema = z
  .string()
  .min(1, "known-risk handle must be non-empty")
  .transform(normaliseHandle)
  .refine((s) => s.length > 0, {
    message: "known-risk handle must be non-empty after trim/@-strip",
  });

const entrySchema = z.object({
  project: z.string().trim().min(1),
  handles: z.array(handleSchema).min(1),
  risk: z.string().trim().min(1),
  severity: z.enum(["medium", "high", "critical"]),
  notes: z.string().optional(),
});

const registrySchema = z.array(entrySchema).min(1);

export const loadKnownRiskProjects = (): readonly KnownRiskProjectEntry[] => {
  const parsed = registrySchema.parse(riskProjectsRaw);
  return parsed as readonly KnownRiskProjectEntry[];
};

export const knownRiskProjects: readonly KnownRiskProjectEntry[] = loadKnownRiskProjects();

export const matchKnownRiskProjectHandle = (
  handle: string | null | undefined,
  registry: readonly KnownRiskProjectEntry[] = knownRiskProjects,
): KnownRiskProjectEntry | null => {
  if (handle == null) return null;
  const candidate = normaliseHandle(handle);
  if (candidate.length === 0) return null;

  return registry.find((entry) => entry.handles.includes(candidate)) ?? null;
};
