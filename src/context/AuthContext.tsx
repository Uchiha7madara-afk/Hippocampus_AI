import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase.ts';
import type { RbacRole } from '../types/app.ts';

// In-memory cache for the Google Workspace OAuth access token (never stored in localStorage/sessionStorage)
let cachedWorkspaceAccessToken: string | null = null;
let isSigningInFlow = false;

interface AuthContextValue {
  user: User | null;
  idToken: string | null;
  googleAccessToken: string | null;
  activeRole: RbacRole;
  setActiveRole: (role: RbacRole) => Promise<void>;
  loading: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  connectGoogleWorkspace: () => Promise<string | null>;
  logout: () => Promise<void>;
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(
    cachedWorkspaceAccessToken
  );
  const [activeRole, setActiveRoleState] = useState<RbacRole>('Admin');
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        if (cachedWorkspaceAccessToken) {
          setGoogleAccessToken(cachedWorkspaceAccessToken);
        } else if (!isSigningInFlow) {
          cachedWorkspaceAccessToken = null;
          setGoogleAccessToken(null);
        }

        try {
          const token = await firebaseUser.getIdToken();
          setIdToken(token);
          const res = await fetch('/api/auth/sync', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });
          if (res.ok) {
            const data = (await res.json()) as {
              user?: { role?: RbacRole };
            };
            if (
              data.user?.role === 'Admin' ||
              data.user?.role === 'Manager' ||
              data.user?.role === 'Engineer'
            ) {
              setActiveRoleState(data.user.role);
            }
          }
        } catch (err) {
          console.warn('Token sync warning:', err);
        }
      } else {
        setIdToken(null);
        cachedWorkspaceAccessToken = null;
        setGoogleAccessToken(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    isSigningInFlow = true;
    try {
      const result = await signInWithPopup(auth, googleAuthProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        cachedWorkspaceAccessToken = credential.accessToken;
        setGoogleAccessToken(credential.accessToken);
      }
      const token = await result.user.getIdToken();
      setIdToken(token);
      await fetch('/api/auth/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Google Sign-In failed.';
      setAuthError(msg);
    } finally {
      isSigningInFlow = false;
    }
  }, []);

  const connectGoogleWorkspace = useCallback(async (): Promise<
    string | null
  > => {
    setAuthError(null);
    isSigningInFlow = true;
    try {
      const result = await signInWithPopup(auth, googleAuthProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (!credential?.accessToken) {
        throw new Error(
          'Failed to obtain Google Drive & Docs access token from sign-in.'
        );
      }
      cachedWorkspaceAccessToken = credential.accessToken;
      setGoogleAccessToken(credential.accessToken);
      const token = await result.user.getIdToken();
      setIdToken(token);
      return credential.accessToken;
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Google Workspace connection failed.';
      setAuthError(msg);
      return null;
    } finally {
      isSigningInFlow = false;
    }
  }, []);

  const logout = useCallback(async () => {
    setAuthError(null);
    await signOut(auth);
    setIdToken(null);
    cachedWorkspaceAccessToken = null;
    setGoogleAccessToken(null);
  }, []);

  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const headers = new Headers(options.headers || {});
      if (!headers.has('Content-Type') && options.body) {
        headers.set('Content-Type', 'application/json');
      }
      if (!headers.has('x-hippocampus-role')) {
        headers.set('x-hippocampus-role', activeRole);
      }
      if (
        cachedWorkspaceAccessToken &&
        !headers.has('x-google-access-token')
      ) {
        headers.set('x-google-access-token', cachedWorkspaceAccessToken);
      }
      if (user) {
        try {
          const freshToken = await user.getIdToken();
          headers.set('Authorization', `Bearer ${freshToken}`);
        } catch {
          if (idToken) {
            headers.set('Authorization', `Bearer ${idToken}`);
          }
        }
      } else if (idToken) {
        headers.set('Authorization', `Bearer ${idToken}`);
      }

      return fetch(url, {
        ...options,
        headers,
      });
    },
    [user, idToken, activeRole]
  );

  const setActiveRole = useCallback(
    async (nextRole: RbacRole) => {
      setActiveRoleState(nextRole);
      try {
        await fetch('/api/auth/role', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-hippocampus-role': nextRole,
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({ role: nextRole }),
        });
      } catch {
        // Non-blocking role sync
      }
    },
    [idToken]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        idToken,
        googleAccessToken,
        activeRole,
        setActiveRole,
        loading,
        authError,
        signInWithGoogle,
        connectGoogleWorkspace,
        logout,
        authFetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
