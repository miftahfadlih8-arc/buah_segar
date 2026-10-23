"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon } from "./icons";
import { Button } from "./primitives";

export interface FilterOption {
  value: string;
  label: string;
}

interface TableSearchFilterBarProps {
  placeholder?: string;
  paramName?: string;
  statusParamName?: string;
  statusOptions?: FilterOption[];
  statusLabel?: string;
  totalCount?: number;
  filteredCount?: number;
}

export function TableSearchFilterBar({
  placeholder = "Cari kode, nama, atau referensi...",
  paramName = "q",
  statusParamName = "status",
  statusOptions,
  statusLabel = "Semua Status",
  totalCount,
  filteredCount,
}: TableSearchFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentQuery = searchParams.get(paramName) ?? "";
  const currentStatus = searchParams.get(statusParamName) ?? "";

  const [query, setQuery] = useState(currentQuery);

  function applyFilters(nextQuery: string, nextStatus: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextQuery.trim()) {
      params.set(paramName, nextQuery.trim());
    } else {
      params.delete(paramName);
    }

    if (nextStatus) {
      params.set(statusParamName, nextStatus);
    } else {
      params.delete(statusParamName);
    }

    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function handleReset() {
    setQuery("");
    applyFilters("", "");
  }

  const hasActiveFilter = Boolean(currentQuery || currentStatus);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyFilters(query, currentStatus);
      }}
      className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-3 sm:px-6"
    >
      <div className="flex flex-1 flex-wrap items-center gap-2.5">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
            <Icon name="search" size={15} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pr-3 pl-9 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600"
          />
        </div>

        {statusOptions && statusOptions.length > 0 && (
          <div className="flex items-center gap-1.5">
            <select
              aria-label={statusLabel}
              value={currentStatus}
              onChange={(e) => applyFilters(query, e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              <option value="">{statusLabel}</option>
              {statusOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <Button type="submit" variant="secondary" size="sm" icon="filter" loading={isPending}>
          Terapkan
        </Button>

        {hasActiveFilter && (
          <Button type="button" variant="ghost" size="sm" onClick={handleReset}>
            Reset Filter
          </Button>
        )}
      </div>

      {typeof totalCount === "number" && (
        <div className="tabular-nums text-xs font-medium text-slate-500">
          Menampilkan{" "}
          <strong className="text-slate-800">{filteredCount ?? totalCount}</strong> dari{" "}
          <strong className="text-slate-800">{totalCount}</strong> data
        </div>
      )}
    </form>
  );
}
