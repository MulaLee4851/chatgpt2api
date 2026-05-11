"use client";

import localforage from "localforage";

import type { GptWebInlineLink, GptWebMessageRole, GptWebSourceGroup } from "@/lib/api";

export type GptWebMessageStatus = "pending" | "success" | "error";

export type GptWebStoredMessage = {
  id: string;
  role: GptWebMessageRole;
  content: string;
  createdAt: string;
  status?: GptWebMessageStatus;
  error?: string;
  sources?: GptWebSourceGroup[];
  inlineLinks?: GptWebInlineLink[];
};

export type GptWebConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: GptWebStoredMessage[];
};

const gptWebConversationStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "gpt_web_conversations",
});

const GPT_WEB_CONVERSATIONS_KEY = "items";
let gptWebConversationWriteQueue: Promise<void> = Promise.resolve();

function normalizeSourceGroups(value: unknown): GptWebSourceGroup[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const groups = value
    .map((group) => {
      if (!group || typeof group !== "object") {
        return null;
      }
      const candidate = group as { type?: unknown; items?: unknown };
      if (candidate.type !== "grouped_webpages" || !Array.isArray(candidate.items)) {
        return null;
      }
      const items = candidate.items
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const source = item as Record<string, unknown>;
          const url = String(source.url || "").trim();
          if (!url) {
            return null;
          }
          return {
            id: String(source.id || url),
            title: String(source.title || url),
            url,
            attribution: typeof source.attribution === "string" ? source.attribution : undefined,
            snippet: typeof source.snippet === "string" ? source.snippet : undefined,
            ref_indices: Array.isArray(source.ref_indices)
              ? source.ref_indices.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
              : undefined,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      return items.length > 0 ? { type: "grouped_webpages" as const, items } : null;
    })
    .filter((group): group is GptWebSourceGroup => Boolean(group));
  return groups.length > 0 ? groups : undefined;
}

function normalizeInlineLinks(value: unknown): GptWebInlineLink[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const links = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const link = item as Record<string, unknown>;
      const url = String(link.url || "").trim();
      const label = String(link.label || "").trim();
      if (!url || !label) {
        return null;
      }
      return {
        id: String(link.id || `${label}:${url}`),
        label,
        url,
        ref_indices: Array.isArray(link.ref_indices)
          ? link.ref_indices.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
          : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return links.length > 0 ? links : undefined;
}

function normalizeMessage(message: GptWebStoredMessage & Record<string, unknown>): GptWebStoredMessage {
  return {
    id: String(message.id || `${Date.now()}`),
    role:
      message.role === "assistant" || message.role === "system"
        ? message.role
        : "user",
    content: String(message.content || ""),
    createdAt: String(message.createdAt || new Date().toISOString()),
    status:
      message.status === "pending" || message.status === "error" || message.status === "success"
        ? message.status
        : undefined,
    error: typeof message.error === "string" ? message.error : undefined,
    sources: normalizeSourceGroups(message.sources),
    inlineLinks: normalizeInlineLinks(message.inlineLinks),
  };
}

function normalizeConversation(conversation: GptWebConversation & Record<string, unknown>): GptWebConversation {
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages.map((message) => normalizeMessage(message as GptWebStoredMessage & Record<string, unknown>))
    : [];
  const createdAt = String(conversation.createdAt || messages[0]?.createdAt || new Date().toISOString());
  const updatedAt = String(
    conversation.updatedAt || messages[messages.length - 1]?.createdAt || createdAt,
  );
  return {
    id: String(conversation.id || `${Date.now()}`),
    title: String(conversation.title || "新对话"),
    createdAt,
    updatedAt,
    messages,
  };
}

function sortGptWebConversations(conversations: GptWebConversation[]): GptWebConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getTimestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function pickLatestConversation(current: GptWebConversation, next: GptWebConversation) {
  return getTimestamp(next.updatedAt) >= getTimestamp(current.updatedAt) ? next : current;
}

function queueGptWebConversationWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = gptWebConversationWriteQueue.then(operation);
  gptWebConversationWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readStoredGptWebConversations(): Promise<GptWebConversation[]> {
  const items =
    (await gptWebConversationStorage.getItem<Array<GptWebConversation & Record<string, unknown>>>(
      GPT_WEB_CONVERSATIONS_KEY,
    )) || [];
  return items.map(normalizeConversation);
}

export async function listGptWebConversations(): Promise<GptWebConversation[]> {
  return sortGptWebConversations(await readStoredGptWebConversations());
}

export async function saveGptWebConversations(conversations: GptWebConversation[]): Promise<void> {
  await queueGptWebConversationWrite(async () => {
    const items = await readStoredGptWebConversations();
    const conversationMap = new Map(items.map((item) => [item.id, item]));
    for (const conversation of conversations.map(normalizeConversation)) {
      const current = conversationMap.get(conversation.id);
      conversationMap.set(conversation.id, current ? pickLatestConversation(current, conversation) : conversation);
    }
    await gptWebConversationStorage.setItem(
      GPT_WEB_CONVERSATIONS_KEY,
      sortGptWebConversations([...conversationMap.values()]),
    );
  });
}

export async function saveGptWebConversation(conversation: GptWebConversation): Promise<void> {
  await queueGptWebConversationWrite(async () => {
    const items = await readStoredGptWebConversations();
    const nextConversation = normalizeConversation(conversation);
    const current = items.find((item) => item.id === nextConversation.id);
    const persistedConversation = current ? pickLatestConversation(current, nextConversation) : nextConversation;
    const nextItems = sortGptWebConversations([
      persistedConversation,
      ...items.filter((item) => item.id !== persistedConversation.id),
    ]);
    await gptWebConversationStorage.setItem(GPT_WEB_CONVERSATIONS_KEY, nextItems);
  });
}

export async function deleteGptWebConversation(id: string): Promise<void> {
  await queueGptWebConversationWrite(async () => {
    const items = await readStoredGptWebConversations();
    await gptWebConversationStorage.setItem(
      GPT_WEB_CONVERSATIONS_KEY,
      items.filter((item) => item.id !== id),
    );
  });
}

export async function clearGptWebConversations(): Promise<void> {
  await queueGptWebConversationWrite(async () => {
    await gptWebConversationStorage.removeItem(GPT_WEB_CONVERSATIONS_KEY);
  });
}
