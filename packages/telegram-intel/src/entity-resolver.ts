import type { Chat, ChatFullInfo, User } from "grammy/types";
import type { TelegramIntelClient } from "./client.ts";
import { classifyBotApiFailure, type BotApiFailure } from "./failure.ts";

/**
 * Entity resolver — three explicit paths matching the three actual Bot API
 * capabilities per docs/research/m3-design.md §3.1:
 *
 *   1. `resolveChannelOrSupergroup(@handle)` — `getChat(@handle)`. Bot API
 *      documents username resolution for channels and supergroups, and in
 *      practice can also return public bot/user handles as `type=private`.
 *   2. `resolveById(numeric_id)` — `getChat(id)`. Works once we have the
 *      numeric ID (from a forward, prior observation, or our snapshot store).
 *      Bot must have prior interaction with users; channels/supergroups
 *      always resolvable by ID once we know it.
 *   3. `resolveUserOrBot(@handle)` — returns
 *      `{ status: "cannot_resolve_cold" }` immediately. Bot API does NOT
 *      document username resolution for users/bots; we make this explicit
 *      rather than guessing.
 *
 * All three functions return a discriminated `ResolverResult` so callers
 * can dispatch without try/catch noise. Failure classification mirrors
 * PR-D1 (rate-limited / provider-down / failed / not-resolvable).
 *
 * For `resolveUserOrBot`, when we DO have prior context (the user has been
 * observed before, or we received a forwarded message from them), the
 * caller should use `resolveById` with the cached numeric ID instead. The
 * cold path is reserved for first-time-seen user/bot handles.
 */
export type ResolverResult =
  | {
      readonly status: "ok";
      readonly entity: ResolvedEntity;
    }
  | {
      readonly status: "not_resolvable";
      readonly reason: NotResolvableReason;
      /** Original Bot API description, if the error came from a server response. */
      readonly description: string | null;
    }
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly failure: BotApiFailure;
    };

/**
 * Why an entity could not be resolved. Each reason maps to a different UX
 * hint — the scanner uses the discriminator to decide what to tell the user.
 *
 *   - `channel_or_supergroup_not_found` — `getChat(@handle)` returned
 *     "chat not found". The handle is either dead, never claimed, or a
 *     private channel the bot can't see.
 *   - `user_or_bot_handle_requires_prior_context` — Bot API doesn't
 *     document cold user/bot @handle resolution. UX should prompt the
 *     user to forward a message from the target instead.
 *   - `resolved_not_channel_or_supergroup` — the handle resolved, but to
 *     a group or another unsupported kind. Private bot/user handles are
 *     accepted when Telegram returns them from `getChat(@handle)`.
 *   - `entity_not_found_by_id` — `getChat(numeric_id)` returned
 *     "chat not found". The ID is real (we observed it once) but Bot API
 *     can't see it now — common when the entity was deleted, the bot
 *     lost access, or the entity migrated and the old ID is dead.
 */
export type NotResolvableReason =
  | "channel_or_supergroup_not_found"
  | "user_or_bot_handle_requires_prior_context"
  | "resolved_not_channel_or_supergroup"
  | "entity_not_found_by_id";

/**
 * Normalised view of a resolved entity. Carries enough to feed the
 * snapshot module; consumers that need the full Bot API `ChatFullInfo`
 * can read `raw`.
 */
export interface ResolvedEntity {
  readonly id: bigint;
  readonly kind: "user" | "bot" | "group" | "supergroup" | "channel" | "monoforum" | "unknown";
  readonly username: string | null;
  readonly activeUsernames: readonly string[] | null;
  readonly displayName: string | null;
  readonly bio: string | null;
  readonly photoFileUniqueId: string | null;
  readonly isPremium: boolean | null;
  readonly memberCount: number | null;
  readonly isBot: boolean | null;
  /** Full Bot API response, preserved for forensic replay. */
  readonly raw: Readonly<Record<string, unknown>>;
}

const stripLeadingAt = (handle: string): string =>
  handle.startsWith("@") ? handle.slice(1) : handle;

/**
 * Resolve a public Telegram handle by `@handle`. The name is historical:
 * this started as the documented channel/supergroup path, but Telegram also
 * returns public bot/user handles as `type=private` in practice. Accept those
 * as resolvable entities so pasted public handles are useful without forcing
 * the user to forward a message first.
 */
export const resolveChannelOrSupergroup = async (
  client: TelegramIntelClient,
  handle: string,
): Promise<ResolverResult> => {
  if (!client.enabled) {
    return { status: "disabled" };
  }

  const normalised = stripLeadingAt(handle);

  try {
    const chat = await client.raw.getChat(`@${normalised}`);

    if (chat.type !== "channel" && chat.type !== "supergroup" && chat.type !== "private") {
      // The handle resolved but to a different entity kind (for example,
      // a basic group). Surface a specific reason rather than a single
      // generic "not found" message.
      return {
        status: "not_resolvable",
        reason: "resolved_not_channel_or_supergroup",
        description: null,
      };
    }

    return { status: "ok", entity: toResolvedEntity(chat) };
  } catch (error) {
    return classifyResolverError(error, "channel_or_supergroup_not_found");
  }
};

/**
 * Resolve by numeric ID. Works for any entity kind once we know the ID
 * — typically discovered from a forward_origin update or our snapshot
 * store. For users, the bot must have prior interaction (DM, group
 * co-presence).
 */
export const resolveById = async (
  client: TelegramIntelClient,
  id: bigint,
): Promise<ResolverResult> => {
  if (!client.enabled) {
    return { status: "disabled" };
  }

  try {
    // grammY's `getChat` accepts `number | string`. Bot API IDs fit in 52
    // significant bits so a JS `number` would also be safe (per
    // <https://core.telegram.org/api/bots/ids>), but `String(id)` is the
    // unconditionally-safe form and grammY happily accepts it.
    const chat = await client.raw.getChat(String(id));
    return { status: "ok", entity: toResolvedEntity(chat) };
  } catch (error) {
    // ID-based path: we already had the numeric ID (from a forward or our
    // snapshot store), so a not-resolvable response means the entity was
    // deleted, banned, or the bot lost access — NOT that we need prior
    // context. Use the more specific reason.
    return classifyResolverError(error, "entity_not_found_by_id");
  }
};

/**
 * Resolve a user or bot by `@handle` — returns `cannot_resolve_cold`
 * unconditionally. Bot API does not document user/bot handle resolution,
 * and even when it works empirically, the contract is undocumented. The
 * scanner's UX should prompt the caller to forward a message from the
 * target so the numeric ID enters our snapshot store, then re-scan.
 *
 * Callers that DO have a snapshot for the handle should look it up via
 * the snapshot store first and call `resolveById` with the cached numeric
 * ID instead — that path IS supported.
 */
export const resolveUserOrBot = (handle: string): ResolverResult => {
  return {
    status: "not_resolvable",
    reason: "user_or_bot_handle_requires_prior_context",
    description: `Bot API does not support cold resolution of user/bot @handle '${stripLeadingAt(handle)}'. Forward a message from the target so its numeric ID can be cached, then re-scan.`,
  };
};

/**
 * Build a `ResolvedEntity` from a grammY `ChatFullInfo`. We map the Bot
 * API's free-form `Chat.type` discriminator into our narrower `entityKind`
 * enum, and pull only the fields the snapshot module needs.
 */
const toResolvedEntity = (chat: ChatFullInfo): ResolvedEntity => {
  const kind = mapChatType(chat);
  const raw = chat as unknown as Readonly<Record<string, unknown>>;

  return {
    id: BigInt(chat.id),
    kind,
    username: extractUsername(chat),
    activeUsernames:
      "active_usernames" in chat && Array.isArray(chat.active_usernames)
        ? chat.active_usernames
        : null,
    displayName: extractDisplayName(chat),
    bio: extractBio(chat),
    photoFileUniqueId: extractPhotoFileUniqueId(chat),
    isPremium: extractIsPremium(chat),
    memberCount: null, // requires a separate getChatMembersCount call; PR-3+ if needed
    isBot: chat.type === "private" ? extractIsBot(chat) : false,
    raw,
  };
};

const mapChatType = (chat: ChatFullInfo): ResolvedEntity["kind"] => {
  switch (chat.type) {
    case "supergroup":
      return "supergroup";
    case "channel":
      return "channel";
    case "group":
      return "group";
    case "private":
      // For private chats the Bot API doesn't directly say "this is a bot"
      // on the chat row; we infer from any User-shaped fields we can find.
      // When ambiguous, prefer "user" — narrower than "unknown".
      return extractIsBot(chat) === true ? "bot" : "user";
    default:
      return "unknown";
  }
};

const extractUsername = (chat: Chat | ChatFullInfo): string | null => {
  if ("username" in chat && typeof chat.username === "string") {
    return chat.username.toLowerCase();
  }
  return null;
};

const extractDisplayName = (chat: ChatFullInfo): string | null => {
  if (chat.type === "private") {
    const first = "first_name" in chat ? chat.first_name : "";
    const last = "last_name" in chat && typeof chat.last_name === "string" ? chat.last_name : "";
    const combined = `${first} ${last}`.trim();
    return combined.length > 0 ? combined : null;
  }
  if ("title" in chat && typeof chat.title === "string") {
    return chat.title;
  }
  return null;
};

const extractBio = (chat: ChatFullInfo): string | null => {
  if ("bio" in chat && typeof chat.bio === "string") return chat.bio;
  if ("description" in chat && typeof chat.description === "string") return chat.description;
  return null;
};

const extractPhotoFileUniqueId = (chat: ChatFullInfo): string | null => {
  if (!("photo" in chat)) return null;
  const photo: unknown = (chat as unknown as { photo: unknown }).photo;
  if (photo === null || typeof photo !== "object" || !("big_file_unique_id" in photo)) {
    return null;
  }
  const id: unknown = photo.big_file_unique_id;
  return typeof id === "string" ? id : null;
};

const extractIsPremium = (chat: ChatFullInfo): boolean | null => {
  // `is_premium` lives on `User`, not on `Chat`. We only see it on chat
  // rows when the Bot API embeds it for type=private. Treat absence as
  // unknown (null), not false.
  if ("is_premium" in chat && typeof chat.is_premium === "boolean") {
    return chat.is_premium;
  }
  return null;
};

const extractIsBot = (chat: ChatFullInfo): boolean | null => {
  // For bot-typed private chats, grammY's ChatFullInfo doesn't model
  // is_bot directly. We probe the underlying object defensively.
  if ("is_bot" in chat) {
    const value: unknown = (chat as unknown as { is_bot: unknown }).is_bot;
    if (typeof value === "boolean") return value;
  }
  return null;
};

/**
 * Convert a forwarded message's `forward_origin.sender_user` (a Bot API
 * `User`) into a `ResolvedEntity`. This is the path that lets us snapshot
 * a bot/user we've never `getChat`-resolved — they came in via a forward.
 */
export const resolvedEntityFromUser = (user: User): ResolvedEntity => ({
  id: BigInt(user.id),
  kind: user.is_bot ? "bot" : "user",
  username: typeof user.username === "string" ? user.username.toLowerCase() : null,
  activeUsernames: null,
  displayName:
    [user.first_name, user.last_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() || null,
  bio: null,
  photoFileUniqueId: null,
  isPremium: user.is_premium === true ? true : null,
  memberCount: null,
  isBot: user.is_bot,
  raw: user as unknown as Readonly<Record<string, unknown>>,
});

const classifyResolverError = (
  error: unknown,
  notResolvableReason: NotResolvableReason,
): ResolverResult => {
  const failure = classifyBotApiFailure(error);

  if (failure.status === "not_resolvable") {
    return {
      status: "not_resolvable",
      reason: notResolvableReason,
      description: failure.description,
    };
  }

  return { status: "failed", failure };
};
