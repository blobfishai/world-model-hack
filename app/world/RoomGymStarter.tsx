"use client";

import { useState } from "react";
import { worldRoom } from "../lib/robot-worlds";

export function RoomGymStarter({ path, creating, onCreate }: {
  path: string; creating: boolean; onCreate: (path: string) => Promise<void>;
}) {
  const room = worldRoom(path);
  const [error, setError] = useState<string | null>(null);
  return <main className="rw-picker">
    <div className="rw-picker-intro">
      <span className="rw-eyebrow">REACTOR FOOTAGE → MUJOCO PLAYGROUND</span>
      <h1>Turn {room.theme.name} into a training gym.</h1>
      <p>{room.goal}. Use this room’s Reactor recording to build a physical workcell, control its Panda arm, and export the task for training.</p>
    </div>
    <section className="rw-preview" aria-label={`${room.theme.name} training gym`}>
      <video src={`/reactor-gyms/${room.theme.id}.mp4`} poster={`/reactor-gyms/${room.theme.id}.jpg`} controls muted loop autoPlay playsInline style={{ width: "100%", borderRadius: 12 }} aria-label={`Reactor footage of ${room.theme.name}`} />
      <h2>{room.goal}</h2>
      <p className="rw-caption">The existing Reactor footage is reused. Building physics estimates the room’s geometry and scale from that footage; the simulator checks task success.</p>
      <button className="rw-button rw-primary rw-full" disabled={creating} onClick={() => {
        setError(null); void onCreate(path).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
      }}>{creating ? "Preparing the room…" : "Build this training gym"}</button>
      <a className="rw-button rw-full" href={`/worlds?${new URLSearchParams({ room: path, mode: "physics" })}`}>Play this robot task now ↗</a>
      <a className="rw-link" href={`/worlds?room=${encodeURIComponent(path)}`}>← Return to {room.theme.name}</a>
      {error && <p className="rw-error-inline" role="alert">{error}</p>}
    </section>
  </main>;
}
