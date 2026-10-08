"use client";

import { useState } from "react";
import { GymBadges } from "./GymBadges";
import { robotTaskTitle, stepSummary, taskProgram } from "./lib/robot";
import { RELATION_META, gymCatalog, jobActive, jobLabel } from "./lib/rooms";
import type { Job, RobotState, World, WorldRoom } from "./lib/types";

export type JobKind = "scan" | "physics" | "playground" | "children" | "demo";

const IDLE_JOB: Job = { status: "idle", progress: 0, message: "", error: null, updated_at: null };

function JobRow({ label, job }: { label: string; job: Job }) {
  return <div className={`rw-job rw-job-${job.status}`}>
    <div><span>{label}</span><b>{jobLabel(job)}</b></div>
    {jobActive(job) && <progress max={100} value={job.progress} aria-label={`${label} progress`} />}
  </div>;
}

export function TaskPanel({ world, room, playgroundAvailable, robotState, onJob, onInteract, onOpenRobot, onNavigate, onClose }: {
  world: World; room: WorldRoom; playgroundAvailable: boolean; robotState: RobotState | null;
  onJob: (path: string, kind: JobKind) => Promise<void>;
  onInteract: () => void; onOpenRobot: () => void; onNavigate: (path: string) => void; onClose: () => void;
}) {
  const [pending, setPending] = useState<JobKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const meta = RELATION_META[room.relation];
  const { scan, physics, export: exportJob, children } = room.jobs;
  const robot = room.task.robot_task;
  const demo = room.jobs.demo ?? IDLE_JOB;
  const steps = robotState?.steps ?? room.steps ?? taskProgram(room.task);
  const progress = stepSummary(steps);
  const demoVideo = room.media.demo ?? null;
  const demoRender = room.media.demo_reactor ?? null;
  const outcome = room.robot_demo ?? null;
  const scanReady = scan.status === "ready" && Boolean(room.media.scan);
  const physicsReady = physics.status === "ready" && Boolean(room.physics?.valid);
  const exportReady = exportJob.status === "ready" && Boolean(room.export?.download_url);

  async function run(kind: JobKind) {
    setPending(kind);
    setError(null);
    try { await onJob(room.path, kind); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  }

  const busy = (kind: JobKind, job: Job) => pending === kind || jobActive(job);
  const physicsBlocked = !scanReady ? "Needs a Reactor scan" : null;
  const exportBlocked = !physicsReady ? "Build physics first"
    : !robot ? "This room has no robot task"
    : !robot.feasible ? (robot.reason ?? "The robot task is not feasible for a Panda gripper")
    : !playgroundAvailable ? "Install the playground extra on the server (uv sync --extra playground)" : null;
  const parent = room.parent ? world.rooms[room.parent] : null;
  const childRooms = room.children.map(path => world.rooms[path]).filter((child): child is WorldRoom => Boolean(child));

  return <aside className="rw-panel" aria-label="Task details">
    <div className="rw-panel-heading">
      <span className="rw-kicker"><i style={{ background: meta.color }} />{meta.label}</span>
      <button className="rw-icon-button" onClick={onClose} aria-label="Close task details">×</button>
    </div>
    <h2>{room.title}</h2>
    <p className="rw-goal">{room.task.goal}</p>
    <GymBadges room={room} />

    {room.task.objects.length > 0 && <section className="rw-section">
      <span className="rw-eyebrow">REAL TASK — FROM THE BEGINNING IMAGE OF {world.source.file}</span>
      <ul className="rw-objects">
        {room.task.objects.map(object => <li key={object.id}>
          <span>{object.label}</span><small>{object.kind} · {object.size.map(value => Math.round(value * 100)).join("×")} cm</small>
        </li>)}
      </ul>
    </section>}

    <section className="rw-section">
      <span className="rw-eyebrow">REWARD CHECKED BY CODE — MUJOCO STEP CHECKS</span>
      {robot
        ? <>
          <p className={robot.feasible ? "rw-robot" : "rw-robot rw-warn"}>
            {robotTaskTitle(room.task)}
            {!robot.feasible && <span>{robot.reason ?? "Not graspable by the Panda gripper"}</span>}
          </p>
          {robot.feasible && <ol className="rw-checklist" aria-label="Robot task steps">
            {steps.map((step, index) => <li key={step.id} className={step.done ? "rw-done" : index === progress.current && robotState ? "rw-current" : undefined}>
              <i aria-hidden="true">{step.done ? "✓" : index + 1}</i><span>{step.title}</span>
            </li>)}
          </ol>}
          {robotState?.success && <p className="rw-robot-success rw-small" role="status">Task complete · {progress.total}/{progress.total} steps</p>}
          {robot.feasible && <button className="rw-button rw-full" onClick={onOpenRobot}>
            {physicsReady ? "Open robot simulation" : "Open robot simulation (needs physics)"}
          </button>}
        </>
        : <p className="rw-muted">Explore-only room: no robot task was planned for its objects.</p>}
    </section>

    <section className="rw-section">
      <span className="rw-eyebrow">REALISTIC WORLD — REACTOR LINGBOT WORLD 2</span>
      <JobRow label="LingBot World 2 scan" job={scan} />
      {room.media.storyboard && <img className="rw-storyboard" src={room.media.storyboard} alt={`Storyboard of the Reactor scan of ${room.title}`} />}
      <div className="rw-button-row">
        <button className="rw-button" disabled={busy("scan", scan)} onClick={() => void run("scan")}>
          {scan.status === "ready" ? "Regenerate scan" : "Generate Reactor scan"}
        </button>
        {scanReady && <button className="rw-button" onClick={() => setWatching(value => !value)}>{watching ? "Hide scan" : "Watch Reactor scan"}</button>}
      </div>
      {watching && room.media.scan && <video className="rw-scan" src={room.media.scan} controls autoPlay muted playsInline
        aria-label={`Reactor scan of ${room.title}, 1664×960 at 48 fps`} />}
      <p className="rw-caption">Each scan is ~20 s of a paid LingBot World 2 session, recorded at native 1664×960 @ 48 fps.</p>
    </section>

    <section className="rw-section">
      <span className="rw-eyebrow">PHYSICS — MUJOCO RECONSTRUCTION</span>
      <JobRow label="MuJoCo reconstruction" job={physics} />
      {room.physics && <p className="rw-muted">{room.physics.objects} objects · {room.physics.valid ? "physics validated" : "needs review"} · rev {room.physics.revision.slice(0, 8)}</p>}
      <div className="rw-button-row">
        <button className="rw-button" disabled={Boolean(physicsBlocked) || busy("physics", physics)} title={physicsBlocked ?? undefined} onClick={() => void run("physics")}>
          {physics.status === "ready" ? "Rebuild physics" : "Build physics"}
        </button>
        <button className="rw-button" disabled={!physicsReady} title={physicsReady ? undefined : "Build physics first"} onClick={onInteract}>Interact</button>
      </div>
      {physicsBlocked && <p className="rw-caption">{physicsBlocked}.</p>}
    </section>

    <section className="rw-section">
      <span className="rw-eyebrow">VERIFIED DEMO — SCRIPTED PANDA, RENDERED BY REACTOR</span>
      <JobRow label="Scripted demo + Reactor render" job={demo} />
      <button className="rw-button rw-full" disabled={!physicsReady || !robot?.feasible || busy("demo", demo)}
        title={!physicsReady ? "Build physics first" : !robot?.feasible ? "This room has no feasible robot task" : undefined}
        onClick={() => void run("demo")}>{outcome ? "Render the demo again" : "Render demo with Reactor"}</button>
      {outcome && <p className="rw-muted">
        Scripted demo: {outcome.steps_completed}/{outcome.total_steps} steps in {outcome.seconds.toFixed(1)} s
        {outcome.success ? " · solved" : " · not solved"}
        {" · "}{outcome.reactor ? "Reactor render ready" : outcome.reactor_error ? `Reactor render failed: ${outcome.reactor_error}` : "no Reactor render"}
      </p>}
      {(demoVideo || demoRender) && <div className="rw-demo-pair">
        {demoVideo && <figure>
          <video src={demoVideo} muted loop autoPlay controls playsInline aria-label={`MuJoCo simulation of the scripted demo in ${room.title}`} />
          <figcaption>MuJoCo simulation</figcaption>
        </figure>}
        {demoRender && <figure>
          <video src={demoRender} muted loop autoPlay controls playsInline aria-label={`Reactor render of the scripted demo in ${room.title}`} />
          <figcaption>Reactor render</figcaption>
        </figure>}
      </div>}
      <p className="rw-caption">Reactor restyles appearance only; the MuJoCo simulation is the ground truth for the task.</p>
    </section>

    <section className="rw-section">
      <span className="rw-eyebrow">TRAINING GYM — MUJOCO PLAYGROUND (MJX)</span>
      <JobRow label="Playground gym export" job={exportJob} />
      <button className="rw-button rw-primary rw-full" disabled={Boolean(exportBlocked) || busy("playground", exportJob)}
        title={exportBlocked ?? undefined} onClick={() => void run("playground")}>Export to MuJoCo Playground</button>
      {exportBlocked && <p className="rw-caption">{exportBlocked}.</p>}
      {room.export && !room.export.feasible && <p className="rw-caption rw-warn">{room.export.reason}</p>}
      {exportReady && room.export && <div className="rw-export">
        {room.media.preview && <img src={room.media.preview} alt={`MuJoCo Playground preview of ${room.title}`} />}
        {room.export.env_name && <p>Environment <code>{room.export.env_name}</code></p>}
        {room.export.checks && <ul className="rw-checks">
          {Object.entries(room.export.checks).map(([name, value]) => <li key={name} className={value === false ? "rw-warn" : undefined}>
            <span>{name.replaceAll("_", " ")}</span><b>{value === true ? "✓" : value === false ? "✗" : String(value)}</b>
          </li>)}
        </ul>}
        <a className="rw-button rw-primary rw-full" href={room.export.download_url!} download>Download Playground gym (.zip)</a>
        <pre className="rw-commands">{"pip install -r requirements.txt && python smoke_test.py\npython train.py --impl warp   # NVIDIA GPU\n# or open colab.ipynb in Google Colab"}</pre>
      </div>}
    </section>

    {room.path === "root" && <section className="rw-section">
      <span className="rw-eyebrow">GYM CATALOG · {Object.keys(world.rooms).length} TASK ROOMS</span>
      <ul className="rw-catalog">
        {gymCatalog(world).map(entry => <li key={entry.path}>
          <button aria-current={entry.path === room.path ? "page" : undefined} onClick={() => onNavigate(entry.path)}>
            <span className="rw-catalog-title"><i style={{ background: RELATION_META[entry.relation].color }} />{entry.title}</span>
            <small>{entry.path === "root" ? "Beginning image" : `${RELATION_META[entry.relation].label} · ${entry.door_label}`}</small>
            <GymBadges room={entry} empty="No checks yet" />
          </button>
        </li>)}
      </ul>
    </section>}

    <section className="rw-section">
      <span className="rw-eyebrow">DOORS FROM HERE</span>
      <div className="rw-door-list">
        {parent && <button onClick={() => onNavigate(parent.path)}><b className="rw-door-arrow" aria-hidden="true">←</b><span>Go back to {parent.title}</span></button>}
        {childRooms.map(child => <button key={child.path} onClick={() => onNavigate(child.path)}>
          <i style={{ background: RELATION_META[child.relation].color }} /><span>Go to {child.title}</span><small>{child.media.arrival ? "ready" : jobLabel(child.jobs.scan)}</small>
        </button>)}
      </div>
      {childRooms.length === 0 && <>
        <JobRow label="Deeper rooms" job={children} />
        <button className="rw-button rw-full" disabled={!room.media.arrival && room.path !== "root" || busy("children", children)}
          onClick={() => void run("children")}>Plan deeper rooms</button>
      </>}
    </section>

    {error && <p className="rw-error-inline" role="alert">{error}</p>}
    <p className="rw-provenance">Recording {world.source.id} at {world.source.t.toFixed(1)} s · {world.attribution}</p>
  </aside>;
}
