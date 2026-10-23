"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icons";
import { LogoutButton } from "@/app/(app)/logout-button";

export interface NavItemConfig {
  href: string;
  label: string;
  shortLabel?: string;
  icon: IconName;
  badgeCount?: number;
  badgeTone?: "neutral" | "warning" | "emerald";
}

export interface NavGroupConfig {
  id: string;
  groupTitle: string;
  items: NavItemConfig[];
}

interface AppShellProps {
  actor: {
    id: string;
    name: string;
    username: string | null;
    email: string;
    roles: Array<{
      roleCode: string;
      roleName: string;
      warehouseId: string | null;
    }>;
  };
  navGroups: NavGroupConfig[];
  pendingApprovalsCount: number;
  children: ReactNode;
}

export function AppShell({
  actor,
  navGroups,
  pendingApprovalsCount,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [navSearch, setNavSearch] = useState("");
  const [topSearch, setTopSearch] = useState("");

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const el = document.getElementById("global-module-search");
        el?.focus();
      }
      if (e.key === "Escape" && mobileMenuOpen) {
        setMobileMenuOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  const navQuery = navSearch.trim().toLowerCase();
  const filteredGroups = navQuery
    ? navGroups
        .map((g) => ({
          ...g,
          items: g.items.filter(
            (item) =>
              item.label.toLowerCase().includes(navQuery) ||
              g.groupTitle.toLowerCase().includes(navQuery) ||
              item.href.toLowerCase().includes(navQuery),
          ),
        }))
        .filter((g) => g.items.length > 0)
    : navGroups;

  let activeContext = {
    groupTitle: "Operasional",
    pageLabel: "Pusat Kendali",
    href: pathname,
  };
  for (const group of navGroups) {
    for (const item of group.items) {
      if (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) {
        activeContext = {
          groupTitle: group.groupTitle,
          pageLabel: item.label,
          href: item.href,
        };
        break;
      }
    }
  }

  const nameParts = actor.name.trim().split(/\s+/);
  const initials =
    nameParts.length >= 2
      ? `${nameParts[0]?.[0] ?? ""}${nameParts[1]?.[0] ?? ""}`.toUpperCase()
      : actor.name.slice(0, 2).toUpperCase();

  const primaryRole = actor.roles[0];

  function handleTopSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = topSearch.trim();
    if (!q) return;

    // First check if query matches a navigation module name
    const allItems = navGroups.flatMap((g) => g.items);
    const matchingNav = allItems.find(
      (i) =>
        i.label.toLowerCase().includes(q.toLowerCase()) ||
        i.href.toLowerCase() === `/${q.toLowerCase()}`,
    );
    if (matchingNav && pathname === "/") {
      router.push(matchingNav.href);
      return;
    }

    // Otherwise apply search filter (`?q=...`) to current operational page
    const params = new URLSearchParams(window.location.search);
    params.set("q", q);
    router.push(`${pathname}?${params.toString()}`);
  }

  function renderSidebarContent(isMobile: boolean) {
    const isCompact = !isMobile && sidebarCollapsed;

    return (
      <div className="flex h-full flex-col bg-[#0b1324] text-slate-200 select-none">
        {/* Brand Identity Header */}
        <div className="flex h-16 items-center justify-between border-b border-[#1b2944] px-4">
          <Link
            href="/"
            onClick={() => isMobile && setMobileMenuOpen(false)}
            className="flex items-center gap-3 overflow-hidden"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600/20 text-emerald-400 ring-1 ring-emerald-500/30">
              <Icon name="leaf" size={18} />
            </div>
            {!isCompact && (
              <div className="truncate">
                <div className="text-sm font-bold tracking-tight text-white">
                  Nusantara Segar
                </div>
                <div className="text-[10px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
                  ERP Distribusi Bekasi
                </div>
              </div>
            )}
          </Link>

          {isMobile ? (
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Tutup menu navigasi"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-[#162440] hover:text-white"
            >
              <Icon name="close" size={18} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-label={isCompact ? "Perluas sidebar" : "Ciutkan sidebar"}
              title={isCompact ? "Perluas sidebar" : "Ciutkan sidebar"}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-[#162440] hover:text-white"
            >
              <Icon name={isCompact ? "chevronRight" : "chevronLeft"} size={16} />
            </button>
          )}
        </div>

        {/* Sidebar Module Filter */}
        {!isCompact && (
          <div className="px-3.5 pt-3.5 pb-2">
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
                <Icon name="search" size={14} />
              </span>
              <input
                type="search"
                value={navSearch}
                onChange={(e) => setNavSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filteredGroups[0]?.items[0]) {
                    router.push(filteredGroups[0].items[0].href);
                    if (isMobile) setMobileMenuOpen(false);
                  }
                }}
                placeholder="Cari modul..."
                aria-label="Filter menu modul"
                className="min-h-[36px] w-full rounded-lg border border-[#1e2f4f] bg-[#111d35] py-1.5 pr-9 pl-8 text-xs text-slate-100 placeholder:text-slate-400 focus:border-emerald-500"
              />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
                <kbd className="rounded bg-[#1a2b49] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  ⌘K
                </kbd>
              </span>
            </div>
          </div>
        )}

        {/* Navigation Groups */}
        <nav
          aria-label="Navigasi Utama Modul Operasional"
          className="flex-1 space-y-4 overflow-y-auto px-3 py-3"
        >
          {filteredGroups.map((group) => (
            <div key={group.id} className="space-y-1">
              {!isCompact && (
                <div className="px-2.5 pt-1 pb-1 text-[10px] font-bold tracking-[0.12em] text-slate-400/90 uppercase">
                  {group.groupTitle}
                </div>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname === item.href || pathname.startsWith(`${item.href}/`);

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => isMobile && setMobileMenuOpen(false)}
                        title={isCompact ? `${group.groupTitle}: ${item.label}` : undefined}
                        aria-current={isActive ? "page" : undefined}
                        className={`group relative flex items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors ${
                          isActive
                            ? "bg-[#172746] font-semibold text-white ring-1 ring-emerald-500/30"
                            : "text-slate-300 hover:bg-[#13203a] hover:text-white"
                        }`}
                      >
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-1.5 left-0 w-1 rounded-r bg-emerald-400"
                          />
                        )}
                        <div className="flex items-center gap-2.5 truncate">
                          <span
                            className={
                              isActive
                                ? "text-emerald-400"
                                : "text-slate-400 group-hover:text-slate-200"
                            }
                          >
                            <Icon name={item.icon} size={17} />
                          </span>
                          {!isCompact && <span className="truncate">{item.label}</span>}
                        </div>

                        {!isCompact &&
                          typeof item.badgeCount === "number" &&
                          item.badgeCount > 0 && (
                            <span
                              className={`tabular-nums rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                item.badgeTone === "warning"
                                  ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/30"
                                  : item.badgeTone === "emerald"
                                    ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/30"
                                    : "bg-slate-700/80 text-slate-200"
                              }`}
                            >
                              {item.badgeCount}
                            </span>
                          )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Bottom User Profile & Session Footer */}
        <div className="border-t border-[#1b2944] p-3">
          <div className="flex items-center justify-between gap-2.5 rounded-xl bg-[#111d35] p-2.5 ring-1 ring-[#1e2f4f]">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/30 text-xs font-bold text-blue-200 ring-1 ring-blue-400/30">
                {initials}
              </div>
              {!isCompact && (
                <div className="truncate">
                  <div className="truncate text-xs font-semibold text-white">{actor.name}</div>
                  <div className="truncate text-[11px] text-slate-400">
                    {primaryRole
                      ? `${primaryRole.roleName} (${primaryRole.warehouseId ?? "Semua Gudang"})`
                      : "Staf Operasional"}
                  </div>
                </div>
              )}
            </div>
            {!isCompact && <LogoutButton compact />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#f6f8fb] text-slate-900">
      {/* Desktop Sidebar */}
      <aside
        className={`hidden shrink-0 border-r border-[#1b2944] transition-[width] duration-200 lg:block ${
          sidebarCollapsed ? "w-[72px]" : "w-[264px]"
        }`}
      >
        <div className="sticky top-0 h-screen">{renderSidebarContent(false)}</div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true">
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative z-10 w-[280px] max-w-[85vw] shadow-2xl">
            {renderSidebarContent(true)}
          </div>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-slate-200/90 bg-white/95 px-4 backdrop-blur-xs sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 overflow-hidden">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Buka menu navigasi"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 lg:hidden"
            >
              <Icon name="menu" size={18} />
            </button>

            {/* Breadcrumb */}
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs sm:text-sm">
              <Link
                href="/"
                className="hidden font-medium text-slate-400 transition hover:text-slate-700 sm:inline"
              >
                {activeContext.groupTitle}
              </Link>
              <span aria-hidden="true" className="hidden text-slate-300 sm:inline">
                /
              </span>
              <span className="truncate font-bold text-slate-900">
                {activeContext.pageLabel}
              </span>
            </nav>
          </div>

          {/* Right Topbar Controls */}
          <div className="flex items-center gap-3">
            {/* Functional Quick Search */}
            <form onSubmit={handleTopSearchSubmit} className="hidden md:block">
              <div className="relative w-64 lg:w-72">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
                  <Icon name="search" size={15} />
                </span>
                <input
                  id="global-module-search"
                  type="search"
                  value={topSearch}
                  onChange={(e) => setTopSearch(e.target.value)}
                  placeholder="Cari di halaman atau modul..."
                  aria-label="Cari di halaman atau modul"
                  className="min-h-[36px] w-full rounded-lg border border-slate-200 bg-slate-50/80 py-1.5 pr-11 pl-9 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:bg-white"
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
                  <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-400">
                    ⌘K
                  </kbd>
                </span>
              </div>
            </form>

            {/* Workspace Timezone & Currency Pill */}
            <span className="hidden items-center gap-1.5 rounded-lg border border-slate-200/80 bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 xl:inline-flex">
              <Icon name="clock" size={13} className="text-emerald-600" />
              WIB • IDR
            </span>

            {/* Pending Approvals Indicator */}
            {pendingApprovalsCount > 0 && (
              <Link
                href="/penjualan"
                title={`${pendingApprovalsCount} permintaan persetujuan menunggu keputusan`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100"
              >
                <Icon name="alert" size={14} className="text-amber-600" />
                <span className="tabular-nums">{pendingApprovalsCount}</span>
                <span className="hidden sm:inline">Approval</span>
              </Link>
            )}

            {/* Mobile Logout / Role Indicator */}
            <div className="flex items-center gap-2 lg:hidden">
              <LogoutButton compact />
            </div>
          </div>
        </header>

        {/* Page Container */}
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
