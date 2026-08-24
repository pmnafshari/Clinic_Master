'use client';

import { useCallback, useRef, useState } from 'react';
import { useVoiceSocket } from './use-voice-socket';

const SOCKET_URL =
  process.env.NEXT_PUBLIC_VOICE_WS_URL || 'ws://localhost:3001/voice';

type MicState = 'idle' | 'requesting' | 'denied' | 'capturing';

export function VoiceWidget({ socketUrl }: { socketUrl?: string } = {}) {
  // The public page uses the anonymous default; the portal passes a ticketed
  // url. Nothing else differs between the two surfaces.
  const { state, connect, sendText, sendAudio, endAudio, disconnect } = useVoiceSocket(
    socketUrl ?? SOCKET_URL
  );
  const [mic, setMic] = useState<MicState>('idle');
  const [typed, setTyped] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);

  const startTalking = useCallback(async () => {
    setMic('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      connect();

      const context = new AudioContext();
      contextRef.current = context;
      await context.audioWorklet.addModule('/voice-capture-worklet.js');

      const source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, 'voice-capture');
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => sendAudio(event.data);
      source.connect(capture);

      setMic('capturing');
    } catch {
      // The browser's own message is not shown: it varies by vendor and says
      // nothing the caller can act on beyond "permission was refused".
      setMic('denied');
    }
  }, [connect, sendAudio]);

  const stopTalking = useCallback(() => {
    endAudio();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
    setMic('idle');
  }, [endAudio]);

  const submitTyped = useCallback(() => {
    if (!typed.trim()) return;
    connect();
    sendText(typed.trim());
    setTyped('');
  }, [typed, connect, sendText]);

  const unavailable = state.status === 'unavailable';

  return (
    <section aria-label="Voice assistant" className="mx-auto max-w-md rounded-lg border p-6">
      {/*
        Rendered unconditionally and before any control that can reach
        getUserMedia, so nobody can start speaking to an automated system
        without having been told that is what it is.
      */}
      <p className="mb-4 text-sm text-gray-600">
        You are speaking with an automated assistant, not a member of staff. It can answer
        questions about the clinic and book an appointment for you.
      </p>

      <div className="flex flex-col gap-3">
        {mic === 'capturing' ? (
          <button type="button" onClick={stopTalking} className="rounded bg-gray-800 px-4 py-2 text-white">
            Stop talking
          </button>
        ) : (
          <button
            type="button"
            onClick={startTalking}
            disabled={unavailable}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            Start talking
          </button>
        )}

        <div className="flex gap-2">
          <input
            aria-label="Type a message instead"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or type your question"
            className="flex-1 rounded border px-3 py-2"
          />
          <button type="button" onClick={submitTyped} disabled={unavailable} className="rounded border px-3 py-2">
            Send
          </button>
        </div>
      </div>

      <div className="mt-4 min-h-[3rem] text-sm" aria-live="polite">
        {mic === 'requesting' && <p>Asking for microphone access…</p>}
        {mic === 'denied' && (
          <p role="alert">
            Microphone access was not granted. You can still type your question below.
          </p>
        )}
        {state.status === 'thinking' && <p>Thinking…</p>}
        {state.partial && <p className="italic text-gray-500">{state.partial}</p>}
        {state.reply && <p>{state.reply}</p>}
        {unavailable && (
          <p role="alert">
            This conversation was ended. Please refresh the page to start a new one.
          </p>
        )}
        {state.errorCode && !unavailable && (
          <p role="alert">Something went wrong. Please try again.</p>
        )}
      </div>

      <button type="button" onClick={disconnect} className="sr-only">
        End conversation
      </button>
    </section>
  );
}
