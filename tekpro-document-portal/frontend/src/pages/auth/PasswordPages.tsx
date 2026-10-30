import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, Button, Field, Input } from "../../components/ui";
import { AuthLayout } from "../../layouts/AuthLayout";
import { errorMessage } from "../../services/api";
import { authApi } from "../../services/endpoints";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone((await authApi.forgotPassword(email.trim())).message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Reset your password">
      {done ? (
        <Alert kind="success">{done}</Alert>
      ) : (
        <form onSubmit={submit} className="form">
          <p className="muted">Enter your email address and we will send you a link to choose a new password.</p>
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="Email address">
            {(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="btn-block">
            Send reset link
          </Button>
        </form>
      )}
      <p className="auth-links">
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}

export const PASSWORD_HINT = "At least 12 characters, using three of: lower-case, upper-case, digits, symbols.";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("The passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      setDone((await authApi.resetPassword(token, password)).message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout title="Choose a password">
        <Alert kind="error">This link is incomplete. Please use the link from your email or request a new one.</Alert>
        <p className="auth-links">
          <Link to="/forgot-password">Request a new link</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a password">
      {done ? (
        <>
          <Alert kind="success">{done}</Alert>
          <p className="auth-links">
            <Link to="/login">Go to sign in</Link>
          </p>
        </>
      ) : (
        <form onSubmit={submit} className="form">
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="New password" hint={PASSWORD_HINT}>
            {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label="Confirm new password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="btn-block">
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
