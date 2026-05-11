"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { GptWebComposer } from "@/app/gpt-web/components/gpt-web-composer";
import { GptWebMessages } from "@/app/gpt-web/components/gpt-web-messages";
import { GptWebSidebar } from "@/app/gpt-web/components/gpt-web-sidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createGptWebChatCompletion, type GptWebChatMessage } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import {
  clearGptWebConversations,
  deleteGptWebConversation,
  listGptWebConversations,
  saveGptWebConversation,
  type GptWebConversation,
  type GptWebStoredMessage,
} from "@/store/gpt-web-conversations";

const ACTIVE_CONVERSATION_STORAGE_KEY = "chatgpt2api:gpt_web_active_conversation_id";

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 18) {
    return trimmed;
  }
  return `${trimmed.slice(0, 18)}...`;
}

function sortConversations(conversations: GptWebConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function pickFallbackConversationId(conversations: GptWebConversation[]) {
  return conversations[0]?.id ?? null;
}

function toApiMessages(messages: GptWebStoredMessage[]): GptWebChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .filter((message) => message.status !== "error")
    .map((message) => ({ role: message.role, content: message.content }));
}

function GptWebPageContent() {
  const conversationsRef = useRef<GptWebConversation[]>([]);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState("");
  const [conversations, setConversations] = useState<GptWebConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "one"; id: string } | { type: "all" } | null>(null);

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  const deleteConfirmTitle = deleteConfirm?.type === "all" ? "清空历史记录" : deleteConfirm?.type === "one" ? "删除对话" : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部 gpt-web 对话历史吗？删除后无法恢复。"
      : deleteConfirm?.type === "one"
        ? "确认删除这条 gpt-web 对话吗？删除后无法恢复。"
        : "";

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const items = await listGptWebConversations();
        if (cancelled) {
          return;
        }
        conversationsRef.current = items;
        setConversations(items);
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) : null;
        const nextSelectedConversationId =
          (storedConversationId && items.some((conversation) => conversation.id === storedConversationId)
            ? storedConversationId
            : null) ?? pickFallbackConversationId(items);
        setSelectedConversationId(nextSelectedConversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取会话记录失败";
        toast.error(message);
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }
    resultsViewportRef.current?.scrollTo({
      top: resultsViewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [selectedConversation?.updatedAt, selectedConversation?.messages.length, selectedConversation]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (selectedConversationId) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, selectedConversationId);
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const persistConversation = async (conversation: GptWebConversation) => {
    const nextConversations = sortConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveGptWebConversation(conversation);
  };

  const updateConversation = useCallback(async (conversation: GptWebConversation) => {
    const nextConversations = sortConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveGptWebConversation(conversation);
  }, []);

  const resetComposer = useCallback(() => {
    setPrompt("");
    textareaRef.current?.focus();
  }, []);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
  };

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteGptWebConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listGptWebConversations();
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearGptWebConversations();
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const handleSubmit = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) {
      return;
    }

    const now = new Date().toISOString();
    const conversationId = selectedConversation?.id ?? createId();
    const userMessage: GptWebStoredMessage = {
      id: createId(),
      role: "user",
      content: trimmedPrompt,
      createdAt: now,
      status: "success",
    };
    const placeholderMessage: GptWebStoredMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const baseConversation: GptWebConversation = selectedConversation
      ? {
          ...selectedConversation,
          updatedAt: placeholderMessage.createdAt,
          messages: [...selectedConversation.messages, userMessage, placeholderMessage],
        }
      : {
          id: conversationId,
          title: buildConversationTitle(trimmedPrompt) || "新对话",
          createdAt: now,
          updatedAt: placeholderMessage.createdAt,
          messages: [userMessage, placeholderMessage],
        };

    setSelectedConversationId(conversationId);
    setPrompt("");
    setIsSubmitting(true);
    await persistConversation(baseConversation);

    try {
      const response = await createGptWebChatCompletion(toApiMessages(baseConversation.messages));
      const content = String(response.choices?.[0]?.message?.content || "").trim();
      const replyText = content || "";
      const replySources = response.x_gpt_web?.sources;
      const replyInlineLinks = response.x_gpt_web?.inline_links;
      const updatedConversation: GptWebConversation = {
        ...baseConversation,
        updatedAt: new Date().toISOString(),
        messages: baseConversation.messages.map((message) =>
          message.id === placeholderMessage.id
            ? {
                ...message,
                content: replyText,
                status: "success",
                error: undefined,
                sources: replySources,
                inlineLinks: replyInlineLinks,
                createdAt: new Date().toISOString(),
              }
            : message,
        ),
      };
      await updateConversation(updatedConversation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "对话请求失败";
      const updatedConversation: GptWebConversation = {
        ...baseConversation,
        updatedAt: new Date().toISOString(),
        messages: baseConversation.messages.map((item) =>
          item.id === placeholderMessage.id
            ? {
                ...item,
                content: message,
                status: "error",
                error: message,
                createdAt: new Date().toISOString(),
              }
            : item,
        ),
      };
      await updateConversation(updatedConversation);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
      textareaRef.current?.focus();
    }
  };

  return (
    <>
      <section className="mx-auto grid h-[calc(100dvh-6.25rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-5rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-stone-200/70 pr-3 lg:block">
          <GptWebSidebar
            conversations={conversations}
            isLoadingHistory={isLoadingHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={setSelectedConversationId}
            onDeleteConversation={openDeleteConversationConfirm}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(82dvh,760px)] w-[92vw] max-w-[460px] flex-col overflow-hidden rounded-[32px] border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:rounded-[36px]">
            <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
              <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <History className="size-5" />
                历史记录
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
              <GptWebSidebar
                conversations={conversations}
                isLoadingHistory={isLoadingHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  setSelectedConversationId(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex min-h-0 flex-col gap-2 sm:gap-4">
          <div className="flex items-center justify-between gap-2 px-1 lg:hidden">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-2xl border-stone-200 bg-white/90 text-stone-700 shadow-sm"
              onClick={() => setIsHistoryOpen(true)}
            >
              <History className="mr-2 size-4" />
              历史记录 ({conversations.length})
            </Button>
            <Button
              className="h-10 rounded-2xl bg-stone-950 text-white shadow-sm"
              onClick={handleCreateDraft}
            >
              <Plus className="size-4" />
              新建
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-2xl border-stone-200 bg-white/85 px-3 text-stone-600 shadow-sm"
              onClick={openClearHistoryConfirm}
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <div
            ref={resultsViewportRef}
            className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-1 py-2 sm:px-4 sm:py-4"
          >
            <GptWebMessages selectedConversation={selectedConversation} formatConversationTime={formatConversationTime} />
          </div>

          <GptWebComposer
            prompt={prompt}
            isSubmitting={isSubmitting}
            textareaRef={textareaRef}
            onPromptChange={setPrompt}
            onSubmit={handleSubmit}
          />
        </div>
      </section>

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">{deleteConfirmDescription}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default function GptWebPage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <GptWebPageContent />;
}
