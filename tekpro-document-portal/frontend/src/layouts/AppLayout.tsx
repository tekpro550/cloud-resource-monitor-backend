import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Brand } from "../components/Brand";
import { useAuth, useCurrentUser } from "../hooks/useAuth";
import type { Role } from "../types/api";
import { ROLE_LABELS } from "../utils/format";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

export function navItemsFor(role: Role, activityAccess: boolean): NavItem[] {
  const items: NavItem[] = [{ to: "/", label: "Dashboard", end: true }];
  if (role === "SUPER_ADMIN") {
    items.push(
      { to: "/customers", label: "Customers" },
      { to: "/users", label: "Users" },
      { to: "/audit", label: "Audit logs" },
      { to: "/storage", label: "Storage" },
      { to: "/settings", label: "Settings" },
    );
  } else if (role === "TEKPRO_USER") {
    items.push({ to: "/customers", label: "My customers" });
    if (activityAccess) items.push({ to: "/audit", label: "Activity" });
  } else {
    items.push({ to: "/documents", label: "Documents" });
    if (activityAccess) items.push({ to: "/activity", label: "Activity" });
    if (role === "CUSTOMER_ADMIN") items.push({ to: "/organisation-storage", label: "Storage" });
  }
  items.push({ to: "/account", label: "My account" });
  return items;
}

export function AppLayout() {
  const user = useCurrentUser();
  const { logout, features } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const items = navItemsFor(user.role, features.activityAccess);

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <button
          type="button"
          className="icon-button nav-toggle"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen((o) => !o)}
        >
          ☰
        </button>
        <Brand />
        <div className="topbar-user">
          <div className="topbar-user-text">
            <span className="topbar-user-name">{user.fullName}</span>
            <span className="topbar-user-role">
              {ROLE_LABELS[user.role]}
              {user.customer ? ` · ${user.customer.name}` : ""}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await logout();
              navigate("/login", { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="app-body">
        <nav id="sidebar" className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="Main navigation">
          <ul>
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} onClick={() => setOpen(false)} className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}
        <main id="main" className="content" tabIndex={-1} key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
