import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Spinner } from "./components/ui";
import { CustomerExplorerPage, MyDocumentsPage } from "./features/explorer/ExplorerPage";
import { useAuth } from "./hooks/useAuth";
import { AppLayout } from "./layouts/AppLayout";
import { AuditPage, CustomerActivityPage } from "./pages/admin/AuditPage";
import { CustomerDetailPage, CustomersPage } from "./pages/admin/CustomersPage";
import { AccountPage, SettingsPage, StoragePage } from "./pages/admin/SystemPages";
import { OrganisationStoragePage } from "./features/storage/StorageManagement";
import { UserDetailPage, UsersPage } from "./pages/admin/UsersPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/auth/PasswordPages";
import { DashboardPage } from "./pages/DashboardPage";
import { AccessDeniedPage, NotFoundPage } from "./pages/StatusPages";
import type { Role } from "./types/api";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Loading the portal" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** UI-level route guard; the API enforces the same rules independently. */
function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <AccessDeniedPage />;
  return <>{children}</>;
}

function RequireActivity({ children }: { children: ReactNode }) {
  const { features } = useAuth();
  return features.activityAccess ? <>{children}</> : <AccessDeniedPage />;
}

const STAFF: Role[] = ["SUPER_ADMIN", "TEKPRO_USER"];
const SUPER: Role[] = ["SUPER_ADMIN"];
const CUSTOMER: Role[] = ["CUSTOMER_ADMIN", "CUSTOMER_USER"];

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="documents" element={<RequireRole roles={CUSTOMER}><MyDocumentsPage /></RequireRole>} />
        <Route path="activity" element={<RequireRole roles={CUSTOMER}><RequireActivity><CustomerActivityPage /></RequireActivity></RequireRole>} />
        <Route path="customers" element={<RequireRole roles={STAFF}><CustomersPage /></RequireRole>} />
        <Route path="customers/:customerId" element={<RequireRole roles={SUPER}><CustomerDetailPage /></RequireRole>} />
        <Route path="customers/:customerId/documents" element={<RequireRole roles={STAFF}><CustomerExplorerPage /></RequireRole>} />
        <Route path="users" element={<RequireRole roles={SUPER}><UsersPage /></RequireRole>} />
        <Route path="users/:userId" element={<RequireRole roles={SUPER}><UserDetailPage /></RequireRole>} />
        <Route path="audit" element={<RequireRole roles={STAFF}><RequireActivity><AuditPage /></RequireActivity></RequireRole>} />
        <Route path="storage" element={<RequireRole roles={SUPER}><StoragePage /></RequireRole>} />
        <Route path="organisation-storage" element={<RequireRole roles={["CUSTOMER_ADMIN"]}><OrganisationStoragePage /></RequireRole>} />
        <Route path="settings" element={<RequireRole roles={SUPER}><SettingsPage /></RequireRole>} />
        <Route path="account" element={<AccountPage />} />
        <Route path="access-denied" element={<AccessDeniedPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
