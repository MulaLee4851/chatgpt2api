"use client";

import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type { GptWebSourceItem } from "@/lib/api";
import type { GptWebConversation, GptWebStoredMessage } from "@/store/gpt-web-conversations";

type GptWebMessagesProps = {
  selectedConversation: GptWebConversation | null;
  formatConversationTime: (value: string) => string;
};

function flattenSources(message: GptWebStoredMessage): GptWebSourceItem[] {
  const seen = new Set<string>();
  const items: GptWebSourceItem[] = [];
  for (const group of message.sources || []) {
    for (const item of group.items) {
      const url = String(item.url || "").trim();
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      items.push(item);
    }
  }
  return items;
}

function stripCitationPlaceholders(content: string) {
  return content
    .replace(/citeturn\d+search\d+/g, "")
    .replace(/cite/g, "")
    .replace(//g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function MessageBubble({ message, formatConversationTime }: { message: GptWebStoredMessage; formatConversationTime: (value: string) => string }) {
  const isUser = message.role === "user";
  const isPending = message.status === "pending";
  const isError = message.status === "error";
  const sources = isUser || isPending || isError ? [] : flattenSources(message);
  const renderedContent = stripCitationPlaceholders(message.content || (isError ? message.error || "请求失败" : ""));

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[92%] sm:max-w-[82%]", isUser ? "items-end" : "items-start")}>
        <div className={cn("mb-1.5 flex gap-2 text-[11px] text-stone-400", isUser ? "justify-end" : "justify-start")}>
          <span>{isUser ? "你" : "gpt-web"}</span>
          <span>{formatConversationTime(message.createdAt)}</span>
        </div>
        <div
          className={cn(
            "whitespace-pre-wrap rounded-3xl px-4 py-3 text-[14px] leading-6 shadow-sm sm:px-5 sm:py-4 sm:text-[15px] sm:leading-7",
            isUser
              ? "bg-stone-950 text-white"
              : isError
                ? "border border-rose-200 bg-rose-50 text-rose-700"
                : "border border-stone-200 bg-white text-stone-900",
          )}
        >
          {isPending ? (
            <div className="flex items-center gap-2 text-stone-500">
              <LoaderCircle className="size-4 animate-spin" />
              正在回复...
            </div>
          ) : (
            renderedContent
          )}
        </div>
        {sources.length > 0 ? (
          <div className="mt-3 rounded-2xl border border-stone-200/80 bg-stone-50/80 px-4 py-3 text-left shadow-sm">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500">Sources</div>
            <div className="space-y-2.5">
              {sources.map((source, index) => (
                <a
                  key={`${source.url}-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block rounded-xl border border-stone-200 bg-white px-3 py-2.5 transition hover:border-stone-300 hover:bg-stone-50"
                >
                  <div className="text-sm font-medium leading-5 text-stone-900">{source.title}</div>
                  {source.attribution ? (
                    <div className="mt-1 text-xs text-stone-500">{source.attribution}</div>
                  ) : null}
                  {source.snippet ? (
                    <div className="mt-1.5 line-clamp-3 text-xs leading-5 text-stone-600">{source.snippet}</div>
                  ) : null}
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function GptWebMessages({ selectedConversation, formatConversationTime }: GptWebMessagesProps) {
  if (!selectedConversation) {
    return (
      <div className="flex h-full min-h-[260px] items-center justify-center text-center sm:min-h-[420px]">
        <div className="w-full max-w-4xl">
          <h1
            className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            Talk with gpt-web
          </h1>
          <p
            className="mx-auto mt-3 max-w-[300px] text-sm italic tracking-[0.01em] text-stone-500 sm:mt-4 sm:max-w-none sm:text-[15px]"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            在独立页面里保留本地文本历史，并通过 gpt-web 模型走现有 chat completions 链路完成多轮对话。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4 sm:gap-6">
      {selectedConversation.messages.map((message) => (
        <MessageBubble key={message.id} message={message} formatConversationTime={formatConversationTime} />
      ))}
    </div>
  );
}
