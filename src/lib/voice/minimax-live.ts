"use client";

/**
 * Real voice session — Option B from PROJECTCOMPLETE.md.
 *
 * Pipeline (all in the browser, no realtime WebSocket needed):
 *   mic → Web Speech API (STT) → /api/agent (MiniMax chat, SSE) → MiniMax T2A → speaker
 *
 * The session is conversational: after ResQ finishes speaking, the mic is
 * re-armed for the next turn. Tool calls from the agent are surfaced as
 * visualized events (not executed) — same contract as the demo session.
 */

import { streamAgentResponse } from "@/lib/agent/stream";
import {
  generateMiniMaxVoiceAndWait,
  stopSpeaking,
  unlockAudio,
} from "@/lib/voice/minimax-tts";
import type {
  VoiceSession,
  VoiceSessionCallbacks,
  VoiceStatus,
} from "@/lib/voice/types";

// ---------- Minimal Web Speech API typings (not in TS DOM lib) ----------

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((e: Event) => void) | null;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export interface RealVoiceOptions {
  userId: string;
  userName: string;
  lang?: string;
}

/**
 * Start a real voice session. Throws if the Web Speech API isn't available
 * so the caller can fall back to the scripted demo.
 */
export function startRealVoiceSession(
  callbacks: VoiceSessionCallbacks,
  opts: RealVoiceOptions
): VoiceSession {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    throw new Error(
      "Web Speech API is not supported in this browser. Try Google Chrome on desktop."
    );
  }

  const recognition = new Ctor();
  recognition.lang = opts.lang ?? "en-US";
  recognition.continuous = false; // single utterance per turn; we restart on end
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let status: VoiceStatus = "idle";
  let stopped = false;
  let processing = false; // true while waiting on agent / speaking
  let sttDead = false; // true if speech recognition is unusable (e.g. network blocked)
  let userTurnId: string | null = null;
  let assistantTurnId: string | null = null;
  let currentAssistantText = "";
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  const history: { role: "user" | "assistant" | "function"; content: string }[] = [];

  const setStatus = (s: VoiceStatus) => {
    status = s;
    callbacks.onStatus(s);
  };
  const id = (prefix: string) =>
    `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const startListening = () => {
    if (stopped || processing || sttDead) return;
    userTurnId = null;
    try {
      recognition.start();
    } catch {
      // start() throws if already started — ignore.
    }
  };

  recognition.onstart = () => {
    if (!stopped) setStatus("listening");
  };

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i]!;
      if (res.isFinal) final += res[0]!.transcript;
      else interim += res[0]!.transcript;
    }
    const text = (final || interim).trim();
    if (!text) return;

    if (!userTurnId) {
      userTurnId = id("u");
      callbacks.onTranscript({
        id: userTurnId,
        role: "user",
        text,
        partial: !final,
        ts: Date.now(),
      });
    } else {
      callbacks.onTranscriptUpdate(userTurnId, text, !final);
    }

    if (final) {
      processing = true;
      try {
        recognition.stop();
      } catch {
        /* noop */
      }
      setStatus("thinking");
      void handleTurn(final.trim());
    }
  };

  recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
    const err = e.error ?? "speech-recognition-error";
    // no-speech / aborted are expected during normal pause/stop flow.
    if (err === "no-speech" || err === "aborted") return;

    // Fatal: the browser can't reach its speech service (e.g. Google's
    // endpoints are blocked on this network/region) or the mic is denied.
    // Don't keep retrying — surface a helpful message and keep the session
    // alive so the user can type instead.
    const fatal = [
      "network",
      "service-not-allowed",
      "not-allowed",
      "audio-capture",
      "language-not-supported",
    ].includes(err);

    if (fatal) {
      sttDead = true;
      if (resumeTimer) clearTimeout(resumeTimer);
      const msg =
        err === "not-allowed" || err === "audio-capture"
          ? "Microphone is blocked. End the session, allow mic access, and start again — or type a message below."
          : "Live speech-to-text is unavailable on this network/browser. Type a message below and ResQ will reply out loud.";
      callbacks.onError(new Error(msg));
      // If this fired mid-turn, unblock processing so the UI isn't stuck in
      // thinking/speaking forever; otherwise just return to ready.
      processing = false;
      setStatus("ready");
      return;
    }

    callbacks.onError(new Error(`Speech recognition error: ${err}`));
  };

  recognition.onend = () => {
    if (stopped) {
      setStatus("closed");
      return;
    }
    // If STT is unusable, don't re-arm the mic — let the user type.
    if (sttDead) return;
    // If we're not mid-turn, re-arm the mic for the next utterance.
    if (!processing && status !== "thinking" && status !== "speaking") {
      setStatus("ready");
      resumeTimer = setTimeout(startListening, 200);
    }
  };

  async function handleTurn(userText: string) {
    if (userTurnId) callbacks.onTranscriptUpdate(userTurnId, userText, false);

    assistantTurnId = id("a");
    currentAssistantText = "";
    callbacks.onTranscript({
      id: assistantTurnId,
      role: "assistant",
      text: "",
      partial: true,
      ts: Date.now(),
    });

    let turnErrored = false;
    await new Promise<void>((resolve) => {
      streamAgentResponse({
        userId: opts.userId,
        userName: opts.userName,
        message: userText,
        history,
        onText: (chunk) => {
          currentAssistantText += chunk;
          if (assistantTurnId) {
            callbacks.onTranscriptUpdate(assistantTurnId, currentAssistantText, true);
          }
        },
        onAction: (action) => {
          callbacks.onToolCall({
            id: id("t"),
            name: action.tool,
            args: action.args,
            ts: Date.now(),
            status: "visualized",
          });
        },
        onError: (errMsg) => {
          turnErrored = true;
          callbacks.onError(new Error(errMsg));
          resolve();
        },
        onDone: () => resolve(),
      });
    });

    if (stopped) return;

    // If the agent stream errored, don't speak a bogus fallback or record it as
    // a real assistant turn — reset and re-arm so the user can try again.
    if (turnErrored) {
      if (assistantTurnId) {
        callbacks.onTranscriptUpdate(assistantTurnId, "(Sorry, that didn't go through. Try again.)", false);
      }
      processing = false;
      setStatus("ready");
      if (!sttDead) resumeTimer = setTimeout(startListening, 300);
      return;
    }

    const finalText = currentAssistantText || "(I'm here, what's next?)";
    if (assistantTurnId) callbacks.onTranscriptUpdate(assistantTurnId, finalText, false);

    history.push({ role: "user", content: userText });
    history.push({ role: "assistant", content: finalText });

    // Speak the full reply in one TTS call. Synthesizing the whole text (rather
    // than per-sentence clips) preserves prosody and avoids MP3 primer/padding
    // truncating word endings — single-call speech sounds natural.
    setStatus("speaking");
    await generateMiniMaxVoiceAndWait({ text: finalText });

    if (stopped) return;

    // Re-arm the mic for the next turn.
    processing = false;
    setStatus("ready");
    resumeTimer = setTimeout(startListening, 300);
  }

  // Kickoff — unlock the persistent audio element inside this user gesture so
  // Safari will allow our later TTS play() calls (which happen after STT/agent
  // latency, outside any gesture).
  unlockAudio();
  setStatus("connecting");
  resumeTimer = setTimeout(() => {
    if (stopped) return;
    setStatus("ready");
    startListening();
  }, 350);

  const stop = async () => {
    stopped = true;
    processing = false;
    if (resumeTimer) clearTimeout(resumeTimer);
    stopSpeaking();
    try {
      recognition.abort();
    } catch {
      /* noop */
    }
    setStatus("closed");
  };

  const sendText = (text: string) => {
    if (stopped) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Ignore sends while a turn is already in flight — otherwise two concurrent
    // handleTurn calls overlap agent requests and TTS playback.
    if (processing) return;
    // The Send button is a fresh user gesture — re-unlock in case Safari
    // dropped the activation (e.g. after a long prior turn).
    unlockAudio();
    processing = true;
    try {
      recognition.stop();
    } catch {
      /* noop */
    }
    // Surface the typed message as a user bubble above the reply.
    userTurnId = id("u");
    callbacks.onTranscript({
      id: userTurnId,
      role: "user",
      text: trimmed,
      partial: false,
      ts: Date.now(),
    });
    setStatus("thinking");
    void handleTurn(trimmed);
  };

  return {
    stop,
    sendText,
    status: () => status,
  };
}
