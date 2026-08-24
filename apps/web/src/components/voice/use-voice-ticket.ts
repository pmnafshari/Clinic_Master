'use client';

import { useCallback } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * Fetches a one-time key for opening an authenticated voice socket.
 *
 * The ticket is used immediately and never stored: it is a bearer credential
 * with a one-minute life, and putting it in localStorage or a URL the browser
 * keeps would outlive its usefulness while remaining useful to somebody else.
 */
export function useVoiceTicket() {
  return useCallback(async (): Promise<string | null> => {
    try {
      const { data } = await apiClient.post<{ ticket: string }>('/voice/ticket');
      return data.ticket ?? null;
    } catch {
      // An unauthenticated or rate-limited caller simply gets no ticket, and
      // the socket falls back to an anonymous session.
      return null;
    }
  }, []);
}
