/**
 * MiniMax T2A (Text-to-Speech) integration.
 * Converts ResQ's text responses to audio for voice mode.
 *
 * The T2A endpoint returns JSON with a hex-encoded audio string in
 * `data.audio` (NOT raw audio bytes), so we decode the hex into a Uint8Array
 * before handing it to the <audio> element.
 *
 * Safari note: Safari blocks `audio.play()` that isn't initiated (directly or
 * via a previously-unlocked element) by a user gesture. Because our play()
 * happens seconds after the mic tap (after STT → agent → synthesize → TTS),
 * Safari throws NotAllowedError. We solve this with ONE persistent <audio>
 * element that is "unlocked" once inside the mic-tap / send gesture, then
 * reused for every TTS clip. See unlockAudio().
 *
 * Configure via env:
 *   MINIMAX_API_KEY           — server-side key (required)
 *   NEXT_PUBLIC_MINIMAX_API_KEY — browser-side key (required for client-side TTS)
 *   MINIMAX_T2A_URL           — T2A base URL, defaults to https://api.minimax.io/v1
 */

const API_KEY =
  process.env.MINIMAX_API_KEY ?? process.env.NEXT_PUBLIC_MINIMAX_API_KEY;
const T2A_URL = process.env.MINIMAX_T2A_URL ?? "https://api.minimax.io/v1";

export const isMiniMaxVoiceConfigured = Boolean(API_KEY && T2A_URL);

export interface TTSOptions {
  text: string;
  model?: string;
  voice?: string;
  speed?: number;
}

/** Decode a hex string into a Uint8Array (browser-safe, no Buffer). */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0) {
    throw new Error("Malformed TTS audio (odd-length hex)");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

interface T2AResponse {
  data?: { audio?: string; status?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

export async function generateSpeech(
  options: TTSOptions & { signal?: AbortSignal }
): Promise<ArrayBuffer> {
  if (!API_KEY) throw new Error("MINIMAX_API_KEY not set");

  const response = await fetch(`${T2A_URL}/t2a_v2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: options.model ?? "speech-2.6-hd",
      text: options.text,
      stream: false,
      voice_setting: {
        voice_id: options.voice ?? "English_expressive_narrator",
        speed: options.speed ?? 1.0,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
      output_format: "hex",
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TTS API error ${response.status}: ${text}`);
  }

  const json = (await response.json()) as T2AResponse;
  const status = json.base_resp?.status_code ?? 0;
  if (status !== 0) {
    throw new Error(`TTS API error [${status}]: ${json.base_resp?.status_msg ?? "unknown"}`);
  }

  const audioHex = json.data?.audio;
  if (!audioHex) throw new Error("TTS API returned no audio data");

  return hexToBytes(audioHex).buffer as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Persistent, gesture-unlocked player (Safari autoplay fix)
// ---------------------------------------------------------------------------

let player: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let audioUnlocked = false;
let cancelPlayback: (() => void) | null = null;
let activeFetchAbort: AbortController | null = null;

function ensurePlayer(): HTMLAudioElement {
  if (typeof window === "undefined") throw new Error("Audio requires a browser");
  if (!player) {
    player = new Audio();
    player.preload = "auto";
    player.setAttribute("playsinline", "");
  }
  return player;
}

/** Build a valid 0-frame silent WAV so Safari has something real to "play". */
function buildSilentWavUrl(): string {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, 0, true); // 0 data bytes
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * MUST be called from within a user-gesture handler (mic tap, Send click).
 * Plays a silent clip on the persistent element so Safari treats it as
 * user-activated, allowing later programmatic play() of TTS audio.
 */
export function unlockAudio(): void {
  if (typeof window === "undefined" || audioUnlocked) return;
  try {
    const el = ensurePlayer();
    const url = buildSilentWavUrl();
    el.muted = true;
    el.src = url;
    el.loop = false;
    const p = el.play();
    const finish = () => {
      try { el.pause(); } catch { /* noop */ }
      el.muted = false;
      URL.revokeObjectURL(url);
      audioUnlocked = true;
    };
    if (p && typeof p.then === "function") {
      p.then(finish).catch(() => {
        // Unlock failed (e.g. user gesture didn't register) — reset the flag so
        // a later unlockAudio() (next Send / next session) can retry instead of
        // being skipped forever.
        audioUnlocked = false;
        el.muted = false;
        URL.revokeObjectURL(url);
      });
    } else {
      finish();
    }
  } catch {
    /* noop */
  }
}

/**
 * Immediately stop any in-flight TTS fetch and audio playback.
 * Call when the user taps the mic to end/interrupt a voice session.
 */
export function stopSpeaking(): void {
  activeFetchAbort?.abort();
  activeFetchAbort = null;

  cancelPlayback?.();
  cancelPlayback = null;

  const el = player;
  if (el) {
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      /* noop */
    }
    try {
      el.removeAttribute("src");
      el.load();
    } catch {
      /* noop */
    }
  }
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
}

/**
 * Play one TTS clip on the persistent (unlocked) element. Resolves when
 * playback ends or errors. Reusing the same element is what lets Safari allow
 * the play() call outside the original gesture.
 */
function playOnPlayer(buffer: ArrayBuffer): Promise<void> {
  return new Promise((resolve) => {
    const el = ensurePlayer();
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/mp3" }));
    activeObjectUrl = url;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelPlayback = null;
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      if (activeObjectUrl === url) {
        URL.revokeObjectURL(url);
        activeObjectUrl = null;
      }
      resolve();
    };

    cancelPlayback = finish;

    const onEnded = () => finish();
    const onError = () => finish();

    el.addEventListener("ended", onEnded, { once: true });
    el.addEventListener("error", onError, { once: true });
    el.src = url;
    try {
      el.currentTime = 0;
    } catch {
      /* noop */
    }

    const p = el.play();
    if (p && typeof p.then === "function") {
      p.catch((err) => {
        console.warn("[minimax-tts] audio playback failed:", err);
        finish();
      });
    }
  });
}

export function playAudio(arrayBuffer: ArrayBuffer): void {
  void playOnPlayer(arrayBuffer);
}

export function playAudioAsync(arrayBuffer: ArrayBuffer): Promise<void> {
  return playOnPlayer(arrayBuffer);
}

/**
 * Browser-friendly helper exposed under the MiniMax Voice name. Renders a text
 * response to speech via MiniMax T2A. No-op (returns false) when the public
 * key isn't configured so callers can fall back to demo mode. Fire-and-forget
 * — does not wait for playback to finish.
 */
export async function generateMiniMaxVoice(
  options: TTSOptions
): Promise<boolean> {
  if (!isMiniMaxVoiceConfigured) return false;
  try {
    const buffer = await generateSpeech(options);
    playAudio(buffer);
    return true;
  } catch (err) {
    console.warn("[minimax-tts] speech generation failed:", err);
    return false;
  }
}

/**
 * Same as generateMiniMaxVoice, but waits for playback to finish before
 * resolving. Used by the live voice session so it can re-arm the mic only
 * after ResQ has finished speaking.
 */
export async function generateMiniMaxVoiceAndWait(
  options: TTSOptions
): Promise<boolean> {
  if (!isMiniMaxVoiceConfigured) return false;
  stopSpeaking();
  const controller = new AbortController();
  activeFetchAbort = controller;
  try {
    const buffer = await generateSpeech({ ...options, signal: controller.signal });
    if (controller.signal.aborted) return false;
    activeFetchAbort = null;
    await playAudioAsync(buffer);
    return !controller.signal.aborted;
  } catch (err) {
    if (controller.signal.aborted) return false;
    console.warn("[minimax-tts] speech generation failed:", err);
    return false;
  } finally {
    if (activeFetchAbort === controller) activeFetchAbort = null;
  }
}
