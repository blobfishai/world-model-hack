"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { worldRequest, type Job, type WorldRoom, type WorldSource, type WorldSourceRef } from "../world/lib/types";
import { formatSeconds, jobActive, worldUrl } from "../world/lib/rooms";
import styles from "./lab.module.css";

interface Task {
  id: string; world_id: string; world_title: string; title: string; room: WorldRoom; source: WorldSourceRef;
  grounding: "source_frame" | "generated_variation"; build: Job; simulation_ready: boolean; training_ready: boolean;
}
interface Catalog {
  tasks: Task[]; sources: (WorldSource & { qc_status?: string })[]; attribution: string;
  worlds: { id: string; title: string; status: string; error: string | null }[];
}
type Preview = "reactor" | "physics" | "world" | "source";
const active = (task: Task) => jobActive(task.build) || Object.values(task.room.jobs).some(jobActive);
const url = (task: Task, robot = false) => worldUrl(task.world_id, task.room.path) + (robot ? "&view=robot" : "");
const sourceVideo = (task: Task) => `/api/worlds/sources/${task.source.id}/video#t=${task.source.t}`;
const label = (task: Task) => task.training_ready ? "Training ready" : task.simulation_ready ? "Playable simulation"
  : active(task) ? "Building" : task.room.task.robot_task?.feasible ? "World generated" : "World only";

export default function Lab() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState("all");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Preview>("reactor");
  const [pending, setPending] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setCatalog(await worldRequest<Catalog>("/catalog")); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const busy = Boolean(catalog?.tasks.some(active) || catalog?.worlds.some(world => world.status === "planning"));
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [busy, refresh]);
  const tasks = useMemo(() => (catalog?.tasks ?? []).filter(task =>
    (source === "all" || task.source.id === source) && (filter === "all" || (filter === "ready" ? task.training_ready : task.simulation_ready))
    && `${task.title} ${task.world_title} ${task.source.task_type ?? ""}`.toLowerCase().includes(search.toLowerCase())), [catalog, source, filter, search]);
  const featured = catalog?.tasks.find(task => task.id === selected) ?? tasks[0] ?? catalog?.tasks[0];
  const playable = catalog?.tasks.filter(task => task.simulation_ready).length ?? 0;
  const ready = catalog?.tasks.filter(task => task.training_ready).length ?? 0;
  const generated = catalog?.tasks.filter(task => task.room.jobs.scan.status === "ready").length ?? 0;

  const build = async (task: Task) => {
    setPending(task.id); setError(null);
    try {
      await worldRequest(`/${task.world_id}/rooms/${task.room.path}/build`, { method: "POST" });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };
  const media = featured?.room.media;
  const available = { reactor: media?.demo_reactor, physics: media?.demo, world: media?.scan, source: featured ? sourceVideo(featured) : null };
  const showing: Preview = available[preview] ? preview : media?.scan ? "world" : "source";

  return <div className={styles.app}>
    <header className={styles.header}><a href="/worlds" className={styles.brand}><span>◈</span> rooms</a><span className={styles.headerLabel}>TASK LAB <i /> FOOTAGE → REACTOR → MUJOCO</span><nav><a href="/worlds?mode=physics">Walk the labs ↗</a><a className={styles.new} href="/world">+ Build from footage</a></nav></header>
    <main>
      <section className={styles.intro}><div><span className={styles.eyebrow}>MUJOCO PLAYGROUND · REACTOR VISUALS</span><h1>Real rooms.<br /><span>Robots in motion.</span></h1><p>Start with a place from the footage. Explore its Reactor world, take control of the Panda, and train on a task with measurable success.</p></div>
        <div className={styles.counts}><div><strong>{generated.toString().padStart(2, "0")}</strong><span>Reactor worlds</span></div><div><strong>{playable.toString().padStart(2, "0")}</strong><span>Playable tasks</span></div><div><strong>{ready.toString().padStart(2, "0")}</strong><span>Verified MJX gyms</span></div></div>
      </section>
      {error && <div className={styles.error} role="alert">{error}<button onClick={() => void refresh()}>Retry</button></div>}
      {!catalog && !error && <p className={styles.empty} role="status">Opening the task library…</p>}
      {featured && <section className={styles.showcase} aria-label="Selected task">
        <div className={styles.film}>
          <video key={`${featured.id}:${showing}`} src={available[showing] ?? undefined} poster={media?.arrival ?? undefined} muted controls playsInline loop={showing !== "source"} autoPlay={showing !== "source"} preload="metadata" aria-label={`${showing === "reactor" ? "Reactor rendered" : showing === "physics" ? "MuJoCo simulation" : showing === "world" ? "Reactor walkthrough" : "Source footage"}: ${featured.title}`} />
          <span className={styles.filmBadge}><i />{showing === "reactor" ? "REACTOR RENDER · RECORDED DEMO" : showing === "physics" ? "MUJOCO · RECORDED DEMO" : showing === "world" ? "LINGBOT WORLD 2 · WALKTHROUGH" : "ORIGINAL /DATA FOOTAGE"}</span>
        </div>
        <div className={styles.details}><span className={styles.eyebrow}>{label(featured)}</span><h2>{featured.title}</h2>
          <p>{featured.room.task.robot_task?.kind === "lift" ? "Reach, close both fingers, lift 15 cm and hold steady for one second." : "Reach, grasp, lift, carry, settle the object, then open the fingers and retreat."}</p>
          <div className={styles.previewTabs} role="group" aria-label="Task preview">
            {([['reactor', 'Reactor render'], ['physics', 'MuJoCo'], ['world', 'Walkthrough'], ['source', 'Source footage']] as [Preview, string][]).map(([key, name]) => <button key={key} disabled={!available[key]} aria-pressed={showing === key} onClick={() => setPreview(key)}>{name}</button>)}
          </div>
          <dl><div><dt>Robot</dt><dd>Franka Panda · 7 joints</dd></div><div><dt>Task checks</dt><dd>{featured.room.robot_demo?.success ? `${featured.room.robot_demo.steps_completed}/${featured.room.robot_demo.total_steps} passed` : `${featured.room.steps?.length ?? 0} ordered steps`}</dd></div><div><dt>Source</dt><dd>Recording {featured.source.id} · {formatSeconds(featured.source.t)}</dd></div><div><dt>Training</dt><dd>{featured.training_ready ? "MJX replay passed" : featured.simulation_ready ? "Simulation available" : "Build physics to begin"}</dd></div></dl>
          <div className={styles.featureActions}>{featured.simulation_ready ? <a className={styles.primary} href={url(featured, true)}>Control the robot ↗</a> : <a className={styles.primary} href={url(featured)}>Explore Reactor world ↗</a>}
            {featured.training_ready && featured.room.export?.download_url && <a className={styles.download} href={featured.room.export.download_url}>↓ Playground bundle</a>}</div>
          <small>Reactor renders appearance; MuJoCo measures contacts and success. Reconstructed geometry uses estimated scale.</small>
        </div>
      </section>}
      <section className={styles.library} aria-label="Task library">
        <div className={styles.libraryHeading}><div><span className={styles.eyebrow}>CHOOSE A TASK</span><h2>Your training grounds<span>{tasks.length}</span></h2></div><input type="search" aria-label="Search tasks" placeholder="Find a task or a room…" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className={styles.filters}><div role="group" aria-label="Task readiness"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All tasks</button><button aria-pressed={filter === "playable"} onClick={() => setFilter("playable")}>Playable <span>{playable}</span></button><button aria-pressed={filter === "ready"} onClick={() => setFilter("ready")}>Training ready <span>{ready}</span></button></div><select aria-label="Source recording" value={source} onChange={event => setSource(event.target.value)}><option value="all">All footage</option>{catalog?.sources.map(item => <option key={item.id} value={item.id}>{item.label}{item.qc_status === "flagged" ? " · QC flagged" : ""}</option>)}</select></div>
        {catalog && !tasks.length && <div className={styles.empty}>No tasks match these filters.<button onClick={() => { setFilter("all"); setSource("all"); setSearch(""); }}>Show all tasks</button></div>}
        <div className={styles.grid}>{tasks.map(task => {
          const robot = task.room.task.robot_task;
          const working = active(task) || pending === task.id;
          const stage = Object.values(task.room.jobs).find(jobActive);
          const buildError = task.build.error ?? (task.room.jobs.physics.status === "failed" ? task.room.jobs.physics.error : null);
          return <article key={task.id} className={styles.card} data-testid="lab-task" data-training-ready={task.training_ready}>
            <button className={styles.cardImage} onClick={() => { setSelected(task.id); setPreview("reactor"); document.querySelector('[aria-label="Selected task"]')?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-label={`Preview ${task.title}`}>
              <img loading="lazy" src={task.room.media.arrival ?? `/api/worlds/sources/${task.source.id}/frame?t=${task.source.t}&w=640`} alt={task.room.door_label} />
              <span className={task.training_ready ? styles.ready : styles.badge}>{label(task)}</span><span className={styles.play}>↗</span>
            </button>
            <div className={styles.cardBody}><span className={styles.meta}>{robot?.kind === "lift" ? "LIFT + HOLD" : robot?.kind === "place" ? "PICK + PLACE" : "ROOM EXPLORATION"}<i />{task.room.door_label}</span><h3>{task.title}</h3>
              <p>Recording {task.source.id} · {formatSeconds(task.source.t)}<span>{task.grounding === "source_frame" ? "Footage frame → Reactor" : "Reactor task variation"}</span></p>
              {working && <p className={styles.job} role="status">{stage?.message || task.build.message || "Queued…"}</p>}
              {buildError && <p className={styles.cardError}>{buildError}</p>}
              {!robot?.feasible && <p className={styles.cardError}>{robot?.reason ?? "No supported single-arm subtask in this recording."}</p>}
              <div className={styles.cardActions}><a href={url(task, task.simulation_ready)}>{task.simulation_ready ? "Play task ↗" : "Walk world ↗"}</a>
                {task.training_ready && task.room.export?.download_url ? <a href={task.room.export.download_url}>↓ Train</a> : robot?.feasible && task.room.jobs.scan.status === "ready" ? <button disabled={working} onClick={() => void build(task)}>{working ? "Building…" : task.build.status === "failed" ? "Resume build" : "Build gym + render"}</button> : null}
              </div>
            </div>
          </article>;
        })}</div>
      </section>
      <section className={styles.pipeline}><div><span>01 / CAPTURE</span><h3>Grounded in footage</h3><p>Real frames, room materials and visible objects from local recordings seed each new world.</p></div><div><span>02 / GENERATE</span><h3>Reactor brings it to life</h3><p>LingBot generates walkthroughs. SANA edits the live simulation camera and recorded robot demonstrations.</p></div><div><span>03 / TRAIN</span><h3>Measured in MuJoCo</h3><p>Playground bundles include randomized resets, ordered task rewards, a checked MJX replay and PPO training scripts.</p></div></section>
      <p className={styles.note}>These are rigid-object robot subtasks derived from human footage. Cloth and water remain visual context. “Training ready” means the environment and demonstration passed validation; a policy has not been trained.</p>
    </main><footer className={styles.footer}><span>rooms / task lab</span><span>{catalog?.attribution ?? "Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0"}</span><a href="https://playground.mujoco.org/" target="_blank" rel="noreferrer">MuJoCo Playground ↗</a></footer>
  </div>;
}
