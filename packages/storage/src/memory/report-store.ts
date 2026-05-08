import type { ScanReport } from "@tonshield/shared";
import { canonicalInputHash } from "../canonical-hash.ts";
import type { ReportStore } from "../interfaces/report-store.ts";

/**
 * In-memory `ReportStore`. Keeps reports in two indexes — by id and by
 * canonical input hash — so both `findById` and `findByInputHash` are O(1).
 *
 * Used in tests and as the default for local development where no
 * `DATABASE_URL` is configured.
 */
export const createInMemoryReportStore = (): ReportStore => {
  const byId = new Map<string, ScanReport>();
  const byInputHash = new Map<string, ScanReport>();

  return {
    async save(report) {
      const inputHash = canonicalInputHash(report.input);
      const existing = byInputHash.get(inputHash);

      if (existing !== undefined) {
        return Promise.resolve(existing);
      }

      byId.set(report.id, report);
      byInputHash.set(inputHash, report);

      return Promise.resolve(report);
    },

    async findById(id) {
      return Promise.resolve(byId.get(id) ?? null);
    },

    async findByInputHash(inputHash) {
      return Promise.resolve(byInputHash.get(inputHash) ?? null);
    },
  };
};
