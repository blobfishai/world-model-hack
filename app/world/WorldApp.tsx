"use client";

import "./world.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LingbotStage } from "./LingbotStage";
import { RobotStage } from "./RobotStage";
import { SourcePicker } from "./SourcePicker";
import { TaskPanel, type JobKind } from "./TaskPanel";
import { WorldPhysics } from "./WorldPhysics";
import { anyJobActive, roomApi, roomTrail, validRoomPath, validWorldId, worldUrl } from "./lib/rooms";
import { worldRequest, type RobotState, type SourcesResponse, type World, type WorldRoom } from "./lib/types";

const POLL_MS = 1500;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function WorldApp({ initialWorld, initialRoom, reactorConfigured }: {
  initialWorld: string | null; initialRoom: string; reactorConfigured: boolean;
}) {
  const [worldId, setWorldId] = useState<string | null>(initialWorld);
  const [world, setWorld] = useState<World | null>(null);
  const [roomPath, setRoomPath] = useState(initialRoom);
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [physicsOpen, setPhysicsOpen] = useState(false);
  const [view, setView] = useState<"world" | "robot">("world");
  const [robotStates, setRobotStates] = useState<Record<string, RobotState>>({});
  const worldIdRef = useRef(worldId);
  worldIdRef.current = worldId;

  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) setPanelOpen(false);
  }, []);

  useEffect(() => {
    let active = true;
    worldRequest<SourcesResponse>("/sources").then(value => { if (active) setSources(value); })
      .catch(cause => { if (active) setSourcesError(message(cause)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!worldId) { setWorld(null); return; }
    let active = true;
    setError(null);
    worldRequest<World>(`/${encodeURIComponent(worldId)}`).then(value => { if (active) setWorld(value); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [worldId]);

  const busy = Boolean(world && (world.status === "planning" || anyJobActive(world)));
  const pollId = world?.id;
  useEffect(() => {
    if (!pollId || !busy) return;
    const timer = window.setInterval(() => {
      worldRequest<World>(`/${encodeURIComponent(pollId)}`)
        .then(value => { if (worldIdRef.current === value.id) setWorld(value); })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pollId, busy]);

  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const nextWorld = params.get("w"), nextRoom = params.get("room");
      setWorldId(validWorldId(nextWorld) ? nextWorld : null);
      setRoomPath(validRoomPath(nextRoom) ? nextRoom : "root");
      setPhysicsOpen(false);
      setView("world");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    setRoomPath(path);
    setPhysicsOpen(false);
    setView("world");
    window.history.pushState(null, "", worldUrl(worldIdRef.current, path));
  }, []);

  const startOver = useCallback(() => {
    setWorldId(null);
    setWorld(null);
    setRoomPath("root");
    setPhysicsOpen(false);
    setView("world");
    setRobotStates({});
    window.history.pushState(null, "", "/world");
  }, []);

  const create = useCallback(async (source: string, t: number) => {
    setCreating(true);
    setError(null);
    try {
      const value = await worldRequest<World>("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, t }) });
      setWorld(value);
      setWorldId(value.id);
      setRoomPath("root");
      window.history.pushState(null, "", worldUrl(value.id, "root"));
    } finally {
      setCreating(false);
    }
  }, []);

  const mergeRoom = useCallback((updated: WorldRoom) => {
    setWorld(current => current ? { ...current, rooms: { ...current.rooms, [updated.path]: updated } } : current);
  }, []);

  const runJob = useCallback(async (path: string, kind: JobKind) => {
    const id = worldIdRef.current;
    if (!id) return;
    mergeRoom(await worldRequest<WorldRoom>(roomApi(id, path, kind), { method: "POST" }));
  }, [mergeRoom]);

  const requestScan = useCallback((path: string) => {
    const id = worldIdRef.current;
    if (!id) return;
    void worldRequest<WorldRoom>(`${roomApi(id, path, "scan")}?priority=1`, { method: "POST" })
      .then(mergeRoom).catch(cause => setError(message(cause)));
  }, [mergeRoom]);

  const showWorld = useCallback(() => setView("world"), []);
  const showRobot = useCallback(() => { setPhysicsOpen(false); setView("robot"); }, []);
  const recordRobotState = useCallback((path: string, state: RobotState) => {
    setRobotStates(current => ({ ...current, [path]: state }));
  }, []);

  const room = world ? (world.rooms[roomPath] ?? world.rooms.root ?? null) : null;
  const trail = world && room ? roomTrail(world, room.path) : [];

  let body: React.ReactNode;
  if (!worldId) {
    body = <SourcePicker data={sources} loadError={sourcesError} creating={creating} onCreate={create} />;
  } else if (!world) {
    body = <main className="rw-planning"><div>
      {error ? <><span className="rw-eyebrow">WORLD UNAVAILABLE</span><h1>That world could not be opened.</h1>
        <p className="rw-error-inline" role="alert">{error}</p><button className="rw-button rw-primary" onClick={startOver}>Choose a recording</button></>
        : <><i className="rw-spinner" /><p>Opening world…</p></>}
    </div></main>;
  } else if (world.status !== "ready" || !room) {
    const failed = world.status === "failed";
    body = <main className="rw-planning">
      <img src={world.start_url} alt="Beginning image" />
      <div>
        <span className="rw-eyebrow">{failed ? "PLANNING FAILED" : "PLANNING"}</span>
        <h1>{failed ? "The rooms could not be planned." : "Reading the beginning image…"}</h1>
        {failed
          ? <><p className="rw-error-inline" role="alert">{world.error ?? "Planning failed"}</p><button className="rw-button rw-primary" onClick={startOver}>Choose another frame</button></>
          : <><p>Gemini is naming what it sees and planning task rooms. Reactor starts generating each room as soon as the plan is ready.</p><i className="rw-spinner" /></>}
      </div>
    </main>;
  } else {
    const robotView = view === "robot";
    body = <div className="rw-workspace">
      <div className={`rw-stage-area${robotView ? " rw-robot-mode" : ""}`}>
        <LingbotStage world={world} room={room} reactorConfigured={reactorConfigured} onNavigate={navigate} onRequestScan={requestScan}
          pip={robotView} inputEnabled={!robotView} onShowWorld={showWorld} />
        {robotView && <RobotStage world={world} room={room} reactorConfigured={reactorConfigured}
          playgroundAvailable={sources?.playground_available ?? true} onJob={runJob} onState={recordRobotState} onExit={showWorld} />}
      </div>
      {panelOpen && <TaskPanel world={world} room={room} playgroundAvailable={sources?.playground_available ?? true}
        robotState={robotStates[room.path] ?? null} onJob={runJob} onInteract={() => setPhysicsOpen(true)} onOpenRobot={showRobot}
        onNavigate={navigate} onClose={() => setPanelOpen(false)} />}
      {physicsOpen && room.physics && <WorldPhysics world={world} room={room} onClose={() => setPhysicsOpen(false)} />}
    </div>;
  }

  return <div className="rw-app">
    <header className="rw-header">
      <a className="rw-brand" href="/world" onClick={event => { event.preventDefault(); startOver(); }}>
        <span className="rw-brand-mark">◇</span><strong>rooms<span>REACTOR WORLD</span></strong>
      </a>
      <span className="rw-tagline">Training gym · realistic worlds, real tasks, rewards checked by code</span>
      {world && room && world.status === "ready" && <nav className="rw-trail" aria-label="Room trail">
        {trail.map((item, index) => <span key={item.path}>
          {index > 0 && <i aria-hidden="true">›</i>}
          {index === trail.length - 1
            ? <b aria-current="page">{item.path === "root" ? world.hub_title || "Beginning" : item.title}</b>
            : <button onClick={() => navigate(item.path)}>{item.path === "root" ? world.hub_title || "Beginning" : item.title}</button>}
        </span>)}
      </nav>}
      {world && room && world.status === "ready" && <div className="rw-viewswitch" role="group" aria-label="Stage view">
        <button aria-pressed={view === "world"} onClick={showWorld}><span className="rw-long">Reactor world</span><span className="rw-short">World</span></button>
        <button aria-pressed={view === "robot"} onClick={showRobot}><span className="rw-long">Robot simulation</span><span className="rw-short">Robot</span></button>
      </div>}
      <div className="rw-header-right">
        {room?.parent && world?.status === "ready" && <button className="rw-button" onClick={() => navigate(room.parent!)} aria-label="Return to parent room">← Back</button>}
        {world?.status === "ready" && <button className="rw-button" aria-pressed={panelOpen} onClick={() => setPanelOpen(value => !value)}>Task details</button>}
        {worldId && <button className="rw-button" onClick={startOver}>New world</button>}
        <Link className="rw-link" href="/explore">Task explorer ↗</Link>
      </div>
    </header>
    {body}
    {error && world && <p className="rw-toast" role="alert">{error}<button aria-label="Dismiss" onClick={() => setError(null)}>×</button></p>}
    <footer className="rw-footer">
      <span>Reactor LingBot World 2 · doors are waypoints over generated video</span>
      <span>{world?.attribution ?? sources?.attribution ?? "Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0"}</span>
    </footer>
  </div>;
}
