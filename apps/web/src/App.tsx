import { Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/layout/app-shell";
import { AuthPage } from "@/pages/auth";
import { DashboardPage } from "@/pages/dashboard";
import { FilesPage } from "@/pages/files";
import { IdentitiesPage } from "@/pages/identities";
import { LimitsPage } from "@/pages/limits";
import { NotFoundPage } from "@/pages/not-found";
import { SessionsPage } from "@/pages/sessions";
import { UsagePage } from "@/pages/usage";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="identities" element={<IdentitiesPage />} />
        <Route path="limits" element={<LimitsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="auth" element={<AuthPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
