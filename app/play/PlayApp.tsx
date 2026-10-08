"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReactorPreview } from "./ReactorPreview";
import { worldRequest, type Demo, type Family, type PlayerState, type TaskProgress, type Tool, type WorldCatalog, type WorldCommand, type WorldSession } from "./types";
import type { WorldHandle } from "./WorldView";
import styles from "./play.module.css";

const WorldView = dynamic(() => import("./WorldView").then(m => m.WorldView), { ssr: false });

function RoomIcon({ family }: { family: Family }) {
  return <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
    {family === "dishes" ? <><ellipse cx="16" cy="19" rx="10" ry="5" /><path d="M6 19v3c0 6 20 6 20 0v-3M12 10V5h5v7M8 13h17" /></> : family === "laundry" ? <><path d="m11 6-7 5 4 6 3-2v12h11V15l3 2 4-6-7-5c-2 4-8 4-11 0Z" /><path d="M16 11v13" strokeDasharray="2 3" /></> : <><path d="M7 5h18v24H7zM12 3h8v5h-8zM12 23l1-5L24 7l4 4-11 11-5 1Z" /><path d="m13 18 4 4" /></>}
  </svg>;
}

export function PlayApp({ reactorConfigured }: { reactorConfigured: boolean }) {
  const [catalog, setCatalog] = useState<WorldCatalog | null>(null);
  const [session, setSession] = useState<WorldSession | null>(null);
  const [state, setState] = useState<TaskProgress | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [connected, setConnected] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [reload, setReload] = useState(0);
  const [intro, setIntro] = useState(true);
  const [demo, setDemo] = useState<Family | null>(null);
  const stateRef = useRef<TaskProgress | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const worldRef = useRef<WorldHandle>(null);
  const lastRoom = useRef<Family>("dishes");
  if (player?.room) lastRoom.current = player.room;
  const family = state?.station ?? player?.room ?? lastRoom.current;
  const room = catalog?.spec.rooms.find(r => r.id === family);
  const task = room?.tasks.find(t => t.id === state?.active[family]);

  useEffect(() => {
    let disposed = false;
    let id: string | undefined;
    let ws: WebSocket | undefined;
    const abort = new AbortController();
    setConnected(false); setError(""); setSession(null); setState(null);
    void (async () => {
      try {
        const details = await worldRequest<WorldCatalog>("", { signal: abort.signal });
        if (disposed) return;
        setCatalog(details);
        // Keep creation un-aborted: a late response still needs its allocated session released.
        const value = await worldRequest<WorldSession>("/sessions", { method: "POST" });
        id = value.id;
        if (disposed) { await worldRequest(`/sessions/${id}`, { method: "DELETE" }); return; }
        stateRef.current = value.state; setState(value.state); setSession(value);
        const base = process.env.NEXT_PUBLIC_ROOM_SIM_WS_URL ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8000`;
        ws = new WebSocket(`${base}/task-world/sessions/${id}`); socketRef.current = ws;
        let lastUI = 0;
        ws.onopen = () => { if (!disposed) setConnected(true); };
        ws.onmessage = event => {
          if (disposed) return;
          const message = JSON.parse(event.data);
          if (message.type === "state") {
            stateRef.current = message;
            if (performance.now() - lastUI > 80) { setState(message); lastUI = performance.now(); }
          } else if (message.type === "closed") { setError(message.error); setConnected(false); }
          else if (message.error) setHint(message.error);
        };
        ws.onerror = () => { if (!disposed) setError("The physics connection was interrupted. Reconnect to enter a new world."); };
        ws.onclose = () => { if (!disposed) { setConnected(false); setError("Your physics session is disconnected. Reconnect to continue."); } };
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { disposed = true; abort.abort(); socketRef.current = null; ws?.close(); if (id) void worldRequest(`/sessions/${id}`, { method: "DELETE" }).catch(() => {}); };
  }, [reload]);

  const command = useCallback((value: WorldCommand) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(value));
  }, []);
  const leave = useCallback(() => worldRef.current?.leave(), []);
  useEffect(() => { if (!hint) return; const timer = setTimeout(() => setHint(""), 4500); return () => clearTimeout(timer); }, [hint]);
  const completed = state?.completed.length ?? 0;
  const activeTaskComplete = !!state?.completed.includes(`${family}:${task?.id}`);
  const inStation = !!state?.station;
  const demoFamily = intro ? "dishes" : demo;
  function watchDemo() { leave(); setDemo(family); }

  return <div className={styles.app}>
    <header className={styles.header}><Link href="/play" className={styles.wordmark}><span className={styles.brandMark}>f</span>fieldwork<span className={styles.brandDot}>®</span></Link><span className={styles.headerNote}>A WORLD OF SMALL ACTIONS</span><nav><Link href="/explore">Experiments ↗</Link><Link href="/rooms/simulation">Robot gym ↗</Link></nav></header>
    <main className={styles.main}>
      <div className={styles.intro}><div><p className={styles.eyebrow}>OBSERVE SOMETHING. TRY SOMETHING.</p><h1>Every room, <em>a possibility.</em></h1><p>Step inside. Learn a small skill. See your world take shape.</p></div><div className={styles.total}><strong>{String(completed).padStart(2, "0")}<span> / 09</span></strong><small>TASKS EXPLORED</small></div></div>
      <nav className={styles.roomNav} aria-label="Walk to a task room">{catalog?.spec.rooms.map((item, i) => {
        const count = state?.completed.filter(id => id.startsWith(`${item.id}:`)).length ?? 0;
        return <button key={item.id} className={`${styles.roomCard} ${player?.room === item.id ? styles.currentRoom : ""}`} disabled={!connected || intro} onClick={() => worldRef.current?.walkTo(item.id)} aria-label={`Walk to ${item.title}`} aria-current={player?.room === item.id ? "location" : undefined} style={{ "--room-color": item.color } as React.CSSProperties}><RoomIcon family={item.id} /><span><strong>{item.title}</strong><small>{item.id === "dishes" ? "Wash, rinse, repeat." : item.id === "laundry" ? "A little order, one fold at a time." : "Follow a line. Make your mark."}</small></span><span className={styles.roomCount}>{count}/3 <b>↗</b></span><span className={styles.roomNumber}>0{i + 1}</span></button>;
      })}</nav>
      {error && <div className={styles.errorBanner} role="alert"><span>{error}</span><button onClick={() => setReload(r => r + 1)}>Reconnect</button></div>}
      <div className={styles.workspace}>
        <section className={styles.worldPanel}>
          <div className={styles.panelHeading}><span><i className={connected ? styles.statusDot : styles.offlineDot} /> YOUR WORLD / {inStation ? "AT THE STATION" : "FIRST PERSON"}</span><span className={styles.pill}>{player?.room ? room?.title : session ? "Corridor" : "Opening world"}</span></div>
          <div className={styles.viewport}>
            {session && catalog ? <WorldView ref={worldRef} session={session} catalog={catalog} stateRef={stateRef} disabled={!connected || intro || !!demo} onCommand={command} onCanvas={setCanvas} onPlayer={setPlayer} onHint={setHint} /> : <div className={styles.empty}><span className={styles.loadingMark}>f</span><h3>{error ? "Your world is waiting." : "Preparing a little world…"}</h3><p>{error ? "Run pnpm rooms:dev, then reconnect." : "Setting the tables. Opening the doors."}</p></div>}
            {session && <>
              <div className={styles.sceneBadge}>{inStation ? "PRACTICE MODE" : "WALK & EXPLORE"}<span>{player?.room ? room?.title : "Connecting corridor"}</span></div>
              {!inStation && <div className={styles.crosshair}>+</div>}
              <div className={styles.map}><span>YOU ARE HERE</span><svg viewBox="0 0 220 110" aria-label="Map of the three connected task rooms"><path d="M5 8h210v88H5Z" fill="#dde5d6" /><path d="M5 69h210" stroke="#9aa991" />{catalog?.spec.rooms.map((item, i) => <g key={item.id}><rect x={8+i*69} y="11" width="66" height="54" fill={item.color} /><text x={41+i*69} y="28" textAnchor="middle" fontSize="10" fill="#384934">0{i+1}</text><path d={`M${30+i*69} 69h22`} stroke="#fff9e7" strokeWidth="4" /></g>)}{player && <g transform={`translate(${(player.position[0] + 10) * 10.5 + 5},${69 - player.position[1] * 9.5}) rotate(${-player.yaw*180/Math.PI})`} data-testid="player-marker"><circle r="4.5" fill="#2e4734" stroke="#fff9e7" strokeWidth="2" /><path d="m-3-7 3-4 3 4" fill="none" stroke="#2e4734" strokeWidth="1.5" /></g>}</svg></div>
              {hint && <div className={styles.toast} role="status">{hint}</div>}
              <div className={styles.stationPrompt}><button disabled={!connected || intro || (!inStation && !player?.near)} onClick={() => worldRef.current?.interact()}><kbd>{inStation ? "ESC" : "E"}</kbd>{inStation ? "Return to walking" : player?.near ? `Use ${room?.title.toLowerCase()} station` : "Walk closer to a station"}<span>↗</span></button></div>
            </>}
          </div>
          <div className={styles.toolbar}><span>{inStation ? <><b>Drag</b> to use your tool · <b>Esc</b> to leave</> : <><b>W A S D</b> move · <b>Drag</b> look · <b>E</b> interact</>}</span><button disabled={!session || intro} onClick={watchDemo}>▷ Watch demonstration</button></div>
          <div className={styles.taskPanel}>
            <div className={styles.taskTitle}><div><span className={styles.eyebrow}>TRY SOMETHING / {room?.title ?? "DISHES"}</span><h2>{task?.title ?? "A small place to begin."}<span className={styles.taskDone}>{activeTaskComplete ? "✓" : ""}</span></h2></div><span className={styles.taskPercent}>{Math.round((state?.progress[family] ?? 0)*100)}<small>%</small></span></div>
            <p className={styles.taskInstruction}>{inStation ? task?.instruction : "Walk up to the work surface and press E to begin. You can come back to any room."}</p>
            <progress className={styles.progress} max={1} value={state?.progress[family] ?? 0} aria-label="Current task progress" />
            <div className={styles.taskOptions}>{room?.tasks.map((item, i) => <button key={item.id} disabled={!inStation || !connected} aria-pressed={task?.id === item.id} onClick={() => command({ type: "select_task", family, task: item.id })}><span>{state?.completed.includes(`${family}:${item.id}`) ? "✓" : `0${i+1}`}</span>{item.title}</button>)}</div>
            <div className={styles.tools}><div><span className={styles.eyebrow}>IN YOUR HAND</span>{(family === "dishes" ? ["sponge", "hand"] : family === "drawing" ? ["pencil"] : ["hand"]).map(tool => <button key={tool} aria-pressed={state?.tools[family] === tool} disabled={!inStation || !connected} onClick={() => command({ type: "tool", tool: tool as Tool })}>{tool === "hand" ? "✋" : tool === "sponge" ? "▧" : "✎"} {tool}</button>)}</div><button className={styles.reset} disabled={!inStation || !connected} onClick={() => command({ type: "reset_task", family })}>↺ Reset task</button></div>
            {inStation && family === "dishes" && task?.id === "wash-stack" && <div className={styles.steps}><span className={state && state.details.scrub >= 1 ? styles.stepDone : ""}>01 Scrub</span><i>→</i><span className={state && state.details.rinse >= 1 ? styles.stepDone : ""}>02 Rinse</span><i>→</i><span>03 Stack</span></div>}
            {inStation && family === "laundry" && <p className={styles.microHint}>{(state?.details.folds ?? 0) < (state?.details.fold_goal ?? 1) ? (state?.details.folds === 0 ? "Drag the left edge → across the garment." : "Now drag the right edge ← inward.") : task?.id === "fold-stack" ? "Fold complete. Drag the garment to the marked stack and release." : "Fold complete. Try the next task or explore another room."}</p>}
          </div>
        </section>
        <aside className={styles.side}><ReactorPreview canvas={canvas} configured={reactorConfigured} room={player?.room ? room?.title ?? "Dishes" : "the connecting corridor"} appearance={player?.room ? room?.appearance ?? "" : "A calm sage and cream corridor with three open doorways leading to a kitchen, laundry station, and drawing desk."} task={inStation ? task?.title ?? "exploring" : "walking between task rooms"} />
          <section className={styles.sourceCard}><div><span className={styles.eyebrow}>IT STARTED WITH A REAL MOMENT</span><span className={styles.sourceTag}>SOURCE / {catalog?.media[family].recording ?? "03"}</span></div>{catalog && <button className={styles.sourceImage} onClick={watchDemo} disabled={intro}><img src={catalog.media[family].posterUrl} alt={`${room?.title} demonstration from the original dataset`} /><span>▷</span></button>}<h3>Watch it. Then make it yours.</h3><p>Real first-person footage shaped these task stations. Every room gives you a new way to practice.</p><a href="https://huggingface.co/buckets/eidon-ai/egocentric-pov" target="_blank" rel="noreferrer">Eidon AI · Egocentric POV · CC-BY-4.0 ↗</a></section>
        </aside>
      </div>
      <footer className={styles.footer}><span>Built from observation. Open to possibility.</span><span>Three.js <i>×</i> MuJoCo <i>×</i> Reactor</span></footer>
    </main>
    {demoFamily && catalog && <DemoPlayer key={demoFamily} family={demoFamily} demo={catalog.media[demoFamily]} intro={intro} onClose={() => { setIntro(false); setDemo(null); }} />}
  </div>;
}

function DemoPlayer({ family, demo, intro, onClose }: { family: Family; demo: Demo; intro: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  async function start() {
    if (!video.current) return;
    video.current.currentTime = demo.start;
    try { await video.current.play(); setPlaying(true); setEnded(false); } catch { setFailed(true); }
  }
  return <dialog ref={dialog} className={styles.demoDialog} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={intro ? "Welcome demonstration" : `${family} demonstration`}>
    <div className={styles.demoHeading}><span className={styles.eyebrow}>{intro ? "YOUR FIRST SMALL EXPERIMENT" : "BACK TO THE SOURCE"}</span><button onClick={onClose} aria-label="Close demonstration">×</button></div>
    <h2>{intro ? <>A little observation.<br /><em>A world to explore.</em></> : <>See how it begins.</>}</h2>
    <div className={styles.demoVideo}>
      <video ref={video} src={demo.sourceUrl} poster={demo.posterUrl} muted playsInline preload="metadata" onError={() => setFailed(true)} onEnded={() => { setEnded(true); setPlaying(false); }} onTimeUpdate={() => {
        if (video.current && video.current.currentTime >= demo.start + demo.seconds) { video.current.pause(); setEnded(true); setPlaying(false); }
      }} />
      {!playing && <button className={styles.demoPlay} onClick={() => void start()} disabled={failed}>{failed ? "Footage unavailable" : ended ? "↺ Replay" : "▷ Watch 10-second demo"}</button>}
    </div>
    <p>{failed ? "The source video could not load. Run pnpm world:prepare to prepare the local demonstrations. You can still enter the world." : intro ? "Start with a real dishwashing moment, then step into three rooms of related tasks." : "This recording inspired the station’s objects, materials, and actions."}</p>
    <div className={styles.demoActions}><span>WASD to walk · Drag to look · E to interact</span><button className={styles.darkButton} onClick={onClose}>{intro ? ended ? "Enter the world" : "Skip & enter the world" : "Return to the world"}<span>→</span></button></div>
    <small>Eidon AI / Solidic Labs Inc · Egocentric POV · CC-BY-4.0</small>
  </dialog>;
}
