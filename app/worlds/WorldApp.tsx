"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { validWorldPath, worldChildren, worldGymUrl, worldRoom } from "../lib/robot-worlds";
import { ReactorPhysicsView } from "./ReactorPhysicsView";
import ReactorGym, { type GeneratedGym } from "./ReactorGym";
import type { RobotControl, RobotState, WorldSession } from "./types";
import styles from "./worlds.module.css";

const RobotWorld = dynamic(() => import("./RobotWorld"), { ssr: false });
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/robot-worlds/${path}`, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : body.error ?? "Robot command failed");
  return body;
}

export default function WorldApp({ initialPath, initialMode, videos, generated, reactorConfigured }: {
  initialPath: string; initialMode: "reactor" | "physics"; videos: string[]; generated: GeneratedGym[]; reactorConfigured: boolean;
}) {
  const [path, setPath] = useState(initialPath);
  const [mode, setMode] = useState(initialMode);
  const [entryRequest, setEntryRequest] = useState(0);
  const room = worldRoom(path), children = worldChildren(path);
  const [session, setSession] = useState<WorldSession | null>(null);
  const [state, setState] = useState<RobotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [directory, setDirectory] = useState(false);
  const [showReactor, setShowReactor] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [completed, setCompleted] = useState<string[]>([]);
  const stateRef = useRef<RobotState | null>(null);
  const input = useRef(new Set<string>());
  const grip = useRef(1);
  const pending = useRef<RobotControl[]>([]);
  const stopMotion = useCallback(() => input.current.clear(), []);
  const robot = state?.robot;

  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem("robot-worlds:completed") ?? "[]"); if (Array.isArray(saved)) setCompleted(saved.filter(v => typeof v === "string")); } catch {}
    const pop = () => { const query = new URLSearchParams(location.search); const next = query.get("room") ?? "root"; setPath(validWorldPath(next) ? next : "root"); setMode(query.get("mode") === "physics" ? "physics" : "reactor"); };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    let disposed = false, identifier: string | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0, settling = 0;
    setSession(null); setState(null); stateRef.current = null; setError(null);
    input.current.clear(); pending.current = []; grip.current = 1;
    if (mode !== "physics") return;
    const close = () => {
      if (!identifier) return;
      const closing = identifier; identifier = null;
      void fetch(`/api/robot-worlds/sessions/${closing}`, { method: "DELETE", keepalive: true }).catch(() => {});
    };
    const leave = () => { disposed = true; clearTimeout(timer); stopMotion(); close(); };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) setRetry(value => value + 1); };
    window.addEventListener("pagehide", leave); window.addEventListener("pageshow", restore);
    const receive = (next: RobotState) => {
      stateRef.current = next; setState(next);
      grip.current = next.robot.gripper_open ? 1 : -1;
      if (next.robot.is_success) setCompleted(previous => {
        if (previous.includes(path)) return previous;
        const result = [...previous, path].slice(-200);
        try { localStorage.setItem("robot-worlds:completed", JSON.stringify(result)); } catch {}
        return result;
      });
    };
    const loop = async () => {
      if (disposed || !identifier) return;
      const started = performance.now();
      const keys = input.current;
      const motion = [Number(keys.has("right")) - Number(keys.has("left")), Number(keys.has("forward")) - Number(keys.has("backward")), Number(keys.has("up")) - Number(keys.has("down"))];
      const queued = pending.current.shift();
      if (!queued && !motion.some(Boolean) && !settling && (!stateRef.current || stateRef.current.robot.done || stateRef.current.robot.controller === "manual")) {
        timer = setTimeout(loop, 50); return;
      }
      const control = queued ?? (motion.some(Boolean) ? { type: "action" as const, action: [...motion.map(n => n * .55), grip.current] } : { type: "advance" as const });
      settling = queued || motion.some(Boolean) ? 12 : Math.max(0, settling - 1);
      try {
        const result = await request<{ state: RobotState; sequence: number }>(`sessions/${identifier}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sequence: sequence + 1, command: control }), signal: AbortSignal.timeout(8000),
        });
        if (disposed) return;
        sequence = result.sequence; receive(result.state);
        timer = setTimeout(loop, Math.max(0, 50 - (performance.now() - started)));
      } catch (failure) {
        if (!disposed) { stopMotion(); setError(failure instanceof Error ? failure.message : "Robot connection interrupted"); }
      }
    };
    void request<WorldSession>("sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })
      .then(result => {
        identifier = result.id;
        if (disposed) { close(); return; }
        setSession(result); receive(result.state); void loop();
      }).catch(failure => { if (!disposed) setError(failure.message); });
    return () => {
      disposed = true; clearTimeout(timer); stopMotion(); pending.current = [];
      window.removeEventListener("pagehide", leave); window.removeEventListener("pageshow", restore); close();
    };
  }, [path, mode, retry, stopMotion]);

  const queue = (control: RobotControl) => { stopMotion(); pending.current.push(control); };
  const toggleGrip = useCallback(() => {
    grip.current *= -1;
    pending.current.push({ type: "action", action: [0, 0, 0, grip.current] });
  }, []);
  useEffect(() => {
    if (mode !== "physics") return;
    const directions: Record<string, string> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "forward", ArrowDown: "backward", r: "up", f: "down" };
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,dialog")) return;
      const direction = directions[event.key];
      if (direction) { event.preventDefault(); input.current.add(direction); }
      if (event.code === "Space" && !event.repeat) { event.preventDefault(); toggleGrip(); }
    };
    const keyup = (event: KeyboardEvent) => { const direction = directions[event.key]; if (direction) input.current.delete(direction); };
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", stopMotion);
    const visibility = () => { if (document.hidden) stopMotion(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", stopMotion); document.removeEventListener("visibilitychange", visibility); };
  }, [mode, stopMotion, toggleGrip]);

  const navigate = useCallback((next: string) => {
    stopMotion(); setDirectory(false); setPath(next);
    if (mode === "reactor") setEntryRequest(value => value + 1);
    const query = new URLSearchParams(); if (next !== "root") query.set("room", next); if (mode === "physics") query.set("mode", "physics");
    history.pushState({}, "", `/worlds${query.size ? `?${query}` : ""}`);
  }, [stopMotion, mode]);
  const changeMode = (next: "reactor" | "physics") => {
    stopMotion(); setShowReactor(false); setMode(next);
    if (next === "reactor") setEntryRequest(value => value + 1);
    const query = new URLSearchParams(location.search); if (next === "physics") query.set("mode", next); else query.delete("mode");
    history.pushState({}, "", `/worlds${query.size ? `?${query}` : ""}`);
  };
  const downloadGym = async () => {
    if (!session) return;
    setExporting(true);
    try {
      const response = await fetch(`/api/robot-worlds/sessions/${session.id}/gym`, { method: "POST" });
      if (!response.ok) throw new Error("Gym export could not complete");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${room.theme.id}-robot-gym.zip`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Export failed"); }
    finally { setExporting(false); }
  };

  const moveButton = (direction: string, label: string, symbol: string) => <button aria-label={label} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); input.current.add(direction); }} onPointerUp={() => input.current.delete(direction)} onPointerCancel={() => input.current.delete(direction)} onLostPointerCapture={() => input.current.delete(direction)}>{symbol}</button>;
  const progress = robot?.is_success ? 1 : state?.tasks[0]?.progress ?? 0;
  return <div className={styles.app} style={{ "--accent": room.theme.accent } as CSSProperties}>
    <header className={styles.header}><a href="/worlds" className={styles.brand}><span>◈</span>rooms<span className={styles.brandSub}>ROBOT WORLDS</span></a><span className={styles.experiment}>EXPERIMENT 03 <i /> REACTOR WORLD MODEL</span><div className={styles.headerActions}><a href="/lab">Task lab ↗</a><button onClick={() => changeMode(mode === "reactor" ? "physics" : "reactor")} aria-pressed={mode === "reactor"}>{mode === "reactor" ? "Physics prototype ↗" : "◉ Reactor world"}</button>{mode === "physics" && <button onClick={() => setShowReactor(v => !v)} aria-pressed={showReactor}>◉ High fidelity</button>}</div></header>
    <nav className={styles.trail}><button aria-label="Show connected robot rooms" onClick={() => setDirectory(v => !v)}>☷</button><button aria-label="Return to parent world" disabled={!room.parent} onClick={() => room.parent && navigate(room.parent)}>←</button><button onClick={() => navigate("root")}>The Glasshouse</button>{path !== "root" && <><span>/</span><span>{room.theme.name}</span></>}<span className={styles.depth}>DEPTH {String(room.depth).padStart(2, "0")} · {completed.length} COMPLETED</span></nav>
    <main className={styles.main}>
      <aside className={`${styles.directory} ${directory ? styles.directoryOpen : ""}`}><div className={styles.directoryHeading}><small>WALK SOMEWHERE NEW</small><h2>10 other worlds <span>↗</span></h2><p>Different environments. One task per room.</p></div><div className={styles.roomList}>{children.map((child, index) => <button key={child.path} aria-label={`Enter ${child.theme.name}`} onClick={() => navigate(child.path)}><img src={generated.find(asset => asset.theme === child.theme.id)?.image ?? child.image} alt="" /><span><small>{String(index + 1).padStart(2, "0")} / {child.kind.toUpperCase()}</small><strong>{child.theme.name}</strong><em>{child.goal}</em></span><b>{completed.includes(child.path) ? "✓" : "↗"}</b></button>)}</div><p className={styles.directoryNote}>Every doorway has another ten paths.<br />Choose a world and enter Reactor.</p></aside>
      <section className={styles.stage} aria-label={`Playable robot room: ${room.theme.name}`}>
        {mode === "reactor" ? <ReactorGym room={room} entryRequest={entryRequest} nextRoom={children[0]} generated={generated.find(asset => asset.theme === room.theme.id)} configured={reactorConfigured} onPhysics={() => changeMode("physics")} onDoor={navigate} /> : <>
        {session && <RobotWorld session={session} stateRef={stateRef} room={room} children={children} videoUrl={videos.includes(room.theme.id) ? room.video : null} onDoor={navigate} onCanvas={setCanvas} />}
        {!session && <div className={styles.loading} style={{ backgroundImage: `linear-gradient(#10181533,#101815aa), url(${room.image})` }}><span className={styles.spinner} /><p>{error ? "Connection needs attention" : "Preparing your robot world…"}</p></div>}
        <ReactorPhysicsView room={room} canvas={canvas} enabled={showReactor} configured={reactorConfigured} onEnabledChange={setShowReactor} />
        <div className={styles.roomTitle}><small>WORLD {String(room.index + 1).padStart(2, "0")} <span>MUJOCO PHYSICS</span></small><h1>{room.theme.name}</h1><p>{room.theme.description}</p></div>
        <div className={styles.walkHint}><kbd>W A S D</kbd> walk <span>·</span> drag to look <span>·</span> click doors</div>
        {robot?.is_success && <div className={styles.success} role="status"><span>✓</span><strong>Task complete</strong><p>Real contacts. A real result.</p><button onClick={() => queue({ type: "reset" })}>Try again</button><button onClick={() => navigate(children[0]?.path ?? "root")}>Next world ↗</button></div>}
        <div className={styles.taskPanel}><div className={styles.taskHeading}><span className={styles.taskIcon}>⌘</span><div><small>YOUR ROBOT TASK <span>{room.kind.toUpperCase()}</span></small><h2>{room.goal}</h2></div><span className={`${styles.connection} ${session && !error ? styles.online : ""}`}><i />{session && !error ? "Physics live" : "Connecting"}</span></div><div className={styles.progress}><i style={{ width: `${progress * 100}%` }} /></div><div className={styles.taskStats}><span>Goal distance <strong data-testid="goal-distance">{robot ? `${(robot.distance * 100).toFixed(1)} cm` : "—"}</strong></span><span>Contact <strong>{robot?.grasped ? "Both fingers ✓" : "Ready to grasp"}</strong></span><span>Step <strong data-testid="robot-step">{robot?.steps ?? 0}</strong></span></div>
          <div className={styles.controls}><div className={styles.dpad}>{moveButton("forward", "Move robot forward", "↑")}<div>{moveButton("left", "Move robot left", "←")}{moveButton("backward", "Move robot backward", "↓")}{moveButton("right", "Move robot right", "→")}</div></div><div className={styles.heightControls}>{moveButton("up", "Raise gripper", "R ↑")}{moveButton("down", "Lower gripper", "F ↓")}</div><button className={styles.gripButton} disabled={!session || robot?.done} onClick={toggleGrip}>{robot?.gripper_open ? "Close gripper" : "Open gripper"}<small>SPACE</small></button><div className={styles.taskActions}><button disabled={!session} onClick={() => { grip.current = 1; queue({ type: "reset" }); }}>↺ Reset task</button><button disabled={!session} onClick={() => queue({ type: "run", controller: "scripted" })}>▷ Watch demo</button><button disabled={!session || exporting} onClick={() => void downloadGym()}>{exporting ? "Exporting…" : "↓ Export training gym"}</button></div></div><p className={styles.controlHint}>Arrow keys move the robot · R / F change height · Space opens or closes the fingers</p>
        </div>
        {error && <div className={styles.error} role="alert">{error}<button onClick={() => setRetry(v => v + 1)}>Reconnect</button></div>}
        </>}
      </section>
    </main><footer className={styles.footer}><span>{mode === "reactor" ? "REACTOR GENERATES THE VIEW AS YOU MOVE." : "MUJOCO PHYSICS PROTOTYPE."}</span><span>{mode === "reactor" ? "LingBot World 2 · generated video · gym geometry needs reconstruction" : "Franka Panda · 7 articulated joints · physical finger contacts"}</span><a href={worldGymUrl(room)}>Footage → Playground pipeline ↗</a></footer>
  </div>;
}
