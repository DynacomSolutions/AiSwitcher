import type * as React from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/** One tab of a page. `segment` is the URL path segment; the first tab of a
 * page is the bare page path, so its segment is never used in a link. */
export interface PageTab {
  segment: string;
  label: React.ReactNode;
}

/** Where a tab's link points. The first tab is the page's own path (`base`);
 * the others hang off `prefix` (defaults to `base`). */
function tabHref(tabs: PageTab[], index: number, base: string, prefix: string): string {
  return index === 0 ? base : `${prefix}/${tabs[index]!.segment}`;
}

/** Resolve the `:tab` route param against the page's tabs. `active` is the
 * segment to render (the first tab when the param is absent); `invalid` is
 * true for an unknown segment, in which case render `<PageTabRedirect>`. */
export function usePageTab(tabs: PageTab[]): { active: string; invalid: boolean } {
  const { tab } = useParams<{ tab?: string }>();
  const first = tabs[0]?.segment ?? "";
  if (tab === undefined || tab === "") return { active: first, invalid: false };
  const known = tabs.some((t, i) => i > 0 && t.segment === tab);
  return known ? { active: tab, invalid: false } : { active: first, invalid: true };
}

export function PageTabRedirect({ to }: { to: string }) {
  return <Navigate to={to} replace />;
}

/** Horizontal route tabs: real links, so each tab is a shareable URL and the
 * browser back button works. Scrolls sideways on narrow screens. */
export function PageTabs({
  tabs,
  active,
  base,
  prefix = base,
  className,
}: {
  tabs: PageTab[];
  active: string;
  base: string;
  prefix?: string;
  className?: string;
}) {
  return (
    <nav aria-label="Page sections" className={cn("max-w-full overflow-x-auto", className)}>
      <div
        data-slot="tabs-list"
        className="bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.segment === active;
          return (
            <NavLink
              key={tab.segment || "index"}
              to={tabHref(tabs, index, base, prefix)}
              end
              data-slot="tabs-trigger"
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "inline-flex h-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
                isActive && "bg-background text-foreground shadow-sm",
              )}
            >
              {tab.label}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
