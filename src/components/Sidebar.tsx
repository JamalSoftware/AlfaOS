"use client";

import { useState } from "react";
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

function NavList({
  profile,
  pathname,
  onNavigate,
}: {
  profile: AccessProfile;
  pathname: string;
  onNavigate?: () => void;
}) {
  const items = navigationFor(profile);
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
      {items.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-info-bg text-primary-text"
                : "text-fg-secondary hover:bg-surface-muted hover:text-fg"
            }`}
          >
            <Icon name={item.icon} className="h-5 w-5 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Brand({ companyName }: { companyName: string }) {
  return (
    <div className="flex h-16 items-center gap-3 border-b border-border px-5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary font-bold text-primary-fg">
        A
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-fg">AlfaOS</p>
        <p className="truncate text-xs text-fg-muted">{companyName}</p>
      </div>
    </div>
  );
}

function UserFooter({ userName, profile }: SidebarProps) {
  return (
    <div className="border-t border-border px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">
            {userName}
          </p>
          <p className="text-xs text-fg-muted">{PROFILE_LABELS[profile]}</p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-surface-muted"
            title="Sair"
          >
            Sair
          </button>
        </form>
      </div>
    </div>
  );
}

export function Sidebar({ profile, userName, companyName }: SidebarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Abrir menu"
          className="rounded-md p-1.5 text-fg-secondary hover:bg-surface-muted"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            className="h-6 w-6"
            aria-hidden="true"
          >
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <p className="truncate text-sm font-semibold text-fg">
          AlfaOS
        </p>
        <span className="ml-auto truncate text-xs text-fg-muted">
          {userName}
        </span>
      </header>

      {/* Mobile drawer + backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-overlay/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute left-0 top-0 flex h-full w-72 flex-col border-r border-border bg-surface shadow-xl">
            <div className="flex items-center justify-between pr-3">
              <Brand companyName={companyName} />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Fechar menu"
                className="rounded-md p-1.5 text-fg-muted hover:bg-surface-muted"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <NavList
              profile={profile}
              pathname={pathname}
              onNavigate={() => setMobileOpen(false)}
            />
            <UserFooter profile={profile} userName={userName} companyName={companyName} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <Brand companyName={companyName} />
        <NavList profile={profile} pathname={pathname} />
        <UserFooter profile={profile} userName={userName} companyName={companyName} />
      </aside>
    </>
  );
}
