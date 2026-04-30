"use client";

import { ArrowUp, LoaderCircle } from "lucide-react";
import type { RefObject } from "react";

import { Textarea } from "@/components/ui/textarea";

type GptWebComposerProps = {
  prompt: string;
  isSubmitting: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onPromptChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
};

export function GptWebComposer({ prompt, isSubmitting, textareaRef, onPromptChange, onSubmit }: GptWebComposerProps) {
  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <div className="rounded-[24px] border border-stone-200 bg-white shadow-[0_14px_60px_-42px_rgba(15,23,42,0.45)] sm:rounded-[32px] sm:shadow-none">
          <div
            className="relative cursor-text"
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              placeholder="输入你想发给 gpt-web 的内容"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[82px] resize-none rounded-[24px] border-0 bg-transparent px-4 pt-4 pb-2 text-[15px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:min-h-[148px] sm:rounded-[32px] sm:px-6 sm:pt-6 sm:pb-20 sm:leading-7"
            />

            <div className="border-t border-stone-100 bg-white px-3 pb-3 pt-2 sm:absolute sm:inset-x-0 sm:bottom-0 sm:border-t-0 sm:bg-gradient-to-t sm:from-white sm:via-white/95 sm:to-transparent sm:px-6 sm:pb-4 sm:pt-6">
              <div className="flex items-end justify-between gap-3">
                <div className="rounded-full bg-stone-100 px-3 py-2 text-xs font-medium text-stone-600">
                  {isSubmitting ? (
                    <span className="inline-flex items-center gap-1.5">
                      <LoaderCircle className="size-3 animate-spin" />
                      正在请求
                    </span>
                  ) : (
                    "Enter 发送，Shift+Enter 换行"
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim() || isSubmitting}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-stone-950 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:size-11"
                  aria-label="发送消息"
                >
                  <ArrowUp className="size-3.5 sm:size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
