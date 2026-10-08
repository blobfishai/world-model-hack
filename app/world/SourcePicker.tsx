"use client";

import { useEffect, useState } from "react";
import type { SourcesResponse } from "./lib/types";

function taskLabel(value: string | null): string | null {
  if (!value) return null;
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SourcePicker({ data, loadError, creating, onCreate }: {
  data: SourcesResponse | null;
  loadError: string | null;
  creating: boolean;
  onCreate: (source: string, t: number) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [previewTime, setPreviewTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewTime(time), 250);
    return () => window.clearTimeout(timer);
  }, [time]);

  const source = data?.sources.find(item => item.id === selected) ?? null;
  const max = source ? Math.max(0, Math.min(source.duration - 0.5, 30)) : 0;

  async function create() {
    if (!source) return;
    setError(null);
    try { await onCreate(source.id, time); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <main className="rw-picker">
    <div className="rw-picker-intro">
      <span className="rw-eyebrow">REACTOR WORLD · LINGBOT WORLD 2</span>
      <h1>Start from the first frame of a recording.</h1>
      <p>Reactor turns that beginning image into a walkable world. Gemini plans task rooms from what it shows, Reactor generates each room at 1664×960 @ 48 fps, and every room can become a MuJoCo Playground gym.</p>
    </div>
    <div className="rw-picker-body">
      <div className="rw-sources" role="list" aria-label="Start videos">
        {!data && !loadError && <p className="rw-muted">Loading recordings…</p>}
        {data?.sources.length === 0 && <p className="rw-muted">No recordings found in data/000.</p>}
        {data?.sources.map(item => <div key={item.id} role="listitem">
          <button className={`rw-source${item.id === selected ? " rw-selected" : ""}`} aria-pressed={item.id === selected}
            onClick={() => { setSelected(item.id); setTime(0); setPreviewTime(0); }}>
            <img src={item.poster_url} alt="" loading="lazy" draggable={false} />
            <span><strong>{item.label}</strong>
              <small>{[taskLabel(item.task_type), `${Math.round(item.duration)} s`, `${item.width}×${item.height}`].filter(Boolean).join(" · ")}</small></span>
          </button>
        </div>)}
        {loadError && <p className="rw-error-inline" role="alert">{loadError}</p>}
      </div>
      <section className="rw-preview" aria-label="Beginning image">
        {source
          ? <img src={`/api/worlds/sources/${encodeURIComponent(source.id)}/frame?t=${previewTime}&w=960`}
            alt={`Beginning image of ${source.label} at ${previewTime.toFixed(1)} seconds`} draggable={false} />
          : <div className="rw-preview-empty">Choose a recording to see its beginning image.</div>}
        <label className="rw-scrubber">
          <span>Beginning image <b>{time.toFixed(1)} s</b></span>
          <input type="range" min={0} max={max} step={0.5} value={time} disabled={!source} aria-label="Beginning image time in seconds"
            onChange={event => setTime(Number(event.target.value))} />
        </label>
        <button className="rw-button rw-primary rw-full" disabled={!source || creating || data?.planner_configured === false} onClick={() => void create()}>
          {creating ? "Creating world…" : "Create world"}
        </button>
        {data?.planner_configured === false && <p className="rw-caption rw-warn">Set GOOGLE_API_KEY in .env so Gemini can plan rooms from the image.</p>}
        {data && !data.reactor_configured && <p className="rw-caption">REACTOR_API_KEY is not set: you can explore offline, but Reactor will not generate rooms.</p>}
        <p className="rw-caption">Planning reads the frame once with Gemini. Each room scan is ~20 s of a paid LingBot World 2 session (~$0.14); walking live costs ~$0.42 per minute.</p>
        {error && <p className="rw-error-inline" role="alert">{error}</p>}
        {data && <p className="rw-provenance">{data.attribution}</p>}
      </section>
    </div>
  </main>;
}
