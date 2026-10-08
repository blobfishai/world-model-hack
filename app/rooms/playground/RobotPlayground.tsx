"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { roomRequest, type PhysicsState, type RoomId, type SimulationSession } from "../types";

const RoomViewer = dynamic(() => import("../RoomViewer").then(module => module.RoomViewer), { ssr: false });
const ReactorRoomView = dynamic(() => import("../ReactorRoomView").then(module => module.ReactorRoomView), { ssr: false });
const noop = () => {};
const recordedReactor = { src: "/robot-playground/reactor-mug-lift.mp4", poster: "/robot-playground/reactor-mug-lift.jpg" };
type Task = { id: string; label: string; kind: "reach" | "lift" | "push"; tolerance: number; goal: number[] };
type Evaluation = { seed: number; success: boolean; return: number; distance: number; steps: number; failure: string | null };
type Training = { algorithm: string; task: string; actual_timesteps: number; success_rate: number; seed: number; evaluation: Evaluation[]; policy_available: boolean };
type Catalog = { room: RoomId; revision: string; source: "training" | "current"; name: string; scale_status: string; tasks: Task[]; training: Training | null; video_url: string | null };
type RobotState = PhysicsState & { robot: { controller: "manual" | "scripted" | "policy"; seed: number; task: Task; steps: number; max_steps: number; done: boolean; truncated: boolean; is_success: boolean; failure: string | null; reward: number; return: number; distance: number; grasped: boolean; gripper_open: boolean; tool_position: number[] } };
type RobotSession = SimulationSession & { goal: number[]; policy_available: boolean; source: string; state: RobotState };
type RobotCommand = { type: "action" | "advance" | "reset" | "pause" | "run" | "take_control"; action?: number[]; controller?: "scripted" | "policy"; seed?: number; paused?: boolean };

const directions = [
  { key: "w", label: "Forward", mark: "↑", axis: 1, sign: 1 },
  { key: "a", label: "Left", mark: "←", axis: 0, sign: -1 },
  { key: "s", label: "Back", mark: "↓", axis: 1, sign: -1 },
  { key: "d", label: "Right", mark: "→", axis: 0, sign: 1 },
  { key: "q", label: "Up", mark: "+Z", axis: 2, sign: 1 },
  { key: "e", label: "Down", mark: "−Z", axis: 2, sign: -1 },
];

export function RobotPlayground() {
  const [room, setRoom] = useState<RoomId>("kitchen");
  const [source, setSource] = useState<"training" | "current">("training");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [task, setTask] = useState("");
  const [session, setSession] = useState<RobotSession | null>(null);
  const [snapshot, setSnapshot] = useState<RobotState | null>(null);
  const [seed, setSeed] = useState("42");
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pressed, setPressed] = useState<string[]>([]);
  const [keyboard, setKeyboard] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<PhysicsState | null>(null);
  const robotRef = useRef<RobotState | null>(null);
  const sessionRef = useRef<{ id: string; room: RoomId } | null>(null);
  const keys = useRef(new Set<string>());
  const grip = useRef(1);
  const settling = useRef(0);
  const blocked = useRef(false);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const pendingReplay = useRef<{ seed: number; task: string } | null>(null);

  const accept = useCallback((value: RobotState) => {
    stateRef.current = robotRef.current = value;
    grip.current = value.robot.gripper_open ? 1 : -1;
    setSnapshot(value);
  }, []);

  const send = useCallback((command: RobotCommand) => {
    const target = sessionRef.current;
    if (!target) return Promise.resolve();
    const operation = pending.current.catch(noop).then(async () => {
      if (sessionRef.current?.id !== target.id) return;
      try {
        const value = await roomRequest<RobotState>(`/rooms/${target.room}/robot-sessions/${target.id}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
        });
        if (sessionRef.current?.id === target.id) accept(value);
      } catch (cause) {
        if (sessionRef.current?.id === target.id) {
          blocked.current = true;
          keys.current.clear(); setPressed([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    });
    pending.current = operation;
    return operation;
  }, [accept]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setError(null);
    void roomRequest<Catalog>(`/rooms/${room}/playground?source=${source}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setCatalog(value);
      setTask(current => value.tasks.some(item => item.id === (pendingReplay.current?.task ?? current))
        ? pendingReplay.current?.task ?? current : value.tasks[0]?.id ?? "");
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [room, source, generation]);

  useEffect(() => {
    if (!catalog || !catalog.tasks.some(item => item.id === task)) return;
    let active = true;
    let id: string | null = null;
    const selectedRoom = catalog.room;
    keys.current.clear(); setPressed([]); settling.current = 0; blocked.current = false;
    robotRef.current = null; stateRef.current = null; sessionRef.current = null;
    pending.current = Promise.resolve();
    setSession(null); setSnapshot(null); setError(null);
    const close = (sessionId: string) => fetch(`/api/rooms/${selectedRoom}/robot-sessions/${sessionId}`, { method: "DELETE", keepalive: true }).catch(noop);
    const leave = () => { active = false; if (id) void close(id); };
    window.addEventListener("pagehide", leave);
    const requestSeed = pendingReplay.current?.seed ?? 42;
    void roomRequest<RobotSession>(`/rooms/${selectedRoom}/robot-sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: catalog.source, revision: catalog.revision, task, seed: requestSeed }),
    }).then(value => {
      id = value.id;
      if (!active) { void close(id); return; }
      sessionRef.current = { id, room: selectedRoom };
      setSession(value); accept(value.state); setSeed(String(value.state.robot.seed));
      if (pendingReplay.current && pendingReplay.current.task === task) {
        const replay = pendingReplay.current; pendingReplay.current = null;
        setBusy(true);
        void send({ type: "run", controller: "policy", seed: replay.seed }).finally(() => { if (active) setBusy(false); });
      }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      window.removeEventListener("pagehide", leave);
      active = false; keys.current.clear(); settling.current = 0;
      if (!id || sessionRef.current?.id === id) sessionRef.current = null;
      if (id) void close(id);
    };
  }, [catalog, task, accept, send]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      const start = performance.now();
      const value = robotRef.current;
      if (!blocked.current && value && !value.paused && !value.robot.done && sessionRef.current) {
        if (keys.current.size) {
          const action = [0, 0, 0, grip.current];
          for (const direction of directions) if (keys.current.has(direction.key)) action[direction.axis] += .5 * direction.sign;
          await send({ type: "action", action });
          settling.current = 8;
        } else if (value.robot.controller !== "manual" || settling.current > 0) {
          settling.current = Math.max(0, settling.current - 1);
          await send({ type: "advance" });
        }
      }
      if (active) timer = setTimeout(tick, Math.max(0, 50 - (performance.now() - start)));
    }
    timer = setTimeout(tick, 50);
    return () => { active = false; clearTimeout(timer); };
  }, [send]);

  const clearKeys = useCallback(() => { keys.current.clear(); setPressed([]); }, []);
  const toggleGrip = useCallback(() => {
    if (!sessionRef.current || robotRef.current?.robot.done || robotRef.current?.paused) return;
    grip.current *= -1; settling.current = 12;
    void send({ type: "action", action: [0, 0, 0, grip.current] });
  }, [send]);

  function parsedSeed() {
    const value = Number(seed);
    if (!Number.isInteger(value) || value < 0 || value > 2**32 - 1) {
      setError("Use a whole-number seed between 0 and 4294967295."); return null;
    }
    return value;
  }

  async function run(controller: "scripted" | "policy") {
    const value = parsedSeed(); if (value === null) return;
    clearKeys(); settling.current = 0; setError(null); blocked.current = false; setBusy(true);
    await send({ type: "run", controller, seed: value });
    setBusy(false);
  }

  function reset() {
    const value = parsedSeed(); if (value === null) return;
    clearKeys(); settling.current = 0; blocked.current = false; setError(null);
    void send({ type: "reset", seed: value });
  }

  async function replay(evaluation: Evaluation) {
    if (!catalog?.training) return;
    clearKeys(); settling.current = 0; setSeed(String(evaluation.seed)); setError(null); blocked.current = false;
    if (catalog.source === "training" && task === catalog.training.task && sessionRef.current) {
      setBusy(true); await send({ type: "run", controller: "policy", seed: evaluation.seed }); setBusy(false);
    } else {
      pendingReplay.current = { seed: evaluation.seed, task: catalog.training.task };
      setSource("training"); setTask(catalog.training.task);
    }
    viewport.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (document.activeElement !== viewport.current || event.repeat || !sessionRef.current) return;
      const key = event.key.toLowerCase();
      if (directions.some(item => item.key === key)) {
        event.preventDefault(); keys.current.add(key); setPressed([...keys.current]);
      } else if (key === " ") { event.preventDefault(); toggleGrip(); }
    }
    function keyUp(event: KeyboardEvent) {
      keys.current.delete(event.key.toLowerCase()); setPressed([...keys.current]);
    }
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", clearKeys);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", clearKeys); };
  }, [clearKeys, toggleGrip]);

  const robot = snapshot?.robot;
  const training = catalog?.training;
  const successCount = training?.evaluation.filter(item => item.success).length ?? 0;
  const disabled = !session || !!robot?.done || !!snapshot?.paused || busy;
  const controllerName = robot?.controller === "policy" ? "Trained PPO policy" : robot?.controller === "scripted" ? "Scripted demonstration" : "Manual control";
  const outcome = robot?.is_success ? "Task completed" : robot?.done ? robot.failure ? "Object dropped or outside room" : "Episode time limit reached" : snapshot?.paused ? "Paused" : controllerName;

  return <div className="rooms-app robot-playground">
    <header className="robot-header"><Link href="/explore" className="rooms-wordmark">room<span>/</span>world</Link><nav><Link href="/explore">Task explorer</Link><Link href="/rooms/simulation">Room editor</Link><span aria-current="page">Robot playground</span></nav><span className="robot-local"><i /> LOCAL SIMULATION</span></header>
    <main className="robot-main">
      <div className="robot-intro"><div><p className="eyebrow">FROM YOUR FOOTAGE TO PHYSICAL ACTION</p><h1>A room. A robot.<br /><em>Your next move.</em></h1><p>Drive the gripper. Watch Reactor transform the live scene. Replay real policy results.</p></div><div className="robot-result-summary"><span className="eyebrow">RECORDED PPO EVALUATION</span>{training ? <><strong>{successCount}<small> / {training.evaluation.length}</small></strong><span>successful episodes · {training.actual_timesteps.toLocaleString()} training steps</span><a href="#training-results">See every result ↓</a></> : <><strong>—</strong><span>No saved training run for this room.</span></>}</div></div>

      <div className="robot-setup">
        <label>Room<select aria-label="Robot room" value={room} onChange={event => { clearKeys(); pendingReplay.current = null; setRoom(event.target.value as RoomId); setSource("current"); setTask(""); }}><option value="kitchen">Kitchen</option><option value="living-room">Living room</option><option value="bedroom">Bedroom</option><option value="bathroom">Bathroom</option></select></label>
        <label>Scene<select aria-label="Scene version" value={catalog?.source ?? source} onChange={event => { pendingReplay.current = null; setSource(event.target.value as "training" | "current"); }}>{(training || source === "training") && <option value="training">Saved training scene</option>}<option value="current">Current room reconstruction</option></select></label>
        <label className="robot-task-select">Task<select aria-label="Robot task" disabled={!catalog || busy} value={task} onChange={event => { clearKeys(); pendingReplay.current = null; setTask(event.target.value); }}>{!catalog && <option>Loading tasks…</option>}{catalog?.tasks.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Episode seed<input aria-label="Episode seed" type="number" min="0" max="4294967295" value={seed} onChange={event => setSeed(event.target.value)} /></label>
      </div>

      {error && <div className="room-error room-global-error" role="alert"><span>{error}</span><button onClick={() => { clearKeys(); pendingReplay.current = null; setGeneration(value => value + 1); }}>Reconnect</button></div>}

      <div className="robot-workspace">
        <section className="robot-view-panel" aria-label="Live robot environment">
          <div className="robot-view-heading"><span className="eyebrow">LIVE / MUJOCO PHYSICS</span><span className={`room-pill ${session ? "live" : ""}`}><i />{session ? controllerName : "Opening environment…"}</span></div>
          <div ref={viewport} className={`robot-viewport ${keyboard ? "keyboard-active" : ""}`} tabIndex={0} role="group" aria-label="Robot keyboard controls" onFocus={() => setKeyboard(true)} onBlur={() => { setKeyboard(false); clearKeys(); }} onPointerDownCapture={() => viewport.current?.focus({ preventScroll: true })}>
            {session ? <RoomViewer session={session} stateRef={stateRef} onCommand={noop} onCanvas={setCanvas} onSelect={noop} interactive={false} goal={session.goal} /> : <div className="room-empty"><strong>Preparing the gripper…</strong><span>Loading room geometry and a fresh physical state.</span></div>}
            <div className="robot-canvas-note"><span className="robot-goal-dot" />Green sphere = task goal<span>{keyboard ? "Keyboard controls active" : "Click the scene to use the keyboard"}</span></div>
          </div>
          <div className="robot-playback"><button className="room-button primary" disabled={!session || busy || robot?.task.kind === "push"} onClick={() => void run("scripted")}>▶ Scripted demo</button><button className="room-button" disabled={!session?.policy_available || !training?.policy_available || busy} onClick={() => void run("policy")}>{busy ? "Loading controller…" : "▶ Trained policy"}</button><button className="room-button" disabled={!session || busy} onClick={() => { clearKeys(); settling.current = 0; void send({ type: "pause", paused: !snapshot?.paused }); }}>{snapshot?.paused ? "▶ Resume" : "Ⅱ Pause"}</button><button className="room-button" disabled={!session || busy} onClick={reset}>↺ Reset episode</button></div>
          <p className="robot-view-caption">Drag to orbit · Scroll to zoom · Idle manual controls pause simulation time. Each RL episode allows {robot?.max_steps ?? 200} steps.</p>
        </section>

        <div className="robot-reactor" aria-label="Reactor robot view">{session ? <ReactorRoomView key={session.id} canvas={canvas} roomName={session.spec.name} recording={room === "kitchen" && catalog?.source === "training" ? recordedReactor : undefined} appearance={`${session.spec.appearance}. Keep the blue robot gripper, its two fingers, and the green target marker clearly visible`} /> : <div className="room-empty"><strong>Reactor view</strong><span>Connect once the robot environment is ready.</span></div>}<p className="robot-reactor-explanation">Your controls → MuJoCo movement → live camera frames → Reactor video. Contacts, rewards, and success are measured in the physical simulation.</p></div>

        <aside className="robot-controls" aria-label="Gripper controls">
          <div className="room-panel-heading"><span className="eyebrow">TAKE THE CONTROLS</span><span className="room-pill">XYZ + grip</span></div>
          <h2>Make the next move.</h2><p>Hold a direction to move. Close the fingers around an object, then lift.</p>
          <div className="robot-pad">{directions.map(direction => <button key={direction.key} className={`robot-direction key-${direction.key} ${pressed.includes(direction.key) ? "pressed" : ""}`} aria-label={`Move ${direction.label.toLowerCase()}`} disabled={disabled} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); keys.current.add(direction.key); setPressed([...keys.current]); }} onPointerUp={event => { keys.current.delete(direction.key); setPressed([...keys.current]); event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { keys.current.delete(direction.key); setPressed([...keys.current]); }} onLostPointerCapture={() => { keys.current.delete(direction.key); setPressed([...keys.current]); }}><b>{direction.mark}</b><span>{direction.label}</span><kbd>{direction.key.toUpperCase()}</kbd></button>)}</div>
          <button className={`robot-grip ${robot?.gripper_open ? "" : "closed"}`} disabled={disabled} onClick={toggleGrip}>{robot?.gripper_open ? "⇥ ⇤  Close gripper" : "⇤ ⇥  Open gripper"}<kbd>SPACE</kbd></button>
          {robot?.controller !== "manual" && session && <button className="room-button full" disabled={busy} onClick={() => { clearKeys(); settling.current = 0; void send(robot?.done ? { type: "reset" } : { type: "take_control" }); }}>Take manual control</button>}
          <div className={`robot-outcome ${robot?.is_success ? "success" : ""}`} role="status" data-testid="episode-status"><i />{outcome}</div>
          <dl className="robot-telemetry"><div><dt>Goal distance</dt><dd data-testid="goal-distance">{robot ? `${(robot.distance * 100).toFixed(1)} cm` : "—"}</dd></div><div><dt>Episode return</dt><dd data-testid="episode-return">{robot?.return.toFixed(3) ?? "—"}</dd></div><div><dt>Steps</dt><dd data-testid="episode-steps">{robot?.steps ?? 0} <small>/ {robot?.max_steps ?? 200}</small></dd></div><div><dt>Two-finger contact</dt><dd>{robot?.grasped ? "Holding object" : "No grasp"}</dd></div></dl>
          <progress className="robot-episode-progress" max={robot?.max_steps ?? 200} value={robot?.steps ?? 0} aria-label="Episode steps used" />
          <p className="robot-help">Keyboard: <b>W A S D</b> on the floor plane, <b>Q / E</b> up and down, <b>Space</b> to grip. Click the scene first.</p>
          {robot?.done && <p className="robot-help">This episode has ended. Reset to try again with the same seed, or choose another task.</p>}
        </aside>
      </div>

      <div className="robot-evidence-grid">
        <section className="robot-results" id="training-results" aria-label="Actual training results">
          <div className="room-panel-heading"><span className="eyebrow">ACTUAL RESULTS / SAVED POLICY</span><span className="room-pill">{training?.algorithm ?? "No run"}</span></div><h2>Every run. Including the misses.</h2>
          {training ? <><p>The saved policy completed <b>{successCount} of {training.evaluation.length}</b> evaluation episodes. Select a run to replay that exact seed in the original training scene.</p><div className="robot-run-list">{training.evaluation.map((evaluation, index) => <button key={evaluation.seed} className={evaluation.success ? "successful" : ""} onClick={() => void replay(evaluation)} disabled={busy || !training.policy_available} aria-label={`Replay evaluation seed ${evaluation.seed}${evaluation.success ? ", successful" : ", unsuccessful"}`}><span className="robot-run-number">{String(index + 1).padStart(2, "0")}</span><span><strong>Seed {evaluation.seed}</strong><small>{evaluation.steps} steps · {(evaluation.distance * 100).toFixed(1)} cm from goal</small></span><span className="robot-run-status">{evaluation.success ? "Success" : evaluation.failure ? "Failed" : "Time limit"}</span><span aria-hidden="true">▷</span></button>)}</div><p className="robot-help">These results cover <b>{training.task}</b> after {training.actual_timesteps.toLocaleString()} training steps. Scripted demonstrations use programmed actions; they are separate from this learned policy.</p></> : <p>No policy has been trained for this room yet. You can still drive the gripper and run scripted reach or lift demonstrations.</p>}
        </section>
        <section className="robot-source"><div className="room-panel-heading"><span className="eyebrow">THE SCENE REFERENCE</span><span className="room-pill">{catalog?.scale_status ?? "Estimated"} scale</span></div><h2>The footage behind the room.</h2>{catalog?.video_url ? <video key={catalog.video_url} src={catalog.video_url} controls muted playsInline preload="metadata" aria-label="Room reference footage" /> : <div className="robot-no-video">This is an example room. Upload footage in the room editor to reconstruct your space.</div>}<p>The physical scene approximates the visible objects. Geometry and material properties are estimated; robot movement, contact, and rewards come from the simulator.</p><div className="robot-source-facts"><span>{catalog?.tasks.length ?? "—"}<small>robot tasks</small></span><span>20 Hz<small>control rate</small></span><span>{catalog?.source === "training" ? "Frozen" : "Current"}<small>room version</small></span></div><Link className="room-button full" href="/rooms/simulation">Edit the room or export a gym ↗</Link></section>
      </div>
    </main><footer className="robot-footer"><span>Actual physics. Visible results.</span><span>MuJoCo · Reactor · Gymnasium · PPO</span></footer>
  </div>;
}
