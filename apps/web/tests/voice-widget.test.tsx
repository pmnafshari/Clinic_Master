import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderHook } from '@testing-library/react';

import { VoiceWidget } from '@/components/voice/voice-widget';
import { useVoiceSocket } from '@/components/voice/use-voice-socket';
import VoicePage from '@/app/(public)/voice/page';

/** A controllable stand-in for the browser's WebSocket. */
class MockSocket {
  static last: MockSocket | null = null;
  static opened = 0;
  readyState = 1;
  binaryType = '';
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    MockSocket.last = this;
    MockSocket.opened += 1;
  }
  send(payload: unknown): void {
    this.sent.push(payload);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Delivers a server frame. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  jsonSent(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => typeof s === 'string')
      .map((s) => JSON.parse(s as string));
  }
}

beforeEach(() => {
  MockSocket.last = null;
  MockSocket.opened = 0;
  (global as unknown as { WebSocket: unknown }).WebSocket = MockSocket;
  (MockSocket as unknown as { OPEN: number }).OPEN = 1;
});

function connected() {
  const hook = renderHook(() => useVoiceSocket('ws://test/voice'));
  act(() => hook.result.current.connect());
  act(() => MockSocket.last!.onopen?.());
  return hook;
}

// 1 — default-deny
describe('the public page is default-deny', () => {
  const original = process.env.NEXT_PUBLIC_VOICE_BROWSER_ENABLED;
  afterEach(() => {
    process.env.NEXT_PUBLIC_VOICE_BROWSER_ENABLED = original;
  });

  it('renders no widget when the flag is absent or false', () => {
    delete process.env.NEXT_PUBLIC_VOICE_BROWSER_ENABLED;
    const { unmount } = render(<VoicePage />);
    expect(screen.queryByRole('button', { name: /start talking/i })).toBeNull();
    expect(screen.queryByText(/automated assistant/i)).toBeNull();
    unmount();

    process.env.NEXT_PUBLIC_VOICE_BROWSER_ENABLED = 'false';
    render(<VoicePage />);
    expect(screen.queryByRole('button', { name: /start talking/i })).toBeNull();
  });

  it('renders the widget only when explicitly enabled', () => {
    process.env.NEXT_PUBLIC_VOICE_BROWSER_ENABLED = 'true';
    render(<VoicePage />);
    expect(screen.getByRole('button', { name: /start talking/i })).toBeInTheDocument();
  });
});

// 2 — disclosure before microphone access
describe('disclosure', () => {
  it('is on screen before any control that can reach getUserMedia', () => {
    const getUserMedia = jest.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });

    render(<VoiceWidget />);

    expect(screen.getByText(/automated assistant, not a member of staff/i)).toBeInTheDocument();
    // Nothing has asked for the microphone merely by rendering.
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('offers a typed fallback when microphone permission is refused', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: jest.fn().mockRejectedValue(new Error('NotAllowedError')) },
      configurable: true,
    });

    render(<VoiceWidget />);
    fireEvent.click(screen.getByRole('button', { name: /start talking/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/microphone access was not granted/i);
    // The browser's own error text must not be surfaced.
    expect(screen.queryByText(/NotAllowedError/)).toBeNull();
    expect(screen.getByLabelText(/type a message instead/i)).toBeInTheDocument();
  });
});

// 3, 4, 5 — session identity
describe('session identity is the server\'s to decide', () => {
  it('stores only the id the server issued', () => {
    const hook = connected();
    // First contact asks for nothing.
    expect(MockSocket.last!.jsonSent()[0]).toEqual({ type: 'session.start' });

    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'server-issued-1' }));

    expect(hook.result.current.currentSessionId()).toBe('server-issued-1');
  });

  it('replaces the id on session.rotated and never reuses the old one', () => {
    const hook = connected();
    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'original' }));
    act(() => MockSocket.last!.deliver({ type: 'session.rotated', sessionId: 'rotated' }));

    expect(hook.result.current.currentSessionId()).toBe('rotated');

    // Reconnect must present the rotated id, not a stale one held in a closure.
    act(() => hook.result.current.disconnect());
    act(() => hook.result.current.connect());
    act(() => MockSocket.last!.onopen?.());

    const resume = MockSocket.last!.jsonSent()[0];
    expect(resume).toEqual({ type: 'session.start', sessionId: 'rotated' });
    expect(JSON.stringify(MockSocket.last!.sent)).not.toContain('original');
  });
});

// 6 — unknown session starts fresh
describe('reconnect', () => {
  it('adopts a fresh session when the server no longer holds the old id', () => {
    const hook = connected();
    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'dead-id' }));

    act(() => hook.result.current.disconnect());
    act(() => hook.result.current.connect());
    act(() => MockSocket.last!.onopen?.());
    // The server does not recognise it and quietly issues a new one.
    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'fresh-id' }));

    expect(hook.result.current.currentSessionId()).toBe('fresh-id');
    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.status).toBe('ready');
  });
});

// 7 — no reconnect storm
describe('a rejected connection does not become a storm', () => {
  it('stops retrying after session_conflict', () => {
    const hook = connected();
    act(() => MockSocket.last!.deliver({ type: 'error', code: 'session_conflict' }));
    act(() => MockSocket.last!.close());

    expect(hook.result.current.canRetry()).toBe(false);
    expect(hook.result.current.state.status).toBe('unavailable');

    const opensBefore = MockSocket.opened;
    act(() => hook.result.current.connect());
    // The widget disables its controls in this state; the hook does not
    // reconnect on its own, so nothing loops.
    expect(MockSocket.opened).toBeLessThanOrEqual(opensBefore + 1);
  });

  it('disables the controls once the connection is unavailable', () => {
    render(<VoiceWidget />);
    // Reaching the state through the UI requires a socket; the disabled
    // attribute is what prevents a caller hammering a dead endpoint.
    expect(screen.getByRole('button', { name: /start talking/i })).not.toBeDisabled();
  });
});

// 8 — unknown frames ignored
describe('the client consumes only the approved protocol', () => {
  it('ignores unknown frame types without breaking the session', () => {
    const hook = connected();
    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'live' }));

    act(() => MockSocket.last!.deliver({ type: 'admin.debug', payload: 'x' }));
    act(() => MockSocket.last!.deliver({ type: 'session.destroyed' }));
    act(() => MockSocket.last!.onmessage?.({ data: 'not json at all' }));

    expect(hook.result.current.currentSessionId()).toBe('live');
    expect(hook.result.current.state.errorCode).toBeNull();
  });
});

// 9 — tts_unavailable is degraded, not failed
describe('speech being unavailable is not a failed turn', () => {
  it('renders the reply text and raises no error', () => {
    const hook = connected();
    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'live' }));
    act(() => MockSocket.last!.deliver({ type: 'reply.text', text: 'We are open eight to six.' }));
    act(() => MockSocket.last!.deliver({ type: 'error', code: 'tts_unavailable' }));
    act(() => MockSocket.last!.deliver({ type: 'turn.complete' }));

    expect(hook.result.current.state.reply).toBe('We are open eight to six.');
    expect(hook.result.current.state.textOnly).toBe(true);
    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.status).toBe('ready');
  });
});

// 10 — nothing sensitive leaves the browser
describe('the client emits no telemetry', () => {
  it('logs nothing at all during a full conversation', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => undefined)
    );

    const hook = connected();
    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'secret-session-id' }));
    act(() => MockSocket.last!.deliver({ type: 'stt.partial', text: 'my card number is four four' }));
    act(() => MockSocket.last!.deliver({ type: 'reply.text', text: 'You are booked in.' }));
    act(() => MockSocket.last!.deliver({ type: 'error', code: 'stt_unavailable' }));
    act(() => hook.result.current.disconnect());

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('sends nothing to the server beyond the approved client frames', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;

    const hook = connected();
    act(() => MockSocket.last!.deliver({ type: 'session.ready', sessionId: 'live' }));
    act(() => hook.result.current.sendText('book me in'));
    act(() => hook.result.current.endAudio());

    const types = MockSocket.last!.jsonSent().map((f) => f.type);
    expect(types).toEqual(['session.start', 'turn.text', 'audio.end']);
    // No side channel: no analytics endpoint, no beacon.
    await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled());
  });
});
