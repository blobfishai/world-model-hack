"use client";

import { useEffect, useRef, useState } from "react";
import { roomRequest, type RoomDetail, type RoomId } from "./types";

type GymTask = { id: string; kind: "reach" | "push" | "lift"; label: string };
type GymDetail = { revision: string; tasks: GymTask[]; robot: string; control_hz: number; source: string };

export function RobotGymPanel({ room, detail }: { room: RoomId; detail: RoomDetail }) {
  const [gym, setGym] = useState<GymDetail | null>(null);
  const [task, setTask] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void roomRequest<GymDetail>(`/rooms/${room}/gym`, { signal: controller.signal }).then(value => {
      if (value.revision !== detail.revision) throw new Error("The room changed. Reopen it to prepare its robot gym.");
      setGym(value); setTask(value.tasks[0]?.id ?? "");
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [room, detail.revision]);

  async function download() {
    const controller = new AbortController();
    request.current = controller;
    setExporting(true); setError(null); setDownloaded(false);
    try {
      const query = new URLSearchParams({ revision: detail.revision, task });
      const response = await fetch(`/api/rooms/${room}/gym?${query}`, { method: "POST", signal: controller.signal });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? body.detail ?? "Gym export failed");
      }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${room}-robot-gym.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloaded(true);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setExporting(false);
    }
  }

  return <section className="room-gym-panel" aria-label="Robot training gym">
    <div className="room-panel-heading"><span className="eyebrow">ROBOT / REINFORCEMENT LEARNING</span><span className="room-pill">{gym ? `${gym.tasks.length} tasks · ${gym.control_hz} Hz` : "Preparing tasks"}</span></div>
    <div className="room-gym-content">
      <div><h3>Train in this room.</h3><p className="room-subtitle">A robot gripper, physical contacts, and measurable goals. Export this room with its footage and a ready-to-run training script.</p></div>
      <div className="room-gym-controls">
        <label className="room-field-label" htmlFor="robot-task">Starting task</label>
        <select id="robot-task" className="room-text-input" value={task} disabled={!gym || exporting} onChange={event => setTask(event.target.value)}>
          {!gym && <option>Loading tasks…</option>}
          {gym?.tasks.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <button className="room-button primary full" disabled={!gym || !task || exporting} onClick={() => void download()}>{exporting ? "Packaging gym…" : "Download robot gym ↓"}</button>
        <a className="room-button full" style={{ display: "block", textAlign: "center" }} href="/rooms/playground">Play with the robot + Reactor ↗</a>
      </div>
    </div>
    <p className="room-caption">{detail.source_job ? "Uses this reconstructed room and its source footage." : "Uses the current example layout. Upload footage to train in your own room."} Video is a scene reference; rewards come from the physics simulation. Scale: {detail.spec.scale_status}.</p>
    {downloaded && <p className="room-caption" role="status">Gym downloaded. Unzip it and follow README.md to install dependencies and train.</p>}
    {error && <p className="room-error" role="alert">{error}</p>}
  </section>;
}
