"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ImageTemplate } from "@/lib/api";
import { cn } from "@/lib/utils";

type ImageTemplatePickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: ImageTemplate[];
  selectedTemplateId: string;
  isLoading: boolean;
  onSelectTemplate: (templateId: string) => void;
  onClearTemplate: () => void;
};

export function ImageTemplatePicker({
  open,
  onOpenChange,
  templates,
  selectedTemplateId,
  isLoading,
  onSelectTemplate,
  onClearTemplate,
}: ImageTemplatePickerProps) {
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<"all" | "generate" | "edit">("all");
  const [previewTemplateId, setPreviewTemplateId] = useState(selectedTemplateId);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPreviewTemplateId(selectedTemplateId || templates[0]?.id || "");
  }, [open, selectedTemplateId, templates]);

  const filteredTemplates = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (modeFilter !== "all" && template.mode !== modeFilter) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return [template.name, template.description, template.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [modeFilter, query, templates]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === previewTemplateId) ?? null,
    [previewTemplateId, templates],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(84dvh,760px)] w-[94vw] max-w-5xl flex-col overflow-hidden rounded-[28px] border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:rounded-[36px]">
        <DialogHeader className="space-y-2 border-b border-stone-100 px-6 pt-6 pb-4 sm:px-8 sm:pt-8">
          <DialogTitle className="text-xl font-semibold tracking-tight text-stone-950">选择模板</DialogTitle>
          <DialogDescription className="text-sm leading-6 text-stone-500">
            从模板库里挑选可直接复用的提示词、变量和参考图配置。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="flex min-h-0 flex-col border-b border-stone-100 lg:border-r lg:border-b-0">
            <div className="space-y-3 px-6 py-4 sm:px-8">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索模板名、描述或标签"
                  className="h-11 rounded-2xl border-stone-200 bg-white pl-9"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "all", label: "全部" },
                  { value: "generate", label: "文生图" },
                  { value: "edit", label: "图生图" },
                ].map((option) => {
                  const active = option.value === modeFilter;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-medium transition sm:text-sm",
                        active
                          ? "border-stone-950 bg-stone-950 text-white"
                          : "border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:text-stone-900",
                      )}
                      onClick={() => setModeFilter(option.value as typeof modeFilter)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6 lg:px-8">
              {isLoading ? (
                <div className="flex h-full items-center justify-center py-10 text-stone-400">
                  <LoaderCircle className="size-5 animate-spin" />
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-stone-200 bg-stone-50/70 px-4 py-10 text-center text-sm text-stone-500">
                  没找到符合条件的模板。
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredTemplates.map((template) => {
                    const active = template.id === previewTemplateId;
                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => setPreviewTemplateId(template.id)}
                        className={cn(
                          "w-full rounded-3xl border p-4 text-left transition hover:border-stone-300 hover:bg-stone-50",
                          active ? "border-stone-950 bg-stone-50" : "border-stone-200 bg-white",
                        )}
                      >
                        <div className="flex items-start gap-3">
                          {template.cover_image_url ? (
                            <img
                              src={template.cover_image_url}
                              alt={template.name}
                              className="size-16 rounded-2xl object-cover"
                            />
                          ) : (
                            <div className="flex size-16 items-center justify-center rounded-2xl bg-stone-100 text-xs text-stone-500">
                              无封面
                            </div>
                          )}
                          <div className="min-w-0 flex-1 space-y-2">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-medium text-stone-950 sm:text-base">{template.name}</div>
                                <div className="mt-1 text-xs text-stone-500 sm:text-sm">{template.description || "暂无描述"}</div>
                              </div>
                              {active ? <Check className="mt-0.5 size-4 shrink-0 text-stone-950" /> : null}
                            </div>
                            <div className="flex flex-wrap gap-2 text-[11px] text-stone-500 sm:text-xs">
                              <span className="rounded-full bg-stone-100 px-2 py-1">{template.mode === "edit" ? "图生图" : "文生图"}</span>
                              <span className="rounded-full bg-stone-100 px-2 py-1">{template.status}</span>
                              <span className="rounded-full bg-stone-100 px-2 py-1">v{template.version}</span>
                              {template.tags.map((tag) => (
                                <span key={tag} className="rounded-full bg-stone-100 px-2 py-1">#{tag}</span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="hide-scrollbar min-h-0 overflow-y-auto px-6 py-6 sm:px-8 sm:py-8">
            {selectedTemplate ? (
              <div className="space-y-5">
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold text-stone-950">{selectedTemplate.name}</h3>
                  <p className="text-sm leading-6 text-stone-500">{selectedTemplate.description || "暂无描述"}</p>
                </div>
                <div className="grid gap-3 text-sm text-stone-600">
                  <div className="rounded-2xl bg-stone-50 px-4 py-3">
                    <div className="font-medium text-stone-900">正向提示词</div>
                    <div className="mt-2 whitespace-pre-wrap break-words leading-6">{selectedTemplate.prompts.positive}</div>
                  </div>
                  {selectedTemplate.prompts.negative ? (
                    <div className="rounded-2xl bg-stone-50 px-4 py-3">
                      <div className="font-medium text-stone-900">负向提示词</div>
                      <div className="mt-2 whitespace-pre-wrap break-words leading-6">{selectedTemplate.prompts.negative}</div>
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-stone-200 px-4 py-3 text-sm text-stone-600">
                    <div className="font-medium text-stone-900">变量</div>
                    <div className="mt-2">{selectedTemplate.placeholders.length} 个</div>
                  </div>
                  <div className="rounded-2xl border border-stone-200 px-4 py-3 text-sm text-stone-600">
                    <div className="font-medium text-stone-900">引用图</div>
                    <div className="mt-2">{selectedTemplate.references.length} 个槽位</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button className="rounded-full bg-stone-950 text-white hover:bg-stone-800" onClick={() => selectedTemplate && onSelectTemplate(selectedTemplate.id)}>
                    应用模板
                  </Button>
                  <Button variant="outline" className="rounded-full border-stone-200" onClick={onClearTemplate}>
                    取消模板
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[220px] items-center justify-center rounded-3xl border border-dashed border-stone-200 bg-stone-50/70 px-6 text-center text-sm leading-6 text-stone-500">
                选择左侧模板后，这里会显示模板摘要与提示词预览。
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
