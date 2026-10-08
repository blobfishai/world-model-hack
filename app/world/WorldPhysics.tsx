"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, PhysicsState, SimulationSession } from "../rooms/types";
import { roomApi } from "./lib/rooms";
import { worldRequest, type World, type WorldPhysicsSession, type WorldRoom } from "./lib/types";

const RoomViewer = dynamic(() => import("../rooms/RoomViewer").then(module => module.RoomViewer), { ssr: false });

export function WorldPhysics({ world, room, socketBase, onClose }: { world: World; room: WorldRoom; socketBase: string; onClose: () => void }) {
  const [session, setSession] = useState<WorldPhysicsSession | null>(null);
  const [snapshot, setSnapshot] = useState<PhysicsState | null>(null);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<PhysicsState | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const revision = room.physics?.revision;
  const worldId = world.id;

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let id: string | null = null;
    let lastUi = 0;
    setSession(null); setConnected(false); setError(null);
    worldRequest<WorldPhysicsSession>(roomApi(worldId, room.path, "sessions"), { method: "POST" }).then(value => {
      id = value.id;
      if (!active) { void fetch(`/api/room-sessions/${id}`, { method: "DELETE" }).catch(() => {}); return; }
      stateRef.current = value.state; setSnapshot(value.state); setSession(value);
      ws = new WebSocket(`${socketBase}/sessions/${id}`);
      socketRef.current = ws;
      ws.onopen = () => { if (active) setConnected(true); };
      ws.onmessage = event => {
        if (!active) return;
        const payload = JSON.parse(event.data);
        if (payload.type === "state") {
          stateRef.current = payload;
          if (performance.now() - lastUi > 90) { setSnapshot(payload); lastUi = performance.now(); }
        } else if (payload.error) setError(payload.error);
      };
      ws.onclose = () => { if (active) setConnected(false); };
      ws.onerror = () => { if (active) setError("The physics connection failed. Close and reopen this simulation."); };
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      active = false;
      ws?.close();
      socketRef.current = null;
      if (id) void fetch(`/api/room-sessions/${id}`, { method: "DELETE" }).catch(() => {});
    };
  }, [worldId, room.path, revision, socketBase]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const send = useCallback((command: Command) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command));
  }, []);
  const onCanvas = useCallback(() => {}, []);
  const goal = session?.goal ?? undefined;

  return <div className="rw-modal" role="dialog" aria-modal="true" aria-label={`Physics for ${room.title}`}>
    <div className="rw-physics">
      <header>
        <div><span className="rw-eyebrow">MUJOCO PHYSICS · RECONSTRUCTED FROM THE REACTOR SCAN</span><h2>{room.title}</h2></div>
        <span className={`rw-status${connected ? " rw-live" : ""}`}><i />{connected ? "Simulating" : session ? "Connecting…" : "Opening session…"}</span>
        <button className="rw-button" onClick={onClose}>Close</button>
      </header>
      <div className="rw-physics-view">
        {session && <RoomViewer session={session as unknown as SimulationSession} stateRef={stateRef} onCommand={send} onCanvas={onCanvas}
          onSelect={setSelected} goal={goal} />}
      </div>
      <footer>
        <p>Drag objects to apply forces · drag empty space to orbit · scroll to zoom{selected && <> · selected <b>{selected}</b></>}{goal && <> · the marker is the robot goal</>}.</p>
        <div className="rw-button-row">
          <button className="rw-button" disabled={!connected} onClick={() => send({ type: "pause", paused: !snapshot?.paused })}>{snapshot?.paused ? "Resume" : "Pause"}</button>
          <button className="rw-button" disabled={!connected} onClick={() => send({ type: "reset" })}>Reset</button>
        </div>
        {snapshot?.tasks.length ? <ul className="rw-checks">
          {snapshot.tasks.map(task => <li key={task.id}><span>{task.label}</span><b>{Math.round(task.progress * 100)}%</b></li>)}
        </ul> : null}
        {error && <p className="rw-error-inline" role="alert">{error}</p>}
      </footer>
    </div>
  </div>;
}
