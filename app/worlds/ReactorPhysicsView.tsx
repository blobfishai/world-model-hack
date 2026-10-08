"use client";

import { useEffect, useRef, useState } from "react";
import { SanaStreamingModel } from "@reactor-models/sana-streaming/core";
import type { WorldRoom } from "../lib/robot-worlds";
import { reactorToken } from "../world/lib/tokens";
import { connectionFailure } from "./reactor-connection";
import { physicsRenderPrompt, physicsRenderSeed, RENDER_LOOKS, type RenderLook } from "./physics-render";
import styles from "./physics-render.module.css";

type Phase = "idle" | "connecting" | "rendering" | "live" | "stalled" | "error";
const IDLE_MS = 120_000;

/** Reactor edits the live simulator camera; generated pixels never change physics state. */
export function ReactorPhysicsView({ canvas, room, enabled, configured, onEnabledChange }: {
  canvas: HTMLCanvasElement | null; room: WorldRoom; enabled: boolean; configured: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const client = useRef<SanaStreamingModel | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [frames, setFrames] = useState(0);
  const [anchors, setAnchors] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [look, setLook] = useState<RenderLook>("natural");
  const lookRef = useRef(look); lookRef.current = look;
  const [draft, setDraft] = useState("");
  const [direction, setDirection] = useState("");
  const [editing, setEditing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [retry, setRetry] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [relay, setRelay] = useState<HTMLCanvasElement | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [renderedRoom, setRenderedRoom] = useState<string | null>(null);
  const [renderedLook, setRenderedLook] = useState<string | null>(null);
  const confirmed = useRef(false);
  const sourceRef = useRef(canvas); sourceRef.current = canvas;
  const roomRef = useRef(room); roomRef.current = room;
  const startedRoom = useRef<string | null>(null);
  const prompt = physicsRenderPrompt(room, look, direction);
  const promptRef = useRef(prompt); promptRef.current = prompt;
  const inputAt = useRef(0);
  const lastFrameAt = useRef(0);
  const lastVideoFrame = useRef(0);
  const serial = useRef(0);
  const commands = useRef(Promise.resolve());

  // Keep one fixed-resolution camera track and one GPU session while entering
  // other rooms. The underlying Three.js canvas is replaced for each MuJoCo task.
  useEffect(() => {
    if (!canvas || relay) return;
    const target = document.createElement("canvas"); target.width = 1280; target.height = 704;
    setRelay(target);
  }, [canvas, relay]);
  useEffect(() => {
    if (!relay) return;
    let animation = 0, last = 0;
    const draw = (time: number) => {
      animation = requestAnimationFrame(draw);
      const source = sourceRef.current;
      if (source && source.width && source.height && time - last >= 1000 / 24) {
        relay.getContext("2d")?.drawImage(source, 0, 0, 1280, 704); last = time;
      }
    };
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [relay]);

  useEffect(() => {
    if (!enabled || !relay) { setPhase("idle"); return; }
    // Fixed input size is required by SANA; resizing a published track can crash generation.
    if (relay.width !== 1280 || relay.height !== 704) {
      setError("The live render needs a 1280 × 704 simulation camera."); setPhase("error"); return;
    }
    const model = new SanaStreamingModel({ maxSessionAttempts: 30, maxSdpAttempts: 20, readyTimeoutMs: 60_000 });
    const generation = ++serial.current;
    client.current = model;
    let track: MediaStreamTrack | null = null;
    let stopped = false, callback = 0, count = 0;
    const current = () => !stopped && client.current === model && serial.current === generation;
    setError(null); setNotice(null); setFrames(0); setAnchors(0); setCompare(false); setPhase("connecting");
    setInitialized(false); confirmed.current = false; setRenderedRoom(null); setRenderedLook(null);
    inputAt.current = Date.now(); lastFrameAt.current = 0; lastVideoFrame.current = 0;

    const release = async () => {
      if (stopped) return;
      stopped = true;
      if (client.current === model) client.current = null;
      startedRoom.current = null;
      track?.stop();
      if (video.current) { video.current.cancelVideoFrameCallback?.(callback); video.current.srcObject = null; }
      try { await model.disconnect(); } catch {} finally { model[Symbol.dispose](); }
    };
    const fail = (cause: unknown) => {
      if (!current()) return;
      const failure = connectionFailure(cause);
      setError(failure.retryable ? "Reactor has no free rendering capacity. The simulation is still running; retry shortly." : failure.message);
      setCooldown(failure.retryable ? Date.now() + Math.max(15_000, failure.retryAfterMs) : 0);
      setPhase("error"); void release();
    };
    model.on("error", fail);
    model.onCommandError(message => fail(new Error(message.reason)));
    model.onChunkComplete(message => {
      if (!current()) return;
      count += message.frames_emitted;
      setFrames(count); lastFrameAt.current = Date.now();
      if (message.active_prompt === promptRef.current && sourceRef.current?.dataset.roomPath === roomRef.current.path) {
        confirmed.current = true; setRenderedRoom(roomRef.current.path); setRenderedLook(lookRef.current);
        if (lastVideoFrame.current) setPhase("live");
      }
    });
    model.onAnchored(() => { if (current()) setAnchors(value => value + 1); });
    model.onMainVideo((_track, stream) => {
      if (!current() || !video.current) return;
      const output = video.current;
      output.srcObject = stream;
      const frame = () => {
        if (!current()) return;
        lastVideoFrame.current = Date.now();
        if (count && confirmed.current) setPhase("live");
        callback = output.requestVideoFrameCallback(frame);
      };
      callback = output.requestVideoFrameCallback(frame);
      void output.play().catch(() => fail(new Error("Video playback was blocked. Retry the Reactor render.")));
    });
    model.on("statusChanged", status => {
      if (current() && status === "disconnected") fail(new Error("The Reactor stream disconnected. Retry to reconnect."));
    });

    void (async () => {
      try {
        const token = await reactorToken("sana-streaming");
        if (!current()) return;
        await model.connect(token);
        if (!current()) return;
        track = relay.captureStream(24).getVideoTracks()[0]; track.contentHint = "detail";
        await model.publishCamera(track);
        if (!current()) return;
        await model.setSeed({ seed: physicsRenderSeed(roomRef.current.path) });
        await model.setAnchorInterval({ chunks: 5 });
        if (!current()) return;
        const accepted = await model.setPrompt({ prompt: promptRef.current });
        if (!accepted) throw new Error("Reactor did not accept the appearance prompt.");
        if (!current()) return;
        setPhase("rendering");
        // The SANA SDK's start command returns void on success. Errors arrive through onCommandError.
        await model.start();
        if (current()) { startedRoom.current = roomRef.current.path; setInitialized(true); }
      } catch (cause) { fail(cause); }
    })();

    const touch = () => { inputAt.current = Date.now(); };
    const leave = () => { void release(); onEnabledChange(false); };
    const visibility = () => { if (document.hidden) leave(); };
    window.addEventListener("keydown", touch); window.addEventListener("pointerdown", touch);
    window.addEventListener("pointermove", touch); window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", visibility);
    const health = window.setInterval(() => {
      if (!current()) return;
      if (Date.now() - inputAt.current > IDLE_MS) { setNotice("Reactor stopped after two idle minutes."); leave(); return; }
      if (lastFrameAt.current && Date.now() - lastVideoFrame.current > 5_000) setPhase("stalled");
    }, 1000);
    return () => {
      clearInterval(health);
      window.removeEventListener("keydown", touch); window.removeEventListener("pointerdown", touch);
      window.removeEventListener("pointermove", touch); window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
      void release();
    };
  }, [enabled, relay, retry, onEnabledChange]);

  useEffect(() => {
    const model = client.current;
    if (!model || !canvas || canvas.dataset.roomPath !== room.path || !startedRoom.current || !initialized) return;
    let active = true;
    setApplying(true);
    commands.current = commands.current.catch(() => {}).then(async () => {
      if (!active || client.current !== model) return;
      try {
        const changingRoom = startedRoom.current !== room.path;
        if (changingRoom) {
          setPhase("rendering"); lastVideoFrame.current = 0; confirmed.current = false;
          await model.reset();
          await model.setSeed({ seed: physicsRenderSeed(room.path) });
        }
        const result = await model.setPrompt({ prompt });
        if (active && !result) setError("That appearance edit was not accepted. Try again.");
        if (changingRoom && active && client.current === model) {
          await model.start(); startedRoom.current = room.path;
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active) setApplying(false); }
    });
    return () => { active = false; };
    // Appearance edits update the existing stream; connecting initializes the latest prompt itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, canvas, room.path, initialized]);

  useEffect(() => {
    confirmed.current = false; setRenderedRoom(null);
    if (enabled && client.current) setPhase("rendering");
  }, [room.path]);

  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (cooldown <= Date.now()) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);
  const remaining = Math.max(0, Math.ceil((cooldown - Math.max(clock, Date.now())) / 1000));
  const live = enabled && phase === "live" && frames > 0;
  const label = phase === "connecting" ? "Connecting to Reactor…" : phase === "rendering" ? "Generating the first frames…"
    : phase === "stalled" ? "Catching up · simulation visible" : live ? `${frames.toLocaleString()} generated frames` : "Reactor video rendering";

  return <div className={styles.layer} data-testid="reactor-physics" data-phase={phase} data-frames={frames} data-anchors={anchors}
    data-look={look} data-rendered-look={renderedLook ?? ""} data-rendered-room={renderedRoom ?? ""} data-direction={direction} data-source-width={canvas?.width ?? 0} data-source-height={canvas?.height ?? 0}>
    <video ref={video} aria-label="Reactor enhanced physics view" autoPlay muted playsInline
      className={`${styles.output} ${live && !compare ? styles.visible : ""}`} />
    <section className={styles.toolbar} aria-label="High fidelity rendering">
      <div className={styles.status}><span className={live ? styles.dotLive : styles.dot} /><strong>{live ? "REACTOR + MUJOCO" : "HIGH FIDELITY LAB"}</strong><span>{live ? "LIVE" : "SANA"}</span></div>
      <p role="status">{label}</p>
      {enabled && phase !== "error" ? <>
        <div className={styles.switch} role="group" aria-label="Render view">
          <button aria-pressed={!compare} onClick={() => setCompare(false)}>Reactor view</button>
          <button aria-pressed={compare} onClick={() => setCompare(true)}>Simulation</button>
        </div>
        <div className={styles.looks} role="group" aria-label="Lighting">
          {(Object.keys(RENDER_LOOKS) as RenderLook[]).map(key => <button key={key} aria-pressed={look === key} onClick={() => setLook(key)}>{RENDER_LOOKS[key].label}</button>)}
        </div>
        <div className={styles.actions}><button onClick={() => setEditing(value => !value)} aria-expanded={editing}>Direct appearance ↗</button><button onClick={() => onEnabledChange(false)}>Stop Reactor</button></div>
      </> : <button className={styles.start} disabled={!canvas || !configured || remaining > 0} onClick={() => { setError(null); onEnabledChange(true); setRetry(value => value + 1); }}>
        {remaining ? `Retry in ${remaining}s` : phase === "error" ? "Retry Reactor render" : "Start high fidelity view ↗"}
      </button>}
      {editing && enabled && <form className={styles.edit} onSubmit={event => { event.preventDefault(); setDirection(draft); }}>
        <label htmlFor="physics-appearance">Light, surfaces, atmosphere</label>
        <textarea id="physics-appearance" maxLength={220} rows={2} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Soft studio light, brushed steel, realistic glass…" />
        <button type="submit" disabled={applying || !live}>{applying ? "Applying…" : "Apply appearance"}</button>
      </form>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p>{notice}</p>}
      <small>{!configured ? "Configure Reactor to enable video rendering." : "MuJoCo controls contacts and rewards. Generated frames may lag."}</small>
    </section>
  </div>;
}
