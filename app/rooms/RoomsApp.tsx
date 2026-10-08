"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReactorRoomView } from "./ReactorRoomView";
import { RobotGymPanel } from "./RobotGymPanel";
import { roomRequest, type Command, type PhysicsState, type RoomBuildJob, type RoomDetail, type RoomId, type SimulationSession } from "./types";

const RoomViewer = dynamic(() => import("./RoomViewer").then(m => m.RoomViewer), { ssr: false });
const catalog: { id: RoomId; name: string; description: string; color: string; icon: string }[] = [
  { id: "kitchen", name: "Kitchen", description: "Make room for everyday experiments.", color: "#be8d58", icon: "M5 8h14v12H5z M8 8V4h8v4 M5 13h14 M12 13v7 M8 10h1 M15 10h1" },
  { id: "living-room", name: "Living room", description: "A familiar space. New possibilities.", color: "#819a83", icon: "M5 12V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5 M3 10h3v7h12v-7h3v9H3z M6 19v2 M18 19v2" },
  { id: "bedroom", name: "Bedroom", description: "Pull open the details of your room.", color: "#9393ae", icon: "M3 19V5 M3 10h18v9 M3 15h18 M7 10V7h5v3 M3 19v2 M21 19v2" },
  { id: "bathroom", name: "Bathroom", description: "Small objects, real interactions.", color: "#79a3ac", icon: "M3 12h18v2a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z M6 12V5a2 2 0 0 1 4 0 M6 19v2 M18 19v2" },
];

export function RoomsApp() {
  const [room, setRoom] = useState<RoomId>("kitchen");
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [session, setSession] = useState<SimulationSession | null>(null);
  const [snapshot, setSnapshot] = useState<PhysicsState | null>(null);
  const [connected, setConnected] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState("");
  const [job, setJob] = useState<RoomBuildJob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editor, setEditor] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const stateRef = useRef<PhysicsState | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const currentRoom = useRef(room);
  currentRoom.current = room;
  const card = catalog.find(c => c.id === room)!;

  useEffect(() => {
    let active = true;
    setDetail(null); setSession(null); setSnapshot(null); setError(null); setJob(null); setFile(null); setSelected(""); setReference("");
    void roomRequest<RoomDetail>(`/rooms/${room}`).then(value => {
      if (active) {
        setDetail(value); setJob(value.latest_build ?? null);
        setEditor(JSON.stringify(value.latest_build?.status === "needs_review" && value.latest_build.candidate ? value.latest_build.candidate : value.spec, null, 2));
      }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [room, reload]);

  useEffect(() => {
    if (!file) { setSourceUrl(detail?.source_job ? `/api/room-builds/${detail.source_job}/source` : null); return; }
    const url = URL.createObjectURL(file); setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, detail?.source_job]);

  useEffect(() => {
    if (!detail || detail.spec.room_id !== room) return;
    let active = true;
    let ws: WebSocket | null = null;
    let id: string | null = null;
    let lastUi = 0;
    setConnected(false);
    void roomRequest<SimulationSession>(`/rooms/${room}/sessions`, { method: "POST" }).then(value => {
      id = value.id;
      if (!active) { void roomRequest(`/room-sessions/${id}`, { method: "DELETE" }).catch(() => {}); return; }
      stateRef.current = value.state; setSnapshot(value.state); setSession(value);
      const base = process.env.NEXT_PUBLIC_ROOM_SIM_WS_URL ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8000`;
      ws = new WebSocket(`${base}/sessions/${id}`); socketRef.current = ws;
      ws.onopen = () => { if (active) setConnected(true); };
      ws.onmessage = event => {
        if (!active) return;
        const message = JSON.parse(event.data);
        if (message.type === "state") {
          stateRef.current = message;
          if (performance.now() - lastUi > 90) { setSnapshot(message); lastUi = performance.now(); }
        } else if (message.error) setError(message.error);
      };
      ws.onerror = () => { if (active) setError("Could not connect to the physics service. Check that pnpm rooms:server is running."); };
      ws.onclose = () => { if (active) setConnected(false); };
    }).catch(e => { if (active) setError(e.message); });
    return () => {
      active = false; setConnected(false); socketRef.current = null;
      ws?.close();
      if (id) void roomRequest(`/room-sessions/${id}`, { method: "DELETE" }).catch(() => {});
    };
  }, [detail, room]);

  useEffect(() => {
    if (!job) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await roomRequest<RoomBuildJob>(`/room-builds/${job!.id}`);
        if (!active) return;
        setJob(next);
        if (next.status === "ready") {
          const value = await roomRequest<RoomDetail>(`/rooms/${next.room_id}`);
          if (active && currentRoom.current === next.room_id) { setDetail(value); setEditor(JSON.stringify(value.spec, null, 2)); setError(null); }
        } else if (["failed", "needs_review"].includes(next.status)) {
          if (next.candidate) setEditor(JSON.stringify(next.candidate, null, 2));
        } else timer = setTimeout(refresh, 1500);
      } catch (e) { if (active) { setError(e instanceof Error ? e.message : String(e)); timer = setTimeout(refresh, 3000); } }
    }
    timer = setTimeout(refresh, 1000);
    return () => { active = false; clearTimeout(timer); };
    // A single status subscription lives for the job, without resetting on every progress update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  const command = useCallback((c: Command) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(c));
  }, []);

  async function reconstruct() {
    if (!file) return;
    const selectedRoom = room;
    setUploading(true); setError(null);
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error("Choose a video smaller than 100 MB.");
      const data = new FormData(); data.set("video", file); data.set("reference", reference);
      const value = await roomRequest<RoomBuildJob>(`/rooms/${room}/build`, { method: "POST", body: data });
      if (currentRoom.current === selectedRoom) setJob(value);
    } catch (e) { if (currentRoom.current === selectedRoom) setError(e instanceof Error ? e.message : String(e)); }
    finally { setUploading(false); }
  }

  async function saveScene() {
    setSaving(true); setError(null);
    const selectedRoom = room;
    try {
      const spec = JSON.parse(editor);
      const source = job?.status === "needs_review" ? `?source_job=${job.id}` : "";
      const value = await roomRequest<RoomDetail>(`/rooms/${room}/scene${source}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec) });
      if (currentRoom.current === selectedRoom) { setDetail(value); setEditor(JSON.stringify(value.spec, null, 2)); setJob(null); }
    } catch (e) { if (currentRoom.current === selectedRoom) setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  const busy = uploading || !!(job && !["ready", "needs_review", "failed"].includes(job.status));
  return <div className="rooms-app">
    <header className="rooms-header"><Link href="/rooms" className="rooms-wordmark">room<span>/</span>world<span className="rooms-wordmark-dot">●</span></Link><span className="rooms-header-note">FROM VIDEO TO SOMETHING YOU CAN TOUCH</span><Link href="/helios" className="rooms-demo-link">Helios demo ↗</Link></header>
    <main className="rooms-main">
      <div className="rooms-intro"><div><p className="eyebrow">YOUR WORLD, RECONSTRUCTED</p><h1>Make a room <em>respond.</em></h1><p>Bring a video. Build a physical space. See what happens next.</p></div><div className="rooms-pipeline"><span>01&nbsp; Observe</span><i>→</i><span>02&nbsp; Simulate</span><i>→</i><span>03&nbsp; Reimagine</span></div></div>
      <nav className="rooms-catalog" aria-label="Choose a room">{catalog.map((c, i) => <button key={c.id} className={`room-card ${room === c.id ? "selected" : ""}`} aria-pressed={room === c.id} onClick={() => setRoom(c.id)} style={{ "--room-accent": c.color } as React.CSSProperties}><span className="room-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d={c.icon} /></svg></span><span className="room-card-copy"><span className="room-card-title">{c.name}</span><span className="room-card-description">{c.description}</span></span><span className="room-card-number">0{i + 1}</span></button>)}</nav>
      {error && <div className="room-error room-global-error" role="alert"><span>{error}</span><button onClick={() => { setError(null); setReload(v => v + 1); }}>Reconnect</button></div>}
      <div className="rooms-workspace">
        <aside className="room-source-panel">
          <div className="room-panel-heading"><span className="eyebrow">01 / SOURCE & STRUCTURE</span><span className="room-pill">{detail?.source_job ? "Your footage" : "Example"}</span></div>
          <h2>Your {card.name.toLowerCase()}.</h2><p className="room-subtitle">A little footage. A new way to explore.</p>
          <label className="room-upload" htmlFor="room-video"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4" /></svg><strong>{file ? file.name : "Choose a room video"}</strong><span>MP4, MOV, or WebM · up to 100 MB</span><input id="room-video" type="file" accept="video/mp4,video/quicktime,video/webm" disabled={busy} onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
          {sourceUrl && <video className="room-source-video" src={sourceUrl} controls preload="metadata" aria-label="Original room footage" />}
          <label htmlFor="scale-reference" className="room-field-label">A known dimension <span>optional</span></label><input id="scale-reference" className="room-text-input" placeholder="e.g. The counter is 95 cm high" value={reference} onChange={e => setReference(e.target.value)} disabled={busy} />
          <button className="room-button primary full" disabled={!file || busy} onClick={() => void reconstruct()}>{busy ? "Reconstructing…" : "Build from this video →"}</button>
          <p className="room-caption">Show the room from several angles and open any storage you want to interact with. Reconstruction uses Gemini; its layout remains editable.</p>
          {job && <div className={`room-build-status ${job.error ? "has-error" : ""}`} role="status"><div><strong>{job.status.replaceAll("_", " ")}</strong><span>{job.progress}%</span></div><progress value={job.progress} max={100} />{job.error && <p>{job.error}</p>}{job.frames.length > 0 && <div className="room-evidence">{job.frames.slice(0, 6).map(f => <a key={f.index} href={`/api/room-builds/${job.id}/frames/${f.file}`} target="_blank" rel="noreferrer" title={`Evidence frame ${f.index}, ${f.timestamp}s`}><img src={`/api/room-builds/${job.id}/frames/${f.file}`} alt={`Room at ${f.timestamp}s`} /></a>)}</div>}</div>}
          <div className="room-structure"><div className="room-panel-heading"><span className="eyebrow">PHYSICAL STRUCTURE</span><span className="room-pill">{detail?.spec.scale_status ?? "Estimated"} scale</span></div>{detail ? <><div className="room-stats"><div><strong>{detail.spec.objects.length}</strong><span>objects</span></div><div><strong>{detail.validation.joints}</strong><span>joints</span></div><div><strong>{detail.spec.dimensions.slice(0, 2).join(" × ")}</strong><span>meters</span></div></div><div className="room-object-list">{detail.spec.objects.map(o => <div key={o.id} className={selected.startsWith(o.id) ? "active" : ""}><span style={{ background: o.color }} /><span>{o.label}</span><small>{["cabinet", "drawer"].includes(o.kind) ? "Articulated" : o.movable ? "Movable" : "Fixed"}</small></div>)}</div></> : <p className="room-caption">Start the room service to explore the example scenes.</p>}</div>
          <details className="room-editor" open={job?.status === "needs_review" ? true : undefined}><summary>Edit scene layout <span>↗</span></summary><p className="room-caption">Positions use meters, Z up, and the center of each object’s base. Saving validates physics and restarts this room.</p><textarea aria-label="Room scene JSON" value={editor} onChange={e => setEditor(e.target.value)} spellCheck={false} rows={14} /><button className="room-button full" disabled={saving || busy || !editor} onClick={() => void saveScene()}>{saving ? "Validating…" : "Validate & save scene"}</button></details>
        </aside>
        <div className="room-experience">
          {detail && <RobotGymPanel key={`${room}-${detail.revision}`} room={room} detail={detail} />}
          <section className="room-physics-panel"><div className="room-panel-heading"><span className="eyebrow">LIVE / PHYSICAL WORLD</span><div className="room-button-row"><span className={`room-pill ${connected ? "live" : ""}`}><i />{connected ? "Physics connected" : "Connecting"}</span><span className="room-pill">{detail?.source_job ? "Video reconstruction" : "Example scene"}</span></div></div>
            {session ? <RoomViewer session={session} stateRef={stateRef} onCommand={command} onCanvas={setCanvas} onSelect={setSelected} /> : <div className="room-empty"><div className="room-empty-grid" /><strong>{error ? "Your room is waiting." : "Opening your room…"}</strong><span>{error ? "Start pnpm rooms:server and reconnect." : "Preparing geometry and physical interactions."}</span></div>}
            <div className="room-viewer-toolbar"><span><b>Drag</b> to move an object · <b>Drag empty space</b> to orbit · <b>Scroll</b> to zoom</span><div className="room-button-row"><button className="room-button compact" disabled={!connected} onClick={() => command({ type: "pause", paused: !snapshot?.paused })}>{snapshot?.paused ? "▶ Resume" : "Ⅱ Pause"}</button><button className="room-button compact" disabled={!connected} onClick={() => { setError(null); command({ type: "reset" }); }}>↺ Reset</button><button className="room-button compact" disabled={!connected || !snapshot?.recorded_commands} onClick={() => command({ type: "replay" })}>▷ Replay</button></div></div>
          </section>
          <div className="room-lower-grid">{session && <ReactorRoomView key={session.id} canvas={canvas} appearance={session.spec.appearance} roomName={card.name} />}<section className="room-interactions"><div className="room-panel-heading"><span className="eyebrow">TRY AN INTERACTION</span><span className="room-pill">{snapshot?.replaying ? "Replaying" : "Explore freely"}</span></div><h3>Small actions.<br /><em>Real consequences.</em></h3><p className="room-subtitle">Grab a handle or an object in the physical view. These checks follow its actual state.</p><div className="room-task-list">{snapshot?.tasks.length ? snapshot.tasks.map(task => <div key={task.id}><div><span className={`room-task-check ${task.progress >= .99 ? "done" : ""}`}>{task.progress >= .99 ? "✓" : "○"}</span><span>{task.label}</span><small>{Math.round(task.progress * 100)}%</small></div><progress value={task.progress} max={1} /></div>) : <p className="room-caption">Tasks appear for movable objects and working joints in your room.</p>}</div><p className="room-caption room-notes">{detail?.spec.notes.join(" ")}</p><div className="room-session-clock"><span>SIMULATION TIME</span><strong>{snapshot?.time.toFixed(1) ?? "0.0"}<small>s</small></strong></div></section></div>
        </div>
      </div>
      <footer className="rooms-footer"><span>Built from observation. Driven by physics.</span><Link href="/rooms">Back to the task explorer ↗</Link><span>MuJoCo × Reactor</span></footer>
    </main>
  </div>;
}
