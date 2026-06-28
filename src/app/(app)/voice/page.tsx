"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, RotateCcw, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth-provider";
import * as repo from "@/lib/data/repository";
import { startDemoSession } from "@/lib/voice/demo";
import { generateMiniMaxVoice, isMiniMaxVoiceConfigured, stopSpeaking, unlockAudio } from "@/lib/voice/minimax-tts";
import { isSpeechRecognitionSupported, startRealVoiceSession } from "@/lib/voice/minimax-live";
import { Markdown } from "@/components/chat/markdown";
import type { TranscriptTurn, ToolCallEvent, VoiceStatus, VoiceSession } from "@/lib/voice/types";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Tap to start",
  connecting: "Connecting…",
  ready: "Listening",
  listening: "Listening…",
  speaking: "ResQ is speaking",
  thinking: "ResQ is thinking",
  error: "Something went wrong",
  closed: "Session ended",
};

const STATUS_COLOR: Record<VoiceStatus, string> = {
  idle: "bg-muted-foreground",
  connecting: "bg-amber-500",
  ready: "bg-green-500",
  listening: "bg-red-500",
  speaking: "bg-primary",
  thinking: "bg-amber-500",
  error: "bg-destructive",
  closed: "bg-muted-foreground",
};

export default function VoicePage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcripts, setTranscripts] = useState<TranscriptTurn[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sttSupported, setSttSupported] = useState(false);
  const [compose, setCompose] = useState("");
  const [profileName, setProfileName] = useState<string | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Detect Web Speech API support after mount to avoid SSR hydration mismatch.
  useEffect(() => {
    setSttSupported(isSpeechRecognitionSupported());
  }, []);

  // Load the user's preferred name from their profile so ResQ addresses them by it.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await repo.profile.get(user.uid);
        if (!cancelled) setProfileName(p.name ?? null);
      } catch {
        /* fall back to display name below */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const canGoLive = isMiniMaxVoiceConfigured && sttSupported && !!user;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcripts]);

  const stop = useCallback(() => {
    stopSpeaking();
    if (sessionRef.current) {
      void sessionRef.current.stop();
      sessionRef.current = null;
    }
    setStatus("closed");
  }, []);

  const sendText = useCallback(() => {
    const text = compose.trim();
    if (!text || !sessionRef.current) return;
    setError(null);
    sessionRef.current.sendText(text);
    setCompose("");
  }, [compose]);

  const start = useCallback(async () => {
    setError(null);
    setTranscripts([]);
    setToolCalls([]);
    // Unlock audio inside this user gesture so Safari permits TTS playback
    // later (the actual play() happens after STT + agent latency).
    unlockAudio();

    const callbacks = {
      onStatus: (s: VoiceStatus) => setStatus(s),
      onTranscript: (turn: TranscriptTurn) => {
        setTranscripts((prev) => [...prev, turn]);
        // In demo mode, speak assistant turns aloud via MiniMax T2A when
        // configured. (Live mode handles its own TTS in the session loop.)
        if (!canGoLive && turn.role === "assistant" && !turn.partial && isMiniMaxVoiceConfigured) {
          void generateMiniMaxVoice({ text: turn.text });
        }
      },
      onTranscriptUpdate: (id: string, text: string, partial: boolean) => {
        setTranscripts((prev) =>
          prev.map((t) => (t.id === id ? { ...t, text, partial } : t))
        );
      },
      onToolCall: (call: ToolCallEvent) => {
        setToolCalls((prev) => [...prev, call]);
      },
      onError: (err: Error) => {
        setError(err.message);
        // Don't force status:error — the session manages status so the text
        // compose box stays usable when speech recognition is unavailable.
      },
    };

    if (canGoLive && user) {
      // Option B: real voice — Web Speech API STT → /api/agent → MiniMax T2A.
      try {
        sessionRef.current = startRealVoiceSession(callbacks, {
          userId: user.uid,
          userName: profileName ?? user.displayName ?? user.email ?? "there",
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    } else {
      // Fallback: scripted demo session.
      sessionRef.current = startDemoSession(callbacks) as unknown as VoiceSession;
    }
  }, [canGoLive, user]);

  useEffect(() => {
    return () => {
      if (sessionRef.current) void sessionRef.current.stop();
    };
  }, []);

  const isLive = status !== "idle" && status !== "closed" && status !== "error";

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-8">
      <div className="mx-auto w-full max-w-2xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Badge variant="secondary" className="mb-2">
              {canGoLive
                ? "Google Voice · Live STT→LLM→TTS"
                : !isMiniMaxVoiceConfigured
                ? "Demo mode · Google voice not configured"
                : !sttSupported
                ? "Demo mode · Speech API unsupported (use Chrome)"
                : "Demo mode · sign in to enable live voice"}
            </Badge>
            <h1 className="text-3xl font-bold tracking-tight">Voice Mode</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Talk to ResQ hands-free. Try:
              <span className="ml-1 italic text-foreground/80">
                &ldquo;Hey ResQ, what&rsquo;s about to blow up?&rdquo;
              </span>
            </p>
          </div>
          {isLive && (
            <Button variant="outline" size="sm" onClick={stop}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> End session
            </Button>
          )}
        </div>

        {/* Mic orb */}
        <div className="relative mx-auto mb-8 h-56 w-56">
          <div
            className={cn(
              "absolute inset-0 rounded-full border-2 border-primary/30 transition-opacity",
              status === "listening" || status === "speaking"
                ? "animate-ping opacity-100"
                : "opacity-40"
            )}
          />
          <div
            className={cn(
              "absolute inset-4 rounded-full border-2 border-primary/40 transition-opacity",
              status === "listening" || status === "speaking"
                ? "animate-pulse opacity-100"
                : "opacity-40"
            )}
            style={{ animationDelay: "0.2s" }}
          />
          <div
            className={cn(
              "absolute inset-8 rounded-full border-2 border-primary/50 transition-opacity",
              isLive ? "animate-pulse opacity-100" : "opacity-40"
            )}
            style={{ animationDelay: "0.4s" }}
          />

          <button
            onClick={isLive ? stop : start}
            disabled={status === "connecting"}
            className={cn(
              "absolute inset-12 flex items-center justify-center rounded-full bg-gradient-to-br shadow-2xl transition-all",
              isLive
                ? "from-red-500 to-orange-500 scale-110 shadow-red-500/50"
                : "from-primary to-orange-500 shadow-primary/50 hover:scale-105",
              status === "connecting" && "animate-pulse"
            )}
            aria-label={isLive ? "End voice session" : "Start voice session"}
          >
            {isLive ? (
              <MicOff className="h-12 w-12 text-white" />
            ) : (
              <Mic className="h-12 w-12 text-white" />
            )}
          </button>
        </div>

        {/* Status bar */}
        <div className="mb-6 flex items-center justify-center gap-2 text-sm">
          <span className={cn("h-2 w-2 rounded-full", STATUS_COLOR[status])} />
          <span className="font-medium">{STATUS_LABEL[status]}</span>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Text fallback for live mode (e.g. when STT is blocked on this network) */}
        {canGoLive && isLive && (
          <Card className="mb-6">
            <CardContent className="p-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendText();
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  value={compose}
                  onChange={(e) => setCompose(e.target.value)}
                  placeholder="Type to ResQ. Replies are spoken out loud…"
                  className="flex-1 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <Button type="submit" size="sm" disabled={!compose.trim()}>
                  Send
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Transcript */}
        {transcripts.length > 0 && (
          <Card className="mb-6">
            <CardContent className="p-0">
              <div ref={scrollRef} className="max-h-80 overflow-y-auto p-4">
                <div className="space-y-3">
                  {transcripts.map((turn) => (
                    <div
                      key={turn.id}
                      className={cn(
                        "flex gap-2 text-sm",
                        turn.role === "user" ? "justify-end" : "justify-start"
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[80%] rounded-2xl px-3 py-2 leading-relaxed",
                          turn.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : turn.role === "system"
                            ? "bg-muted text-muted-foreground italic"
                            : "bg-card border border-border/60 text-foreground",
                          turn.partial && "animate-pulse"
                        )}
                      >
                        {turn.role === "assistant" ? (
                          <Markdown content={turn.text} />
                        ) : (
                          turn.text
                        )}
                        {turn.partial && (
                          <span className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-current align-middle" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tool calls observed */}
        {toolCalls.length > 0 && (
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {canGoLive ? `ResQ did this (${toolCalls.length})` : `ResQ would do this (${toolCalls.length})`}
              </div>
              <div className="space-y-2">
                {toolCalls.map((call) => (
                  <div
                    key={call.id}
                    className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 p-2 text-xs"
                  >
                    <Badge variant="secondary" className="text-[10px]">
                      {call.name}
                    </Badge>
                    <span className="truncate font-mono text-foreground/70">
                      {JSON.stringify(call.args)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {canGoLive
                  ? "Actions ran via the agent. Review results in Tasks, Inbox, or Calendar."
                  : "Voice mode visualizes actions without executing. Open chat to confirm."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Suggested phrases */}
        {!isLive && (
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Try saying
              </p>
              <ul className="space-y-2 text-sm">
                {[
                  "What's at risk right now?",
                  "Block a 90-minute focus session tomorrow morning",
                  "Draft a follow-up email to my professor",
                  "How am I doing this week?",
                ].map((phrase) => (
                  <li
                    key={phrase}
                    className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2"
                  >
                    <Volume2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                    <span className="italic">&ldquo;{phrase}&rdquo;</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}