const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SYNTH_URL_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const BINARY_DELIM = "Path:audio\r\n";
const CONTENT_TYPE_JSON =
  "Content-Type:application/json\r\nPath:speech.config\r\n\r\n";
const CONTENT_TYPE_SSML =
  "Content-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n";

import { createLogger } from './logger';
const log = createLogger('BingSpeech');

export interface VoiceConfig {
  locale: string;
  voice: string;
  pitch: string;
  rate: string;
  volume: string;
}

interface RequestState {
  audioDataChunks: Blob[];
  resolve: (url: string) => void;
  reject: (reason: any) => void;
}

class BingSpeechService {
  private socket: WebSocket | null = null;
  private requests: Record<string, RequestState> = {};

  private async generateSecMsGecToken(): Promise<string> {
    // Get the current time in Windows file time format (100ns intervals since 1601-01-01)
    // Note: Using BigInt for precision
    let ticks = BigInt(
      Math.floor((Date.now() / 1000 + 11644473600) * 10000000)
    );

    // Round down to the nearest 5 minutes (3,000,000,000 * 100ns = 5 minutes)
    ticks -= ticks % BigInt(3000000000);

    // Create the string to hash by concatenating the ticks and the trusted client token
    const strToHash = `${ticks}${TRUSTED_CLIENT_TOKEN}`;

    // Compute the SHA256 hash using Web Crypto API
    const encoder = new TextEncoder();
    const data = encoder.encode(strToHash);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);

    // Convert buffer to hex string and upper case
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();

    return hashHex;
  }

  private async ensureSocketReady(): Promise<void> {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      const reopened = !!this.socket;

      const Sec_MS_GEC = await this.generateSecMsGecToken();
      const Sec_MS_GEC_VERSION = "1-130.0.2849.68";

      const url = `${SYNTH_URL_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${Sec_MS_GEC}&Sec-MS-GEC-Version=${Sec_MS_GEC_VERSION}`;

      this.socket = new WebSocket(url);
      this.socket.onmessage = this.onSocketMessage.bind(this);
      this.socket.onclose = () => log.warn('Bing TTS WebSocket closed.');

      // Attach error handler immediately to suppress browser's default error logging
      let errorHandled = false;
      this.socket.onerror = () => {
        errorHandled = true;
      };

      await new Promise<void>((resolve, reject) => {
        if (!this.socket) {
          reject(new Error("WebSocket creation failed"));
          return;
        }

        this.socket.onerror = (error) => {
        log.debug('Bing TTS WebSocket error (will fallback to backend):', error);
          this.socket?.close();
          reject(new Error(`WebSocket error: ${error}`));
        };

        this.socket.onopen = () => {
          log.debug(reopened ? 'Bing TTS WebSocket reopened.' : 'Bing TTS WebSocket opened.');
          this.setAudioOutputFormat();
          resolve();
        };
      });
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve, reject) => {
        if (!this.socket) {
          reject(new Error("WebSocket is null"));
          return;
        }

        const handleOpen = () => {
          this.socket?.removeEventListener("error", handleError);
          resolve();
        };

        const handleError = (error: Event) => {
          this.socket?.removeEventListener("open", handleOpen);
          console.debug("Bing TTS WebSocket error during connection (will fallback to backend):", error);
          reject(new Error("WebSocket connection failed"));
        };

        this.socket.addEventListener("open", handleOpen, { once: true });
        this.socket.addEventListener("error", handleError, { once: true });
      });
    }
  }

  private async sendWhenReady(message: string): Promise<void> {
    await this.ensureSocketReady();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    } else {
      log.error('Socket not open even after ensureSocketReady');
    }
  }

  private async setAudioOutputFormat(
    format: string = AUDIO_FORMAT
  ): Promise<void> {
    const messagePayload = JSON.stringify({
      context: { synthesis: { audio: { outputFormat: format } } },
    });
    await this.sendWhenReady(`${CONTENT_TYPE_JSON}${messagePayload}`);
  }

  private async onSocketMessage(event: MessageEvent): Promise<void> {
    if (!(event.data instanceof Blob)) return;

    const dataText = await event.data.text();
    const requestIdMatch = dataText.match(/X-RequestId:(.*?)\r\n/);

    if (!requestIdMatch) {
      // Might be binary data without header in the first chunk if split differently,
      // but usually header comes in text part.
      // However, the logic in maldpe.js splits by BINARY_DELIM.
      // Let's stick closer to maldpe.js logic.
      return;
    }

    const requestId = requestIdMatch[1];
    const request = this.requests[requestId];
    if (!request) return;

    const arrayBuffer = await event.data.arrayBuffer();
    const dataView = new DataView(arrayBuffer);

    /* Check if the audio fragment is the last one */
    if (
      dataView.getUint8(0) === 0x00 &&
      dataView.getUint8(1) === 0x67 &&
      dataView.getUint8(2) === 0x58
    ) {
      // End of stream
      if (request.audioDataChunks.length) {
        const audioBlob = new Blob(request.audioDataChunks, {
          type: "audio/mp3",
        });
        request.resolve(URL.createObjectURL(audioBlob));
        delete this.requests[requestId];
      }
    } else {
      const delimiterIndex = dataText.indexOf(BINARY_DELIM);
      if (delimiterIndex !== -1) {
        const audioStartIndex = delimiterIndex + BINARY_DELIM.length;
        const audioData = new Blob([arrayBuffer.slice(audioStartIndex)]);
        request.audioDataChunks.push(audioData);
      }
    }
  }

  private createSSML(
    inputText: string,
    { locale, voice, pitch, rate, volume }: VoiceConfig
  ): string {
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">
            <voice name="${voice}"><prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${inputText}</prosody></voice>
        </speak>`;
  }

  // Simple UUID generator if we don't want external dependencies, but we can reuse the one from maldpe.js logic
  // or just use crypto.randomUUID() if available
  private generateUuid(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, "");
    }
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c == "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  public async playText(
    inputText: string,
    config: VoiceConfig
  ): Promise<string> {
    const ssml = this.createSSML(inputText, config);
    const requestId = this.generateUuid();
    const requestMessage = `X-RequestId:${requestId}\r\n${CONTENT_TYPE_SSML}${ssml}`;

    this.requests[requestId] = {
      audioDataChunks: [],
      resolve: () => {},
      reject: () => {},
    };

    const promise = new Promise<string>((resolve, reject) => {
      this.requests[requestId].resolve = resolve;
      this.requests[requestId].reject = reject;
    });

    await this.sendWhenReady(requestMessage);
    return promise;
  }
}

// Export a singleton instance
export const bingSpeechService = new BingSpeechService();
