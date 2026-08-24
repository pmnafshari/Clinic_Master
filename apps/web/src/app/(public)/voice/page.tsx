import { VoiceWidget } from '@/components/voice/voice-widget';

export const metadata = {
  title: 'Speak to SmileFlow Dental',
  description: 'Ask about the clinic or book an appointment by voice.',
};

/**
 * Default-deny, mirroring the server.
 *
 * The server closes the socket when browser voice is off, so the page could
 * never work anyway — but rendering nothing means the widget is not even
 * reachable, and no microphone prompt can be raised on a deployment that has
 * not switched this on.
 */
export default function VoicePage() {
  if (process.env.NEXT_PUBLIC_VOICE_BROWSER_ENABLED !== 'true') {
    return <p className="text-center text-gray-600">Voice booking is not available right now.</p>;
  }

  return <VoiceWidget />;
}
