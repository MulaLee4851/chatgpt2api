"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import webConfig from "@/constants/common-env";
import { getValidatedAuthSession } from "@/lib/auth-session";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

const adminNavItems = [
  { href: "/gpt-web", label: "对话" },
  { href: "/image", label: "画图" },
  { href: "/image-templates", label: "模板管理" },
  { href: "/accounts", label: "号池管理" },
  { href: "/register", label: "注册机" },
  { href: "/image-manager", label: "图片管理" },
  { href: "/logs", label: "日志管理" },
  { href: "/settings", label: "设置" },
];

const userNavItems = [
  { href: "/gpt-web", label: "对话", permission: "chat" as const },
  { href: "/image", label: "画图", permission: "image" as const },
];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (!active) {
          return;
        }
        setSession(null);
        return;
      }

      const storedSession = await getValidatedAuthSession();
      if (!active) {
        return;
      }
      setSession(storedSession);
    };

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  const handleLogout = async () => {
    await clearStoredAuthSession();
    router.replace("/login");
  };

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const navItems =
    session.role === "admin"
      ? adminNavItems
      : userNavItems.filter((item) => session.permissions[item.permission]);
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  const displayName = session.name.trim() || roleLabel;

  return (
    <header className="border-b border-sky-100/80 bg-white/55 backdrop-blur-xl">
      <div className="flex min-h-12 flex-col gap-1 px-3 py-2 sm:h-14 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-0">
        <div className="flex items-center justify-between gap-2 sm:justify-start sm:gap-4">
          <Link
            href="/image"
            className="inline-flex shrink-0 items-center gap-3 py-1 text-[15px] font-bold tracking-tight text-slate-900 transition hover:text-sky-700"
          >
            <span className="flex size-9 items-center justify-center overflow-hidden rounded-2xl border border-sky-100 bg-[#f7f6f2] shadow-sm">
              <Image src="/static/logo.jpg" alt="LeesAiHub logo" width={36} height={36} className="size-full object-cover" />
            </span>
            <span>LeesAiHub</span>
          </Link>
          <button
            type="button"
            className="ml-auto shrink-0 py-1 text-xs text-slate-500 transition hover:text-sky-700 sm:hidden"
            onClick={() => void handleLogout()}
          >
            退出
          </button>
        </div>
        <nav className="hide-scrollbar -mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 sm:mx-0 sm:justify-center sm:gap-8 sm:overflow-visible sm:px-0">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium transition sm:rounded-none sm:px-0 sm:py-1 sm:text-[15px]",
                  active
                    ? "bg-sky-600 text-white shadow-sm sm:bg-transparent sm:font-semibold sm:text-sky-700 sm:shadow-none"
                    : "text-slate-500 hover:text-sky-700",
                )}
              >
                {item.label}
                {active ? <span className="absolute inset-x-0 -bottom-[1px] hidden h-0.5 bg-sky-600 sm:block" /> : null}
              </Link>
            );
          })}
        </nav>
        <div className="hidden items-center justify-end gap-2 sm:flex sm:gap-3">
          <span className="hidden rounded-full border border-sky-100 bg-white/80 px-2.5 py-1 text-[10px] font-medium text-slate-500 sm:inline-block sm:text-[11px]">
            {roleLabel} · {displayName}
          </span>
          <span className="hidden rounded-full border border-sky-100 bg-sky-50/80 px-2.5 py-1 text-[10px] font-medium text-sky-700 sm:inline-block sm:text-[11px]">
            v{webConfig.appVersion}
          </span>
          <button
            type="button"
            className="py-1 text-xs text-slate-500 transition hover:text-sky-700 sm:text-sm"
            onClick={() => void handleLogout()}
          >
            退出
          </button>
        </div>
      </div>
    </header>
  );
}
