import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { ResolvedEntity } from "./entity-resolver.ts";

export interface MtprotoIntelConfig {
  readonly apiId: number | null;
  readonly apiHash: string | null;
  readonly botToken: string | null;
  readonly session: string | null;
  readonly connectionRetries?: number;
  readonly requestRetries?: number;
  readonly floodSleepThresholdSeconds?: number;
}

export type MtprotoResolveResult =
  | {
      readonly status: "ok";
      readonly entity: ResolvedEntity;
    }
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "not_resolvable";
      readonly reason: "username_invalid" | "username_not_occupied";
      readonly description: string;
    }
  | {
      readonly status: "rate_limited";
      readonly retryAfter: number | null;
      readonly description: string;
    }
  | {
      readonly status: "failed";
      readonly description: string;
    };

export interface MtprotoIntelClient {
  readonly enabled: boolean;
  readonly authMode: "bot" | "session" | "disabled";
  resolveUsername(handle: string): Promise<MtprotoResolveResult>;
  close(): Promise<void>;
}

const DEFAULT_CONNECTION_RETRIES = 3;
const DEFAULT_REQUEST_RETRIES = 1;
const DEFAULT_FLOOD_SLEEP_THRESHOLD_SECONDS = 0;

const stripLeadingAt = (handle: string): string =>
  handle.trim().startsWith("@") ? handle.trim().slice(1) : handle.trim();

export const createMtprotoIntelClient = (config: MtprotoIntelConfig): MtprotoIntelClient => {
  const apiId = config.apiId ?? 0;
  const apiHash = config.apiHash ?? "";
  const botToken = config.botToken;
  const session = config.session;
  const enabled =
    config.apiId !== null && config.apiHash !== null && (botToken !== null || session !== null);
  const authMode = !enabled ? "disabled" : session !== null ? "session" : "bot";

  let clientPromise: Promise<TelegramClient> | null = null;
  let resolvedClient: TelegramClient | null = null;

  const getClient = async (): Promise<TelegramClient> => {
    if (!enabled) {
      throw new Error("MTProto client is disabled");
    }
    if (clientPromise !== null) {
      return await clientPromise;
    }

    clientPromise = (async () => {
      const client = new TelegramClient(new StringSession(session ?? ""), apiId, apiHash, {
        connectionRetries: config.connectionRetries ?? DEFAULT_CONNECTION_RETRIES,
        requestRetries: config.requestRetries ?? DEFAULT_REQUEST_RETRIES,
      });
      client.floodSleepThreshold =
        config.floodSleepThresholdSeconds ?? DEFAULT_FLOOD_SLEEP_THRESHOLD_SECONDS;

      if (session !== null) {
        await client.connect();
      } else if (botToken !== null) {
        await client.start({ botAuthToken: botToken });
      }

      resolvedClient = client;
      return client;
    })();

    return await clientPromise;
  };

  return {
    enabled,
    authMode,
    async resolveUsername(handle) {
      if (!enabled) {
        return { status: "disabled" };
      }

      const username = stripLeadingAt(handle);
      if (username.length === 0) {
        return {
          status: "not_resolvable",
          reason: "username_invalid",
          description: "Empty Telegram username",
        };
      }

      try {
        const client = await getClient();
        const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
        const entity = resolvedEntityFromMtproto(resolved);
        if (entity === null) {
          return {
            status: "failed",
            description: "MTProto resolveUsername returned no peer entity",
          };
        }
        return { status: "ok", entity };
      } catch (error) {
        return classifyMtprotoError(error);
      }
    },
    async close() {
      const client = resolvedClient;
      if (client !== null) {
        await client.disconnect();
      }
      resolvedClient = null;
      clientPromise = null;
    },
  };
};

const resolvedEntityFromMtproto = (
  resolved: Api.contacts.TypeResolvedPeer,
): ResolvedEntity | null => {
  const peer = readRecord(resolved, "peer");
  const users = readArray(resolved, "users");
  const chats = readArray(resolved, "chats");

  if (peer !== null && "userId" in peer) {
    const id = toBigInt((peer as { userId?: unknown }).userId);
    const user = findById(users, id);
    return user === null ? null : resolvedUserFromMtproto(user, id);
  }

  if (peer !== null && "channelId" in peer) {
    const id = toBigInt((peer as { channelId?: unknown }).channelId);
    const chat = findById(chats, id);
    return chat === null ? null : resolvedChatFromMtproto(chat, id, "channel");
  }

  if (peer !== null && "chatId" in peer) {
    const id = toBigInt((peer as { chatId?: unknown }).chatId);
    const chat = findById(chats, id);
    return chat === null ? null : resolvedChatFromMtproto(chat, id, "group");
  }

  const firstUser = users[0];
  if (firstUser !== undefined) {
    const record = asRecord(firstUser);
    if (record !== null) {
      const id = toBigInt(record.id);
      return resolvedUserFromMtproto(record, id);
    }
  }

  const firstChat = chats[0];
  if (firstChat !== undefined) {
    const record = asRecord(firstChat);
    if (record !== null) {
      const id = toBigInt(record.id);
      return resolvedChatFromMtproto(record, id, "channel");
    }
  }

  return null;
};

const resolvedUserFromMtproto = (
  user: Readonly<Record<string, unknown>>,
  id: bigint,
): ResolvedEntity => {
  const username = readString(user, "username");
  const firstName = readString(user, "firstName");
  const lastName = readString(user, "lastName");
  const isBot = readBoolean(user, "bot") ?? false;
  const displayName = [firstName, lastName]
    .filter((part) => part !== null)
    .join(" ")
    .trim();

  return {
    id,
    kind: isBot ? "bot" : "user",
    username: username?.toLowerCase() ?? null,
    activeUsernames: activeUsernamesFromMtproto(user),
    displayName: displayName.length > 0 ? displayName : null,
    bio: null,
    photoFileUniqueId: null,
    isPremium: readBoolean(user, "premium"),
    memberCount: null,
    isBot,
    raw: user,
  };
};

const resolvedChatFromMtproto = (
  chat: Readonly<Record<string, unknown>>,
  id: bigint,
  fallbackKind: "channel" | "group",
): ResolvedEntity => {
  const username = readString(chat, "username");
  const isMegagroup = readBoolean(chat, "megagroup") === true;
  const isBroadcast = readBoolean(chat, "broadcast") === true;
  const kind = isMegagroup ? "supergroup" : isBroadcast ? "channel" : fallbackKind;
  const canonicalId = kind === "channel" || kind === "supergroup" ? channelIdToBotApiId(id) : -id;

  return {
    id: canonicalId,
    kind,
    username: username?.toLowerCase() ?? null,
    activeUsernames: activeUsernamesFromMtproto(chat),
    displayName: readString(chat, "title"),
    bio: null,
    photoFileUniqueId: null,
    isPremium: null,
    memberCount: readNumber(chat, "participantsCount"),
    isBot: false,
    raw: chat,
  };
};

const channelIdToBotApiId = (id: bigint): bigint => -1_000_000_000_000n - id;

const activeUsernamesFromMtproto = (
  entity: Readonly<Record<string, unknown>>,
): readonly string[] | null => {
  const usernames = readArray(entity, "usernames");
  const active = usernames
    .map((entry) => {
      const record = asRecord(entry);
      if (record === null) return null;
      if (readBoolean(record, "active") === false) return null;
      return readString(record, "username")?.toLowerCase() ?? null;
    })
    .filter((username): username is string => username !== null);

  return active.length > 0 ? active : null;
};

const findById = (
  entities: readonly unknown[],
  id: bigint,
): Readonly<Record<string, unknown>> | null => {
  for (const entity of entities) {
    const record = asRecord(entity);
    if (record === null) continue;
    if (toBigInt(record.id) === id) return record;
  }
  return null;
};

const classifyMtprotoError = (error: unknown): MtprotoResolveResult => {
  const description = errorDescription(error);
  const upper = description.toUpperCase();

  if (upper.includes("USERNAME_NOT_OCCUPIED")) {
    return { status: "not_resolvable", reason: "username_not_occupied", description };
  }
  if (upper.includes("USERNAME_INVALID")) {
    return { status: "not_resolvable", reason: "username_invalid", description };
  }

  const retryAfter = floodWaitSeconds(error, upper);
  if (retryAfter !== null || upper.includes("FLOOD")) {
    return { status: "rate_limited", retryAfter, description };
  }

  return { status: "failed", description };
};

const errorDescription = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const errorMessage = (error as { errorMessage?: unknown }).errorMessage;
    if (typeof errorMessage === "string") return errorMessage;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const floodWaitSeconds = (error: unknown, upperDescription: string): number | null => {
  if (typeof error === "object" && error !== null) {
    const seconds = (error as { seconds?: unknown }).seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds;
  }
  const match = /FLOOD_WAIT_?(\d+)/.exec(upperDescription);
  return match?.[1] === undefined ? null : Number(match[1]);
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

const readRecord = (obj: unknown, key: string): Readonly<Record<string, unknown>> | null => {
  const record = asRecord(obj);
  return record === null ? null : asRecord(record[key]);
};

const readArray = (obj: unknown, key: string): readonly unknown[] => {
  const record = asRecord(obj);
  if (record === null) return [];
  const value = record[key];
  return Array.isArray(value) ? value : [];
};

const readString = (obj: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const readBoolean = (obj: Readonly<Record<string, unknown>>, key: string): boolean | null => {
  const value = obj[key];
  return typeof value === "boolean" ? value : null;
};

const readNumber = (obj: Readonly<Record<string, unknown>>, key: string): number | null => {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const toBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  if (typeof value === "object" && value !== null && "value" in value) {
    return toBigInt(value.value);
  }
  return BigInt(String(value));
};
