import type { ReactNode } from "react";
import { Brand } from "../components/Brand";

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-shell">
      <main className="auth-card" id="main">
        <div className="auth-brand">
          <Brand />
        </div>
        <h1 className="auth-title">{title}</h1>
        {children}
      </main>
      <p className="auth-footer">Secure document distribution by Tekkonnectpro IT Services</p>
    </div>
  );
}
