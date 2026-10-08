"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import {
  LingbotWorld2MainVideoView,
  LingbotWorld2Provider,
  useLingbotWorld2,
  useLingbotWorld2ChunkComplete,
  useLingbotWorld2CommandError,
  type LingbotWorld2ChunkCompleteMessage,
} from "@reactor-models/lingbot-world-2";
import { ClipDownloadButton, ClipPlayer, RecordingError, type Clip, type ReactorStatus } from "@reactor-team/js-sdk";
import { IDLE_AXES, MOVEMENT_KEYS, actionString, axesFromInput, diffAxes, isTypingTarget, normalizeKey, rotationSpeedFor,
  type Axes, type AxisCommand, type Drag } from "./lib/controls";
import { ORIGIN, SIM_CHUNK_MS, aimAssist, doorAhead, doorLayout, integrate, nearestDoor, simulatedChunk, spreadBearings,
  type ChunkReport, type Door, type Pose } from "./lib/navigation";
import { LINGBOT_COST_PER_SECOND, capacityRetryDelay, isCapacityError } from "./lib/reactor";
import { formatSeconds, seedImage } from "./lib/rooms";
import { tokenResolver } from "./lib/tokens";
import type { World, WorldRoom } from "./lib/types";
import { WorldHud } from "./WorldHud";

const PAUSE_AFTER_MS = 60_000;
const DISCONNECT_AFTER_MS = 120_000;
const WALK_IN_MS = 1500;
const DRAG_RELEASE_MS = 140;
const LEVEL_DEG = 10; // per latent frame (~6 per second): 1.2 s raises the view about 72°
const LEVEL_MS = 1200;

// The session is bound to the token that created it, so one token is memoized for its lifetime.
const fetchWorldToken = tokenResolver("lingbot-world-2");

type LingbotApi = ReturnType<typeof useLingbotWorld2>;

function everyAxis(axes: Axes): AxisCommand[] {
  return [
    { method: "setMoveLongitudinal", params: { move_longitudinal: axes.move_longitudinal } },
    { method: "setMoveLateral", params: { move_lateral: axes.move_lateral } },
    { method: "setLookHorizontal", params: { look_horizontal: axes.look_horizontal } },
    { method: "setLookVertical", params: { look_vertical: axes.look_vertical } },
  ];
}

function message(cause: unknown): string {
  if (cause instanceof RecordingError) return `${cause.code}: ${cause.reason}`;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Lives inside the provider only while the player has opted into a paid session. */
function LiveSession({ apiRef, streaming, onStatus, onChunk, onError }: {
  apiRef: MutableRefObject<LingbotApi | null>; streaming: boolean;
  onStatus: (status: ReactorStatus) => void; onChunk: (chunk: LingbotWorld2ChunkCompleteMessage) => void; onError: (text: string) => void;
}) {
  const lb = useLingbotWorld2();
  apiRef.current = lb;
  useEffect(() => () => { apiRef.current = null; }, [apiRef]);
  useEffect(() => { onStatus(lb.status); }, [lb.status, onStatus]);
  useEffect(() => { if (lb.lastError) onError(lb.lastError.message); }, [lb.lastError, onError]);
  useLingbotWorld2ChunkComplete(onChunk);
  useLingbotWorld2CommandError(failure => onError(`${failure.command}: ${failure.reason}`));
  return <LingbotWorld2MainVideoView className={`rw-video${streaming ? " rw-visible" : ""}`} videoObjectFit="cover"
    style={{ position: "absolute", inset: 0, background: "transparent" }} />;
}

export interface StageProps {
  world: World;
  room: WorldRoom;
  reactorConfigured: boolean;
  onNavigate: (path: string) => void;
  onRequestScan: (path: string) => void;
  /** Shrinks the world to a picture-in-picture while the robot simulation has the stage. */
  pip?: boolean;
  /** False while another view owns the keyboard: walking keys are ignored and held axes released. */
  inputEnabled?: boolean;
  onShowWorld?: () => void;
}

export function LingbotStage({ world, room, reactorConfigured, onNavigate, onRequestScan, pip = false, inputEnabled = true, onShowWorld }: StageProps) {
  const apiRef = useRef<LingbotApi | null>(null);
  const [wanted, setWanted] = useState(false);
  const [status, setStatus] = useState<ReactorStatus>("disconnected");
  const live = wanted && status === "ready";
  const liveRef = useRef(live);
  liveRef.current = live;

  const [pose, setPose] = useState<Pose>(ORIGIN);
  const [streaming, setStreaming] = useState(false);
  const [overlay, setOverlay] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idle, setIdle] = useState<"active" | "paused" | "ended">("active");
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const poseRef = useRef<Pose>(ORIGIN);
  const keysRef = useRef(new Set<string>());
  const dragRef = useRef<{ x: number; y: number; delta: Drag | null; timer: number | null } | null>(null);
  const axesRef = useRef<Axes>(IDLE_AXES);
  const sentRef = useRef<Axes>(IDLE_AXES);
  const speedRef = useRef(rotationSpeedFor(false));
  const lastInputRef = useRef(0);
  const pausedRef = useRef(false);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const transitionRef = useRef(false);
  const seedKeyRef = useRef<string | null>(null);
  const awaitingChunkRef = useRef(false);
  const requestedScanRef = useRef<string | null>(null);
  const statusRef = useRef<ReactorStatus>("disconnected");
  const enterRef = useRef<(door: Door) => void>(() => {});

  const [retry, setRetry] = useState<{ attempt: number; until: number } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const connectRef = useRef<() => Promise<void>>(async () => {});
  const inputRef = useRef(inputEnabled);
  inputRef.current = inputEnabled;

  const report = useCallback((cause: unknown) => setError(message(cause)), []);

  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryAttemptRef.current = 0;
    setRetry(null);
  }, []);

  // Reactor answers 429 when LingBot has no free capacity or the session quota is spent: release the failed session and
  // try again after 10, 20 and 40 s. Every other error is reported as is.
  const failLive = useCallback((text: string) => {
    const delay = isCapacityError(text) ? capacityRetryDelay(retryAttemptRef.current) : null;
    if (delay === null) {
      retryAttemptRef.current = 0;
      setRetry(null);
      setError(text);
      return;
    }
    retryAttemptRef.current += 1;
    setWanted(false);
    setConnecting(false);
    setError(null);
    setRetry({ attempt: retryAttemptRef.current, until: Date.now() + delay * 1000 });
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetry(null);
      void connectRef.current();
    }, delay * 1000);
  }, []);
  const api = () => apiRef.current;

  const doors = useMemo(() => {
    const children = room.children.map(path => world.rooms[path]).filter((child): child is WorldRoom => Boolean(child));
    const fallback = spreadBearings(children.length);
    const parent = room.parent ? world.rooms[room.parent] : undefined;
    return doorLayout(
      children.map((child, index) => ({ path: child.path, label: child.door_label || child.title,
        bearing: Number.isFinite(child.bearing) ? child.bearing : fallback[index] })),
      parent ? { path: parent.path, label: parent.path === "root" ? "Back to the beginning" : `Back to ${parent.title}`, bearing: 180 } : null);
  }, [world.rooms, room.children, room.parent]);
  const doorsRef = useRef(doors);
  doorsRef.current = doors;

  const dispatch = useCallback((command: AxisCommand) => {
    const l = apiRef.current;
    if (!l) return Promise.resolve(undefined);
    switch (command.method) {
      case "setMoveLongitudinal": return l.setMoveLongitudinal(command.params);
      case "setMoveLateral": return l.setMoveLateral(command.params);
      case "setLookHorizontal": return l.setLookHorizontal(command.params);
      case "setLookVertical": return l.setLookVertical(command.params);
    }
  }, []);

  const syncAxes = useCallback((force = false) => {
    if (!liveRef.current || transitionRef.current) return;
    const next = axesRef.current;
    const commands = force ? everyAxis(next) : diffAxes(sentRef.current, next);
    sentRef.current = next;
    for (const command of commands) void dispatch(command).catch(report);
  }, [dispatch, report]);

  const updateAxes = useCallback(() => {
    axesRef.current = axesFromInput(keysRef.current, dragRef.current?.delta ?? null, 1);
    syncAxes();
  }, [syncAxes]);

  const markInput = useCallback(() => {
    lastInputRef.current = Date.now();
    if (pausedRef.current && liveRef.current) {
      pausedRef.current = false;
      setIdle("active");
      void api()?.resume().catch(report);
    }
  }, [report]);

  const setSpeed = useCallback((fast: boolean) => {
    const speed = rotationSpeedFor(fast);
    if (speed === speedRef.current) return;
    speedRef.current = speed;
    if (liveRef.current) void api()?.setRotationSpeedDeg({ rotation_speed_deg: speed }).catch(report);
  }, [report]);

  const applyChunk = useCallback((chunk: ChunkReport) => {
    if (transitionRef.current) return;
    const next = integrate(aimAssist(poseRef.current, chunk, doorsRef.current), chunk, speedRef.current);
    poseRef.current = next;
    setPose(next);
    const door = nearestDoor(next, doorsRef.current);
    if (door) enterRef.current(door);
  }, []);

  const onLiveChunk = useCallback((chunk: ChunkReport) => {
    if (awaitingChunkRef.current) {
      awaitingChunkRef.current = false;
      setStreaming(true);
      setOverlay(null);
      setNotice(null);
    }
    applyChunk(chunk);
  }, [applyChunk]);

  const onLiveStatus = useCallback((next: ReactorStatus) => {
    const previous = statusRef.current;
    statusRef.current = next;
    setStatus(next);
    if (next !== "disconnected") setConnecting(false);
    // Once a ready session ends (lease, network, server), unmount the provider so a later visit builds a fresh one.
    // A failed connect stays mounted with its error until the player leaves; StrictMode's store swap also passes
    // through "disconnected" while connecting, so that transition alone must not tear the session down.
    if (next === "disconnected" && previous === "ready") setWanted(false);
  }, []);

  const enterDoor = useCallback((door: Door) => {
    if (transitionRef.current) return;
    const target = world.rooms[door.path];
    if (!target) return;
    transitionRef.current = true;
    markInput();
    const finish = () => {
      transitionRef.current = false;
      poseRef.current = ORIGIN;
      setPose(ORIGIN);
      setFading(false);
      syncAxes();
      onNavigate(door.path);
    };
    const l = apiRef.current;
    if (liveRef.current && streamingRef.current && l) {
      // Keep the live world continuous: steer the next chunks toward the target room while walking through.
      setNotice(`Walking into ${target.title}…`);
      void l.setPrompt({ prompt: target.prompt }).catch(report);
      void l.setMoveLongitudinal({ move_longitudinal: "forward" }).catch(report);
      sentRef.current = { ...sentRef.current, move_longitudinal: "forward" };
      window.setTimeout(finish, WALK_IN_MS);
    } else {
      setFading(true);
      window.setTimeout(finish, 280);
    }
  }, [world.rooms, markInput, syncAxes, onNavigate, report]);
  enterRef.current = enterDoor;

  const seedRoom = useCallback(async (target: WorldRoom, image: string) => {
    const key = `${target.path}|${image}`;
    seedKeyRef.current = key;
    setOverlay(image);
    setStreaming(false);
    setNotice(`Reactor is generating ${target.path === "root" ? "the beginning image" : target.title}…`);
    try {
      const response = await fetch(image);
      if (!response.ok) throw new Error(`Could not load the room image (${response.status})`);
      const blob = await response.blob();
      const l = apiRef.current;
      if (!l) return;
      const file = await l.uploadFile(blob, { name: `${target.path}.jpg` });
      if (seedKeyRef.current !== key || !liveRef.current) return;
      await l.reset();
      await l.setImage({ image: file });
      await l.setPrompt({ prompt: target.prompt });
      await l.setSeed({ seed: target.seed });
      await l.setRotationSpeedDeg({ rotation_speed_deg: speedRef.current });
      if (seedKeyRef.current !== key) return;
      awaitingChunkRef.current = true;
      await l.start();
      syncAxes(true);
      if (target.camera_pitch_hint === "down" && axesRef.current.look_vertical === "idle") {
        // Egocentric frames look steeply down, and LingBot walks along the look axis: raise the view about 72°
        // (1.2 s at 10° per latent frame) so walking forward moves through the room instead of into the counter.
        await l.setRotationSpeedDeg({ rotation_speed_deg: LEVEL_DEG });
        await l.setLookVertical({ look_vertical: "up" });
        window.setTimeout(() => {
          if (seedKeyRef.current !== key || !liveRef.current) return;
          void apiRef.current?.setLookVertical({ look_vertical: axesRef.current.look_vertical }).catch(report);
          void apiRef.current?.setRotationSpeedDeg({ rotation_speed_deg: speedRef.current }).catch(report);
        }, LEVEL_MS);
      }
    } catch (cause) {
      if (seedKeyRef.current === key) {
        seedKeyRef.current = null;
        setOverlay(null);
        setNotice(null);
        report(cause);
      }
    }
  }, [report, syncAxes]);

  const image = seedImage(world, room);

  useEffect(() => {
    poseRef.current = ORIGIN;
    setPose(ORIGIN);
  }, [room.path]);

  // Ask the backend to prioritize a room the player walked into before Reactor finished it.
  useEffect(() => {
    if (!reactorConfigured || room.path === "root" || room.media.arrival) return;
    const scan = room.jobs.scan.status;
    if ((scan === "idle" || scan === "queued") && requestedScanRef.current !== room.path) {
      requestedScanRef.current = room.path;
      onRequestScan(room.path);
    }
  }, [reactorConfigured, room.path, room.media.arrival, room.jobs.scan.status, onRequestScan]);

  useEffect(() => {
    if (!live) return;
    if (!image) {
      setNotice(`Reactor is generating ${room.title}…`);
      return;
    }
    if (seedKeyRef.current === `${room.path}|${image}`) return;
    void seedRoom(room, image);
  }, [live, room, image, seedRoom]);

  useEffect(() => {
    if (live) return;
    setStreaming(false);
    setOverlay(null);
    seedKeyRef.current = null;
    awaitingChunkRef.current = false;
    sentRef.current = IDLE_AXES;
    pausedRef.current = false;
  }, [live]);

  // Offline (or before Reactor streams): drive the same navigation from a simulated chunk clock.
  useEffect(() => {
    if (live && streaming) return;
    const timer = window.setInterval(() => {
      const action = actionString(axesRef.current);
      if (action !== "still") applyChunk(simulatedChunk(action));
    }, SIM_CHUNK_MS);
    return () => window.clearInterval(timer);
  }, [live, streaming, applyChunk]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (!inputRef.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target as HTMLElement | null)) return;
      const key = normalizeKey(event.key);
      if (key === "shift") { setSpeed(true); return; }
      if (key === "e") {
        const door = doorAhead(poseRef.current, doorsRef.current);
        if (door) { event.preventDefault(); enterRef.current(door); }
        return;
      }
      if (!MOVEMENT_KEYS.has(key)) return;
      event.preventDefault();
      markInput();
      if (keysRef.current.has(key)) return;
      keysRef.current.add(key);
      updateAxes();
    };
    const up = (event: KeyboardEvent) => {
      const key = normalizeKey(event.key);
      if (key === "shift") setSpeed(false);
      if (keysRef.current.delete(key)) updateAxes();
    };
    const blur = () => {
      if (!keysRef.current.size) return;
      keysRef.current.clear();
      updateAxes();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [markInput, setSpeed, updateAxes]);

  // Another view took the keyboard: stop walking instead of leaving an axis held.
  useEffect(() => {
    if (inputEnabled) return;
    keysRef.current.clear();
    dragRef.current = null;
    updateAxes();
  }, [inputEnabled, updateAxes]);

  useEffect(() => {
    if (!retry) return;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [retry]);

  useEffect(() => () => { if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current); }, []);

  useEffect(() => {
    if (live && streaming) retryAttemptRef.current = 0;
  }, [live, streaming]);

  // Billing runs for wall-clock time while connected, so pause and then release idle sessions.
  useEffect(() => {
    if (!live) return;
    lastInputRef.current = Date.now();
    const timer = window.setInterval(() => {
      setSeconds(value => value + 1);
      const quiet = Date.now() - lastInputRef.current;
      if (quiet > DISCONNECT_AFTER_MS) {
        setIdle("ended");
        setWanted(false);
      } else if (quiet > PAUSE_AFTER_MS && !pausedRef.current && streamingRef.current) {
        pausedRef.current = true;
        setIdle("paused");
        void apiRef.current?.pause().catch(() => {});
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const connect = useCallback(async () => {
    setError(null);
    setIdle("active");
    markInput();
    setConnecting(true);
    try {
      await fetchWorldToken(); // fail fast (and keep the offline world) when the server cannot mint a token
      setSeconds(0);
      setWanted(true);
    } catch (cause) {
      setConnecting(false);
      failLive(message(cause));
    }
  }, [markInput, failLive]);
  connectRef.current = connect;

  const leave = useCallback(() => {
    cancelRetry();
    setWanted(false);
  }, [cancelRetry]);

  // Every provider mount starts from "disconnected"; forget the previous session's status when it unmounts.
  useEffect(() => {
    if (wanted) return;
    statusRef.current = "disconnected";
    setStatus("disconnected");
  }, [wanted]);

  const capture = useCallback(async () => {
    const l = apiRef.current;
    if (!l) return;
    setClipBusy(true);
    try {
      setClip(await l.requestClip(10));
    } catch (cause) {
      report(cause);
    } finally {
      setClipBusy(false);
    }
  }, [report]);

  const press = useCallback((key: string, active: boolean) => {
    if (active) { markInput(); keysRef.current.add(key); } else keysRef.current.delete(key);
    updateAxes();
  }, [markInput, updateAxes]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, delta: null, timer: null };
    markInput();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.delta = { dx: event.clientX - drag.x, dy: event.clientY - drag.y };
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.timer !== null) window.clearTimeout(drag.timer);
    drag.timer = window.setTimeout(() => {
      if (dragRef.current) { dragRef.current.delta = null; updateAxes(); }
    }, DRAG_RELEASE_MS);
    markInput();
    updateAxes();
  };
  const endDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.timer !== null) window.clearTimeout(drag.timer);
    dragRef.current = null;
    updateAxes();
  };

  const nearDoor = doorAhead(pose, doors);
  const backdrop = room.media.scan;
  const still = image ?? world.start_url;
  const busy = connecting || (wanted && status !== "ready");
  const mode = live ? (idle === "paused" ? "Paused · resume by moving" : streaming ? "Live · LingBot World 2 · 1664×960 @ 48 fps" : "Starting Reactor world…")
    : busy ? `Reactor ${wanted ? status : "connecting"}…`
    : reactorConfigured ? "Offline preview" : "Offline preview · set REACTOR_API_KEY to go live";

  const retryIn = retry ? Math.max(0, Math.ceil((retry.until - clock) / 1000)) : 0;

  return <section className={`rw-stage${pip ? " rw-pip" : ""}`} aria-label="Reactor world view">
    <div className="rw-surface" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      {!streaming && (backdrop
        ? <video key={backdrop} className="rw-backdrop" src={backdrop} autoPlay muted loop playsInline aria-label={`Recorded Reactor scan of ${room.title}`} />
        : <img key={still} className="rw-backdrop" src={still} alt={room.path === "root" ? "Beginning image" : `Reactor arrival frame of ${room.title}`} draggable={false} />)}
      {wanted && <LingbotWorld2Provider jwtToken={fetchWorldToken} connectOptions={{ autoConnect: true }}>
        <LiveSession apiRef={apiRef} streaming={streaming} onStatus={onLiveStatus} onChunk={onLiveChunk} onError={failLive} />
      </LingbotWorld2Provider>}
      {overlay && <img className="rw-overlay" src={overlay} alt="" aria-hidden="true" draggable={false} />}
      <div className={`rw-fade${fading ? " rw-visible" : ""}`} aria-hidden="true" />
    </div>
    <WorldHud world={world} room={room} pose={pose} doors={doors} nearDoor={nearDoor} notice={notice} onEnterDoor={enterDoor} />
    <div className="rw-session">
      <span className={`rw-status${live && streaming ? " rw-live" : ""}`} data-testid="reactor-world-status"><i />{mode}</span>
      {live && <span className="rw-cost" title="Reactor bills connected wall-clock time">{formatSeconds(seconds)} · ${(seconds * LINGBOT_COST_PER_SECOND).toFixed(2)}</span>}
      {wanted
        ? <>
          {live && <button className="rw-button" onClick={() => void capture()} disabled={clipBusy || !streaming}>{clipBusy ? "Capturing…" : "Capture 10 s clip"}</button>}
          <button className="rw-button" onClick={leave}>Leave Reactor</button>
        </>
        : <button className="rw-button rw-primary" onClick={() => void connect()} disabled={!reactorConfigured || connecting}
          title={reactorConfigured ? "Starts a paid Reactor LingBot World 2 session (~$0.42/min)" : "Set REACTOR_API_KEY in .env"}>
          {connecting ? "Connecting…" : "Enter Reactor world"}
        </button>}
    </div>
    <div className="rw-touch" aria-label="Touch movement controls">
      {([["arrowleft", "↺"], ["w", "▲"], ["arrowright", "↻"], ["a", "◀"], ["s", "▼"], ["d", "▶"]] as const).map(([key, label]) =>
        <button key={key} aria-label={`Hold ${key}`} onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); press(key, true); }}
          onPointerUp={() => press(key, false)} onPointerCancel={() => press(key, false)}>{label}</button>)}
    </div>
    {idle === "ended" && !wanted && <div className="rw-resume" role="dialog" aria-label="Reactor session ended">
      <strong>Reactor session released after two idle minutes.</strong>
      <p>Billing stopped. Resume to regenerate this room from its Reactor frame.</p>
      <button className="rw-button rw-primary" onClick={() => void connect()}>Resume</button>
    </div>}
    {error && <p className="rw-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></p>}
    {retry && <div className="rw-retry" role="status">
      <i className="rw-spinner" />
      <span>Reactor LingBot is at capacity — retrying in {retryIn} s <small>(attempt {retry.attempt} of 3)</small></span>
      <button className="rw-button" onClick={cancelRetry}>Cancel</button>
    </div>}
    {pip && <button className="rw-pip-label" onClick={onShowWorld} aria-label="Show the Reactor world">
      <span><i className={live && streaming ? "rw-live-dot" : undefined} />Realistic world · Reactor LingBot World 2</span>
    </button>}
    {clip && <div className="rw-modal" role="dialog" aria-label="Captured Reactor clip" onClick={() => setClip(null)}>
      <div onClick={event => event.stopPropagation()}>
        <header><span className="rw-eyebrow">REACTOR CLIP · {clip.kind}</span><button className="rw-button" onClick={() => setClip(null)}>Close</button></header>
        <ClipPlayer clip={clip} getJwt={fetchWorldToken} onError={cause => setError(cause.message)} className="rw-clip" />
        <ClipDownloadButton clip={clip} getJwt={fetchWorldToken} filename={`${world.id}-${room.path}-clip.mp4`} onError={cause => setError(cause.message)} />
      </div>
    </div>}
  </section>;
}
