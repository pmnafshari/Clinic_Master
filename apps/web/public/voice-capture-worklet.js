/**
 * Downsamples microphone audio to the format the server expects:
 * PCM linear16, 16 kHz, mono.
 *
 * An AudioWorklet rather than the deprecated ScriptProcessorNode: this runs on
 * the audio thread, so a busy main thread cannot stutter or drop capture.
 */
const TARGET_RATE = 16000;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Fractional read position carried between blocks. Device rates are rarely
    // an exact multiple of 16 kHz, so restarting at zero each block would drift.
    this.position = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      return true;
    }

    const step = sampleRate / TARGET_RATE;
    const samples = [];

    for (let i = this.position; i < channel.length; i += step) {
      const value = channel[Math.floor(i)];
      const clamped = Math.max(-1, Math.min(1, value));
      // Float [-1,1] to signed 16-bit, asymmetric because two's complement is.
      samples.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }

    this.position = (this.position % step) + step * samples.length - channel.length;
    if (this.position < 0) {
      this.position = 0;
    }

    const pcm = new Int16Array(samples);
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
