"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ENVIRONMENTS, RELATIONS, childRooms, isEnvironment, validRoomPath, taskRoom, roomTrail, roomNumber,
  type EnvironmentId, type TaskRoom } from "../lib/task-rooms";
import type { RoomMedia } from "../lib/room-media";
import type { ExperimentView } from "../lib/room-experiment-types";
import type { WorldHandle } from "./RoomWorld";
import styles from "./rooms.module.css";

const RoomWorld = dynamic(() => import("./RoomWorld"), { ssr: false });

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    back: <path d="M19 12H5m6-6-6 6 6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z" /><path d="M9 3v16m6-14v16" /></>,
    sliders: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="16" cy="17" r="3" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></>,
    play: <path d="m9 5 11 7-11 7V5Z" />,
    pause: <path d="M8 5v14M16 5v14" />,
    reset: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /></>,
    door: <><path d="M5 21V3h14v18M3 21h18" /><path d="M9 21V6l7-2v17" /><path d="M13 13h.01" /></>,
    expand: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="M20 2v4m-2-2h4" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
    cube: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5m-9 5v9" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.door}</svg>;
}

function MiniMap({ doors, position, onDoor, onClose }: { doors: TaskRoom[]; position: { x: number; z: number; yaw: number }; onDoor: (index: number) => void; onClose: () => void }) {
  return <div className={styles.minimap}>
    <div className={styles.mapHeader}><span>ROOM MAP</span><button onClick={onClose} aria-label="Hide room map"><Icon name="close" size={13} /></button></div>
    <svg viewBox="0 0 220 208" aria-label="Map of this room with ten connected doorways">
      <rect x="34" y="17" width="152" height="170" rx="3" fill="#272e27" stroke="#65715f" />
      <rect x="73" y="21" width="74" height="4" rx="2" fill="#a9c897" />
      <text x="110" y="37" textAnchor="middle" fill="#7d8d76" fontSize="7">TASK SCREEN</text>
      {doors.map((door, index) => {
        const x = index < 5 ? 30 : 190, y = 43 + index % 5 * 31;
        return <g key={door.path} role="button" tabIndex={0} aria-label={`Enter room ${index + 1}: ${door.title}`} onClick={() => onDoor(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onDoor(index); } }} className={styles.mapDoor}>
          <title>{door.title}</title><rect x={x - 9} y={y - 9} width="18" height="18" rx="3" fill={RELATIONS[door.relation].color} />
          <text x={x} y={y + 2.5} textAnchor="middle" fontSize="7" fill="#233122">{String(index + 1).padStart(2, "0")}</text>
        </g>;
      })}
      <g transform={`translate(${110 + position.x * 6.6},${104 + position.z * 7.2}) rotate(${-position.yaw * 180 / Math.PI})`}>
        <circle r="12" fill="#c0d9a5" opacity=".08" /><path d="m0-7 4 10-4-2-4 2Z" fill="#d9e9bb" />
      </g>
    </svg>
    <div className={styles.mapLegend}><span><i style={{ background: RELATIONS.similar.color }} />Similar</span><span><i style={{ background: RELATIONS.subskill.color }} />Deeper</span><span><i style={{ background: RELATIONS.harder.color }} />Advanced</span><span><i style={{ background: RELATIONS.variation.color }} />Variation</span></div>
  </div>;
}

export default function RoomExplorer({ media, initialEnvironment, initialPath, reactorConfigured }: {
  media: RoomMedia; initialEnvironment: EnvironmentId; initialPath: string; reactorConfigured: boolean;
}) {
  const [room, setRoom] = useState(() => taskRoom(initialEnvironment, initialPath));
  const [hovered, setHovered] = useState<number | null>(null);
  const [position, setPosition] = useState({ x: 0, z: 8.7, yaw: 0.08 });
  const [supported, setSupported] = useState<boolean | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [showDirectory, setShowDirectory] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [visited, setVisited] = useState<string[]>([]);
  const [experiment, setExperiment] = useState<ExperimentView | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const world = useRef<WorldHandle>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const navigationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomIdentity = useRef(`${room.environment}:${room.path}`);
  roomIdentity.current = `${room.environment}:${room.path}`;
  const doors = childRooms(room);
  const trail = roomTrail(room);
  const environment = ENVIRONMENTS[room.environment];
  const footage = media[room.environment];
  const previousAttempt = footage.attempts[room.path];
  const busy = requesting || !!experiment && !["ready", "failed"].includes(experiment.status);
  const videoUrl = experiment?.assetUrl ?? (!experiment && previousAttempt ? previousAttempt.url : footage.sourceUrl);
  const mismatch = experiment?.review?.verdict === "mismatch" || (!experiment && !!previousAttempt);
  const videoLabel = experiment?.assetUrl ? "Reactor experiment" : !experiment && previousAttempt ? "Previous Reactor experiment" : room.depth === 0 ? "Original source footage" : "Source reference";

  useEffect(() => {
    try {
      const preference = localStorage.getItem("task-rooms:auto-generate");
      if (preference !== null) setAutoGenerate(preference === "true");
      const history = JSON.parse(localStorage.getItem("task-rooms:visited") ?? "[]");
      if (Array.isArray(history)) setVisited(history.filter(value => typeof value === "string").slice(-128));
    } catch { /* Browsing still works when local storage is unavailable. */ }
    setPreferencesReady(true);
    const pop = () => {
      const search = new URLSearchParams(window.location.search);
      const nextEnvironment = search.get("environment"), nextPath = search.get("room") ?? "root";
      setRoom(taskRoom(isEnvironment(nextEnvironment) ? nextEnvironment : "kitchen", validRoomPath(nextPath) ? nextPath : "root"));
    };
    window.addEventListener("popstate", pop);
    return () => { window.removeEventListener("popstate", pop); if (navigationTimer.current) clearTimeout(navigationTimer.current); };
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    const key = `${room.environment}:${room.path}`;
    setVisited(previous => {
      const next = previous.includes(key) ? previous : [...previous, key].slice(-128);
      try { localStorage.setItem("task-rooms:visited", JSON.stringify(next)); } catch {}
      return next;
    });
    setHovered(null); setPlaying(true);
  }, [room.environment, room.path, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady) return;
    const controller = new AbortController();
    setExperiment(null); setGenerationError(null);
    const generate = autoGenerate && reactorConfigured && room.depth > 0;
    setRequesting(generate);
    const endpoint = generate ? "/api/rooms/experiments" : `/api/rooms/experiments?environment=${room.environment}&room=${room.path}`;
    void fetch(endpoint, generate ? { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: room.environment, room: room.path }), signal: controller.signal }
      : { cache: "no-store", signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Could not load this experiment."); return body; })
      .then(body => { if (!controller.signal.aborted) setExperiment(body.experiment); })
      .catch(error => { if (!controller.signal.aborted) setGenerationError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setRequesting(false); });
    return () => controller.abort();
  }, [room.environment, room.path, room.depth, autoGenerate, preferencesReady, reactorConfigured]);

  useEffect(() => {
    if (!experiment || ["ready", "failed"].includes(experiment.status)) return;
    const events = new EventSource(`/api/rooms/experiments/${experiment.id}?stream=1`);
    events.onmessage = event => {
      const next = JSON.parse(event.data) as ExperimentView | null;
      if (next) setExperiment(next);
      if (!next || ["ready", "failed"].includes(next.status)) events.close();
    };
    events.onerror = () => { /* EventSource reconnects to the durable job after a network interruption. */ };
    return () => events.close();
  }, [experiment?.id, experiment?.status === "ready", experiment?.status === "failed"]);

  useEffect(() => {
    if (showVideo) dialog.current?.showModal();
    else dialog.current?.close();
  }, [showVideo]);

  useEffect(() => { setPlaying(true); }, [videoUrl]);

  const navigate = useCallback((next: TaskRoom) => {
    if (navigationTimer.current) clearTimeout(navigationTimer.current);
    setTransitioning(true);
    setShowDirectory(false);
    navigationTimer.current = setTimeout(() => {
      setRoom(next); setExperiment(null); setGenerationError(null);
      const query = new URLSearchParams({ environment: next.environment });
      if (next.path !== "root") query.set("room", next.path);
      window.history.pushState({}, "", `/explore?${query}`);
      setTransitioning(false);
    }, 260);
  }, []);

  const enterDoor = (index: number) => {
    setShowDirectory(false);
    if (supported !== true) navigate(doors[index]);
    else world.current?.walkToDoor(index);
  };
  const startExperiment = async () => {
    const identity = roomIdentity.current;
    setRequesting(true); setGenerationError(null);
    try {
      const response = await fetch("/api/rooms/experiments", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment: room.environment, room: room.path, force: !!experiment }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start this experiment.");
      if (roomIdentity.current === identity) setExperiment(body.experiment);
    } catch (error) { if (roomIdentity.current === identity) setGenerationError(error instanceof Error ? error.message : "Could not start this experiment."); }
    finally { if (roomIdentity.current === identity) setRequesting(false); }
  };
  const toggleAuto = () => {
    const next = !autoGenerate;
    setAutoGenerate(next);
    try { localStorage.setItem("task-rooms:auto-generate", String(next)); } catch {}
  };
  const saveTask = () => {
    const blob = new Blob([JSON.stringify({ version: 1, ...room, originalSource: `data/${environment.recording}`,
      experimentId: experiment?.id ?? null, videoReview: experiment?.review ?? null, gymStatus: "not_compiled" }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `task-${roomNumber(room)}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div className={styles.app}>
    <header className={styles.header}>
      <a className={styles.brand} href="/explore" aria-label="Task Rooms home"><span className={styles.brandMark}><Icon name="cube" size={24} /></span><strong>rooms<span>by robofish</span></strong></a>
      <span className={styles.headerDivider} /><span className={styles.projectLabel}>THE TASK EXPLORER <span>EXPERIMENT 01</span></span>
      <div className={styles.headerRight}><span className={styles.localBadge}><i />LOCAL FOOTAGE</span><button className={`${styles.reactorToggle} ${autoGenerate && reactorConfigured ? styles.reactorEnabled : ""}`} onClick={toggleAuto} disabled={!reactorConfigured} aria-pressed={autoGenerate && reactorConfigured} title="Generate a Reactor experiment when entering a new task room"><Icon name="spark" size={15} /><span>Reactor on entry</span><i /></button><button className={styles.helpButton} onClick={() => setShowHelp(value => !value)} aria-label="Show walking controls">?</button></div>
    </header>
    <nav className={styles.breadcrumbs} aria-label="Room trail">
      <button className={styles.directoryToggle} onClick={() => setShowDirectory(value => !value)} aria-label="Show connected rooms"><Icon name="layers" /></button>
      <button className={styles.backButton} disabled={!room.parentPath} onClick={() => room.parentPath && navigate(taskRoom(room.environment, room.parentPath))} aria-label="Return to parent room"><Icon name="back" size={16} /></button>
      <div className={styles.trail}><button onClick={() => navigate(taskRoom(room.environment))}>{environment.name} <span>{environment.code}</span></button>{trail.slice(-3).map((entry, index) => <span className={styles.trailItem} key={entry.path}><Icon name="chevron" size={11} />{entry.path === room.path ? <span>{entry.title}</span> : <button onClick={() => navigate(entry)}>{index === 0 && trail.length > 3 ? "… " : ""}{entry.title}</button>}</span>)}</div>
      <div className={styles.viewActions}><button className={showMap ? styles.activeButton : ""} onClick={() => setShowMap(value => !value)} aria-pressed={showMap}><Icon name="map" size={16} /><span>Map</span></button><button className={showDetails ? styles.activeButton : ""} onClick={() => setShowDetails(value => !value)} aria-pressed={showDetails}><Icon name="sliders" size={16} /><span>Task details</span></button></div>
    </nav>

    <div className={styles.workspace}>
      <aside className={`${styles.directory} ${showDirectory ? styles.directoryOpen : ""}`} aria-label="Ten connected task rooms">
        <div className={styles.directoryHeading}><div><span className={styles.eyebrow}>KEEP EXPLORING</span><h2>10 ways forward<span>↗</span></h2></div><button className={styles.mobileClose} onClick={() => setShowDirectory(false)} aria-label="Close room directory"><Icon name="close" /></button></div>
        <p className={styles.directoryIntro}>One environment.<br />A new task behind every door.</p>
        <div className={styles.doorList}>{doors.map((door, index) => <button key={door.path} className={`${styles.doorButton} ${hovered === index ? styles.doorHovered : ""}`} style={{ "--door-color": RELATIONS[door.relation].color } as CSSProperties} onClick={() => enterDoor(index)} onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)} aria-label={`Walk into room ${index + 1}: ${door.title}`}>
          <span className={styles.doorNumber}>{String(index + 1).padStart(2, "0")}</span><span className={styles.doorCopy}><strong>{door.title}</strong><span><i />{RELATIONS[door.relation].label}{visited.includes(`${door.environment}:${door.path}`) && <b> · visited</b>}</span></span><Icon name="arrow" size={15} />
        </button>)}</div>
        <div className={styles.environments}><span className={styles.eyebrow}>YOUR ENVIRONMENTS</span><div>{Object.entries(ENVIRONMENTS).map(([id, item]) => <button key={id} onClick={() => navigate(taskRoom(id as EnvironmentId))} disabled={!media[id as EnvironmentId].available} className={room.environment === id ? styles.environmentActive : ""}><span>{item.name}</span><small>{item.code}</small>{room.environment === id && <i />}</button>)}</div><p>{visited.length} {visited.length === 1 ? "room" : "rooms"} explored <span>·</span> Eidon POV dataset</p></div>
      </aside>

      <main className={styles.stage} aria-label={`Current room: ${room.title}`}>
        <RoomWorld ref={world} room={room} doors={doors} videoUrl={videoUrl} posterUrl={footage.posterUrl} disabled={transitioning || showVideo} onEnter={index => navigate(doors[index])} onHover={setHovered} onPosition={setPosition} onReady={setSupported} />
        {supported === false && <div className={styles.fallback}><img src={footage.posterUrl} alt={`${environment.name} source footage`} /><div>3D is unavailable in this browser. Use the room list or map to enter each task.</div></div>}
        <div className={`${styles.transition} ${transitioning ? styles.transitionActive : ""}`}><Icon name="door" size={36} /><span>ENTERING NEXT ROOM</span></div>
        <div className={styles.currentRoom}><div className={styles.roomKicker}><span><i />{roomNumber(room)}</span><span>DEPTH {String(room.depth).padStart(2, "0")}</span></div><h1>{room.title}</h1><p>{environment.name} environment <span>·</span> {RELATIONS[room.relation].label}</p></div>
        <div className={styles.sceneTools}><button onClick={() => world.current?.reset()} aria-label="Reset camera view" title="Reset view"><Icon name="reset" size={16} /></button><button onClick={() => setShowVideo(true)} aria-label="Open footage player" title="Open footage"><Icon name="expand" size={16} /></button></div>
        {showHelp && <div className={styles.helpCard}><button className={styles.cardClose} onClick={() => setShowHelp(false)} aria-label="Close walking controls"><Icon name="close" size={15} /></button><span className={styles.eyebrow}>FIND YOUR NEXT TASK</span><h3>Walk. Explore. Go deeper.</h3><p>Use <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to walk and drag the scene to look around. Click any doorway, room name, or map marker to walk into it.</p><p>Each room has ten more doors. Use the back arrow or trail above to retrace your steps.</p><p>With Reactor on entry, a new room starts a video experiment from the original footage. Returning to a room reuses its saved result.</p></div>}
        {hovered !== null && !transitioning && <button className={styles.portalHint} onClick={() => enterDoor(hovered)}><span>{String(hovered + 1).padStart(2, "0")}</span><div><small>{RELATIONS[doors[hovered].relation].label}</small><strong>{doors[hovered].title}</strong></div><Icon name="arrow" size={20} /></button>}
        <div className={styles.walkHint}><div><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></div><p>Walk <span>·</span> drag to look<br /><small>Click a doorway to enter</small></p></div>
        <div className={styles.touchControls} aria-label="Walking controls">{[["w", "↑"], ["a", "←"], ["s", "↓"], ["d", "→"]].map(([direction, label]) => <button key={direction} aria-label={`Walk ${direction === "w" ? "forward" : direction === "s" ? "backward" : direction === "a" ? "left" : "right"}`} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); world.current?.move(direction, true); }} onPointerUp={() => world.current?.move(direction, false)} onPointerCancel={() => world.current?.move(direction, false)}>{label}</button>)}</div>
        {showMap && <MiniMap doors={doors} position={position} onDoor={enterDoor} onClose={() => setShowMap(false)} />}
        <div className={styles.footageBar}>
          <button className={styles.playButton} onClick={() => setPlaying(world.current?.toggleVideo() ?? false)} aria-label={playing ? "Pause footage" : "Play footage"}><Icon name={playing ? "pause" : "play"} size={15} /></button>
          <div className={styles.footageStatus}><strong>{videoLabel}{mismatch && <span className={styles.mismatchBadge}>TASK MISMATCH</span>}</strong><span aria-live="polite">{requesting ? "Starting Reactor experiment…" : generationError ?? experiment?.error ?? (busy ? experiment?.message : mismatch ? "The generated action did not match this task. Open details to inspect it." : experiment?.review?.verdict === "matched" ? "Task matched in automatic video review." : room.depth > 0 && !experiment ? "Task proposal · the original footage is a reference for this room." : "Recorded in the original environment. Choose a door to start exploring.")}</span></div>
          {busy ? <span className={styles.generating}><i />REACTOR {experiment?.status === "reviewing" ? "REVIEWING" : "GENERATING"}</span> : <button className={styles.experimentButton} onClick={startExperiment} disabled={!reactorConfigured}><Icon name="spark" size={15} /><span>{experiment ? "Run again" : "Generate experiment"}</span></button>}
          <button className={styles.footageOpen} onClick={() => setShowVideo(true)} title="View full video" aria-label="View full video"><Icon name="expand" size={16} /></button>
        </div>
      </main>

      {showDetails && <aside className={styles.details} aria-label="Task details">
        <div className={styles.detailsHeading}><span className={styles.eyebrow}>THE CURRENT TASK</span><button onClick={() => setShowDetails(false)} aria-label="Close task details"><Icon name="close" size={17} /></button></div>
        <span className={styles.taskType} style={{ color: RELATIONS[room.relation].color }}><i />{RELATIONS[room.relation].label}</span><h2>{room.title}</h2><p className={styles.taskGoal}>{room.goal}</p>
        <div className={styles.taskStats}><div><span>ENVIRONMENT</span><strong>{environment.name}</strong></div><div><span>EXPLORATION DEPTH</span><strong>{room.depth}</strong></div><div><span>DIFFICULTY</span><strong>{room.difficulty}</strong></div><div><span>NEXT ROOMS</span><strong>10</strong></div></div>
        <div className={styles.detailsSection}><span className={styles.eyebrow}>VIDEO EXPERIMENT</span><p>{experiment?.review?.observedActions ?? (previousAttempt ? "An earlier Reactor attempt repeated the original source action. This proposal has not passed task review." : "Reactor receives the original source video and this room’s task instruction. The generated action is reviewed separately.")}</p>{experiment?.review?.reasons.map(reason => <p className={styles.reviewReason} key={reason}>{reason}</p>)}<button className={styles.primaryButton} onClick={startExperiment} disabled={busy || !reactorConfigured}><Icon name="spark" size={16} />{busy ? "Experiment in progress" : experiment ? "Run another experiment" : "Generate this task"}</button><button className={styles.secondaryButton} onClick={() => setShowVideo(true)}><Icon name="play" size={15} />Inspect footage</button>{generationError && <p className={styles.errorText}>{generationError}</p>}</div>
        <div className={styles.gymCard}><Icon name="cube" size={21} /><h3>Drive a robot gripper</h3><p>Move the gripper in a physical room, watch Reactor render your actions, and replay the saved policy’s actual results.</p><button className={styles.primaryButton} style={{ opacity: 1, borderStyle: "solid" }} onClick={() => window.location.assign("/rooms/playground")}>Open robot gym</button><button className={styles.saveSpec} onClick={saveTask}><Icon name="download" size={14} />Save task specification</button></div>
        <div className={styles.provenance}><span>ORIGINAL SOURCE</span><p>data/{environment.recording}</p><p>Eidon AI / Solidic Labs Inc<br />Egocentric POV · CC-BY-4.0</p><p>All descendants use this original environment.</p></div>
      </aside>}
    </div>
    <footer className={styles.footer}><span><Icon name="layers" size={13} />One task per room. Ten paths forward.</span><a href="/worlds">Play robot worlds <Icon name="door" size={12} /></a><a href="/rooms/simulation">Physical simulation <Icon name="cube" size={12} /></a><a href="/helios">Reactor studio <Icon name="arrow" size={12} /></a></footer>
    <dialog ref={dialog} className={styles.videoDialog} onClose={() => setShowVideo(false)} onClick={event => { if (event.target === event.currentTarget) setShowVideo(false); }}>
      <div role="dialog" aria-label={`Footage for ${room.title}`}><header><div><span className={styles.eyebrow}>{videoLabel.toUpperCase()}</span><h2>{room.title}</h2></div><button onClick={() => setShowVideo(false)} aria-label="Close footage player"><Icon name="close" size={22} /></button></header>{showVideo && <video key={videoUrl} src={videoUrl} controls autoPlay muted playsInline loop />}<footer><p>{mismatch ? "The requested task did not pass video review." : experiment?.review?.observedActions ?? "Reference footage from the original environment."}</p><a href={videoUrl} download={`${roomNumber(room)}.mp4`}><Icon name="download" size={15} />Download footage</a></footer></div>
    </dialog>
  </div>;
}
