"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  SanaStreamingMainVideoView,
  SanaStreamingProvider,
  useSanaStreaming,
  useSanaStreamingChunkComplete,
  useSanaStreamingCommandError,
} from "@reactor-models/sana-streaming";
import type { ReactorStatus } from "@reactor-team/js-sdk";
import { isTypingTarget } from "./lib/controls";
import { SANA_COST_PER_SECOND, capacityRetryDelay, formatCost, isCapacityError } from "./lib/reactor";
import { ROBOT_IDLE, ROBOT_KEYS, contactLabel, coverRect, robotAxesFromKeys, robotTaskTitle, sameAxes, simulationPrompt,
  stepSummary, taskProgram, type RobotAxes } from "./lib/robot";
import { formatSeconds, jobActive, jobLabel, roomApi } from "./lib/rooms";
import { reactorToken, tokenResolver } from "./lib/tokens";
import { worldRequest, type RobotCommand, type RobotSessionInfo, type RobotState, type World, type WorldRoom } from "./lib/types";
import type { JobKind } from "./TaskPanel";

// SANA-Streaming takes a fixed 1280×704 camera track; changing its size mid-session crashes the session.
const RENDER_WIDTH = 1280;
const RENDER_HEIGHT = 704;
const UI_MS = 120;
const FRAME_LIVE_MS = 1500;
const RENDER_IDLE_MS = 120_000;
const fetchSanaToken = tokenResolver("sana-streaming");

type Phase = "idle" | "starting" | "live" | "closed" | "error";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Lives inside the SANA provider: publishes the simulation canvas as the `camera` track (ReactorRoomView pattern). */
function SanaRender({ canvas, prompt, seed, visible, onStatus, onFrames, onError }: {
  canvas: HTMLCanvasElement | null; prompt: string; seed: number; visible: boolean;
  onStatus: (status: ReactorStatus) => void; onFrames: () => void; onError: (text: string) => void;
}) {
  const sana = useSanaStreaming();
  const sanaRef = useRef(sana);
  sanaRef.current = sana;
  const { status, lastError } = sana;
  useEffect(() => { onStatus(status); }, [status, onStatus]);
  useEffect(() => { if (lastError) onError(lastError.message); }, [lastError, onError]);
  useSanaStreamingChunkComplete(onFrames);
  useSanaStreamingCommandError(failure => onError(`${failure.command}: ${failure.reason}`));

  useEffect(() => {
    if (status !== "ready" || !canvas) return;
    let active = true;
    const track = canvas.captureStream(24).getVideoTracks()[0];
    track.contentHint = "detail";
    void (async () => {
      try {
        const model = sanaRef.current;
        await model.publish("camera", track);
        if (!active) return;
        await model.setSeed({ seed });
        await model.setAnchorInterval({ chunks: 5 });
        await model.setPrompt({ prompt });
        if (active) await model.start();
      } catch (cause) {
        if (active) onError(message(cause));
      }
    })();
    return () => {
      active = false;
      track.stop();
      void sanaRef.current.unpublish("camera").catch(() => {});
    };
    // The prompt and seed are fixed for one session; a new prompt means a new session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, canvas]);

  return <SanaStreamingMainVideoView className={`rw-robot-render${visible ? " rw-visible" : ""}`} videoObjectFit="contain" muted
    style={{ position: "absolute", inset: 0, background: "transparent" }} />;
}

export function RobotStage({ world, room, reactorConfigured, playgroundAvailable, onJob, onState, onExit }: {
  world: World; room: WorldRoom; reactorConfigured: boolean; playgroundAvailable: boolean;
  onJob: (path: string, kind: JobKind) => Promise<void>;
  onState: (path: string, state: RobotState) => void;
  onExit: () => void;
}) {
  const robot = room.task.robot_task;
  const scanReady = room.jobs.scan.status === "ready";
  const physicsReady = room.jobs.physics.status === "ready" && Boolean(room.physics?.valid);
  const runnable = physicsReady && Boolean(robot?.feasible);
  const revision = room.physics?.revision ?? null;

  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<RobotSessionInfo | null>(null);
  const [state, setState] = useState<RobotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameLive, setFrameLive] = useState(false);
  const [gripClosed, setGripClosed] = useState(false);
  const [restart, setRestart] = useState(0);
  const [pending, setPending] = useState<JobKind | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  // Live Reactor render of the simulation (reactor/sana-streaming).
  const [renderWanted, setRenderWanted] = useState(reactorConfigured);
  const [renderMounted, setRenderMounted] = useState(false);
  const [renderStatus, setRenderStatus] = useState<ReactorStatus>("disconnected");
  const [renderStreaming, setRenderStreaming] = useState(false);
  const [renderNote, setRenderNote] = useState<string | null>(null);
  const [renderRetry, setRenderRetry] = useState<{ attempt: number; until: number } | null>(null);
  const [renderSeconds, setRenderSeconds] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [renderAttempt, setRenderAttempt] = useState(0);

  const imgRef = useRef<HTMLImageElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const keysRef = useRef(new Set<string>());
  const axesRef = useRef<RobotAxes>(ROBOT_IDLE);
  const gripRef = useRef(false);
  const lastFrameRef = useRef(0);
  const frameUrlRef = useRef<string | null>(null);
  const lastInputRef = useRef(Date.now());
  const renderMountedRef = useRef(false);
  renderMountedRef.current = renderMounted;
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const renderStatusRef = useRef<ReactorStatus>("disconnected");
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const send = useCallback((command: RobotCommand) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  }, []);

  const syncAxes = useCallback(() => {
    const next = robotAxesFromKeys(keysRef.current);
    if (sameAxes(next, axesRef.current)) return;
    axesRef.current = next;
    send({ type: "move", axes: next });
  }, [send]);

  const releaseAll = useCallback(() => {
    if (!keysRef.current.size) return;
    keysRef.current.clear();
    syncAxes();
  }, [syncAxes]);

  const command = useCallback((value: RobotCommand) => {
    lastInputRef.current = Date.now();
    if (value.type === "reset" || value.type === "demo") {
      gripRef.current = false;
      setGripClosed(false);
    }
    send(value);
  }, [send]);

  const toggleGrip = useCallback(() => {
    lastInputRef.current = Date.now();
    gripRef.current = !gripRef.current;
    setGripClosed(gripRef.current);
    send({ type: "gripper", closed: gripRef.current });
  }, [send]);

  const drawForReactor = useCallback((blob: Blob) => {
    const target = canvas;
    if (!target || !renderMountedRef.current) return;
    void createImageBitmap(blob).then(bitmap => {
      const context = target.getContext("2d");
      if (context) {
        const rect = coverRect(bitmap.width, bitmap.height, RENDER_WIDTH, RENDER_HEIGHT);
        context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
      }
      bitmap.close();
    }).catch(() => {});
  }, [canvas]);
  const drawRef = useRef(drawForReactor);
  drawRef.current = drawForReactor;

  // One robot session per visit to the simulation; closing the view releases it on the server.
  useEffect(() => {
    if (!runnable) { setPhase("idle"); return; }
    let disposed = false;
    let socket: WebSocket | null = null;
    let id: string | null = null;
    let lastUi = 0;
    let lastDone = -1;
    setPhase("starting"); setError(null); setInfo(null); setFrameLive(false);
    worldRequest<RobotSessionInfo>(roomApi(world.id, room.path, "robot"), { method: "POST" }).then(value => {
      id = value.id;
      if (disposed) { void fetch(`/api/worlds/robot-sessions/${value.id}`, { method: "DELETE" }).catch(() => {}); return; }
      setInfo(value);
      setState(value.state);
      onStateRef.current(room.path, value.state);
      gripRef.current = value.state.metrics.gripper === "closed";
      setGripClosed(gripRef.current);
      const base = process.env.NEXT_PUBLIC_ROOM_SIM_WS_URL ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8000`;
      socket = new WebSocket(`${base}/worlds/robot-sessions/${value.id}`);
      socket.binaryType = "blob";
      socketRef.current = socket;
      socket.onopen = () => { if (!disposed) { axesRef.current = ROBOT_IDLE; setPhase("live"); } };
      socket.onmessage = event => {
        if (disposed) return;
        if (event.data instanceof Blob) {
          const url = URL.createObjectURL(event.data);
          const image = imgRef.current;
          if (image) image.src = url;
          if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
          frameUrlRef.current = url;
          lastFrameRef.current = performance.now();
          drawRef.current(event.data);
          return;
        }
        const data = JSON.parse(String(event.data));
        if (data.type === "state") {
          const next = data as RobotState;
          const done = next.steps.filter(step => step.done).length;
          if (performance.now() - lastUi > UI_MS || done !== lastDone || next.success) {
            lastUi = performance.now();
            lastDone = done;
            setState(next);
            onStateRef.current(room.path, next);
          }
        } else if (data.type === "error") {
          setError(String(data.error));
        } else if (data.type === "closed") {
          setError(String(data.error));
          setPhase("closed");
        }
      };
      socket.onclose = () => { if (!disposed) setPhase(current => current === "live" || current === "starting" ? "closed" : current); };
    }).catch(cause => {
      if (!disposed) { setError(message(cause)); setPhase("error"); }
    });
    return () => {
      disposed = true;
      socket?.close();
      socketRef.current = null;
      if (id) void fetch(`/api/worlds/robot-sessions/${id}`, { method: "DELETE" }).catch(() => {});
      keysRef.current.clear();
      axesRef.current = ROBOT_IDLE;
      if (frameUrlRef.current) { URL.revokeObjectURL(frameUrlRef.current); frameUrlRef.current = null; }
    };
  }, [runnable, world.id, room.path, revision, restart]);

  useEffect(() => {
    const timer = window.setInterval(() => setFrameLive(performance.now() - lastFrameRef.current < FRAME_LIVE_MS), 500);
    return () => window.clearInterval(timer);
  }, []);

  // While the simulation has the stage, arrows / R / F / Space drive the robot and Esc returns to the Reactor world.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target as HTMLElement | null)) return;
      const key = event.key.toLowerCase();
      if (key === "escape") { event.preventDefault(); onExitRef.current(); return; }
      if (key === " " || key === "spacebar") {
        event.preventDefault();
        if (!event.repeat) toggleGrip();
        return;
      }
      if (!ROBOT_KEYS.has(key)) return;
      event.preventDefault();
      lastInputRef.current = Date.now();
      if (keysRef.current.has(key)) return;
      keysRef.current.add(key);
      syncAxes();
    };
    const up = (event: KeyboardEvent) => { if (keysRef.current.delete(event.key.toLowerCase())) syncAxes(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", releaseAll);
      releaseAll();
    };
  }, [toggleGrip, syncAxes, releaseAll]);

  const hold = (key: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      lastInputRef.current = Date.now();
      keysRef.current.add(key);
      syncAxes();
    },
    onPointerUp: () => { keysRef.current.delete(key); syncAxes(); },
    onPointerCancel: () => { keysRef.current.delete(key); syncAxes(); },
    onLostPointerCapture: () => { keysRef.current.delete(key); syncAxes(); },
  });

  // Reactor render: fall back to the physics view on any failure; retry capacity errors after 10, 20 and 40 s.
  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryAttemptRef.current = 0;
    setRenderRetry(null);
  }, []);

  const failRender = useCallback((text: string) => {
    setRenderMounted(false);
    setRenderStreaming(false);
    const delay = isCapacityError(text) ? capacityRetryDelay(retryAttemptRef.current) : null;
    if (delay === null) {
      // Stay on the physics view until the player turns Live Reactor on again (no reconnect loop).
      retryAttemptRef.current = 0;
      setRenderRetry(null);
      setRenderWanted(false);
      setRenderNote(`Reactor render unavailable — showing the physics view. ${text}`);
      return;
    }
    retryAttemptRef.current += 1;
    setRenderNote(null);
    setRenderRetry({ attempt: retryAttemptRef.current, until: Date.now() + delay * 1000 });
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRenderRetry(null);
      setRenderAttempt(value => value + 1);
    }, delay * 1000);
  }, []);

  // Start the render once the simulation streams; check the token first so a missing key keeps the physics view quiet.
  useEffect(() => {
    if (!renderWanted || phase !== "live" || renderMounted || renderRetry) return;
    let active = true;
    setRenderNote(null);
    reactorToken("sana-streaming").then(() => {
      if (!active) return;
      setRenderSeconds(0);
      setRenderStreaming(false);
      lastInputRef.current = Date.now();
      setRenderMounted(true);
    }).catch(cause => { if (active) failRender(message(cause)); });
    return () => { active = false; };
    // renderAttempt re-runs this after a capacity backoff.
  }, [renderWanted, phase, renderMounted, renderRetry, renderAttempt, failRender]);

  useEffect(() => {
    if (renderWanted) return;
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setRenderRetry(null);
    setRenderMounted(false);
    setRenderStreaming(false);
  }, [renderWanted]);

  useEffect(() => () => { if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current); }, []);

  const onRenderStatus = useCallback((next: ReactorStatus) => {
    const previous = renderStatusRef.current;
    renderStatusRef.current = next;
    setRenderStatus(next);
    if (next === "disconnected" && previous === "ready") {
      setRenderMounted(false);
      setRenderStreaming(false);
      setRenderNote("The Reactor render ended — showing the physics view. Turn Live Reactor on to render again.");
      setRenderWanted(false);
    }
  }, []);

  const onRenderFrames = useCallback(() => {
    retryAttemptRef.current = 0;
    setRenderStreaming(true);
  }, []);

  useEffect(() => {
    if (!renderMounted) { renderStatusRef.current = "disconnected"; setRenderStatus("disconnected"); }
  }, [renderMounted]);

  // Reactor bills connected wall-clock time: count it, and stop the render after two idle minutes.
  useEffect(() => {
    if (!renderMounted || renderStatus !== "ready") return;
    const timer = window.setInterval(() => {
      setRenderSeconds(value => value + 1);
      if (Date.now() - lastInputRef.current > RENDER_IDLE_MS) {
        setRenderWanted(false);
        setRenderNote("Reactor render stopped after two idle minutes — showing the physics view.");
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [renderMounted, renderStatus]);

  useEffect(() => {
    if (!renderRetry) return;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [renderRetry]);

  async function run(kind: JobKind) {
    setPending(kind);
    setJobError(null);
    try { await onJob(room.path, kind); }
    catch (cause) { setJobError(message(cause)); }
    finally { setPending(null); }
  }

  const steps = state?.steps ?? room.steps ?? taskProgram(room.task);
  const summary = stepSummary(steps);
  const success = Boolean(state?.success);
  const title = robotTaskTitle(room.task) ?? room.task.title;
  const reactorShowing = renderMounted && renderStreaming;
  const metrics = state?.metrics ?? null;
  const exportJob = room.jobs.export;
  const download = room.export?.download_url ?? null;
  const exportBlocked = !runnable ? "Build physics first" : !playgroundAvailable ? "Install the playground extra on the server" : null;
  const prompt = simulationPrompt(room, info?.layout.support ?? null);
  const retryIn = renderRetry ? Math.max(0, Math.ceil((renderRetry.until - clock) / 1000)) : 0;
  const physicsBlocked = !scanReady ? "Generate the room's Reactor scan first" : null;

  let placeholder: React.ReactNode = null;
  if (!robot) {
    placeholder = <><strong>Explore-only room</strong><p>No single-arm robot task was planned for this room's objects.</p></>;
  } else if (!robot.feasible) {
    placeholder = <><strong>Not a Panda task</strong><p>{robot.reason ?? "The task object is not graspable by the Panda gripper."}</p></>;
  } else if (!physicsReady) {
    placeholder = <>
      <strong>The robot simulation runs on this room's MuJoCo reconstruction.</strong>
      <p>Build physics from the Reactor scan, then drive a Franka Panda through the task step by step.</p>
      <div className="rw-button-row">
        <button className="rw-button rw-primary" disabled={Boolean(physicsBlocked) || pending === "physics" || jobActive(room.jobs.physics)}
          title={physicsBlocked ?? undefined} onClick={() => void run("physics")}>Build physics</button>
      </div>
      <p className="rw-caption">{physicsBlocked ?? `MuJoCo reconstruction · ${jobLabel(room.jobs.physics)}`}</p>
    </>;
  } else if (phase === "starting" || phase === "idle") {
    placeholder = <><i className="rw-spinner" /><strong>Starting the Panda simulation…</strong><p>Loading the exported MuJoCo Playground scene for {room.title}.</p></>;
  } else if (phase === "closed" || phase === "error") {
    placeholder = <><strong>{phase === "error" ? "The simulation could not start." : "The simulation ended."}</strong>
      {error && <p>{error}</p>}
      <div className="rw-button-row"><button className="rw-button rw-primary" onClick={() => setRestart(value => value + 1)}>Restart simulation</button></div></>;
  }

  return <section className="rw-robot-stage" aria-label="Robot simulation">
    <div className={`rw-robot-view${reactorShowing ? " rw-rendered" : ""}`}>
      {renderMounted && <SanaStreamingProvider jwtToken={fetchSanaToken} connectOptions={{ autoConnect: true }}>
        <SanaRender canvas={canvas} prompt={prompt} seed={room.seed} visible={reactorShowing}
          onStatus={onRenderStatus} onFrames={onRenderFrames} onError={failRender} />
      </SanaStreamingProvider>}
      <figure className={`rw-robot-physics${reactorShowing ? " rw-robot-pip" : ""}`}>
        <img ref={imgRef} alt={`MuJoCo physics of the Franka Panda in ${room.title}`} draggable={false} />
        {reactorShowing && <figcaption>Physics ground truth</figcaption>}
      </figure>
      <canvas ref={setCanvas} width={RENDER_WIDTH} height={RENDER_HEIGHT} className="rw-robot-canvas" aria-hidden="true" />
      <div className="rw-robot-badge">
        <span className="rw-eyebrow">ROBOT SIMULATION</span>
        <b>{reactorShowing ? "Reactor · live render of the simulation" : "MuJoCo physics · Franka Panda"}</b>
      </div>
      <button className={`rw-live-reactor${renderWanted ? " rw-on" : ""}`} aria-pressed={renderWanted} disabled={!reactorConfigured}
        title={reactorConfigured ? "Render the simulation live with reactor/sana-streaming (~$0.10/min)" : "Set REACTOR_API_KEY in .env"}
        onClick={() => { setRenderNote(null); setRenderWanted(value => !value); }}>
        <i />Live Reactor
      </button>
      {renderMounted && !renderStreaming && phase === "live" && <p className="rw-robot-note" role="status"><i className="rw-spinner" />Reactor is rendering the simulation…</p>}
      {renderRetry && <div className="rw-retry rw-robot-retry" role="status">
        <i className="rw-spinner" />
        <span>Reactor SANA is at capacity — retrying in {retryIn} s <small>(attempt {renderRetry.attempt} of 3)</small></span>
        <button className="rw-button" onClick={() => { cancelRetry(); setRenderWanted(false); }}>Cancel</button>
      </div>}
      {renderNote && !renderRetry && <p className="rw-robot-note rw-warn" role="alert">{renderNote}<button aria-label="Dismiss" onClick={() => setRenderNote(null)}>×</button></p>}
      {state?.mode === "demo" && <p className="rw-robot-demo-note" role="status">Scripted demo running — any control takes over.</p>}
      {placeholder && <div className="rw-robot-placeholder">{placeholder}</div>}
    </div>

    <div className="rw-robot-bar" role="region" aria-label="Your robot task">
      <div className="rw-robot-bar-head">
        <span className="rw-robot-icon" aria-hidden="true">⌘</span>
        <div className="rw-robot-title">
          <span className="rw-eyebrow">YOUR ROBOT TASK <b>{robot?.kind ?? "explore"}</b>
            <em>Real task — from the beginning image of {world.source.file}</em></span>
          <h2>{title}</h2>
        </div>
        <span className={`rw-physics-live${frameLive ? " rw-on" : ""}`} data-testid="robot-physics-status"><i />
          {frameLive ? "Physics live" : phase === "starting" ? "Starting" : runnable ? "Physics paused" : "Physics not built"}</span>
      </div>
      <div className="rw-step-head">
        <span className="rw-eyebrow">REWARD CHECKED BY CODE — MUJOCO STEP CHECKS</span>
        <span>{summary.done}/{summary.total} checks</span>
      </div>
      <ol className="rw-step-track" aria-label="Task steps">
        {steps.map((step, index) => <li key={step.id} className={step.done ? "rw-done" : index === summary.current ? "rw-current" : undefined} title={step.title}>
          <span>{step.title}</span>
        </li>)}
      </ol>
      {success
        ? <p className="rw-robot-success" role="status">Task complete · {summary.total}/{summary.total} steps</p>
        : <p className="rw-robot-next">{steps[summary.current] ? `Step ${summary.current + 1}: ${steps[summary.current].title}` : "No steps"}</p>}
      <dl className="rw-robot-metrics">
        <div><dt>Goal distance</dt><dd>{metrics ? `${(metrics.goal_distance_m * 100).toFixed(1)} cm` : "—"}</dd></div>
        <div><dt>Contact</dt><dd>{metrics ? contactLabel(metrics) : "—"}</dd></div>
        <div><dt>Step</dt><dd>{Math.min(summary.current + 1, summary.total)} / {summary.total}</dd></div>
        <div><dt>Time</dt><dd>{state ? `${state.time.toFixed(1)} s` : "—"}</dd></div>
        {renderMounted && <div><dt>Reactor render</dt><dd className="rw-cost">{formatSeconds(renderSeconds)} · {formatCost(renderSeconds, SANA_COST_PER_SECOND)}</dd></div>}
      </dl>
      <div className="rw-robot-controls">
        <div className="rw-pad" role="group" aria-label="Move the gripper">
          <button aria-label="Move away (Arrow Up)" disabled={phase !== "live"} {...hold("arrowup")}>↑</button>
          <button aria-label="Move left (Arrow Left)" disabled={phase !== "live"} {...hold("arrowleft")}>←</button>
          <button aria-label="Move closer (Arrow Down)" disabled={phase !== "live"} {...hold("arrowdown")}>↓</button>
          <button aria-label="Move right (Arrow Right)" disabled={phase !== "live"} {...hold("arrowright")}>→</button>
        </div>
        <div className="rw-pad-z" role="group" aria-label="Change height">
          <button aria-label="Raise (R)" disabled={phase !== "live"} {...hold("r")}>R ↑</button>
          <button aria-label="Lower (F)" disabled={phase !== "live"} {...hold("f")}>F ↓</button>
        </div>
        <button className="rw-grip" aria-pressed={gripClosed} disabled={phase !== "live"} onClick={toggleGrip}
          onKeyDown={event => { if (event.key === " ") event.preventDefault(); }}>
          {gripClosed ? "Open gripper" : "Close gripper"}<small>SPACE</small>
        </button>
        <div className="rw-robot-actions">
          <button className="rw-button" disabled={phase !== "live"} onClick={() => command({ type: "reset" })}>↺ Reset task</button>
          <button className="rw-button" disabled={phase !== "live"} onClick={() => command({ type: "demo" })}>▷ Watch demo</button>
          {download
            ? <a className="rw-button rw-primary" href={download} download>↓ Download training gym</a>
            : <button className="rw-button" disabled={Boolean(exportBlocked) || pending === "playground" || jobActive(exportJob)}
              title={exportBlocked ?? (room.export && !room.export.feasible ? room.export.reason ?? undefined : "Training gym — MuJoCo Playground (MJX)")}
              onClick={() => void run("playground")}>
              {jobActive(exportJob) ? `Exporting… ${Math.round(exportJob.progress)}%` : "↓ Export training gym"}
            </button>}
        </div>
      </div>
      {(jobError || (room.export && !room.export.feasible && room.export.reason)) &&
        <p className="rw-error-inline" role="alert">{jobError ?? room.export?.reason}</p>}
      <p className="rw-robot-hint">Arrow keys move the robot · R / F change height · Space opens or closes the fingers · Esc returns to the Reactor world</p>
    </div>
  </section>;
}
