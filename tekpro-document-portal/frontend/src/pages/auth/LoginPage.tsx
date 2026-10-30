import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Alert, Button, Field, Input } from "../../components/ui";
import { useAuth } from "../../hooks/useAuth";
import { AuthLayout } from "../../layouts/AuthLayout";
import { errorMessage } from "../../services/api";

export function LoginPage() {
  const { login, user, sessionEnded } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof fieldErrors = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) errs.email = "Enter a valid email address";
    if (!password) errs.password = "Enter your password";
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Sign in">
      {sessionEnded === "expired" && <Alert kind="warning">Your session has ended. Please sign in again.</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={submit} noValidate className="form">
        <Field label="Email address" error={fieldErrors.email}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} aria-invalid={!!fieldErrors.email} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
        </Field>
        <Field label="Password" error={fieldErrors.password}>
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              aria-invalid={!!fieldErrors.password}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="btn-block">
          Sign in
        </Button>
      </form>
      <p className="auth-links">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
    </AuthLayout>
  );
}
