'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Exactly the frames the server sends. Anything else is ignored. */
type ServerFrame =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.rotated'; sessionId: string }
  | { type: 'stt.partial'; text: string }
  | { type: 'agent.thinking' }
  | { type: 'reply.text'; text: string }
  | { type: 'turn.complete' }
  | { type: 'error'; code: string };

export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'closed'
  | 'unavailable';

export interface VoiceState {
  status: VoiceStatus;
  partial: string;
  reply: string;
  /** True when the reply arrived as text because speech was unavailable. */
  textOnly: boolean;
  errorCode: string | null;
}

const INITIAL: VoiceState = {
  status: 'idle',
  partial: '',
  reply: '',
  textOnly: false,
  errorCode: null,
};

/**
 * `tts_unavailable` means the reply arrived as text instead of speech. The turn
 * still happened and the caller still has their answer, so it is a degraded
 * delivery, not a failure — showing an error here would hide a perfectly good
 * reply behind a warning.
 */
const DEGRADED_CODES = new Set(['tts_unavailable']);

/** Codes that end the connection. Reconnecting on these is pointless or harmful. */
const TERMINAL_CODES = new Set(['session_conflict', 'rate_limited']);

export function useVoiceSocket(url: string) {
  const socketRef = useRef<WebSocket | null>(null);
  /**
   * The current server-issued id. A ref, not state, because every send has to
   * read the latest value: a closure capturing an id from render would keep
   * presenting a rotated-away one after `session.rotated`.
   */
  const sessionIdRef = useRef<string | null>(null);
  /** Set when the server ends the connection for a reason worth not retrying. */
  const noRetryRef = useRef(false);

  const [state, setState] = useState<VoiceState>(INITIAL);
  const [audioQueue, setAudioQueue] = useState<ArrayBuffer[]>([]);

  const handleFrame = useCallback((frame: ServerFrame) => {
    switch (frame.type) {
      case 'session.ready':
        // The server decides the id. A value we asked for is never authoritative.
        sessionIdRef.current = frame.sessionId;
        setState((s) => ({ ...s, status: 'ready', errorCode: null }));
        return;

      case 'session.rotated':
        // Replace immediately: the previous id is already dead server-side, so
        // anything still holding it would be talking to nothing.
        sessionIdRef.current = frame.sessionId;
        return;

      case 'stt.partial':
        setState((s) => ({ ...s, status: 'listening', partial: frame.text }));
        return;

      case 'agent.thinking':
        setState((s) => ({ ...s, status: 'thinking', partial: '' }));
        return;

      case 'reply.text':
        setState((s) => ({ ...s, reply: frame.text, textOnly: true }));
        return;

      case 'turn.complete':
        setState((s) => ({ ...s, status: 'ready', partial: '' }));
        return;

      case 'error':
        if (DEGRADED_CODES.has(frame.code)) {
          setState((s) => ({ ...s, textOnly: true }));
          return;
        }
        if (TERMINAL_CODES.has(frame.code)) {
          noRetryRef.current = true;
        }
        setState((s) => ({ ...s, errorCode: frame.code }));
        return;

      default:
        // An unrecognised frame is ignored rather than guessed at.
        return;
    }
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current) return;

    setState((s) => ({ ...s, status: 'connecting' }));
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;

    socket.onopen = () => {
      // Resume under the latest id if we hold one. An id the server no longer
      // has is not an error: it quietly issues a fresh session, and
      // `session.ready` tells us which id is now authoritative.
      const resume = sessionIdRef.current;
      socket.send(JSON.stringify(resume ? { type: 'session.start', sessionId: resume } : { type: 'session.start' }));
    };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        setAudioQueue((q) => [...q, event.data as ArrayBuffer]);
        setState((s) => ({ ...s, status: 'speaking', textOnly: false }));
        return;
      }
      try {
        handleFrame(JSON.parse(String(event.data)) as ServerFrame);
      } catch {
        // Unparseable payloads are dropped silently — there is nothing useful
        // to show a caller about a malformed frame.
      }
    };

    socket.onclose = () => {
      socketRef.current = null;
      setState((s) => ({
        ...s,
        // A conflict or a limit ended this deliberately. Presenting it as a
        // plain close would invite the UI to offer a retry that will fail the
        // same way, which is how a reconnect storm starts.
        status: noRetryRef.current ? 'unavailable' : 'closed',
      }));
    };
  }, [url, handleFrame]);

  const disconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  const sendText = useCallback((text: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'turn.text', text }));
    }
  }, []);

  const sendAudio = useCallback((chunk: ArrayBuffer) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(chunk);
    }
  }, []);

  const endAudio = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'audio.end' }));
    }
  }, []);

  useEffect(() => () => socketRef.current?.close(), []);

  return {
    state,
    audioQueue,
    connect,
    disconnect,
    sendText,
    sendAudio,
    endAudio,
    /** Exposed for tests and for reconnect logic. Never rendered. */
    currentSessionId: () => sessionIdRef.current,
    canRetry: () => !noRetryRef.current,
  };
}
