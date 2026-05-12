"use client";

import { LoaderCircle } from "lucide-react";

import { ImageTemplatesCard } from "@/app/settings/components/image-templates-card";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function ImageTemplatesPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-sky-100/80 bg-white/95 p-6 shadow-[0_24px_80px_-48px_rgba(37,99,235,0.22)] sm:p-7">
        <div className="space-y-2">
          <p className="text-sm font-medium text-sky-700">LeesAiHub · Image Templates</p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">模板管理</h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-500 sm:text-[15px]">
            统一管理模板的正负提示词、变量、引用图、封面、标签、状态和版本信息。
          </p>
        </div>
      </section>
      <ImageTemplatesCard />
    </div>
  );
}
