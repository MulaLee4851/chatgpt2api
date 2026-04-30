"use client";

import localforage from "localforage";

import type { GptWebMessageRole } from "@/lib/api";

export type GptWebMessageStatus = "pending" | "success" | "error";

export type GptWebStoredMessage = {
  id: string;
  role: GptWebMessageRole;
  content: string;
  createdAt: string;
  status?: GptWebMessageStatus;
  error?: string;
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
