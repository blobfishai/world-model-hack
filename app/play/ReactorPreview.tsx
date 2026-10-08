"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SanaStreamingModel } from "@reactor-models/sana-streaming/core";
import styles from "./play.module.css";

export function ReactorPreview({ canvas, appearance, task, room, configured }: {
  canvas: HTMLCanvasElement | null; appearance: string; task: string; room: string; configured: boolean;
}) {
  const client = useRef<SanaStreamingModel | null>(null);
  const source = useRef<MediaStreamTrack | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState("disconnected");
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [frames, setFrames] = useState(0);
  const running = playing && frames > 0;
  const [phase, setPhase] = useState("Ready to connect");
  const prompt = `Photorealistic first-person view inside ${room}. ${appearance} The current activity is ${task}. Preserve the input camera movement, walls, open doorways, object positions, task tools and physical actions exactly. Render natural materials and soft daylight. Keep the scene coherent as the viewer walks. No text overlays or added people.`;
  const promptRef = useRef(prompt); promptRef.current = prompt;
  const disconnect = useCallback(async () => {
    const model = client.current; client.current = null;
    source.current?.stop(); source.current = null;
    if (video.current) video.current.srcObject = null;
    setPlaying(false); setPublished(false);
    if (!model) { setStatus("disconnected"); setPhase("Ready to connect"); return; }
    setStatus("disconnecting");
    try { await model.disconnect(); }
    finally { model[Symbol.dispose](); setStatus("disconnected"); setPhase("Ready to connect"); }
  }, []);

  // Own the core client for one user-initiated connection. React effect replay
  // and frequent player-state renders must not dispose or republish that client.
  useEffect(() => {
    const close = () => { void disconnect().catch(() => {}); };
    window.addEventListener("pagehide", close);
    return () => { window.removeEventListener("pagehide", close); close(); };
  }, [canvas, disconnect]);

  async function connect() {
    if (!canvas || client.current) return;
    const model = new SanaStreamingModel(); client.current = model;
    const current = () => client.current === model;
    setStatus("connecting"); setPhase("Connecting"); setError(null); setFrames(0); setPlaying(false);
    model.on("statusChanged", value => {
      if (!current()) return;
      setStatus(value);
      if (value === "disconnected") void disconnect().catch(() => {});
    });
    model.on("error", value => { if (current()) setError(value.message); });
    model.onCommandError(value => { if (current()) setError(value.reason); });
    model.onChunkComplete(value => { if (current()) setFrames(n => n + value.frames_emitted); });
    model.onMainVideo((_track, stream) => {
      if (!current() || !video.current) return;
      video.current.srcObject = stream;
      void video.current.play().catch(() => { if (current()) setError("Click the video to start playback."); });
    });
    try {
      const response = await fetch("/api/reactor/token?model=sana-streaming", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Reactor authentication failed");
      if (!current()) return;
      await model.connect(data.jwt);
      if (!current()) return;
      setPhase("Sending camera");
      const track = canvas.captureStream(24).getVideoTracks()[0];
      if (!track) throw new Error("Your browser could not capture the 3D camera.");
      source.current = track; track.contentHint = "detail";
      await model.publishCamera(track);
      if (!current()) return;
      setPhase("Preparing scene");
      await model.setSeed({ seed: 42 });
      await model.setAnchorInterval({ chunks: 5 });
      await model.setPrompt({ prompt: promptRef.current });
      if (current()) {
        await model.start();
        if (current()) { setPublished(true); setPhase("Rendering first frames"); }
      }
    } catch (e) {
      if (current()) { setError(e instanceof Error ? e.message : String(e)); await disconnect().catch(() => {}); }
    }
  }

  useEffect(() => {
    if (!published || status !== "ready") return;
    const model = client.current;
    const timer = setTimeout(() => { void model?.setPrompt({ prompt }).catch(e => { if (client.current === model) setError(String(e)); }); }, 300);
    return () => clearTimeout(timer);
  }, [prompt, published, status]);
  const active = status !== "disconnected";
  async function toggle() {
    setError(null);
    try { if (active) await disconnect(); else await connect(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <section className={styles.reactor} aria-label="Live Reactor preview" data-reactor-status={status} data-reactor-running={running} data-reactor-phase={phase} data-reactor-frames={frames}>
    <div className={styles.panelHeading}><span><i className={styles.orb} /> REACTOR / LIVE RENDER</span><span className={styles.pill}>{running ? `Streaming · ${frames} frames` : phase}</span></div>
    <div className={styles.reactorScreen}>
      <video ref={video} className={styles.reactorOutput} aria-label="Live Reactor output" autoPlay muted playsInline controls onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)} style={{ objectFit: "contain" }} />
      {!running && <div className={styles.reactorPlaceholder}><div className={styles.reactorHalo}>R<span>↗</span></div><h3>The same world.<br /><em>A new surface.</em></h3><p>Your moving camera becomes a live, generated video.</p></div>}
      {running && <div className={styles.liveLabel}><i /> REACTOR SANA-STREAMING</div>}
    </div>
    <div className={styles.reactorCopy}><div><span className={styles.eyebrow}>CAMERA INPUT</span><strong>{room} <span>→</span> Reactor</strong></div><p>The 3D view controls movement and tasks. This view follows your camera with generated lighting and materials.</p>
      <button className={styles.darkButton} disabled={!canvas || !configured} onClick={() => void toggle()}>{active ? "Disconnect Reactor" : "Start live Reactor view"}<span aria-hidden="true">{active ? "□" : "↗"}</span></button>
      <small>{configured ? "Uses a paid Reactor session. The generated view may lag behind your movement." : "Add REACTOR_API_KEY to .env and restart to enable the live view."}</small>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  </section>;
}
