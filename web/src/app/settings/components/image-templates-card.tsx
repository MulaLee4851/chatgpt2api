"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
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
  fetchImageTemplates,
  updateImageTemplate,
  uploadImageTemplateAsset,
  type ImageTemplate,
  type ImageTemplatePayload,
} from "@/lib/api";

type TemplateFormState = ImageTemplatePayload;

const IMAGE_SIZE_OPTIONS = [
  { value: "", label: "未指定" },
  { value: "1:1", label: "1:1 (正方形)" },
  { value: "16:9", label: "16:9 (横版)" },
  { value: "4:3", label: "4:3 (横版)" },
  { value: "3:4", label: "3:4 (竖版)" },
  { value: "9:16", label: "9:16 (竖版)" },
];

function createDefaultForm(): TemplateFormState {
  return {
    name: "",
    description: "",
    mode: "generate",
    prompt_template: "",
    default_count: 1,
    default_size: "",
    requires_placeholder: false,
    placeholder_token: "{{prompt}}",
    requires_user_source_image: false,
    enabled: true,
  };
}

function formFromTemplate(template: ImageTemplate): TemplateFormState {
  return {
    name: template.name,
    description: template.description,
    mode: template.mode,
    prompt_template: template.prompt_template,
    default_count: template.default_count,
    default_size: template.default_size,
    requires_placeholder: template.requires_placeholder,
    placeholder_token: template.placeholder_token,
    requires_user_source_image: template.requires_user_source_image,
    enabled: template.enabled,
  };
}

function describeTemplate(template: ImageTemplate) {
  const flags = [template.mode === "edit" ? "图生图" : "文生图"];
  if (template.requires_placeholder) {
    flags.push(`占位 ${template.placeholder_token}`);
  }
  if (template.requires_user_source_image) {
    flags.push("需上传原图");
  }
  flags.push(`默认 ${template.default_count} 张`);
  if (template.default_size) {
    flags.push(template.default_size);
  }
  if (!template.enabled) {
    flags.push("已停用");
  }
  return flags.join(" · ");
}

export function ImageTemplatesCard() {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const originalInputRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ImageTemplate | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ id: string; kind: "reference" | "original" } | null>(null);
  const [pendingAssetTarget, setPendingAssetTarget] = useState<{ id: string; kind: "reference" | "original" } | null>(null);
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

  const openCreateDialog = () => {
    setEditingTemplate(null);
    setForm(createDefaultForm());
    setIsDialogOpen(true);
  };

  const openEditDialog = (template: ImageTemplate) => {
    setEditingTemplate(template);
    setForm(formFromTemplate(template));
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    const name = form.name.trim();
    const promptTemplate = form.prompt_template.trim();
    const placeholderToken = form.placeholder_token.trim() || "{{prompt}}";
    if (!name) {
      toast.error("请输入模板名称");
      return;
    }
    if (!promptTemplate) {
      toast.error("请输入模板提示词");
      return;
    }
    if (form.requires_placeholder && !promptTemplate.includes(placeholderToken)) {
      toast.error("提示词里缺少占位符");
      return;
    }

    setIsSaving(true);
    try {
      const payload: ImageTemplatePayload = {
        ...form,
        name,
        description: form.description.trim(),
        prompt_template: promptTemplate,
        placeholder_token: placeholderToken,
        default_count: Math.max(1, Math.min(100, Math.floor(Number(form.default_count) || 1))),
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
      const data = await uploadImageTemplateAsset(pendingAssetTarget.id, pendingAssetTarget.kind, file);
      setTemplates((current) => current.map((item) => (item.id === data.item.id ? data.item : item)));
      toast.success(pendingAssetTarget.kind === "reference" ? "参考图已更新" : "原图已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传模板图片失败");
    } finally {
      setUploading(null);
      setPendingAssetTarget(null);
      if (referenceInputRef.current) {
        referenceInputRef.current.value = "";
      }
      if (originalInputRef.current) {
        originalInputRef.current.value = "";
      }
    }
  };

  const handleDeleteAsset = async (template: ImageTemplate, kind: "reference" | "original") => {
    setUploading({ id: template.id, kind });
    try {
      const data = await deleteImageTemplateAsset(template.id, kind);
      setTemplates((current) => current.map((item) => (item.id === data.item.id ? data.item : item)));
      toast.success(kind === "reference" ? "参考图已删除" : "原图已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除模板图片失败");
    } finally {
      setUploading(null);
    }
  };

  return (
    <>
      <input
        ref={referenceInputRef}
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
      <input
        ref={originalInputRef}
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
              <p className="text-sm leading-6 text-stone-500">维护模板 prompt、参考图和原图，模板资产会单独存放，不走普通图片删除链路。</p>
            </div>
            <Button className="rounded-2xl bg-stone-950 text-white hover:bg-stone-800" onClick={openCreateDialog}>
              <Plus className="mr-2 size-4" />新增模板
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 rounded-2xl border border-dashed border-stone-200 px-4 py-6 text-sm text-stone-500">
              <LoaderCircle className="size-4 animate-spin" />加载模板中
            </div>
          ) : templates.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-stone-200 px-4 py-6 text-sm text-stone-500">还没有模板，先创建一个可复用的生图配置。</div>
          ) : (
            <div className="space-y-3">
              {templates.map((template) => {
                const busy = deletingId === template.id || uploading?.id === template.id;
                return (
                  <div key={template.id} className="rounded-3xl border border-stone-200/80 bg-stone-50/70 p-4 sm:p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-stone-950">{template.name}</h3>
                          <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-stone-600">{describeTemplate(template)}</span>
                        </div>
                        {template.description ? <p className="text-sm leading-6 text-stone-500">{template.description}</p> : null}
                        <div className="rounded-2xl bg-white/90 px-3 py-3 text-sm leading-6 text-stone-700">
                          {template.prompt_template}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">参考图</div>
                            <div className="flex items-center gap-3">
                              {template.reference_image_url ? (
                                <img src={template.reference_image_url} alt={`${template.name} 参考图`} className="size-16 rounded-2xl border border-stone-200 object-cover" />
                              ) : (
                                <div className="flex size-16 items-center justify-center rounded-2xl border border-dashed border-stone-200 bg-white text-xs text-stone-400">未上传</div>
                              )}
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="rounded-xl"
                                  disabled={busy}
                                  onClick={() => {
                                    setPendingAssetTarget({ id: template.id, kind: "reference" });
                                    referenceInputRef.current?.click();
                                  }}
                                >
                                  <ImagePlus className="mr-2 size-4" />上传参考图
                                </Button>
                                {template.reference_image_url ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="rounded-xl text-rose-600"
                                    disabled={busy}
                                    onClick={() => void handleDeleteAsset(template, "reference")}
                                  >
                                    删除
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">原图</div>
                            <div className="flex items-center gap-3">
                              {template.original_image_url ? (
                                <img src={template.original_image_url} alt={`${template.name} 原图`} className="size-16 rounded-2xl border border-stone-200 object-cover" />
                              ) : (
                                <div className="flex size-16 items-center justify-center rounded-2xl border border-dashed border-stone-200 bg-white text-xs text-stone-400">未上传</div>
                              )}
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="rounded-xl"
                                  disabled={busy}
                                  onClick={() => {
                                    setPendingAssetTarget({ id: template.id, kind: "original" });
                                    originalInputRef.current?.click();
                                  }}
                                >
                                  <ImagePlus className="mr-2 size-4" />上传原图
                                </Button>
                                {template.original_image_url ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="rounded-xl text-rose-600"
                                    disabled={busy}
                                    onClick={() => void handleDeleteAsset(template, "original")}
                                  >
                                    删除
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <Button type="button" variant="outline" className="rounded-xl" onClick={() => openEditDialog(template)} disabled={busy}>
                          <Pencil className="mr-2 size-4" />编辑
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-xl text-rose-600"
                          disabled={busy}
                          onClick={() => void handleDelete(template)}
                        >
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
        <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[28px] border-white/80 bg-white p-0 sm:max-w-3xl">
          <DialogHeader className="px-6 pt-6 sm:px-7">
            <DialogTitle>{editingTemplate ? "编辑生图模板" : "新建生图模板"}</DialogTitle>
            <DialogDescription>模板 prompt、默认张数、比例和约束都在这里维护，图片资产保存后可单独上传。</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 px-6 pb-2 sm:grid-cols-2 sm:px-7">
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
              <Input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="可选，说明这个模板适合什么场景" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <label className="text-sm font-medium text-stone-700">模板提示词</label>
              <Textarea value={form.prompt_template} onChange={(event) => setForm((current) => ({ ...current, prompt_template: event.target.value }))} className="min-h-[160px] rounded-2xl border-stone-200 bg-white" placeholder="可写固定提示词，也可以包含占位符，例如 {{prompt}}" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">默认张数</label>
              <Input type="number" min="1" max="100" value={String(form.default_count)} onChange={(event) => setForm((current) => ({ ...current, default_count: Math.max(1, Math.min(100, Number(event.target.value) || 1)) }))} className="h-11 rounded-xl border-stone-200 bg-white" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">默认比例</label>
              <Select value={form.default_size || "__empty__"} onValueChange={(value) => setForm((current) => ({ ...current, default_size: value === "__empty__" ? "" : value }))}>
                <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IMAGE_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option.label} value={option.value || "__empty__"}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-3 sm:col-span-2">
              <label className="flex items-center gap-3 rounded-2xl border border-stone-200 px-4 py-3 text-sm text-stone-700">
                <Checkbox checked={form.requires_placeholder} onCheckedChange={(checked) => setForm((current) => ({ ...current, requires_placeholder: Boolean(checked) }))} />
                这个模板要求用户填写关键字占位
              </label>
              {form.requires_placeholder ? (
                <Input value={form.placeholder_token} onChange={(event) => setForm((current) => ({ ...current, placeholder_token: event.target.value }))} className="h-11 rounded-xl border-stone-200 bg-white" placeholder="例如 {{prompt}}" />
              ) : null}
              <label className="flex items-center gap-3 rounded-2xl border border-stone-200 px-4 py-3 text-sm text-stone-700">
                <Checkbox checked={form.requires_user_source_image} onCheckedChange={(checked) => setForm((current) => ({ ...current, requires_user_source_image: Boolean(checked) }))} />
                这个模板要求用户额外上传待处理原图
              </label>
              <label className="flex items-center gap-3 rounded-2xl border border-stone-200 px-4 py-3 text-sm text-stone-700">
                <Checkbox checked={form.enabled} onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: Boolean(checked) }))} />
                启用这个模板，让生图页可以直接看到
              </label>
            </div>
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
