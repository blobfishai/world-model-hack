"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SanaStreamingModel } from "@reactor-models/sana-streaming/core";

export function ReactorRoomView({ canvas, appearance, roomName, recording }: { canvas: HTMLCanvasElement | null; appearance: string; roomName: string; recording?: { src: string; poster: string } }) {
  const client = useRef<SanaStreamingModel | null>(null);
  const sourceTrack = useRef<MediaStreamTrack | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [hasFrames, setHasFrames] = useState(false);
  const [frames, setFrames] = useState(0);
  const [prompt, updatePrompt] = useState(`Render this ${roomName.toLowerCase()} with natural photographic lighting. ${appearance}. Preserve the source camera, geometry, object identities, positions, and physical movement. Do not introduce new objects.`);

  const disconnect = useCallback(async () => {
    const previous = client.current;
    client.current = null;
    sourceTrack.current?.stop(); sourceTrack.current = null;
    if (video.current) video.current.srcObject = null;
    setStatus("disconnected"); setHasFrames(false);
    if (previous) {
      try { await previous.disconnect(); } finally { previous[Symbol.dispose](); }
    }
  }, []);

  // A client is owned by a user-initiated connection, so React's development
  // effect replay cannot accidentally reuse a permanently disposed client.
  useEffect(() => {
    const leave = () => { void disconnect().catch(() => {}); };
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); leave(); };
  }, [canvas, disconnect]);

  async function connect() {
    if (!canvas || client.current) return;
    const model = new SanaStreamingModel();
    client.current = model;
    const current = () => client.current === model;
    setError(null); setFrames(0); setHasFrames(false); setStatus("connecting");
    model.on("statusChanged", value => {
      if (!current()) return;
      setStatus(value);
      if (value === "disconnected") void disconnect().catch(() => {});
    });
    model.on("error", value => { if (current()) setError(value.message); });
    model.onCommandError(message => { if (current()) setError(message.reason); });
    model.onChunkComplete(message => { if (current()) setFrames(value => value + message.frames_emitted); });
    model.onMainVideo((_track, stream) => {
      if (!current() || !video.current) return;
      video.current.srcObject = stream;
      void video.current.play().catch(() => { if (current()) setError("Click the video to start playback."); });
    });
    try {
      const response = await fetch("/api/reactor/token?model=sana-streaming", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Reactor authentication failed");
      if (!current()) return;
      await model.connect(body.jwt);
      if (!current()) return;
      const track = canvas.captureStream(24).getVideoTracks()[0];
      sourceTrack.current = track;
      track.contentHint = "detail";
      await model.publishCamera(track);
      if (!current()) return;
      await model.setSeed({ seed: 42 });
      await model.setAnchorInterval({ chunks: 5 });
      await model.setPrompt({ prompt });
      if (current()) await model.start();
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : String(cause));
        await disconnect().catch(() => {});
      }
    }
  }

  const active = status !== "disconnected";
  return <section className="reactor-room-panel">
    <div className="room-panel-heading"><span className="eyebrow">02 / REACTOR VIEW</span><span data-testid="reactor-status" data-connection-status={status} className={`room-pill ${hasFrames ? "live" : ""}`}>{hasFrames ? `Streaming · ${frames} frames` : !active && recording ? "Recorded preview" : status}</span></div>
    <div className="room-reactor-video">
      <video ref={video} className="reactor-output" aria-label="Live Reactor output" autoPlay muted playsInline controls onPlaying={() => setHasFrames(true)} style={{ objectFit: "contain", visibility: active ? "visible" : "hidden" }} />
      {!active && recording && <video className="reactor-output" src={recording.src} poster={recording.poster} aria-label="Recorded Reactor mug-lift result" controls muted playsInline preload="metadata" style={{ objectFit: "contain" }} />}
      {!hasFrames && (active || !recording) && <div className="reactor-placeholder"><div className="reactor-orb" /><strong>{active ? "Preparing your live view…" : "See your moves through Reactor."}</strong><p>{active ? "Waiting for the first generated frames. You can keep moving the robot." : "Stream the robot scene, then change its lighting and appearance as you play."}</p></div>}
    </div>
    <div className="reactor-room-settings">
      <label htmlFor="appearance-prompt" className="eyebrow">APPEARANCE DIRECTION</label>
      <textarea id="appearance-prompt" value={prompt} onChange={event => updatePrompt(event.target.value)} rows={3} />
      <div className="room-button-row">
        <button className="room-button primary" disabled={!canvas} onClick={() => { setError(null); void (active ? disconnect() : connect()).catch(cause => setError(String(cause))); }}>{active ? "Disconnect Reactor" : "Start Reactor view ↗"}</button>
        {status === "ready" && <button className="room-button" onClick={() => { setError(null); void client.current?.setPrompt({ prompt }); }}>Apply edit</button>}
      </div>
      {error && <p className="room-error" role="alert">{error}</p>}
      {!active && recording && <p className="room-caption">Recorded result: a scripted mug lift, rendered by Reactor. Press play above to watch, or start a live session to render your own movements.</p>}
      <p className="room-caption">Generated appearance · may lag or drift from the physical scene. Starting this view uses a paid Reactor session.</p>
    </div>
  </section>;
}
