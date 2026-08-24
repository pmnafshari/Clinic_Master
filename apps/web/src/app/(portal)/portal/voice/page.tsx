'use client';

import { useEffect, useState } from 'react';
import { VoiceWidget } from '@/components/voice/voice-widget';
import { useVoiceTicket } from '@/components/voice/use-voice-ticket';

const BASE = process.env.NEXT_PUBLIC_VOICE_WS_URL || 'ws://localhost:3001/voice';

/**
 * The authenticated voice surface.
 *
 * Identical to the public widget except for the ticket: the socket opens with
 * a one-time key, and the server derives who the caller is from it. The
 * browser never names a user or a patient, and never sees either.
 */
export default function PortalVoicePage() {
  const getTicket = useVoiceTicket();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getTicket().then((ticket) => {
      if (cancelled) return;
      if (!ticket) {
        setFailed(true);
        return;
      }
      setUrl(`${BASE}?ticket=${encodeURIComponent(ticket)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [getTicket]);

  if (process.env.NEXT_PUBLIC_VOICE_BROWSER_ENABLED !== 'true') {
    return <p className="text-center text-gray-600">Voice is not available right now.</p>;
  }

  if (failed) {
    return <p className="text-center text-gray-600">Could not start a voice session. Please try again.</p>;
  }

  if (!url) {
    return <p className="text-center text-gray-600">Preparing your voice session…</p>;
  }

  return <VoiceWidget socketUrl={url} />;
}
