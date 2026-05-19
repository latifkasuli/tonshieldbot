/**
 * Persistent store for Telegram entity snapshots.
 *
 * Snapshots are the canonical source for "this handle used to be X, now it's
 * Y" detection. The Bot API exposes only present state, so we keep our own
 * time series, keyed by the entity's stable numeric Telegram ID.
 *
 * Schema rationale (see docs/research/m3-design.md §4):
 *   - `entities` holds the (id, kind, first_seen, last_seen) tuple. One row
 *     per entity, ever.
 *   - `entity_snapshots` is append-only — every observation is a new row.
 *     The latest snapshot per entity is the current "truth"; older rows are
 *     the historical record.
 *   - `username_bindings` indexes the (handle, entity_id, bound_from,
 *     bound_to) relationship. Lets us answer "who claims `@foo` right now?"
 *     and "what entity used `@bar` between 2026-01 and 2026-03?".
 *   - `migration_edges` records basic group → supergroup migrations and
 *     (future) collectible username transfers.
 *
 * The Postgres impl uses native types (`bigint` for Telegram IDs); the
 * memory impl is straightforward `Map`-based and lives behind the same
 * interface so unit tests don't need a database.
 */

export type TelegramEntityKind =
  | "user"
  | "bot"
  | "group"
  | "supergroup"
  | "channel"
  | "monoforum"
  | "unknown";

export interface TelegramEntity {
  readonly id: bigint;
  readonly kind: TelegramEntityKind;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/**
 * One observation of an entity's mutable attributes. Fields are nullable
 * because not every observation source populates the same set (e.g. a
 * forward-origin update gives us `id`, `username`, `displayName`, `isBot`,
 * `isPremium` but no `bio` or `memberCount`).
 */
export interface TelegramEntitySnapshotInput {
  readonly entityId: bigint;
  readonly entityKind: TelegramEntityKind;
  readonly observedAt: Date;
  readonly username: string | null;
  readonly activeUsernames: readonly string[] | null;
  readonly displayName: string | null;
  readonly bio: string | null;
  readonly photoFileUniqueId: string | null;
  readonly isPremium: boolean | null;
  readonly memberCount: number | null;
  readonly isBot: boolean | null;
  readonly source: "getChat" | "message_observe" | "forward" | "manual" | "mtproto";
  readonly raw: Readonly<Record<string, unknown>> | null;
}

export interface TelegramEntitySnapshot extends TelegramEntitySnapshotInput {
  readonly id: bigint;
}

export interface UsernameBinding {
  readonly username: string;
  readonly entityId: bigint;
  readonly boundFrom: Date;
  readonly boundTo: Date | null;
  readonly isCollectible: boolean;
}

export interface RecordSnapshotResult {
  /** The just-written snapshot row. */
  readonly snapshot: TelegramEntitySnapshot;
  /**
   * The previous snapshot for the same entity, if any. Useful for diff
   * detection (e.g. `TELEGRAM_USERNAME_RECENTLY_CHANGED`) so callers don't
   * have to make a separate query after recording.
   */
  readonly previous: TelegramEntitySnapshot | null;
  /**
   * True when this snapshot was actually inserted; false when it was
   * suppressed by the cooldown window (see `cooldownMs`). When suppressed,
   * `snapshot` is the most-recent existing row.
   */
  readonly inserted: boolean;
}

export interface TelegramEntityStore {
  /**
   * Records a snapshot of an entity's current attributes. The store
   * upserts the `entities` row (advancing `lastSeenAt`, setting
   * `firstSeenAt` on first sight), and appends to `entity_snapshots`.
   *
   * Cooldown: if the most-recent snapshot for the same entity is younger
   * than `cooldownMs` AND its observable attributes are identical, the new
   * snapshot is suppressed and `inserted: false` is returned. This is what
   * stops a rapid-fire scan loop from filling the table with duplicates.
   */
  recordSnapshot(
    input: TelegramEntitySnapshotInput,
    options?: { readonly cooldownMs?: number },
  ): Promise<RecordSnapshotResult>;

  /** Returns the most-recent snapshot for `entityId`, or `null`. */
  latestSnapshot(entityId: bigint): Promise<TelegramEntitySnapshot | null>;

  /**
   * Returns the most-recent N snapshots for `entityId`, newest-first.
   * Used by the username-change detector and (PR-9) the drain detector.
   */
  recentSnapshots(entityId: bigint, limit: number): Promise<readonly TelegramEntitySnapshot[]>;

  /**
   * Returns the entity currently bound to `@username`, if any. Lowercase-
   * normalised inside the impl.
   */
  findEntityByUsername(username: string): Promise<TelegramEntity | null>;

  /**
   * Returns the username-binding history for `entityId`, newest-first.
   * Useful for evidence on `TELEGRAM_USERNAME_RECENTLY_CHANGED` findings.
   */
  usernameHistory(entityId: bigint): Promise<readonly UsernameBinding[]>;

  /**
   * Delete snapshots whose `observed_at` is strictly older than `cutoff`.
   * Returns the number of rows actually deleted. The `entities` row is
   * left in place — it's tiny and carries no PII, and keeping it lets a
   * future revisit of the same entity preserve `firstSeenAt`.
   *
   * `maxRows` caps the work per call. If more rows are eligible than the
   * cap, the impl deletes up to `maxRows` and stops; the next run will
   * pick up the rest. The cap is the load-bearing safety on a
   * misconfigured retention period — operators can set a tight retention
   * for testing without nuking the entire history in one transaction.
   *
   * Design doc decision #9: 365-day retention for public-entity
   * snapshots is the default operational policy; the actual cutoff is
   * decided by the caller (the worker's retention loop).
   */
  pruneSnapshots(options: {
    readonly cutoff: Date;
    readonly maxRows: number;
  }): Promise<{ readonly deletedCount: number }>;
}
