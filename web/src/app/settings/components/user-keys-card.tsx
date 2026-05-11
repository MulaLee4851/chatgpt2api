"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, Copy, KeyRound, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createUserKey,
  deleteUserKey,
  fetchUserKeys,
  updateUserKey,
  type UserKey,
  type UserKeyLimits,
  type UserKeyPermissions,
} from "@/lib/api";

type LimitFormState = {
  expiresAtUnlimited: boolean;
  expiresAt: string;
  maxTokensUnlimited: boolean;
  maxTokens: string;
  maxImagesUnlimited: boolean;
  maxImages: string;
};

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function toDateTimeLocalValue(value?: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function createDefaultPermissions(): UserKeyPermissions {
  return { chat: true, image: true };
}

function createDefaultLimitsForm(): LimitFormState {
  return {
    expiresAtUnlimited: true,
    expiresAt: "",
    maxTokensUnlimited: true,
    maxTokens: "",
    maxImagesUnlimited: true,
    maxImages: "",
  };
}

function limitsFormFromItem(item: UserKey): LimitFormState {
  return {
    expiresAtUnlimited: item.limits.expires_at == null,
    expiresAt: toDateTimeLocalValue(item.limits.expires_at),
    maxTokensUnlimited: item.limits.max_tokens == null,
    maxTokens: item.limits.max_tokens == null ? "" : String(item.limits.max_tokens),
    maxImagesUnlimited: item.limits.max_images == null,
    maxImages: item.limits.max_images == null ? "" : String(item.limits.max_images),
  };
}

function buildLimitsPayload(form: LimitFormState): UserKeyLimits {
  let expiresAt: string | null = null;
  if (!form.expiresAtUnlimited) {
    if (!form.expiresAt.trim()) {
      throw new Error("请填写有效期时间，或勾选无限时长");
    }
    const parsed = new Date(form.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("有效期时间格式不正确");
    }
    expiresAt = parsed.toISOString();
  }

  let maxTokens: number | null = null;
  if (!form.maxTokensUnlimited) {
    const normalized = form.maxTokens.trim();
    if (!normalized) {
      throw new Error("请填写 tokens 上限，或勾选无限 tokens");
    }
    maxTokens = Number(normalized);
    if (!Number.isInteger(maxTokens) || maxTokens < 0) {
      throw new Error("tokens 上限必须是大于等于 0 的整数");
    }
  }

  let maxImages: number | null = null;
  if (!form.maxImagesUnlimited) {
    const normalized = form.maxImages.trim();
    if (!normalized) {
      throw new Error("请填写图片次数上限，或勾选无限图片次数");
    }
    maxImages = Number(normalized);
    if (!Number.isInteger(maxImages) || maxImages < 0) {
      throw new Error("图片次数上限必须是大于等于 0 的整数");
    }
  }

  return {
    expires_at: expiresAt,
    max_tokens: maxTokens,
    max_images: maxImages,
  };
}

function permissionsEqual(left: UserKeyPermissions, right: UserKeyPermissions) {
  return left.chat === right.chat && left.image === right.image;
}

function limitsEqual(left: UserKeyLimits, right: UserKeyLimits) {
  return (
    left.expires_at === right.expires_at &&
    left.max_tokens === right.max_tokens &&
    left.max_images === right.max_images
  );
}

function formatPermissions(permissions: UserKeyPermissions) {
  const labels = [];
  if (permissions.chat) {
    labels.push("对话");
  }
  if (permissions.image) {
    labels.push("生图");
  }
  return labels.length > 0 ? labels.join(" / ") : "未开启";
}

function formatExpiration(expiresAt: string | null) {
  if (!expiresAt) {
    return "时长无限";
  }
  const expiresAtDate = new Date(expiresAt);
  if (!Number.isNaN(expiresAtDate.getTime()) && expiresAtDate.getTime() <= Date.now()) {
    return "已过期";
  }
  return `时效至 ${formatDateTime(expiresAt)}`;
}

function formatQuotaLimit(label: string, max: number | null, unlimitedLabel: string) {
  return max == null ? unlimitedLabel : `${label}上限 ${max}`;
}

function formatQuotaUsage(label: string, used: number, max: number | null) {
  if (max == null) {
    return `${label} 已用 ${used}`;
  }
  const normalizedMax = Math.max(0, max);
  const normalizedUsed = Math.max(0, used);
  if (normalizedUsed >= normalizedMax) {
    return `${label} ${normalizedUsed} / ${normalizedMax}（已耗尽）`;
  }
  return `${label} ${normalizedUsed} / ${normalizedMax}（剩余 ${normalizedMax - normalizedUsed}）`;
}

function formatLimits(limits: UserKeyLimits) {
  return [
    formatExpiration(limits.expires_at),
    formatQuotaLimit("Tokens ", limits.max_tokens, "Tokens 无限"),
    formatQuotaLimit("图片", limits.max_images, "图片次数无限"),
  ].join(" · ");
}

function formatUsage(item: UserKey) {
  return [
    formatQuotaUsage("Tokens", item.usage.used_tokens, item.limits.max_tokens),
    formatQuotaUsage("图片", item.usage.used_images, item.limits.max_images),
  ].join(" · ");
}

async function copyText(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("copy failed");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

export function UserKeysCard() {
  const didLoadRef = useRef(false);
  const [items, setItems] = useState<UserKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [createPermissions, setCreatePermissions] = useState<UserKeyPermissions>(createDefaultPermissions);
  const [createLimitsForm, setCreateLimitsForm] = useState<LimitFormState>(createDefaultLimitsForm);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [revealedKey, setRevealedKey] = useState("");
  const [deletingItem, setDeletingItem] = useState<UserKey | null>(null);
  const [editingItem, setEditingItem] = useState<UserKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editPermissions, setEditPermissions] = useState<UserKeyPermissions>(createDefaultPermissions);
  const [editLimitsForm, setEditLimitsForm] = useState<LimitFormState>(createDefaultLimitsForm);

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await fetchUserKeys();
      setItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用户密钥失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void load();
  }, []);

  const handleCreate = async () => {
    if (!createPermissions.chat && !createPermissions.image) {
      toast.error("至少需要开启一种权限");
      return;
    }
    let limits: UserKeyLimits;
    try {
      limits = buildLimitsPayload(createLimitsForm);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "额度配置不正确");
      return;
    }

    setIsCreating(true);
    try {
      const data = await createUserKey({
        name: name.trim(),
        permissions: createPermissions,
        limits,
      });
      setItems(data.items);
      setRevealedKey(data.key);
      setName("");
      setCreatePermissions(createDefaultPermissions());
      setCreateLimitsForm(createDefaultLimitsForm());
      setIsDialogOpen(false);
      toast.success("用户密钥已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建用户密钥失败");
    } finally {
      setIsCreating(false);
    }
  };

  const setItemPending = (id: string, isPending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (isPending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleToggle = async (item: UserKey) => {
    setItemPending(item.id, true);
    try {
      const data = await updateUserKey(item.id, { enabled: !item.enabled });
      setItems(data.items);
      toast.success(item.enabled ? "用户密钥已禁用" : "用户密钥已启用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新用户密钥失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const handleDelete = async () => {
    if (!deletingItem) {
      return;
    }
    const item = deletingItem;
    setItemPending(item.id, true);
    try {
      const data = await deleteUserKey(item.id);
      setItems(data.items);
      setDeletingItem(null);
      toast.success("用户密钥已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除用户密钥失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const openEditDialog = (item: UserKey) => {
    setEditingItem(item);
    setEditName(item.name);
    setEditKey("");
    setEditPermissions(item.permissions);
    setEditLimitsForm(limitsFormFromItem(item));
  };

  const handleEdit = async () => {
    if (!editingItem) {
      return;
    }
    if (!editPermissions.chat && !editPermissions.image) {
      toast.error("至少需要开启一种权限");
      return;
    }
    let limits: UserKeyLimits;
    try {
      limits = buildLimitsPayload(editLimitsForm);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "额度配置不正确");
      return;
    }
    const item = editingItem;
    const trimmedName = editName.trim();
    const trimmedKey = editKey.trim();
    const nameChanged = trimmedName !== item.name;
    const keyChanged = Boolean(trimmedKey);
    const permissionsChanged = !permissionsEqual(editPermissions, item.permissions);
    const limitsChanged = !limitsEqual(limits, item.limits);
    if (!nameChanged && !keyChanged && !permissionsChanged && !limitsChanged) {
      setEditingItem(null);
      return;
    }
    setItemPending(item.id, true);
    try {
      const data = await updateUserKey(item.id, {
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(keyChanged ? { key: trimmedKey } : {}),
        ...(permissionsChanged ? { permissions: editPermissions } : {}),
        ...(limitsChanged ? { limits } : {}),
      });
      setItems(data.items);
      setEditingItem(null);
      setEditKey("");
      toast.success("用户密钥已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新用户密钥失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const handleCopy = async (value: string) => {
    try {
      await copyText(value);
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <>
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-6 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                <KeyRound className="size-5 text-stone-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">用户密钥管理</h2>
                <p className="text-sm text-stone-500">创建普通用户密钥时必须明确配置对话/生图权限，以及时间、tokens、图片次数额度。</p>
              </div>
            </div>
            <Button className="h-9 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => setIsDialogOpen(true)}>
              <Plus className="size-4" />
              创建用户密钥
            </Button>
          </div>

          {revealedKey ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-900">
              <div className="font-medium">新密钥仅展示一次，请立即保存：</div>
              <div className="mt-3 flex flex-col gap-3 rounded-lg border border-emerald-200 bg-white/80 p-3 md:flex-row md:items-center md:justify-between">
                <code className="break-all font-mono text-[13px]">{revealedKey}</code>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-xl border-emerald-200 bg-white px-4 text-emerald-700"
                  onClick={() => void handleCopy(revealedKey)}
                >
                  <Copy className="size-4" />
                  复制
                </Button>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <LoaderCircle className="size-5 animate-spin text-stone-400" />
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl bg-stone-50 px-6 py-10 text-center text-sm text-stone-500">
              暂无普通用户密钥。点击右上角按钮后即可创建并分发给其他人。
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const isPending = pendingIds.has(item.id);
                return (
                  <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white px-4 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-medium text-stone-800">{item.name}</div>
                        <Badge variant={item.enabled ? "success" : "secondary"} className="rounded-md">
                          {item.enabled ? "已启用" : "已禁用"}
                        </Badge>
                        <Badge variant="secondary" className="rounded-md bg-stone-100 text-stone-700">
                          {formatPermissions(item.permissions)}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                        <span>创建时间 {formatDateTime(item.created_at)}</span>
                        <span>最近使用 {formatDateTime(item.last_used_at)}</span>
                      </div>
                      <div className="text-xs leading-5 text-stone-500">{formatLimits(item.limits)}</div>
                      <div className="text-xs leading-5 text-stone-500">{formatUsage(item)}</div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={() => openEditDialog(item)}
                        disabled={isPending}
                      >
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />}
                        编辑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={() => void handleToggle(item)}
                        disabled={isPending}
                      >
                        {isPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : item.enabled ? (
                          <Ban className="size-4" />
                        ) : (
                          <CheckCircle2 className="size-4" />
                        )}
                        {item.enabled ? "禁用" : "启用"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-rose-200 bg-white px-4 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                        onClick={() => setDeletingItem(item)}
                        disabled={isPending}
                      >
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="rounded-2xl p-6 sm:max-w-2xl">
          <DialogHeader className="gap-2">
            <DialogTitle>创建用户密钥</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              创建时必须同时配置权限和额度；无限时长、无限 tokens、无限图片次数都需要显式勾选。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">名称（可选）</label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：设计同学 A、运营临时账号"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>

            <div className="space-y-3 rounded-2xl border border-stone-200 p-4">
              <div className="text-sm font-medium text-stone-800">权限</div>
              <label className="flex items-center gap-3 text-sm text-stone-700">
                <Checkbox checked={createPermissions.chat} onCheckedChange={(checked) => setCreatePermissions((current) => ({ ...current, chat: Boolean(checked) }))} />
                开启对话权限
              </label>
              <label className="flex items-center gap-3 text-sm text-stone-700">
                <Checkbox checked={createPermissions.image} onCheckedChange={(checked) => setCreatePermissions((current) => ({ ...current, image: Boolean(checked) }))} />
                开启生图权限
              </label>
            </div>

            <div className="space-y-4 rounded-2xl border border-stone-200 p-4">
              <div className="text-sm font-medium text-stone-800">额度</div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm font-medium text-stone-700">有效期</label>
                  <label className="flex items-center gap-2 text-sm text-stone-600">
                    <Checkbox checked={createLimitsForm.expiresAtUnlimited} onCheckedChange={(checked) => setCreateLimitsForm((current) => ({ ...current, expiresAtUnlimited: Boolean(checked) }))} />
                    无限时长
                  </label>
                </div>
                <Input
                  type="datetime-local"
                  value={createLimitsForm.expiresAt}
                  onChange={(event) => setCreateLimitsForm((current) => ({ ...current, expiresAt: event.target.value }))}
                  disabled={createLimitsForm.expiresAtUnlimited}
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm font-medium text-stone-700">Tokens 上限</label>
                  <label className="flex items-center gap-2 text-sm text-stone-600">
                    <Checkbox checked={createLimitsForm.maxTokensUnlimited} onCheckedChange={(checked) => setCreateLimitsForm((current) => ({ ...current, maxTokensUnlimited: Boolean(checked) }))} />
                    无限 Tokens
                  </label>
                </div>
                <Input
                  type="number"
                  min="0"
                  value={createLimitsForm.maxTokens}
                  onChange={(event) => setCreateLimitsForm((current) => ({ ...current, maxTokens: event.target.value }))}
                  disabled={createLimitsForm.maxTokensUnlimited}
                  placeholder="例如：200000"
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm font-medium text-stone-700">图片生成次数上限</label>
                  <label className="flex items-center gap-2 text-sm text-stone-600">
                    <Checkbox checked={createLimitsForm.maxImagesUnlimited} onCheckedChange={(checked) => setCreateLimitsForm((current) => ({ ...current, maxImagesUnlimited: Boolean(checked) }))} />
                    无限图片次数
                  </label>
                </div>
                <Input
                  type="number"
                  min="0"
                  value={createLimitsForm.maxImages}
                  onChange={(event) => setCreateLimitsForm((current) => ({ ...current, maxImages: event.target.value }))}
                  disabled={createLimitsForm.maxImagesUnlimited}
                  placeholder="例如：100"
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setIsDialogOpen(false)}
              disabled={isCreating}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleCreate()}
              disabled={isCreating}
            >
              {isCreating ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingItem)} onOpenChange={(open) => (!open ? setDeletingItem(null) : null)}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>删除用户密钥</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              确认删除用户密钥「{deletingItem?.name}」吗？删除后该密钥将无法继续调用接口。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setDeletingItem(null)}
              disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-rose-600 px-5 text-white hover:bg-rose-700"
              onClick={() => void handleDelete()}
              disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}
            >
              {deletingItem && pendingIds.has(deletingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editingItem)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingItem(null);
            setEditKey("");
          }
        }}
      >
        <DialogContent className="rounded-2xl p-6 sm:max-w-2xl">
          <DialogHeader className="gap-2">
            <DialogTitle>编辑用户密钥</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              可以修改名称、权限、额度和原始密钥；留空则保持当前密钥不变。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">名称</label>
              <Input
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                placeholder="例如：设计同学 A、运营临时账号"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">新的专用密钥（可选）</label>
              <Input
                value={editKey}
                onChange={(event) => setEditKey(event.target.value)}
                placeholder="例如：sk-your-custom-user-key"
                className="h-11 rounded-xl border-stone-200 bg-white font-mono"
              />
              <p className="text-xs leading-5 text-stone-500">
                保存后旧密钥会立即失效，新密钥生效。系统仍只保存哈希，不会回显当前密钥。
              </p>
            </div>

            <div className="space-y-3 rounded-2xl border border-stone-200 p-4">
              <div className="text-sm font-medium text-stone-800">权限</div>
              <label className="flex items-center gap-3 text-sm text-stone-700">
                <Checkbox checked={editPermissions.chat} onCheckedChange={(checked) => setEditPermissions((current) => ({ ...current, chat: Boolean(checked) }))} />
                开启对话权限
              </label>
              <label className="flex items-center gap-3 text-sm text-stone-700">
                <Checkbox checked={editPermissions.image} onCheckedChange={(checked) => setEditPermissions((current) => ({ ...current, image: Boolean(checked) }))} />
                开启生图权限
              </label>
            </div>

            <div className="space-y-4 rounded-2xl border border-stone-200 p-4">
              <div className="text-sm font-medium text-stone-800">额度</div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm font-medium text-stone-700">有效期</label>
                  <label className="flex items-center gap-2 text-sm text-stone-600">
                    <Checkbox checked={editLimitsForm.expiresAtUnlimited} onCheckedChange={(checked) => setEditLimitsForm((current) => ({ ...current, expiresAtUnlimited: Boolean(checked) }))} />
                    无限时长
                  </label>
                </div>
                <Input
                  type="datetime-local"
                  value={editLimitsForm.expiresAt}
                  onChange={(event) => setEditLimitsForm((current) => ({ ...current, expiresAt: event.target.value }))}
                  disabled={editLimitsForm.expiresAtUnlimited}
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm font-medium text-stone-700">Tokens 上限</label>
                  <label className="flex items-center gap-2 text-sm text-stone-600">
                    <Checkbox checked={editLimitsForm.maxTokensUnlimited} onCheckedChange={(checked) => setEditLimitsForm((current) => ({ ...current, maxTokensUnlimited: Boolean(checked) }))} />
                    无限 Tokens
                  </label>
                </div>
                <Input
                  type="number"
                  min="0"
                  value={editLimitsForm.maxTokens}
                  onChange={(event) => setEditLimitsForm((current) => ({ ...current, maxTokens: event.target.value }))}
                  disabled={editLimitsForm.maxTokensUnlimited}
                  placeholder="例如：200000"
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm font-medium text-stone-700">图片生成次数上限</label>
                  <label className="flex items-center gap-2 text-sm text-stone-600">
                    <Checkbox checked={editLimitsForm.maxImagesUnlimited} onCheckedChange={(checked) => setEditLimitsForm((current) => ({ ...current, maxImagesUnlimited: Boolean(checked) }))} />
                    无限图片次数
                  </label>
                </div>
                <Input
                  type="number"
                  min="0"
                  value={editLimitsForm.maxImages}
                  onChange={(event) => setEditLimitsForm((current) => ({ ...current, maxImages: event.target.value }))}
                  disabled={editLimitsForm.maxImagesUnlimited}
                  placeholder="例如：100"
                  className="h-11 rounded-xl border-stone-200 bg-white"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => {
                setEditingItem(null);
                setEditKey("");
              }}
              disabled={editingItem ? pendingIds.has(editingItem.id) : false}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleEdit()}
              disabled={editingItem ? pendingIds.has(editingItem.id) : false}
            >
              {editingItem && pendingIds.has(editingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
