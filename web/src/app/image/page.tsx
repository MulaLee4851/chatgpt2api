"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageTemplatePicker } from "@/app/image/components/image-template-picker";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  createImageEditTask,
  createImageGenerationTask,
  fetchImageTasks,
  fetchImageTemplates,
  type ImageTask,
  type ImageTemplate,
} from "@/lib/api";
import { getValidatedAuthSession } from "@/lib/auth-session";
import { isRequestError } from "@/lib/request";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";
import {
  clearImageConversations,
  deleteImageConversation,
  getImageConversationStats,
  listImageConversations,
  renameImageConversation,
  saveImageConversation,
  saveImageConversations,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ImageTurnStatus,
  type ReferenceImageSource,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";

const ACTIVE_CONVERSATION_STORAGE_KEY = "chatgpt2api:image_active_conversation_id";
const IMAGE_SIZE_STORAGE_KEY = "chatgpt2api:image_last_size";
const IMAGE_COUNT_STORAGE_KEY = "chatgpt2api:image_last_count";
const SESSION_REFRESH_INTERVAL_MS = 60_000;

function clampImageCount(value: string, maxCount = 100) {
  const normalizedMax = Math.max(1, Math.floor(Number(maxCount) || 1));
  return String(Math.min(normalizedMax, Math.max(1, Math.floor(Number(value) || 1))));
}
const activeConversationQueueIds = new Set<string>();

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}...`;
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

function getRemainingImages(session: StoredAuthSession | null) {
  if (!session || !session.permissions.image) {
    return 0;
  }
  if (session.limits.max_images == null) {
    return null;
  }
  return Math.max(0, session.limits.max_images - session.usage.used_images);
}

function formatAvailableQuota(session: StoredAuthSession | null) {
  if (!session) {
    return "加载中...";
  }
  if (!session.permissions.image) {
    return "不可用";
  }
  const remainingImages = getRemainingImages(session);
  return remainingImages == null ? "无限" : String(remainingImages);
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }

  return {
    name: fileName,
    type: "image/png",
    dataUrl: `data:image/png;base64,${image.b64_json}`,
  };
}

async function fetchImageAsFile(url: string, fileName: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("读取结果图失败");
  }
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

async function buildReferenceImageFromStoredImage(image: StoredImage, fileName: string) {
  const direct = buildReferenceImageFromResult(image, fileName);
  if (direct) {
    return {
      referenceImage: direct,
      file: dataUrlToFile(direct.dataUrl, direct.name, direct.type),
    };
  }

  if (!image.url) {
    return null;
  }
  const file = await fetchImageAsFile(image.url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

type ReferenceImageEntry = {
  file: File;
  preview: StoredReferenceImage;
  source: ReferenceImageSource;
};

function unzipReferenceImageEntries(entries: ReferenceImageEntry[]) {
  return {
    files: entries.map((entry) => entry.file),
    previews: entries.map((entry) => entry.preview),
    sources: entries.map((entry) => entry.source),
  };
}

function createTemplateFieldValues(template: ImageTemplate | null) {
  if (!template) {
    return {} as Record<string, string>;
  }
  return Object.fromEntries(
    template.placeholders.map((placeholder) => [placeholder.key, placeholder.default_value || ""]),
  );
}

async function buildReferenceImageFromTemplate(url: string, fileName: string) {
  const file = await fetchImageAsFile(url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

function normalizeImageFailureReason(value: string | null | undefined) {
  let normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("上游未生成图片，而是返回补充说明：")) {
    normalized = normalized.replace(/^上游未生成图片，而是返回补充说明：\s*/, "").trim();
  }
  if (normalized === "image task returned no image data") {
    return "未返回图片结果，请稍后重试";
  }
  return normalized;
}

function formatImageFailureMessage(value: string | null | undefined, fallback = "生成失败") {
  const reason = normalizeImageFailureReason(value);
  if (!reason) {
    return fallback;
  }
  return reason.startsWith("生成失败") ? reason : `生成失败：${reason}`;
}

function formatImageRequestError(error: unknown, fallback = "生成失败") {
  if (isRequestError(error)) {
    if (error.status === 401 || error.status === 403) {
      return "登录状态异常，请重试或重新登录";
    }
    if (error.status === 413) {
      return "图片太大，请压缩后重试";
    }
    if (error.code === "ECONNABORTED" || error.message.includes("超时")) {
      return "请求超时，请稍后重试";
    }
    if (error.isNetworkError) {
      return "网络连接失败，请稍后重试";
    }
    return formatImageFailureMessage(error.message, fallback);
  }
  if (error instanceof Error) {
    return formatImageFailureMessage(error.message, fallback);
  }
  return fallback;
}

function getImageErrorMessage(value: string | null | undefined) {
  return formatImageFailureMessage(value);
}

function isTransientTaskStatusMessage(value: string | null | undefined) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) {
    return false;
  }
  return ["网络连接失败", "请求超时", "状态查询失败", "网络波动", "稍后重试", "timeout", "network"].some((keyword) =>
    message.toLowerCase().includes(keyword.toLowerCase()),
  );
}

function shouldRecoverTaskStatus(image: StoredImage) {
  if (!image.taskId) {
    return false;
  }
  if (image.status === "loading") {
    return true;
  }
  return image.status === "error" && isTransientTaskStatusMessage(image.error);
}

function isTransientTaskPollError(error: unknown) {
  if (isRequestError(error)) {
    if (error.isNetworkError || error.code === "ECONNABORTED") {
      return true;
    }
    return error.status != null && [408, 425, 429, 499, 500, 502, 503, 504].includes(error.status);
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return ["timeout", "network", "502", "503", "504", "gateway", "连接", "超时"].some((keyword) =>
    message.includes(keyword.toLowerCase()),
  );
}

function taskDataToStoredImage(image: StoredImage, task: ImageTask): StoredImage {
  if (task.status === "success") {
    const first = task.data?.[0];
    if (!first?.b64_json && !first?.url) {
      return {
        ...image,
        taskId: task.id,
        status: "error",
        error: formatImageFailureMessage("未返回图片结果，请稍后重试"),
      };
    }
    return {
      ...image,
      taskId: task.id,
      status: "success",
      b64_json: first.b64_json,
      url: first.url,
      revised_prompt: first.revised_prompt,
      error: undefined,
      progressMessage: undefined,
    };
  }

  if (task.status === "error") {
    const error = getImageErrorMessage(task.error);
    if (image.status === "error" && image.taskId === task.id && image.error === error) {
      return image;
    }
    return {
      ...image,
      taskId: task.id,
      status: "error",
      error,
      progressMessage: undefined,
    };
  }

  const progressMessage = task.progress_message?.trim() || undefined;
  if (image.status === "loading" && image.taskId === task.id && !image.error && image.progressMessage === progressMessage) {
    return image;
  }

  return {
    ...image,
    taskId: task.id,
    status: "loading",
    error: undefined,
    progressMessage,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) =>
    conversation.turns.some((turn) => turn.status === "queued" || turn.status === "generating"),
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function deriveTurnStatus(turn: ImageTurn): Pick<ImageTurn, "status" | "error"> {
  const loadingCount = turn.images.filter((image) => image.status === "loading").length;
  const failedImages = turn.images.filter((image) => image.status === "error");
  const failedCount = failedImages.length;
  const successCount = turn.images.filter((image) => image.status === "success").length;
  if (loadingCount > 0) {
    return { status: turn.status === "queued" ? "queued" : "generating", error: undefined };
  }
  if (failedCount > 0) {
    const uniqueErrors = Array.from(
      new Set(
        failedImages
          .map((image) => image.error?.trim())
          .filter((error): error is string => Boolean(error)),
      ),
    );
    const primaryError = uniqueErrors[0] || "生成失败";
    const suffix = failedCount > 1 ? `（共 ${failedCount} 张失败）` : "";
    return { status: "error", error: `${primaryError}${suffix}` };
  }
  if (successCount > 0) {
    return { status: "success", error: undefined };
  }
  return { status: "queued", error: undefined };
}

async function syncConversationImageTasks(items: ImageConversation[]) {
  const taskIds = Array.from(
    new Set(
      items.flatMap((conversation) =>
        conversation.turns.flatMap((turn) =>
          turn.resultsDeleted
            ? []
            : turn.images.flatMap((image) => (shouldRecoverTaskStatus(image) ? [image.taskId || image.id] : [])),
        ),
      ),
    ),
  );
  if (taskIds.length === 0) {
    return items;
  }

  let taskList: Awaited<ReturnType<typeof fetchImageTasks>>;
  try {
    taskList = await fetchImageTasks(taskIds);
  } catch {
    return items;
  }
  const taskMap = new Map(taskList.items.map((task) => [task.id, task]));
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (!shouldRecoverTaskStatus(image)) {
          return image;
        }
        const taskId = image.taskId || image.id;
        const task = taskMap.get(taskId);
        if (!task) {
          return image;
        }
        const nextImage = taskDataToStoredImage({ ...image, taskId }, task);
        if (nextImage !== image) {
          turnChanged = true;
        }
        return nextImage;
      });
      if (!turnChanged) {
        return turn;
      }
      changed = true;
      const derived = deriveTurnStatus({ ...turn, images });
      return {
        ...turn,
        ...derived,
        images,
      };
    });
    if (turns === conversation.turns || !turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }
    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }
  return normalized;
}

async function recoverConversationHistory(items: ImageConversation[]) {
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      if (turn.status !== "queued" && turn.status !== "generating") {
        return turn;
      }

      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status !== "loading" || image.taskId) {
          return image;
        }
        turnChanged = true;
        return {
          ...image,
          status: "error" as const,
          error: "页面刷新或任务中断，未找到可恢复的任务 ID",
        };
      });
      const derived = deriveTurnStatus({ ...turn, images });
      if (!turnChanged && derived.status === turn.status && derived.error === turn.error) {
        return turn;
      }
      changed = true;
      return {
        ...turn,
        ...derived,
        images,
      };
    });

    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }

    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }

  return syncConversationImageTasks(normalized);
}


function ImagePageContent({ session }: { session: StoredAuthSession }) {
  const didLoadSessionRef = useRef(false);
  const lastSessionRefreshAtRef = useRef(0);
  const isRefreshingSessionRef = useRef(false);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceEntriesRef = useRef<ReferenceImageEntry[]>([]);

  const [authSession, setAuthSession] = useState(session);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("1");
  const [imageSize, setImageSize] = useState("");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [referenceImageSources, setReferenceImageSources] = useState<ReferenceImageSource[]>([]);
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateFieldValues, setTemplateFieldValues] = useState<Record<string, string>>({});
  const [isTemplatePickerOpen, setIsTemplatePickerOpen] = useState(false);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: "one"; id: string }
    | { type: "prompt"; conversationId: string; turnId: string }
    | { type: "results"; conversationId: string; turnId: string }
    | { type: "all" }
    | null
  >(null);

  const remainingImages = useMemo(() => getRemainingImages(authSession), [authSession]);
  const availableQuota = useMemo(() => formatAvailableQuota(authSession), [authSession]);

  const setReferenceEntries = useCallback((entries: ReferenceImageEntry[]) => {
    referenceEntriesRef.current = entries;
    const next = unzipReferenceImageEntries(entries);
    setReferenceImageFiles(next.files);
    setReferenceImages(next.previews);
    setReferenceImageSources(next.sources);
    if (next.files.length === 0 && fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const updateReferenceEntries = useCallback(
    (updater: (entries: ReferenceImageEntry[]) => ReferenceImageEntry[]) => {
      setReferenceEntries(updater(referenceEntriesRef.current));
    },
    [setReferenceEntries],
  );
  const maxSelectableImageCount = useMemo(() => {
    if (remainingImages == null) {
      return 100;
    }
    return Math.max(1, Math.min(100, remainingImages));
  }, [remainingImages]);
  const parsedCount = useMemo(() => Number(clampImageCount(imageCount, maxSelectableImageCount)), [imageCount, maxSelectableImageCount]);
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const activeTaskCount = useMemo(
    () =>
      conversations.reduce((sum, conversation) => {
        const stats = getImageConversationStats(conversation);
        return sum + stats.queued + stats.running;
      }, 0),
    [conversations],
  );
  const deleteConfirmTitle =
    deleteConfirm?.type === "all"
      ? "清空历史记录"
      : deleteConfirm?.type === "prompt"
        ? "删除提示词记录"
        : deleteConfirm?.type === "results"
          ? "删除生成结果"
          : deleteConfirm?.type === "one"
            ? "删除对话"
            : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "prompt"
        ? "确认删除这条提示词记录吗？对应生成结果会保留。"
        : deleteConfirm?.type === "results"
          ? "确认删除这条生成结果吗？对应提示词记录会保留。"
          : deleteConfirm?.type === "one"
            ? "确认删除这条图片对话吗？删除后无法恢复。"
            : "";

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    setAuthSession(session);
  }, [session]);

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const storedSize = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_SIZE_STORAGE_KEY) : null;
        const storedCount = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_COUNT_STORAGE_KEY) : null;
        setImageSize(storedSize || "");
        setImageCount(storedCount ? clampImageCount(storedCount, maxSelectableImageCount) : "1");

        const items = await listImageConversations();
        const normalizedItems = await recoverConversationHistory(items);
        if (cancelled) {
          return;
        }

        conversationsRef.current = normalizedItems;
        setConversations(normalizedItems);
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) : null;
        const nextSelectedConversationId =
          (storedConversationId && normalizedItems.some((conversation) => conversation.id === storedConversationId)
            ? storedConversationId
            : null) ?? pickFallbackConversationId(normalizedItems);
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
    setImageCount((current) => clampImageCount(current || "1", maxSelectableImageCount));
  }, [maxSelectableImageCount]);

  useEffect(() => {
    let cancelled = false;
    const loadTemplates = async () => {
      setIsLoadingTemplates(true);
      try {
        const data = await fetchImageTemplates({ redirectOnUnauthorized: false });
        if (!cancelled) {
          setTemplates(data.items);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(formatImageRequestError(error, "加载模板失败"));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingTemplates(false);
        }
      }
    };

    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSession = useCallback(async (options: { force?: boolean } = {}) => {
    const now = Date.now();
    if (!options.force && now - lastSessionRefreshAtRef.current < SESSION_REFRESH_INTERVAL_MS) {
      return;
    }
    if (isRefreshingSessionRef.current) {
      return;
    }
    isRefreshingSessionRef.current = true;
    try {
      const latest = await getValidatedAuthSession();
      if (latest) {
        setAuthSession(latest);
        lastSessionRefreshAtRef.current = Date.now();
      }
    } finally {
      isRefreshingSessionRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (didLoadSessionRef.current) {
      return;
    }
    didLoadSessionRef.current = true;

    const handleFocus = () => {
      void refreshSession();
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshSession]);

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }

    resultsViewportRef.current?.scrollTo({
      top: resultsViewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [selectedConversation?.id, selectedConversation?.turns.length]);

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
    if (typeof window === "undefined") {
      return;
    }

    if (imageSize) {
      window.localStorage.setItem(IMAGE_SIZE_STORAGE_KEY, imageSize);
      return;
    }
    window.localStorage.removeItem(IMAGE_SIZE_STORAGE_KEY);
  }, [imageSize]);

  useEffect(() => {
    if (typeof window !== "undefined" && parsedCount > 0) {
      window.localStorage.setItem(IMAGE_COUNT_STORAGE_KEY, String(parsedCount));
    }
  }, [parsedCount]);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const persistConversation = async (conversation: ImageConversation) => {
    const nextConversations = sortImageConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveImageConversation(conversation);
  };

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean } = {},
    ) => {
      const current = conversationsRef.current.find((item) => item.id === conversationId) ?? null;
      const nextConversation = updater(current);
      const nextConversations = sortImageConversations([
        nextConversation,
        ...conversationsRef.current.filter((item) => item.id !== conversationId),
      ]);
      conversationsRef.current = nextConversations;
      setConversations(nextConversations);
      if (options.persist !== false) {
        await saveImageConversation(nextConversation);
      }
    },
    [],
  );

  const clearComposerInputs = useCallback(() => {
    setImagePrompt("");
    setSelectedTemplateId("");
    setTemplateFieldValues({});
    setReferenceEntries([]);
  }, [setReferenceEntries]);

  const clearSelectedTemplate = useCallback(() => {
    setSelectedTemplateId("");
    setTemplateFieldValues({});
    updateReferenceEntries((entries) => entries.filter((entry) => entry.source !== "template"));
  }, [updateReferenceEntries]);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const ensureCanQueueImages = useCallback(
    (count: number) => {
      if (!authSession.permissions.image) {
        toast.error("当前密钥没有生图权限");
        return false;
      }
      if (remainingImages != null && remainingImages <= 0) {
        toast.error("当前密钥的图片额度已用完");
        return false;
      }
      if (remainingImages != null && count > remainingImages) {
        toast.error(`当前密钥最多还能生成 ${remainingImages} 张图片`);
        return false;
      }
      return true;
    },
    [authSession.permissions.image, remainingImages],
  );

  const buildEffectivePrompt = useCallback(() => {
    let prompt = imagePrompt.trim();
    if (!selectedTemplate) {
      return prompt;
    }

    for (const placeholder of selectedTemplate.placeholders) {
      const token = `{{${placeholder.key}}}`;
      const value = String(templateFieldValues[placeholder.key] ?? placeholder.default_value ?? "").trim();
      if (placeholder.required && !value) {
        throw new Error(`请先填写${placeholder.label || placeholder.key}`);
      }
      if (!prompt.includes(token)) {
        throw new Error(`当前模板提示词缺少占位符 ${token}`);
      }
      prompt = prompt.replaceAll(token, value);
    }

    return prompt;
  }, [imagePrompt, selectedTemplate, templateFieldValues]);

  const applyTemplate = useCallback(
    async (templateId: string) => {
      if (!templateId) {
        clearSelectedTemplate();
        return;
      }
      const template = templates.find((item) => item.id === templateId);
      if (!template) {
        return;
      }
      try {
        const templateAssets = await Promise.all(
          template.references
            .filter((reference) => reference.asset_url)
            .map((reference) =>
              buildReferenceImageFromTemplate(
                reference.asset_url as string,
                `${template.name || "template"}-${reference.key}.png`,
              ),
            ),
        );

        setSelectedTemplateId(template.id);
        setTemplateFieldValues(createTemplateFieldValues(template));
        setImagePrompt(template.prompts.positive);
        setImageCount(clampImageCount(String(template.defaults.count || 1), maxSelectableImageCount));
        setImageSize(template.defaults.size || "");
        updateReferenceEntries((entries) => [
          ...entries.filter((entry) => entry.source !== "template"),
          ...templateAssets.map((item) => ({
            file: item.file,
            preview: item.referenceImage,
            source: "template" as const,
          })),
        ]);
        setIsTemplatePickerOpen(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        textareaRef.current?.focus();
        toast.success(`已应用模板：${template.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "应用模板失败";
        toast.error(message);
      }
    },
    [clearSelectedTemplate, maxSelectableImageCount, templates, updateReferenceEntries],
  );

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
    textareaRef.current?.focus();
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
      await deleteImageConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations();
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleDeleteTurnPart = async (conversationId: string, turnId: string, part: "prompt" | "results") => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) {
      return;
    }

    const turns = conversation.turns
      .map((turn) => {
        if (turn.id !== turnId) {
          return turn;
        }
        const nextTurn = {
          ...turn,
          prompt: part === "prompt" ? "" : turn.prompt,
          promptDeleted: part === "prompt" ? true : turn.promptDeleted,
          resultsDeleted: part === "results" ? true : turn.resultsDeleted,
          status: part === "results" && turn.status === "generating" ? "error" as const : turn.status,
          images:
            part === "results"
              ? turn.images.map((image) => ({ id: image.id, status: "error" as const, error: "生成结果已删除" }))
              : turn.images,
        };
        return nextTurn.promptDeleted && nextTurn.resultsDeleted ? null : nextTurn;
      })
      .filter((turn): turn is ImageTurn => Boolean(turn));

    if (turns.length === 0) {
      await handleDeleteConversation(conversationId);
      return;
    }

    const nextConversation = {
      ...conversation,
      updatedAt: new Date().toISOString(),
      turns,
    };
    await persistConversation(nextConversation);
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
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

  const handleRenameConversation = async (id: string, title: string) => {
    const nextConversations = conversations.map((item) =>
      item.id === id ? { ...item, title, updatedAt: new Date().toISOString() } : item,
    );
    conversationsRef.current = sortImageConversations(nextConversations);
    setConversations(conversationsRef.current);
    try {
      await renameImageConversation(id, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : "重命名失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openDeletePromptConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "prompt", conversationId, turnId });
  };

  const openDeleteResultsConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "results", conversationId, turnId });
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
    if (target.type === "prompt" || target.type === "results") {
      await handleDeleteTurnPart(target.conversationId, target.turnId, target.type);
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[], source: ReferenceImageSource = "user") => {
    if (files.length === 0) {
      return;
    }

    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );

      updateReferenceEntries((entries) => [
        ...entries,
        ...files.map((file, index) => ({
          file,
          preview: previews[index],
          source,
        })),
      ]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, [updateReferenceEntries]);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    updateReferenceEntries((entries) => entries.filter((_, currentIndex) => currentIndex !== index));
  }, [updateReferenceEntries]);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      try {
        const nextReference =
          "dataUrl" in image
            ? {
                referenceImage: image,
                file: dataUrlToFile(image.dataUrl, image.name, image.type),
              }
            : await buildReferenceImageFromStoredImage(image, `conversation-${conversationId}-${Date.now()}.png`);
        if (!nextReference) {
          return;
        }

        setSelectedConversationId(conversationId);
        setSelectedTemplateId("");
        setTemplateFieldValues({});
        updateReferenceEntries((entries) => [
          ...entries,
          {
            file: nextReference.file,
            preview: nextReference.referenceImage,
            source: "history",
          },
        ]);
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑");
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message);
      }
    },
    [updateReferenceEntries],
  );

  const handleReuseTurnConfig = useCallback(async (conversationId: string, turnId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    const turn = conversation?.turns.find((item) => item.id === turnId);
    if (!conversation || !turn || !turn.prompt.trim()) {
      return;
    }

    setSelectedConversationId(conversationId);
    setSelectedTemplateId("");
    setTemplateFieldValues({});
    setImagePrompt(turn.prompt);
    setImageCount(clampImageCount(String(Math.max(1, turn.count || turn.images.length || 1)), maxSelectableImageCount));
    setImageSize(turn.size);
    setReferenceEntries(
      turn.referenceImages.map((image, index) => ({
        file: dataUrlToFile(image.dataUrl, image.name, image.type),
        preview: image,
        source: turn.referenceImageSources?.[index] ?? "history",
      })),
    );
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();
    toast.success("已复用这条提示词配置");
  }, [maxSelectableImageCount, setReferenceEntries]);

  const openLightbox = useCallback((images: ImageLightboxItem[], index: number) => {
    if (images.length === 0) {
      return;
    }

    setLightboxImages(images);
    setLightboxIndex(Math.max(0, Math.min(index, images.length - 1)));
    setLightboxOpen(true);
  }, []);

  const createLoadingImages = (turnId: string, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const imageId = `${turnId}-${index}`;
      return {
        id: imageId,
        taskId: imageId,
        status: "loading" as const,
      };
    });

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      if (activeConversationQueueIds.has(conversationId)) {
        return;
      }

      const snapshot = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const activeTurn = snapshot?.turns.find(
        (turn) =>
          (turn.status === "queued" || turn.status === "generating") &&
          turn.images.some((image) => image.status === "loading"),
      );
      if (!snapshot || !activeTurn) {
        return;
      }

      activeConversationQueueIds.add(conversationId);
      const applyTasks = async (tasks: ImageTask[]) => {
        const taskMap = new Map(tasks.map((task) => [task.id, task]));
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          let conversationChanged = false;
          const turns = conversation.turns.map((turn) => {
            if (turn.id !== activeTurn.id) {
              return turn;
            }
            let turnChanged = false;
            const images = turn.images.map((image) => {
              const taskId = image.taskId || image.id;
              const task = taskMap.get(taskId);
              if (!task) {
                return image;
              }
              const nextImage = taskDataToStoredImage({ ...image, taskId }, task);
              if (nextImage !== image) {
                turnChanged = true;
              }
              return nextImage;
            });
            const derived = deriveTurnStatus({ ...turn, status: "generating", images });
            if (!turnChanged && derived.status === turn.status && derived.error === turn.error) {
              return turn;
            }
            conversationChanged = true;
            return {
              ...turn,
              ...derived,
              images,
            };
          });
          if (!conversationChanged) {
            return conversation;
          }
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns,
          };
        });
      };

      try {
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "generating",
                    error: undefined,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, taskId: image.taskId || image.id, error: undefined } : image,
                    ),
                  }
                : turn,
            ),
          };
        });

        const referenceFiles = activeTurn.referenceImages.map((image, index) =>
          dataUrlToFile(image.dataUrl, image.name || `${activeTurn.id}-${index + 1}.png`, image.type),
        );
        if (activeTurn.mode === "edit" && referenceFiles.length === 0) {
          throw new Error("未找到可用于继续编辑的参考图");
        }

        const pendingImages = activeTurn.images.filter((image) => image.status === "loading");
        const submitted = await Promise.all(
          pendingImages.map((image) => {
            const taskId = image.taskId || image.id;
            return activeTurn.mode === "edit"
              ? createImageEditTask(taskId, referenceFiles, activeTurn.prompt, activeTurn.model, activeTurn.size)
              : createImageGenerationTask(taskId, activeTurn.prompt, activeTurn.model, activeTurn.size);
          }),
        );
        await applyTasks(submitted);

        let consecutivePollFailures = 0;
        while (true) {
          const latestConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
          const latestTurn = latestConversation?.turns.find((turn) => turn.id === activeTurn.id);
          const loadingTaskIds =
            latestTurn?.images.flatMap((image) =>
              image.status === "loading" && image.taskId ? [image.taskId] : [],
            ) || [];
          if (loadingTaskIds.length === 0) {
            break;
          }

          await sleep(2000);
          try {
            const taskList = await fetchImageTasks(loadingTaskIds);
            consecutivePollFailures = 0;
            if (taskList.items.length > 0) {
              await applyTasks(taskList.items);
            }
            if (taskList.missing_ids.length > 0 && latestTurn) {
              const missingImages = latestTurn.images.filter(
                (image) => image.status === "loading" && image.taskId && taskList.missing_ids.includes(image.taskId),
              );
              const resubmitted = await Promise.all(
                missingImages.map((image) =>
                  activeTurn.mode === "edit"
                    ? createImageEditTask(image.taskId || image.id, referenceFiles, activeTurn.prompt, activeTurn.model, activeTurn.size)
                    : createImageGenerationTask(image.taskId || image.id, activeTurn.prompt, activeTurn.model, activeTurn.size),
                ),
              );
              if (resubmitted.length > 0) {
                await applyTasks(resubmitted);
              }
            }
          } catch (error) {
            if (!isTransientTaskPollError(error)) {
              throw error;
            }
            consecutivePollFailures += 1;
            if (consecutivePollFailures === 1 || consecutivePollFailures % 3 === 0) {
              toast.error("状态查询失败，正在重试");
            }
          }
        }

        await refreshSession();
      } catch (error) {
        const message = formatImageRequestError(error, "生成失败");
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "error",
                    error: message,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, status: "error", error: message } : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        toast.error(message);
      } finally {
        activeConversationQueueIds.delete(conversationId);
        for (const conversation of conversationsRef.current) {
          if (
            !activeConversationQueueIds.has(conversation.id) &&
            conversation.turns.some(
              (turn) =>
                (turn.status === "queued" || turn.status === "generating") &&
                turn.images.some((image) => image.status === "loading"),
            )
          ) {
            void runConversationQueue(conversation.id);
          }
        }
      }
    },
    [refreshSession, updateConversation],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const handleRegenerateTurn = useCallback(
    async (conversationId: string, turnId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      const sourceTurn = conversation?.turns.find((turn) => turn.id === turnId);
      if (!conversation || !sourceTurn || !sourceTurn.prompt.trim()) {
        return;
      }

      const now = new Date().toISOString();
      const nextTurnId = createId();
      const count = Math.max(1, sourceTurn.count || sourceTurn.images.length || 1);
      if (!ensureCanQueueImages(count)) {
        return;
      }
      const nextTurn: ImageTurn = {
        id: nextTurnId,
        prompt: sourceTurn.prompt,
        model: sourceTurn.model,
        mode: sourceTurn.referenceImages.length > 0 ? "edit" : sourceTurn.mode,
        referenceImages: sourceTurn.referenceImages,
        referenceImageSources: sourceTurn.referenceImageSources,
        count,
        size: sourceTurn.size,
        images: createLoadingImages(nextTurnId, count),
        createdAt: now,
        status: "queued",
      };
      const nextConversation = {
        ...conversation,
        updatedAt: now,
        turns: [...conversation.turns, nextTurn],
      };

      setSelectedConversationId(conversationId);
      await persistConversation(nextConversation);
      void runConversationQueue(conversationId);
      toast.success("已加入重新生成队列");
    },
    [ensureCanQueueImages, runConversationQueue],
  );

  const handleRetryImage = useCallback(
    async (conversationId: string, turnId: string, imageId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) {
        return;
      }

      const now = new Date().toISOString();
      const retryImageId = `${turnId}-${createId()}`;
      if (!ensureCanQueueImages(1)) {
        return;
      }
      const nextConversation = {
        ...conversation,
        updatedAt: now,
        turns: conversation.turns.map((turn) => {
          if (turn.id !== turnId) {
            return turn;
          }
          if (!turn.prompt.trim()) {
            return turn;
          }

          const images = turn.images.map((image) =>
            image.id === imageId
              ? {
                  id: retryImageId,
                  taskId: retryImageId,
                  status: "loading" as const,
                }
              : image,
          );
          const derived = deriveTurnStatus({ ...turn, status: "queued", images });
          return {
            ...turn,
            ...derived,
            images,
          };
        }),
      };

      setSelectedConversationId(conversationId);
      await persistConversation(nextConversation);
      void runConversationQueue(conversationId);
    },
    [ensureCanQueueImages, runConversationQueue],
  );

  useEffect(() => {
    for (const conversation of conversations) {
      if (
        !activeConversationQueueIds.has(conversation.id) &&
        conversation.turns.some(
          (turn) =>
            !turn.resultsDeleted &&
            (turn.status === "queued" || turn.status === "generating") &&
            turn.images.some((image) => image.status === "loading"),
        )
      ) {
        void runConversationQueue(conversation.id);
      }
    }
  }, [conversations, runConversationQueue]);

  const handleSubmit = async () => {
    let prompt = "";
    try {
      prompt = buildEffectivePrompt().trim();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板提示词处理失败");
      return;
    }
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }
    if (!ensureCanQueueImages(parsedCount)) {
      return;
    }

    const hasReferenceImages = referenceImageFiles.length > 0;
    const effectiveImageMode: ImageConversationMode =
      selectedTemplate?.mode === "edit" || hasReferenceImages ? "edit" : "generate";
    const requiresUserOriginal = selectedTemplate?.references.some(
      (reference) => reference.type === "original" && reference.required && !reference.asset_url,
    );
    if (requiresUserOriginal && !referenceImageSources.includes("user")) {
      toast.error("这个模板需要额外上传待处理原图");
      return;
    }
    if (effectiveImageMode === "edit" && referenceImageFiles.length === 0) {
      toast.error("请先上传待处理图片或应用带参考图的模板");
      return;
    }

    const targetConversation = selectedConversationId
      ? conversationsRef.current.find((conversation) => conversation.id === selectedConversationId) ?? null
      : null;
    const now = new Date().toISOString();
    const conversationId = targetConversation?.id ?? createId();
    const turnId = createId();
    const draftTurn: ImageTurn = {
      id: turnId,
      prompt,
      model: "gpt-image-2",
      mode: effectiveImageMode,
      referenceImages: effectiveImageMode === "edit" ? referenceImages : [],
      referenceImageSources: effectiveImageMode === "edit" ? referenceImageSources : [],
      count: parsedCount,
      size: imageSize,
      images: createLoadingImages(turnId, parsedCount),
      createdAt: now,
      status: "queued",
    };

    const baseConversation: ImageConversation = targetConversation
      ? {
          ...targetConversation,
          updatedAt: now,
          turns: [...targetConversation.turns, draftTurn],
        }
      : {
          id: conversationId,
          title: buildConversationTitle(prompt),
          createdAt: now,
          updatedAt: now,
          turns: [draftTurn],
        };

    setSelectedConversationId(conversationId);
    clearComposerInputs();

    await persistConversation(baseConversation);
    void runConversationQueue(conversationId);

    const targetStats = getImageConversationStats(baseConversation);
    if (targetStats.running > 0 || targetStats.queued > 1) {
      toast.success("已加入当前对话队列");
    } else if (!targetConversation) {
      toast.success("已创建新对话并开始处理");
    } else {
      toast.success("已发送到当前对话");
    }
  };

  return (
    <>
      <section className="mx-auto grid h-[calc(100dvh-6.5rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 overflow-hidden px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-5.25rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-sky-100/80 pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
            isLoadingHistory={isLoadingHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={setSelectedConversationId}
            onDeleteConversation={openDeleteConversationConfirm}
            onRenameConversation={handleRenameConversation}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(82dvh,760px)] w-[92vw] max-w-[460px] flex-col overflow-hidden rounded-[32px] border-sky-100/90 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(37,99,235,0.28)] sm:rounded-[36px]">
            <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
              <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <History className="size-5" />
                历史记录
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
              <ImageSidebar
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
                onRenameConversation={handleRenameConversation}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex min-h-0 flex-col gap-2 sm:gap-4">
          <ImageTemplatePicker
            open={isTemplatePickerOpen}
            onOpenChange={setIsTemplatePickerOpen}
            templates={templates}
            selectedTemplateId={selectedTemplateId}
            isLoading={isLoadingTemplates}
            onSelectTemplate={(templateId) => {
              void applyTemplate(templateId);
            }}
            onClearTemplate={() => {
              clearSelectedTemplate();
              setIsTemplatePickerOpen(false);
            }}
          />

          <div className="flex items-center justify-between gap-2 px-1 lg:hidden">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-2xl border-sky-100 bg-white/90 text-slate-700 shadow-sm hover:bg-sky-50"
              onClick={() => setIsHistoryOpen(true)}
            >
              <History className="mr-2 size-4" />
              历史记录 ({conversations.length})
            </Button>
            <Button
              className="h-10 rounded-2xl shadow-sm"
              onClick={handleCreateDraft}
            >
              <Plus className="size-4" />
              新建
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-2xl border-sky-100 bg-white/85 px-3 text-slate-600 shadow-sm hover:bg-sky-50"
              onClick={openClearHistoryConfirm}
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <div
            ref={resultsViewportRef}
            className="hide-scrollbar min-h-0 flex-1 overscroll-contain overflow-y-auto px-1 py-2 sm:px-4 sm:py-4"
          >
            <ImageResults
              selectedConversation={selectedConversation}
              onOpenLightbox={openLightbox}
              onContinueEdit={handleContinueEdit}
              onDeletePrompt={openDeletePromptConfirm}
              onDeleteResults={openDeleteResultsConfirm}
              onReuseTurnConfig={handleReuseTurnConfig}
              onRegenerateTurn={handleRegenerateTurn}
              onRetryImage={handleRetryImage}
              formatConversationTime={formatConversationTime}
            />
          </div>

          <ImageComposer
            prompt={imagePrompt}
            imageCount={imageCount}
            maxImageCount={maxSelectableImageCount}
            imageSize={imageSize}
            availableQuota={availableQuota}
            activeTaskCount={activeTaskCount}
            referenceImages={referenceImages}
            selectedTemplate={selectedTemplate}
            templateFieldValues={templateFieldValues}
            isLoadingTemplates={isLoadingTemplates}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            onPromptChange={setImagePrompt}
            onImageCountChange={(value) => setImageCount(value ? clampImageCount(value, maxSelectableImageCount) : "")}
            onImageSizeChange={setImageSize}
            onSubmit={handleSubmit}
            onPickReferenceImage={() => fileInputRef.current?.click()}
            onReferenceImageChange={handleReferenceImageChange}
            onRemoveReferenceImage={handleRemoveReferenceImage}
            onOpenTemplatePicker={() => setIsTemplatePickerOpen(true)}
            onClearTemplate={clearSelectedTemplate}
            onTemplateFieldValueChange={(key, value) => {
              setTemplateFieldValues((current) => ({ ...current, [key]: value }));
            }}
          />
        </div>
      </section>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
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

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent session={session} />;
}
