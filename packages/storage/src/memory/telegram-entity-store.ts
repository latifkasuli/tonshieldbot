import type {
  RecordSnapshotResult,
  TelegramEntity,
  TelegramEntitySnapshot,
  TelegramEntitySnapshotInput,
  TelegramEntityStore,
  UsernameBinding,
} from "../interfaces/telegram-entity-store.ts";

/**
 * In-memory `TelegramEntityStore`. Mirrors the Postgres impl's semantics
 * for unit tests and local dev. State is per-instance — call
 * `createInMemoryTelegramEntityStore()` once per test that needs isolation.
 *
 * Snapshots are stored in a single append-only array per entity. Lookups
 * over `username_bindings` walk the snapshot history (cheap at the scale
 * unit tests operate on; production uses indexed Postgres).
 */
export const createInMemoryTelegramEntityStore = (): TelegramEntityStore => {
  const entitiesById = new Map<string, TelegramEntity>();
  const snapshotsByEntity = new Map<string, TelegramEntitySnapshot[]>();
  let nextSnapshotId = 1n;

  return {
    async recordSnapshot(input, options = {}) {
      const cooldownMs = options.cooldownMs ?? 0;
      const key = input.entityId.toString();
      const history = snapshotsByEntity.get(key) ?? [];
      const previous = history.length > 0 ? (history[history.length - 1] ?? null) : null;

      if (
        previous !== null &&
        cooldownMs > 0 &&
        input.observedAt.getTime() - previous.observedAt.getTime() < cooldownMs &&
        observableAttributesEqual(previous, input)
      ) {
        return Promise.resolve({
          snapshot: previous,
          previous: history.length > 1 ? (history[history.length - 2] ?? null) : null,
          inserted: false,
        } satisfies RecordSnapshotResult);
      }

      const snapshot: TelegramEntitySnapshot = { ...input, id: nextSnapshotId++ };
      history.push(snapshot);
      snapshotsByEntity.set(key, history);

      const existingEntity = entitiesById.get(key);
      if (existingEntity === undefined) {
        entitiesById.set(key, {
          id: input.entityId,
          kind: input.entityKind,
          firstSeenAt: input.observedAt,
          lastSeenAt: input.observedAt,
        });
      } else {
        entitiesById.set(key, {
          id: existingEntity.id,
          // Update entity kind only when we have a more specific reading
          // (avoid overwriting "channel" with "unknown" on a degraded
          // observation).
          kind: input.entityKind === "unknown" ? existingEntity.kind : input.entityKind,
          firstSeenAt: existingEntity.firstSeenAt,
          lastSeenAt:
            input.observedAt > existingEntity.lastSeenAt
              ? input.observedAt
              : existingEntity.lastSeenAt,
        });
      }

      return Promise.resolve({ snapshot, previous, inserted: true });
    },

    async latestSnapshot(entityId) {
      const history = snapshotsByEntity.get(entityId.toString());
      if (history === undefined || history.length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve(history[history.length - 1] ?? null);
    },

    async recentSnapshots(entityId, limit) {
      const history = snapshotsByEntity.get(entityId.toString());
      if (history === undefined || history.length === 0) {
        return Promise.resolve([]);
      }
      return Promise.resolve([...history].reverse().slice(0, Math.max(0, limit)));
    },

    async findEntityByUsername(username) {
      const lowered = username.toLowerCase();
      // Walk newest-first across all entities; return the first entity
      // whose latest snapshot's `username` matches. Acceptable for tests;
      // not for production.
      for (const [, history] of snapshotsByEntity) {
        const latest = history[history.length - 1];
        if (
          latest !== undefined &&
          latest.username !== null &&
          latest.username.toLowerCase() === lowered
        ) {
          return Promise.resolve(entitiesById.get(latest.entityId.toString()) ?? null);
        }
      }
      return Promise.resolve(null);
    },

    async usernameHistory(entityId) {
      const history = snapshotsByEntity.get(entityId.toString());
      if (history === undefined) {
        return Promise.resolve([]);
      }

      // Build bindings by walking the history and emitting one entry per
      // distinct username run. boundTo = the observed_at of the next
      // snapshot where the username changed (or null if still current).
      const bindings: UsernameBinding[] = [];
      let currentUsername: string | null = null;
      let currentFrom: Date | null = null;

      for (const snapshot of history) {
        const observedUsername = snapshot.username;
        if (observedUsername === currentUsername) continue;

        if (currentUsername !== null && currentFrom !== null) {
          bindings.push({
            username: currentUsername,
            entityId,
            boundFrom: currentFrom,
            boundTo: snapshot.observedAt,
            isCollectible: false,
          });
        }

        currentUsername = observedUsername;
        currentFrom = snapshot.observedAt;
      }

      if (currentUsername !== null && currentFrom !== null) {
        bindings.push({
          username: currentUsername,
          entityId,
          boundFrom: currentFrom,
          boundTo: null,
          isCollectible: false,
        });
      }

      return Promise.resolve(bindings.reverse());
    },
  };
};

/**
 * Are all observable attributes of `existing` equal to those in `next`?
 * Used by the cooldown check to suppress identical-content re-snapshots.
 * We deliberately do NOT compare `raw` (a JSON blob whose precise key
 * ordering varies across observations) or `observedAt` (the field we're
 * gating on).
 */
const observableAttributesEqual = (
  existing: TelegramEntitySnapshot,
  next: TelegramEntitySnapshotInput,
): boolean =>
  existing.username === next.username &&
  arraysEqual(existing.activeUsernames, next.activeUsernames) &&
  existing.displayName === next.displayName &&
  existing.bio === next.bio &&
  existing.photoFileUniqueId === next.photoFileUniqueId &&
  existing.isPremium === next.isPremium &&
  existing.memberCount === next.memberCount &&
  existing.isBot === next.isBot &&
  existing.entityKind === next.entityKind;

const arraysEqual = (a: readonly string[] | null, b: readonly string[] | null): boolean => {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
};
