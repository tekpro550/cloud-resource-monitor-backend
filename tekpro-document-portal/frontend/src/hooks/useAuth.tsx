import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onSessionEnd, setCsrfToken } from "../services/api";
import { authApi } from "../services/endpoints";
import type { MePayload, User } from "../types/api";

interface AuthState {
  user: User | null;
  features: MePayload["features"];
  loading: boolean;
  sessionEnded: "expired" | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  applySession: (me: MePayload) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [features, setFeatures] = useState<MePayload["features"]>({ activityAccess: false });
  const [loading, setLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState<"expired" | null>(null);

  const applySession = useCallback((me: MePayload) => {
    setCsrfToken(me.csrfToken);
    setUser(me.user);
    setFeatures(me.features);
    setSessionEnded(null);
  }, []);

  useEffect(() => {
    authApi
      .me()
      .then(applySession)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [applySession]);

  useEffect(() => {
    onSessionEnd((reason) => {
      setCsrfToken(null);
      setUser(null);
      if (reason === "expired") setSessionEnded("expired");
    });
    return () => onSessionEnd(null);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      applySession(await authApi.login(email, password));
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setCsrfToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, features, loading, sessionEnded, login, logout, applySession }),
    [user, features, loading, sessionEnded, login, logout, applySession],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** For pages that require an authenticated user (guarded by RequireAuth). */
export function useCurrentUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("No authenticated user");
  return user;
}
