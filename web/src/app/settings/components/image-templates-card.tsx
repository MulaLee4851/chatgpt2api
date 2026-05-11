"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createImageTemplate,
  deleteImageTemplate,
  deleteImageTemplateAsset,
  deleteImageTemplateReferenceAsset,
  fetchImageTemplates,
  updateImageTemplate,
  uploadImageTemplateAsset,
  uploadImageTemplateReferenceAsset,
  type ImageTemplate,
  type ImageTemplatePayload,
  type ImageTemplatePlaceholder,
  type ImageTemplateReference,
} from "@/lib/api";

type TemplateFormState = ImageTemplatePayload;

type AssetTarget =
  | { id: string; kind: "cover" }
  | { id: string; kind: "reference"; referenceKey: string };

const IMAGE_SIZE_OPTIONS = [
  { value: "", label: "未指定" },
  { value: "1:1", label: "1:1 (正方形)" },
  { value: "16:9", label: "16:9 (横版)" },
  { value: "4:3", label: "4:3 (横版)" },
  { value: "3:4", label: "3:4 (竖版)" },
  { value: "9:16", label: "9:16 (竖版)" },
];

function createPlaceholder(index: number): ImageTemplatePlaceholder {
  return {
    key: `field_${index + 1}`,
    label: `变量 ${index + 1}`,
    type: "text",
    default_value: "",
    required: false,
    help: "",
    validation: {},
  };
}

function createReference(index: number): ImageTemplateReference {
  return {
    key: `reference_${index + 1}`,
    label: `参考图 ${index + 1}`,
    type: index === 0 ? "original" : "reference",
    required: index === 0,
    weight: 1,
    help: "",
    asset_rel: null,
    asset_url: null,
  };
}

function createDefaultForm(): TemplateFormState {
  return {
    name: "",
    description: "",
    mode: "generate",
    prompts: {
      positive: "",
      negative: "",
    },
    defaults: {
      count: 1,
      size: "",
    },
    placeholders: [],
    references: [],
    tags: [],
    status: "active",
    version: "1.0.0",
  };
}

function formFromTemplate(template: ImageTemplate): TemplateFormState {
  return {
    name: template.name,
    description: template.description,
    mode: template.mode,
    prompts: {
      positive: template.prompts.positive,
      negative: template.prompts.negative,
    },
    defaults: {
      count: template.defaults.count,
      size: template.defaults.size,
    },
    placeholders: template.placeholders.map((placeholder) => ({
      key: placeholder.key,
      label: placeholder.label,
      type: placeholder.type,
      default_value: placeholder.default_value,
      required: placeholder.required,
      help: placeholder.help,
      validation: {
        min_length: placeholder.validation.min_length ?? null,
        max_length: placeholder.validation.max_length ?? null,
        min: placeholder.validation.min ?? null,
        max: placeholder.validation.max ?? null,
        regex: placeholder.validation.regex || "",
        options: placeholder.validation.options || [],
      },
    })),
    references: template.references.map((reference) => ({
      key: reference.key,
      label: reference.label,
      type: reference.type,
      required: reference.required,
      weight: reference.weight,
      help: reference.help,
      asset_rel: reference.asset_rel,
      asset_url: reference.asset_url || null,
    })),
    tags: [...template.tags],
    status: template.status,
    version: template.version,
  };
}

function describeTemplate(template: ImageTemplate) {
  const flags = [template.mode === "edit" ? "图生图" : "文生图", `状态 ${template.status}`, `v${template.version}`];
  if (template.tags.length > 0) {
    flags.push(template.tags.join(" / "));
  }
  if (template.prompts.negative) {
    flags.push("含负向提示词");
  }
  if (template.placeholders.length > 0) {
    flags.push(`${template.placeholders.length} 个变量`);
  }
  if (template.references.length > 0) {
    flags.push(`${template.references.length} 个引用槽位`);
  }
  return flags.join(" · ");
}

function splitTags(value: string) {
  return value
    .replace(/，/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ImageTemplatesCard() {
  const assetInputRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ImageTemplate | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<AssetTarget | null>(null);
  const [pendingAssetTarget, setPendingAssetTarget] = useState<AssetTarget | null>(null);
  const [tagsText, setTagsText] = useState("");
  const [form, setForm] = useState<TemplateFormState>(createDefaultForm());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const data = await fetchImageTemplates();
        if (!cancelled) {
          setTemplates(data.items);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "加载模板失败");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedTemplates = useMemo(() => [...templates].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [templates]);

  const openCreateDialog = () => {
    setEditingTemplate(null);
    setForm(createDefaultForm());
    setTagsText("");
    setIsDialogOpen(true);
  };

  const openEditDialog = (template: ImageTemplate) => {
    setEditingTemplate(template);
    setForm(formFromTemplate(template));
    setTagsText(template.tags.join(", "));
    setIsDialogOpen(true);
  };

  const updatePlaceholder = (index: number, updater: (current: ImageTemplatePlaceholder) => ImageTemplatePlaceholder) => {
    setForm((current) => ({
      ...current,
      placeholders: current.placeholders.map((placeholder, currentIndex) => (currentIndex === index ? updater(placeholder) : placeholder)),
    }));
  };

  const updateReference = (index: number, updater: (current: ImageTemplateReference) => ImageTemplateReference) => {
    setForm((current) => ({
      ...current,
      references: current.references.map((reference, currentIndex) => (currentIndex === index ? updater(reference) : reference)),
    }));
  };

  const handleSave = async () => {
    const name = form.name.trim();
    const positivePrompt = form.prompts.positive.trim();
    if (!name) {
      toast.error("请输入模板名称");
      return;
    }
    if (!positivePrompt) {
      toast.error("请输入正向提示词");
      return;
    }

    const placeholders = form.placeholders.map((placeholder) => ({
      ...placeholder,
      key: placeholder.key.trim(),
      label: placeholder.label.trim(),
      default_value: placeholder.default_value.trim(),
      help: placeholder.help.trim(),
      validation: {
        min_length: placeholder.validation.min_length ?? null,
        max_length: placeholder.validation.max_length ?? null,
        min: placeholder.validation.min ?? null,
        max: placeholder.validation.max ?? null,
        regex: placeholder.validation.regex?.trim() || "",
        options: placeholder.type === "select" ? (placeholder.validation.options || []).map((item) => item.trim()).filter(Boolean) : [],
      },
    }));
    if (placeholders.some((placeholder) => !placeholder.key)) {
      toast.error("变量 key 不能为空");
      return;
    }
    for (const placeholder of placeholders) {
      if (!positivePrompt.includes(`{{${placeholder.key}}}`)) {
        toast.error(`正向提示词缺少变量占位符 {{${placeholder.key}}}`);
        return;
      }
      if (placeholder.type === "select" && (!placeholder.validation.options || placeholder.validation.options.length === 0)) {
        toast.error(`变量 ${placeholder.label || placeholder.key} 需要至少一个选项`);
        return;
      }
    }

    const references = form.references.map((reference) => ({
      ...reference,
      key: reference.key.trim(),
      label: reference.label.trim(),
      help: reference.help.trim(),
      asset_rel: reference.asset_rel || null,
      asset_url: reference.asset_url || null,
    }));
    if (references.some((reference) => !reference.key)) {
      toast.error("引用槽位 key 不能为空");
      return;
    }

    setIsSaving(true);
    try {
      const payload: ImageTemplatePayload = {
        name,
        description: form.description.trim(),
        mode: form.mode,
        prompts: {
          positive: positivePrompt,
          negative: form.prompts.negative.trim(),
        },
        defaults: {
          count: Math.max(1, Math.min(100, Math.floor(Number(form.defaults.count) || 1))),
          size: form.defaults.size,
        },
        placeholders,
        references,
        tags: splitTags(tagsText),
        status: form.status,
        version: form.version.trim() || "1.0.0",
      };
      const data = editingTemplate
        ? await updateImageTemplate(editingTemplate.id, payload)
        : await createImageTemplate(payload);
      setTemplates(data.items);
      setIsDialogOpen(false);
      toast.success(editingTemplate ? "模板已更新" : "模板已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存模板失败");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (template: ImageTemplate) => {
    setDeletingId(template.id);
    try {
      const data = await deleteImageTemplate(template.id);
      setTemplates(data.items);
      toast.success("模板已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除模板失败");
    } finally {
      setDeletingId(null);
    }
  };

  const handleAssetUpload = async (file: File) => {
    if (!pendingAssetTarget) {
      return;
    }
    setUploading(pendingAssetTarget);
    try {
      const data = pendingAssetTarget.kind === "cover"
        ? await uploadImageTemplateAsset(pendingAssetTarget.id, "cover", file)
        : await uploadImageTemplateReferenceAsset(pendingAssetTarget.id, pendingAssetTarget.referenceKey, file);
      setTemplates((current) => current.map((item) => (item.id === data.item.id ? data.item : item)));
      toast.success(pendingAssetTarget.kind === "cover" ? "封面已更新" : "引用图片已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传模板图片失败");
    } finally {
      setUploading(null);
      setPendingAssetTarget(null);
      if (assetInputRef.current) {
        assetInputRef.current.value = "";
      }
    }
  };

  const handleDeleteCover = async (template: ImageTemplate) => {
    setUploading({ id: template.id, kind: "cover" });
    try {
      const data = await deleteImageTemplateAsset(template.id, "cover");
      setTemplates((current) => current.map((item) => (item.id === data.item.id ? data.item : item)));
      toast.success("封面已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除封面失败");
    } finally {
      setUploading(null);
    }
  };

  const handleDeleteReferenceAsset = async (templateId: string, referenceKey: string) => {
    setUploading({ id: templateId, kind: "reference", referenceKey });
    try {
      const data = await deleteImageTemplateReferenceAsset(templateId, referenceKey);
      setTemplates((current) => current.map((item) => (item.id === data.item.id ? data.item : item)));
      toast.success("引用图片已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除引用图片失败");
    } finally {
      setUploading(null);
    }
  };

  return (
    <>
      <input
        ref={assetInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void handleAssetUpload(file);
          }
        }}
      />

      <Card className="rounded-3xl border-stone-200/80 bg-white/95 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.35)]">
        <CardContent className="space-y-5 p-6 sm:p-7">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight text-stone-950">生图模板管理</h2>
              <p className="text-sm leading-6 text-stone-500">维护正负提示词、变量、引用图片、封面和模板元信息，模板资产会单独存放，不走普通图片删除链路。</p>
            </div>
            <Button className="rounded-2xl bg-stone-950 text-white hover:bg-stone-800" onClick={openCreateDialog}>
              <Plus className="mr-2 size-4" />新增模板
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 rounded-2xl border border-dashed border-stone-200 px-4 py-6 text-sm text-stone-500">
              <LoaderCircle className="size-4 animate-spin" />加载模板中
            </div>
          ) : sortedTemplates.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-stone-200 px-4 py-6 text-sm text-stone-500">还没有模板，先创建一个可复用的生图配置。</div>
          ) : (
            <div className="space-y-3">
              {sortedTemplates.map((template) => {
                const busy = deletingId === template.id || uploading?.id === template.id;
                return (
                  <div key={template.id} className="rounded-3xl border border-stone-200/80 bg-stone-50/70 p-4 sm:p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1 space-y-3">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-stone-200 bg-white text-xs text-stone-400">
                            {template.cover_image_url ? <img src={template.cover_image_url} alt={`${template.name} 封面`} className="h-full w-full object-cover" /> : "无封面"}
                          </div>
                          <div className="min-w-0 flex-1 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-base font-semibold text-stone-950">{template.name}</h3>
                              <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-stone-600">{describeTemplate(template)}</span>
                            </div>
                            {template.description ? <p className="text-sm leading-6 text-stone-500">{template.description}</p> : null}
                            {template.tags.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {template.tags.map((tag) => (
                                  <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs text-stone-600">
                                    <Tag className="size-3" />{tag}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <div className="rounded-2xl bg-white/90 px-3 py-3 text-sm leading-6 text-stone-700 whitespace-pre-wrap">
                              {template.prompts.positive}
                              {template.prompts.negative ? `\n\nNegative prompt: ${template.prompts.negative}` : ""}
                            </div>
                          </div>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                          <div className="rounded-2xl bg-white/70 px-3 py-3 text-sm text-stone-600">
                            <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-400">变量</div>
                            {template.placeholders.length === 0 ? (
                              <div>无动态变量</div>
                            ) : (
                              <div className="space-y-2">
                                {template.placeholders.map((placeholder) => (
                                  <div key={placeholder.key} className="rounded-xl border border-stone-200 bg-white px-3 py-2">
                                    <div className="font-medium text-stone-800">{placeholder.label} <span className="text-stone-400">({placeholder.key})</span></div>
                                    <div className="text-xs text-stone-500">{placeholder.type}{placeholder.required ? " · 必填" : " · 可选"}{placeholder.help ? ` · ${placeholder.help}` : ""}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="rounded-2xl bg-white/70 px-3 py-3 text-sm text-stone-600">
                            <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-stone-400">引用图片</div>
                            {template.references.length === 0 ? (
                              <div>无引用槽位</div>
                            ) : (
                              <div className="space-y-3">
                                {template.references.map((reference) => {
                                  const isUploadingReference = uploading?.id === template.id && uploading.kind === "reference" && uploading.referenceKey === reference.key;
                                  return (
                                    <div key={reference.key} className="rounded-xl border border-stone-200 bg-white px-3 py-3">
                                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="flex items-center gap-3">
                                          <div className="flex size-14 items-center justify-center overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 text-[10px] text-stone-400">
                                            {reference.asset_url ? <img src={reference.asset_url} alt={`${template.name} ${reference.label}`} className="h-full w-full object-cover" /> : "未上传"}
                                          </div>
                                          <div>
                                            <div className="font-medium text-stone-800">{reference.label}</div>
                                            <div className="text-xs text-stone-500">{reference.type === "original" ? "原图槽位" : "参考图槽位"} · 权重 {reference.weight}{reference.required ? " · 必填" : ""}</div>
                                            {reference.help ? <div className="text-xs text-stone-500">{reference.help}</div> : null}
                                          </div>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <Button
                                            type="button"
                                            variant="outline"
                                            className="rounded-xl"
                                            disabled={busy}
                                            onClick={() => {
                                              setPendingAssetTarget({ id: template.id, kind: "reference", referenceKey: reference.key });
                                              assetInputRef.current?.click();
                                            }}
                                          >
                                            <ImagePlus className="mr-2 size-4" />上传图片
                                          </Button>
                                          {reference.asset_url ? (
                                            <Button
                                              type="button"
                                              variant="outline"
                                              className="rounded-xl text-rose-600"
                                              disabled={busy || isUploadingReference}
                                              onClick={() => void handleDeleteReferenceAsset(template.id, reference.key)}
                                            >
                                              删除
                                            </Button>
                                          ) : null}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="rounded-xl"
                            disabled={busy}
                            onClick={() => {
                              setPendingAssetTarget({ id: template.id, kind: "cover" });
                              assetInputRef.current?.click();
                            }}
                          >
                            <ImagePlus className="mr-2 size-4" />上传封面
                          </Button>
                          {template.cover_image_url ? (
                            <Button type="button" variant="outline" className="rounded-xl text-rose-600" disabled={busy} onClick={() => void handleDeleteCover(template)}>
                              删除封面
                            </Button>
                          ) : null}
                        </div>

                        <div className="text-xs text-stone-400">创建人 {template.created_by || "--"} · 修改人 {template.updated_by || "--"} · 更新时间 {template.updated_at}</div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <Button type="button" variant="outline" className="rounded-xl" onClick={() => openEditDialog(template)} disabled={busy}>
                          <Pencil className="mr-2 size-4" />编辑
                        </Button>
                        <Button type="button" variant="outline" className="rounded-xl text-rose-600" disabled={busy} onClick={() => void handleDelete(template)}>
                          {deletingId === template.id ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Trash2 className="mr-2 size-4" />}删除
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[28px] border-white/80 bg-white p-0 sm:max-w-5xl">
          <DialogHeader className="px-6 pt-6 sm:px-7">
            <DialogTitle>{editingTemplate ? "编辑生图模板" : "新建生图模板"}</DialogTitle>
            <DialogDescription>维护模板的正负提示词、变量、引用图片槽位和基础元信息。图片资产保存后可单独上传。</DialogDescription>
          </DialogHeader>

          <div className="space-y-6 px-6 pb-2 sm:px-7">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">模板名称</label>
                <Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">模板模式</label>
                <Select value={form.mode} onValueChange={(value) => setForm((current) => ({ ...current, mode: value as "generate" | "edit" }))}>
                  <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="generate">文生图</SelectItem>
                    <SelectItem value="edit">图生图</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <label className="text-sm font-medium text-stone-700">模板描述</label>
                <Input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">状态</label>
                <Select value={form.status} onValueChange={(value) => setForm((current) => ({ ...current, status: value as "active" | "draft" | "archived" }))}>
                  <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">启用</SelectItem>
                    <SelectItem value="draft">草稿</SelectItem>
                    <SelectItem value="archived">归档</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">版本</label>
                <Input value={form.version} onChange={(event) => setForm((current) => ({ ...current, version: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="1.0.0" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <label className="text-sm font-medium text-stone-700">标签</label>
                <Input value={tagsText} onChange={(event) => setTagsText(event.target.value)} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="例如：电商, 产品图, 写实" />
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">正向 Prompt</label>
                <Textarea value={form.prompts.positive} onChange={(event) => setForm((current) => ({ ...current, prompts: { ...current.prompts, positive: event.target.value } }))} className="min-h-[180px] rounded-2xl border-stone-200 bg-white" placeholder="可包含 {{variable_key}} 占位符" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">负向 Prompt</label>
                <Textarea value={form.prompts.negative} onChange={(event) => setForm((current) => ({ ...current, prompts: { ...current.prompts, negative: event.target.value } }))} className="min-h-[180px] rounded-2xl border-stone-200 bg-white" placeholder="可选，用于限制不希望出现的内容" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">默认张数</label>
                <Input type="number" min="1" max="100" value={String(form.defaults.count)} onChange={(event) => setForm((current) => ({ ...current, defaults: { ...current.defaults, count: Math.max(1, Math.min(100, Number(event.target.value) || 1)) } }))} className="h-11 rounded-xl border-stone-200 bg-white" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-stone-700">默认比例</label>
                <Select value={form.defaults.size || "__empty__"} onValueChange={(value) => setForm((current) => ({ ...current, defaults: { ...current.defaults, size: value === "__empty__" ? "" : value } }))}>
                  <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {IMAGE_SIZE_OPTIONS.map((option) => (
                      <SelectItem key={option.label} value={option.value || "__empty__"}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-stone-900">变量配置</h3>
                  <p className="text-xs text-stone-500">变量 key 会对应正向 Prompt 里的 {"{{key}}"} 占位符。</p>
                </div>
                <Button type="button" variant="outline" className="rounded-xl" onClick={() => setForm((current) => ({ ...current, placeholders: [...current.placeholders, createPlaceholder(current.placeholders.length)] }))}>
                  <Plus className="mr-2 size-4" />新增变量
                </Button>
              </div>
              <div className="space-y-3">
                {form.placeholders.length === 0 ? <div className="rounded-2xl border border-dashed border-stone-200 px-4 py-4 text-sm text-stone-500">暂无变量，模板会作为固定 prompt 使用。</div> : null}
                {form.placeholders.map((placeholder, index) => (
                  <div key={`${placeholder.key}-${index}`} className="rounded-2xl border border-stone-200 bg-stone-50/70 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-stone-800">变量 {index + 1}</div>
                      <Button type="button" variant="outline" className="rounded-xl text-rose-600" onClick={() => setForm((current) => ({ ...current, placeholders: current.placeholders.filter((_, currentIndex) => currentIndex !== index) }))}>
                        <X className="mr-2 size-4" />移除
                      </Button>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      <Input value={placeholder.key} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, key: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="key，例如 product_name" />
                      <Input value={placeholder.label} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, label: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="显示名，例如 产品名" />
                      <Select value={placeholder.type} onValueChange={(value) => updatePlaceholder(index, (current) => ({ ...current, type: value as ImageTemplatePlaceholder["type"], validation: value === "select" ? { ...current.validation, options: current.validation.options || [""] } : current.validation }))}>
                        <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">单行文本</SelectItem>
                          <SelectItem value="textarea">多行文本</SelectItem>
                          <SelectItem value="number">数字</SelectItem>
                          <SelectItem value="select">下拉选项</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input value={placeholder.default_value} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, default_value: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="默认值" />
                      <Input value={placeholder.help} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, help: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white lg:col-span-2" placeholder="填写提示文案" />
                      {placeholder.type === "select" ? (
                        <Input value={(placeholder.validation.options || []).join(", ")} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, validation: { ...current.validation, options: splitTags(event.target.value) } }))} className="h-11 rounded-xl border-stone-200 bg-white lg:col-span-2" placeholder="下拉选项，用逗号分隔" />
                      ) : null}
                      {placeholder.type === "number" ? (
                        <>
                          <Input type="number" value={placeholder.validation.min ?? ""} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, validation: { ...current.validation, min: event.target.value ? Number(event.target.value) : null } }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="最小值" />
                          <Input type="number" value={placeholder.validation.max ?? ""} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, validation: { ...current.validation, max: event.target.value ? Number(event.target.value) : null } }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="最大值" />
                        </>
                      ) : (
                        <>
                          <Input type="number" value={placeholder.validation.min_length ?? ""} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, validation: { ...current.validation, min_length: event.target.value ? Number(event.target.value) : null } }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="最短长度" />
                          <Input type="number" value={placeholder.validation.max_length ?? ""} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, validation: { ...current.validation, max_length: event.target.value ? Number(event.target.value) : null } }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="最长长度" />
                        </>
                      )}
                      <Input value={placeholder.validation.regex || ""} onChange={(event) => updatePlaceholder(index, (current) => ({ ...current, validation: { ...current.validation, regex: event.target.value } }))} className="h-11 rounded-xl border-stone-200 bg-white lg:col-span-2" placeholder="可选：正则校验" />
                    </div>
                    <label className="mt-3 flex items-center gap-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
                      <Checkbox checked={placeholder.required} onCheckedChange={(checked) => updatePlaceholder(index, (current) => ({ ...current, required: Boolean(checked) }))} />
                      这个变量必填
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-stone-900">引用图片槽位</h3>
                  <p className="text-xs text-stone-500">支持模板自带参考图，也支持要求用户补充上传原图/参考图。</p>
                </div>
                <Button type="button" variant="outline" className="rounded-xl" onClick={() => setForm((current) => ({ ...current, references: [...current.references, createReference(current.references.length)] }))}>
                  <Plus className="mr-2 size-4" />新增槽位
                </Button>
              </div>
              <div className="space-y-3">
                {form.references.length === 0 ? <div className="rounded-2xl border border-dashed border-stone-200 px-4 py-4 text-sm text-stone-500">暂无引用图片槽位。</div> : null}
                {form.references.map((reference, index) => (
                  <div key={`${reference.key}-${index}`} className="rounded-2xl border border-stone-200 bg-stone-50/70 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-stone-800">槽位 {index + 1}</div>
                      <Button type="button" variant="outline" className="rounded-xl text-rose-600" onClick={() => setForm((current) => ({ ...current, references: current.references.filter((_, currentIndex) => currentIndex !== index) }))}>
                        <X className="mr-2 size-4" />移除
                      </Button>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      <Input value={reference.key} onChange={(event) => updateReference(index, (current) => ({ ...current, key: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="key，例如 source-image" />
                      <Input value={reference.label} onChange={(event) => updateReference(index, (current) => ({ ...current, label: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="显示名，例如 待处理原图" />
                      <Select value={reference.type} onValueChange={(value) => updateReference(index, (current) => ({ ...current, type: value as ImageTemplateReference["type"] }))}>
                        <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="reference">参考图</SelectItem>
                          <SelectItem value="original">原图</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input type="number" min="0" max="2" step="0.1" value={String(reference.weight)} onChange={(event) => updateReference(index, (current) => ({ ...current, weight: Math.max(0, Math.min(2, Number(event.target.value) || 0)) }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="权重" />
                      <Input value={reference.help} onChange={(event) => updateReference(index, (current) => ({ ...current, help: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white lg:col-span-2" placeholder="槽位说明" />
                    </div>
                    <label className="mt-3 flex items-center gap-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
                      <Checkbox checked={reference.required} onCheckedChange={(checked) => updateReference(index, (current) => ({ ...current, required: Boolean(checked) }))} />
                      这个图片槽位必填
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {editingTemplate ? (
              <div className="rounded-2xl border border-stone-200 bg-stone-50/70 px-4 py-3 text-sm text-stone-600">
                创建人 {editingTemplate.created_by || "--"} · 修改人 {editingTemplate.updated_by || "--"} · 创建时间 {editingTemplate.created_at}
              </div>
            ) : null}
          </div>

          <DialogFooter className="px-6 pb-6 sm:px-7">
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>取消</Button>
            <Button className="bg-stone-950 text-white hover:bg-stone-800" onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              保存模板
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
