import type { ScanReport } from "@tonshield/shared";

/**
 * Persistent storage for scan reports.
 *
 * Reports are deduped on a stable canonical hash of `ScanInput` (see
 * `canonicalInputHash`). The hot read path is `findByInputHash`; `findById`
 * exists for share-by-id flows (e.g. /r/<id> public report pages).
 *
 * `save` is dedup-aware: if a report with the same `inputHash` already
 * exists, the existing record is returned and the new one is discarded.
 * Callers should always use the returned report (its `id` and `createdAt`
 * may differ from what was passed in).
 */
export interface ReportStore {
  /**
   * Persists `report` and returns the canonical record for its input.
   *
   * If another report with the same `inputHash` already exists, that record
   * is returned and `report` is not written. This guarantees that a
   * concurrent double-write of the same scan converges on a single record.
   */
  save(report: ScanReport): Promise<ScanReport>;

  findById(id: string): Promise<ScanReport | null>;

  findByInputHash(inputHash: string): Promise<ScanReport | null>;
}
