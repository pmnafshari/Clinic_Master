'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from './api-client';

export type UserRole = 'admin' | 'dentist' | 'assistant' | 'receptionist' | 'patient';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

interface RegisterData {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  password: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Brings a user record into the shape this context promises.
 *
 * The two endpoints that produce one disagree: `/auth/login` returns
 * `role: "admin"`, while `/auth/me` returns the joined row,
 * `role: { id, name: "admin", … }`. Every consumer here — the route guard, the
 * sidebar, the header — compares `user.role` to a string, so an unmapped
 * `/auth/me` response silently fails all of them: on a refresh the guard read
 * an object, decided the role was not permitted, and bounced the user to the
 * dashboard, which then failed the same check and rendered nothing.
 *
 * Normalising on the way in keeps that disagreement at the boundary instead of
 * letting it leak into every comparison.
 */
function toUser(raw: unknown): User {
  const data = raw as Omit<User, 'role'> & { role: UserRole | { name?: UserRole } };
  const role = typeof data.role === 'string' ? data.role : data.role?.name;

  return { ...data, role: role as UserRole };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const token = localStorage.getItem('accessToken');
      if (token) {
        const response = await apiClient.get('/auth/me');
        setUser(toUser(response.data));
      }
    } catch (error) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    const response = await apiClient.post('/auth/login', { email, password });
    const { user: userData, accessToken, refreshToken } = response.data;

    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    const user = toUser(userData);
    setUser(user);

    if (user.role === 'patient') {
      router.push('/portal');
    } else {
      router.push('/dashboard');
    }
  };

  const register = async (data: RegisterData) => {
    const response = await apiClient.post('/auth/register', data);
    const { user: userData, accessToken, refreshToken } = response.data;

    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    setUser(toUser(userData));
    router.push('/portal');
  };

  const logout = async () => {
    try {
      await apiClient.post('/auth/logout');
    } catch {
      // Ignore logout errors; tokens are cleared regardless.
    }
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    setUser(null);
    router.push('/login');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login,
        register,
        logout,
        isAuthenticated: !!user,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
