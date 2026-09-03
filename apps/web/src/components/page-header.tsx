import { TriangleAlert } from "lucide-react";
import type * as React from "react";

import { UpdatedAgo } from "@/components/updated-ago";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  updatedAt,
  actions,
  className,
}: {
  title: string;
  description?: string;
  updatedAt?: number;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <UpdatedAgo updatedAt={updatedAt} />
        {actions}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground/70 [&_svg]:size-5">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-sm text-red-600 dark:text-red-400">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="break-words">{message}</span>
    </div>
  );
}
