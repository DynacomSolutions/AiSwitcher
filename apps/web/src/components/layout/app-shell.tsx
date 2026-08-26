import {
  ArrowLeftRight,
  BarChart3,
  FolderOpen,
  Gauge,
  History,
  IdCard,
  LayoutDashboard,
  ShieldCheck,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdatedAgo } from "@/components/updated-ago";
import { useStatusQuery } from "@/hooks/queries";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/identities", label: "Identities", icon: IdCard, end: false },
  { to: "/limits", label: "Limits", icon: Gauge, end: false },
  { to: "/usage", label: "Usage", icon: BarChart3, end: false },
  { to: "/sessions", label: "Sessions", icon: History, end: false },
  { to: "/auth", label: "Auth", icon: ShieldCheck, end: false },
  { to: "/files", label: "Files", icon: FolderOpen, end: false },
] as const;

function TopBar() {
  const status = useStatusQuery();
  const connected = !status.isError && status.data?.ok !== false;

  return (
    <header className="bg-background/85 sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-4 border-b px-4 backdrop-blur md:px-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <ArrowLeftRight className="size-4" aria-hidden />
        </div>
        <span className="text-sm font-semibold tracking-tight">AIS Console</span>
        {status.data?.version ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            v{status.data.version}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            connected ? "animate-pulse bg-emerald-500" : "bg-red-500",
          )}
        />
        <span className="text-sm text-muted-foreground">
          {connected ? "Connected" : "Disconnected"}
        </span>
        <UpdatedAgo updatedAt={status.dataUpdatedAt} className="hidden sm:inline" />
      </div>
    </header>
  );
}

function Sidebar() {
  const status = useStatusQuery();

  return (
    <aside className="bg-sidebar sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 flex-col border-r md:flex">
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                isActive
                  ? "bg-primary/12 text-primary font-medium"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )
            }
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-1 border-t p-4 text-xs text-muted-foreground">
        <p>Loopback console for AiProfileSwitcher</p>
        {status.data?.aisHome ? (
          <p className="truncate font-mono" title={status.data.aisHome}>
            {status.data.aisHome}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

export function AppShell() {
  return (
    <TooltipProvider>
      <div className="flex min-h-full flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-w-0 flex-1 p-4 md:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
