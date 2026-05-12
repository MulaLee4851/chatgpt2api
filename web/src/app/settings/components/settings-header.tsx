"use client";

export function SettingsHeader() {
  return (
    <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-1">
        <div className="text-xs font-semibold tracking-[0.18em] text-sky-700 uppercase">LeesAiHub</div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">系统设置</h1>
      </div>
    </section>
  );
}
