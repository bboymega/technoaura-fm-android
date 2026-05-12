"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronUp,
  Loader2,
  Play,
  Square,
  X,
  Settings
} from "lucide-react";

type StreamQuality = {
  id: string;
  label: string;
  description: string;
  url: string;
};

import { MediaSession } from '@capgo/capacitor-media-session';
import { Preferences } from "@capacitor/preferences";
import { App } from "@capacitor/app";

export default function Page() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fsQualityRef = useRef<HTMLDivElement | null>(null);
  const sidebarQualityRef = useRef<HTMLDivElement | null>(null);
  const externalPauseRef = useRef(false);
  const userPausedRef = useRef(false);
  const streamFailedRef = useRef(false);
  const QUALITY_STORAGE_KEY = "selected-stream-quality";

  // 0 = paused
  // 1 = buffering/recovering
  // 2 = playing
  const [playing, setPlaying] = useState(0);
  const [fsQualityOpen, setFsQualityOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);

  const qualities: StreamQuality[] = [
    {
      id: "24_96",
      label: "UHQ",
      description: "24-bit / 96 kHz",
      url: process.env.NEXT_PUBLIC_STREAM_URL_24_96!,
    },
    {
      id: "24_48",
      label: " HQ",
      description: "24-bit / 48 kHz",
      url: process.env.NEXT_PUBLIC_STREAM_URL_24_48!,
    },
    {
      id: "16_44",
      label: "SD",
      description: "16-bit / 44.1 kHz",
      url: process.env.NEXT_PUBLIC_STREAM_URL_16_44!,
    },
  ];

  const [selectedQuality, setSelectedQuality] = useState<StreamQuality>(qualities[0]);

  useEffect(() => {
    const loadSavedQuality = async () => {
      try {
        const { value } = await Preferences.get({
          key: QUALITY_STORAGE_KEY,
        });

        if (!value) return;

        const savedQuality = qualities.find(
          (q) => q.id === value,
        );

        if (savedQuality) {
          setSelectedQuality(savedQuality);
        }
      } catch (err) {
      }
    };

    void loadSavedQuality();
  }, []);

  const streamUrl = selectedQuality.url;

  /**
   * Prevent stale closures during:
   * - recovery
   * - reconnect
   * - health checks
   * - quality switches
   */
  const streamUrlRef = useRef(streamUrl);

  useEffect(() => {
    streamUrlRef.current = streamUrl;
  }, [streamUrl]);

  const retryCountRef = useRef(0);

  const healthIntervalRef =
    useRef<ReturnType<typeof setInterval> | null>(
      null,
    );

  const recoveringRef = useRef(false);

  const manualStopRef = useRef(false);

  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopHealthCheck = () => {
    if (healthIntervalRef.current !== null) {
      clearInterval(healthIntervalRef.current);

      healthIntervalRef.current = null;
    }

    retryCountRef.current = 0;

    recoveringRef.current = false;
  };

  const startHealthCheck = (interval = 2500) => {
    if (healthIntervalRef.current !== null) {
      clearInterval(healthIntervalRef.current);
    }

    healthIntervalRef.current = setInterval(() => {
      void healthCheck();
    }, interval);
  };

  const hardResetAudio = () => {
    const audio = audioRef.current;

    if (!audio) return;

    audio.pause();

    audio.src = "";

    audio.removeAttribute("src");

    audio.load();
  };

  const reconnectStream = async () => {
    const audio = audioRef.current;

    if (!audio) return;

    if (
      externalPauseRef.current ||
      userPausedRef.current
    ) {
      return;
    }

    try {
      hardResetAudio();

      audio.src = streamUrlRef.current;

      audio.load();

      await audio.play();

      await MediaSession.setPlaybackState({
        playbackState: "playing",
      });

      recoveringRef.current = false;

      retryCountRef.current = 0;

      setPlaying(2);

      startHealthCheck(2500);
    } catch (err) {
      console.error("Reconnect failed", err);
    }
  };

  const healthCheck = async () => {
    const audio = audioRef.current;

    if (!audio) return;
    if (
      externalPauseRef.current ||
      userPausedRef.current
    ) {
      return;
    }

    const controller = new AbortController();

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 2000);

    try {
      const currentUrl = streamUrlRef.current;

      const res = await fetch(currentUrl, {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error("Stream unavailable");
      }

      retryCountRef.current = 0;

      // Recover if needed
      if (recoveringRef.current) {
        await reconnectStream();
      }
    } catch {
      clearTimeout(timeoutId);

      retryCountRef.current += 1;

      // Enter recovery mode
      if (
        retryCountRef.current > 1 &&
        !recoveringRef.current
      ) {
        recoveringRef.current = true;

        setPlaying(1);

        manualStopRef.current = true;

        hardResetAudio();

        manualStopRef.current = false;

        // Faster polling while recovering
        startHealthCheck(2000);
      }

      // Give up
      if (retryCountRef.current >= 15) {
        stopHealthCheck();

        manualStopRef.current = true;

        hardResetAudio();

        manualStopRef.current = false;

        setPlaying(0);

        await MediaSession.setPlaybackState({
          playbackState: "paused",
        });
      }
    }
  };

  const playingRef = useRef(playing);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) return;

    const syncPlayingState = async () => {
      if (!audio.paused && !audio.ended) {
        externalPauseRef.current = false;

        setPlaying(2);

        await MediaSession.setPlaybackState({
          playbackState: "playing",
        });

        startHealthCheck(2500);
      } else {
        setPlaying(0);

        await MediaSession.setPlaybackState({
          playbackState: "paused",
        });
      }
    };

    const handleAudioPlaying = async () => {
      if (pauseTimeoutRef.current) {
        clearTimeout(pauseTimeoutRef.current);

        pauseTimeoutRef.current = null;
      }

      await syncPlayingState();
    };

    const handleAudioPause = async () => {
      if (
        manualStopRef.current ||
        recoveringRef.current ||
        userPausedRef.current
      ) {
        return;
      }

      // transient interruption protection
      pauseTimeoutRef.current = setTimeout(async () => {
        if (audio.paused) {
          externalPauseRef.current = true;

          stopHealthCheck();

          setPlaying(0);

          await MediaSession.setPlaybackState({
            playbackState: "paused",
          });
        }
      }, 1500);
    };

    const handleAudioError = async () => {
      if (
        recoveringRef.current ||
        userPausedRef.current ||
        externalPauseRef.current
      ) {
        return;
      }

      streamFailedRef.current = true;

      recoveringRef.current = true;

      setPlaying(1);

      startHealthCheck(2000);
    };

    const handleEnded = async () => {
      setPlaying(0);

      await MediaSession.setPlaybackState({
        playbackState: "paused",
      });
    };

    audio.addEventListener("pause", handleAudioPause);

    audio.addEventListener(
      "playing",
      handleAudioPlaying,
    );

    audio.addEventListener(
      "play",
      handleAudioPlaying,
    );

    audio.addEventListener("ended", handleEnded);

    audio.addEventListener("error", handleAudioError);

    return () => {
      if (pauseTimeoutRef.current) {
        clearTimeout(pauseTimeoutRef.current);
      }

      audio.removeEventListener(
        "pause",
        handleAudioPause,
      );

      audio.removeEventListener(
        "playing",
        handleAudioPlaying,
      );

      audio.removeEventListener(
        "play",
        handleAudioPlaying,
      );

      audio.removeEventListener(
        "ended",
        handleEnded,
      );

      audio.removeEventListener(
        "error",
        handleAudioError,
      );

      stopHealthCheck();
    };
  }, []);

  useEffect(() => {
    const setupBackButton = async () => {
      const listener = await App.addListener(
        "backButton",
        ({ canGoBack }) => {
          // CLOSE FULLSCREEN QUALITY MENU FIRST
          if (fsQualityOpen) {
            setFsQualityOpen(false);
            return;
          }

          // CLOSE SIDEBAR QUALITY MENU
          if (qualityMenuOpen) {
            setQualityMenuOpen(false);
            return;
          }

          // CLOSE FULLSCREEN PLAYER
          if (controlsOpen) {
            setControlsOpen(false);
            return;
          }

          // OTHERWISE:
          // let Android behave normally
          if (canGoBack) {
            window.history.back();
          } else {
            App.minimizeApp();
          }
        },
      );

      return listener;
    };

    let cleanup:
      | {
          remove: () => Promise<void>;
        }
      | undefined;

    void setupBackButton().then((l) => {
      cleanup = l;
    });

    return () => {
      void cleanup?.remove();
    };
  }, [fsQualityOpen, qualityMenuOpen, controlsOpen]);

  useEffect(() => {
    if (controlsOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [controlsOpen]);

  useEffect(() => {
    if (!fsQualityOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;

      if (
        fsQualityRef.current &&
        !fsQualityRef.current.contains(target)
      ) {
        setFsQualityOpen(false);
      }
    };

    // pointer events cover mouse + touch + pen
    document.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDown,
      );
    };
  }, [fsQualityOpen]);

  useEffect(() => {
    if (!qualityMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;

      if (
        sidebarQualityRef.current &&
        !sidebarQualityRef.current.contains(target)
      ) {
        setQualityMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDown,
      );
    };
  }, [qualityMenuOpen]);


  useEffect(() => {
    const setupMediaSession = async () => {
      await MediaSession.setMetadata({
        title: "TechnoAura Live Radio",
        artist: "TechnoAura",
        album: "Nonstop vibes 24/7",
      });

      //await MediaSession.setPlaybackState({
      //  playbackState: 'paused',
      //});

      await MediaSession.setActionHandler(
        { action: "play" },
        async () => {
          const audio = audioRef.current;

          if (!audio || !audio.paused) return;
          userPausedRef.current = false;
          externalPauseRef.current = false;
          streamFailedRef.current = false;

          try {
            setPlaying(1);

            hardResetAudio();

            audio.src = streamUrlRef.current;

            audio.load();

            await audio.play();

            await MediaSession.setPlaybackState({
              playbackState: "playing",
            });

            retryCountRef.current = 0;

            recoveringRef.current = false;

            setPlaying(2);

            startHealthCheck(2500);

          } catch (err) {
            //console.error("MediaSession play failed", err);

            setPlaying(0);

            await MediaSession.setPlaybackState({
              playbackState: "paused",
            });
          }
        },
      );

      await MediaSession.setActionHandler(
        { action: "pause" },
        async () => {
          const audio = audioRef.current;

          if (!audio) return;
          userPausedRef.current = true;
          externalPauseRef.current = false;
          streamFailedRef.current = false;

          manualStopRef.current = true;

          stopHealthCheck();

          setPlaying(0);

          await MediaSession.setPlaybackState({
            playbackState: "paused",
          });

          hardResetAudio();

          manualStopRef.current = false;

          await MediaSession.setPlaybackState({
            playbackState: "paused",
          });
        },
      );
    };

    setupMediaSession();
    
  }, []);

  const togglePlayback = async () => {
    const audio = audioRef.current;

    if (!audio) return;

    // PLAY
    if (audio.paused) {
      try {
        userPausedRef.current = false;
        externalPauseRef.current = false;
        streamFailedRef.current = false;
        setPlaying(1);

        hardResetAudio();

        audio.src = streamUrlRef.current;

        audio.load();

        await audio.play();

        await MediaSession.setPlaybackState({
          playbackState: "playing",
        });

        retryCountRef.current = 0;

        recoveringRef.current = false;

        setPlaying(2);

        startHealthCheck(2500);
      } catch (error) {
        //console.error(error);

        stopHealthCheck();

        setPlaying(0);

        await MediaSession.setPlaybackState({
          playbackState: "paused",
        });

        hardResetAudio();
      }
    }

    // STOP
    else {
      userPausedRef.current = true;
      externalPauseRef.current = false;
      streamFailedRef.current = false;
      manualStopRef.current = true;

      stopHealthCheck();

      setPlaying(0);

      await MediaSession.setPlaybackState({
        playbackState: "paused",
      });

      hardResetAudio();

      manualStopRef.current = false;
    }
  };

  const changeQuality = async (
    quality: StreamQuality,
  ) => {

    if (quality.url === selectedQuality.url) {
      setQualityMenuOpen(false);
      return;
    }

    const wasPlaying = playing === 2;

    setSelectedQuality(quality);

    await Preferences.set({
      key: QUALITY_STORAGE_KEY,
      value: quality.id,
    });

    setQualityMenuOpen(false);

    if (!wasPlaying) return;

    const audio = audioRef.current;

    if (!audio) return;

    try {
      setPlaying(1);

      hardResetAudio();

      audio.src = quality.url;

      audio.load();

      await audio.play();

      await MediaSession.setPlaybackState({
        playbackState: "playing",
      });

      setPlaying(2);

      retryCountRef.current = 0;

      recoveringRef.current = false;

      startHealthCheck(2500);
    } catch (err) {
      console.error("Quality switch failed", err);

      setPlaying(0);

      await MediaSession.setPlaybackState({
        playbackState: "paused",
      });

      hardResetAudio();
    }
  };

  const ChannelArtwork = () => (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      fill="none"
    >
      <rect
        x="8"
        y="8"
        width="84"
        height="84"
        rx="16"
        fill={process.env.NEXT_PUBLIC_CHANNEL_COLOR}
      />

      <g
        stroke="#e4e4e7"
        strokeWidth="5"
        strokeLinecap="round"
      >
        <path d="M24 60V40" />
        <path d="M36 68V32" />
        <path d="M50 76V24" />
        <path d="M64 68V32" />
        <path d="M76 60V40" />
      </g>
    </svg>
  );

  return (
    <div
      className="
        h-[100dvh]
        overflow-hidden
        overscroll-none
        touch-pan-y
        select-none
        text-white
      "
      style={{
        backgroundColor:
          process.env.NEXT_PUBLIC_BACKGROUND_COLOR,

        WebkitTapHighlightColor: "transparent",
        WebkitTouchCallout: "none",
      }}
    >
      <audio ref={audioRef} preload="none" />

      {/* Scroll Container */}
      <div
        className="
          h-full
          overflow-y-auto
          overscroll-y-contain
          scroll-smooth
          [-webkit-overflow-scrolling:touch]
        "
      >
        <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 pt-10 pb-40">
          <div className="mb-8">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-400">
              Live radio
            </p>
          </div>

          <div className="mx-auto w-full max-w-sm shrink-0">
            <div className="flex aspect-square min-h-0 w-full items-center justify-center overflow-hidden rounded-3xl bg-zinc-800 p-8 shadow-2xl ring-1 ring-white/5">
              <svg
                viewBox="0 0 240 240"
                preserveAspectRatio="xMidYMid meet"
                className="h-full w-full"
                fill="none"
              >
                <rect
                  x="12"
                  y="12"
                  width="216"
                  height="216"
                  rx="28"
                  fill={
                    process.env.NEXT_PUBLIC_CHANNEL_COLOR
                  }
                />

                <g
                  stroke="#e4e4e7"
                  strokeWidth="8"
                  strokeLinecap="round"
                >
                  <path d="M44 140V100" />
                  <path d="M64 160V80" />
                  <path d="M84 176V64" />
                  <path d="M104 150V90" />
                  <path d="M124 188V52" />
                  <path d="M144 150V90" />
                  <path d="M164 176V64" />
                  <path d="M184 160V80" />
                  <path d="M204 140V100" />
                </g>
              </svg>
            </div>
          </div>

          <div className="mt-8 space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {process.env.NEXT_PUBLIC_NAME}
            </h1>

            <p className="text-sm text-zinc-400">
              {process.env.NEXT_PUBLIC_DESC}
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Player */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-white/5 bg-zinc-950/90 backdrop-blur-2xl"
        style={{
          backgroundColor:
            process.env.NEXT_PUBLIC_PLAYER_COLOR,
        }}
      >
        <div className="mx-auto flex h-[74px] w-full max-w-screen-2xl items-center gap-4 px-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setControlsOpen(true)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-4"
          >
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-zinc-700 p-2 ring-1 ring-white/5">
              <ChannelArtwork />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-medium sm:text-base">
                {process.env.NEXT_PUBLIC_NAME}
              </p>

              <p className="truncate text-[13px] text-zinc-400 sm:text-sm">
                {selectedQuality.description}
              </p>
            </div>
          </div>

          {/* QUALITY BUTTON */}
          <div
            ref={sidebarQualityRef}
            className="relative shrink-0"
          >
            <button
              type="button"
              onClick={() =>
                setQualityMenuOpen((v) => !v)
              }
              className="flex h-10 min-w-[70px] cursor-pointer items-center justify-between rounded-full bg-white/10 px-3 text-xs font-medium transition hover:bg-white/15"
            >
              {selectedQuality.label}

              <ChevronUp
                size={14}
                className={`transition-transform ${
                  qualityMenuOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {/* QUALITY MENU */}
            <div
              className={`absolute bottom-14 right-0 w-64 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl transition-all duration-200 ${
                qualityMenuOpen
                  ? "pointer-events-auto translate-y-0 opacity-100"
                  : "pointer-events-none translate-y-2 opacity-0"
              }`}
            >
              <div className="border-b border-white/5 px-4 py-3">
                <p className="text-sm font-medium">
                  Audio quality
                </p>

                <p className="mt-1 text-xs text-zinc-400">
                  Choose streaming bitrate
                </p>
              </div>

              <div className="p-2">
                {qualities.map((quality) => {
                  const active =
                    quality.url ===
                    selectedQuality.url;

                  return (
                    <button
                      key={quality.url}
                      type="button"
                      onClick={() =>
                        void changeQuality(quality)
                      }
                      className="flex cursor-pointer w-full items-center justify-between rounded-xl px-3 py-3 text-left transition hover:bg-white/5"
                    >
                      <div>
                        <p className="text-sm font-medium">
                          {quality.label}
                        </p>

                        <p className="text-xs text-zinc-400">
                          {quality.description}
                        </p>
                      </div>

                      {active && (
                        <Check
                          size={18}
                          className="text-green-400"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* PLAY BUTTON */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();

              void togglePlayback();
            }}
            className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed"
            aria-label={
              playing === 2 ? "Pause" : "Play"
            }
            disabled={playing === 1}
          >
            {playing === 1 && (
              <Loader2
                size={20}
                className="animate-spin"
              />
            )}

            {playing === 2 && (
              <Square
                size={18}
                fill="currentColor"
              />
            )}

            {playing === 0 && (
              <Play
                size={18}
                fill="currentColor"
              />
            )}
          </button>
        </div>
      </div>

      {/* Fullscreen Player */}
      <div
        className={`fixed inset-0 z-50 flex flex-col bg-black text-white will-change-transform transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          controlsOpen
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-full opacity-100"
        }`}
      >
        {/* DRAG HANDLE */}
        <div className="flex justify-center pt-2">
          <div className="h-1.5 w-12 rounded-full bg-white/20" />
        </div>
        
        {/* FULLSCREEN TOP BAR */}
        <div className="absolute left-6 top-6 z-10 flex items-center gap-3">
          {/* QUALITY GEAR */}
          <div
            ref={fsQualityRef}
            className="relative"
          >
            <button
              type="button"
              onClick={() => setFsQualityOpen((v) => !v)}
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/5 transition hover:bg-white/10"
              aria-label="Quality settings"
            >
              <Settings size={18} />
            </button>

            {/* DROPDOWN */}
            <div
              className={`absolute left-0 top-12 w-64 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl transition-all duration-200 ${
                fsQualityOpen
                  ? "pointer-events-auto translate-y-0 opacity-100"
                  : "pointer-events-none translate-y-2 opacity-0"
              }`}
            >
              <div className="border-b border-white/5 px-4 py-3">
                <p className="text-sm font-medium">Audio quality</p>
                <p className="mt-1 text-xs text-zinc-400">
                  Choose streaming bitrate
                </p>
              </div>

              <div className="p-2">
                {qualities.map((quality) => {
                  const active = quality.url === selectedQuality.url;

                  return (
                    <button
                      key={quality.url}
                      type="button"
                      onClick={() => {
                        void changeQuality(quality);
                        setFsQualityOpen(false);
                      }}
                      className="flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-3 text-left transition hover:bg-white/5"
                    >
                      <div>
                        <p className="text-sm font-medium">
                          {quality.label}
                        </p>
                        <p className="text-xs text-zinc-400">
                          {quality.description}
                        </p>
                      </div>

                      {active && (
                        <Check size={18} className="text-green-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end px-6 pt-6">
          <button
            type="button"
            onClick={() => setControlsOpen(false)}
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/5"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="mb-8 flex h-40 w-40 shrink-0 items-center justify-center rounded-3xl bg-zinc-800 p-6 shadow-2xl">
            <ChannelArtwork />
          </div>

          <h2 className="text-3xl font-semibold">
            {process.env.NEXT_PUBLIC_NAME}
          </h2>

          <p className="mt-2 max-w-sm text-sm text-zinc-400">
            {process.env.NEXT_PUBLIC_DESC}
          </p>

          <p className="mt-3 text-xs uppercase tracking-[0.2em] text-zinc-500">
            {selectedQuality.label} ·{" "}
            {selectedQuality.description}
          </p>

          <button
            type="button"
            onClick={() => void togglePlayback()}
            className="mt-10 flex h-24 w-24 cursor-pointer items-center justify-center rounded-full bg-white text-black transition-transform active:scale-95 disabled:opacity-70"
            aria-label={
              playing === 2 ? "Pause" : "Play"
            }
            disabled={playing === 1}
          >
            {playing === 1 && (
              <Loader2
                size={32}
                className="animate-spin"
              />
            )}

            {playing === 2 && (
              <Square
                size={28}
                fill="currentColor"
              />
            )}

            {playing === 0 && (
              <Play
                size={30}
                fill="currentColor"
              />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}