"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AccessProfile } from "@prisma/client";
import { navigationFor, PROFILE_LABELS } from "@/lib/navigation";
import { Icon } from "./icons";

interface SidebarProps {
  profile: AccessProfile;
  userName: string;
  companyName: string;
}

export function Sidebar({ profile, userName, companyName }: SidebarProps) {
  const pathname = usePathname();
  const items = navigationFor(profile);

  return (
    <aside className="flex h-full w-64 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">
          A
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">
            AlfaOS
          </p>
          <p className="truncate text-xs text-slate-500">{companyName}</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-50 text-blue-700"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Icon name={item.icon} className="h-5 w-5 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-200 px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">
              {userName}
            </p>
            <p className="text-xs text-slate-500">
              {PROFILE_LABELS[profile]}
            </p>
          </div>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
              title="Sair"
            >
              Sair
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
