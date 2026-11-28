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
  type User,
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
  // Least-privilege initial UI state; authoritative role always comes from server DB via /api/auth/sync
  const [activeRole, setActiveRoleState] = useState<RbacRole>('Engineer');
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const syncVerifiedUser = useCallback(async (firebaseUser: User) => {
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
  }, []);

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
          await syncVerifiedUser(firebaseUser);
        } catch (err) {
          console.warn('Token sync warning:', err);
        }
      } else {
        setIdToken(null);
        setActiveRoleState('Engineer');
        cachedWorkspaceAccessToken = null;
        setGoogleAccessToken(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [syncVerifiedUser]);

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
      await syncVerifiedUser(result.user);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Google Sign-In failed.';
      setAuthError(msg);
    } finally {
      isSigningInFlow = false;
    }
  }, [syncVerifiedUser]);

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
      await syncVerifiedUser(result.user);
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
  }, [syncVerifiedUser]);

  const logout = useCallback(async () => {
    setAuthError(null);
    await signOut(auth);
    setIdToken(null);
    setActiveRoleState('Engineer');
    cachedWorkspaceAccessToken = null;
    setGoogleAccessToken(null);
  }, []);

  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const headers = new Headers(options.headers || {});
      if (!headers.has('Content-Type') && options.body) {
        headers.set('Content-Type', 'application/json');
      }
      // Mission 001: Never send client-controlled role headers (x-hippocampus-role removed)
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
    [user, idToken]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        idToken,
        googleAccessToken,
        activeRole,
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
