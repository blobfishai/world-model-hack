"use client";

import type { CSSProperties } from "react";
import { doorDistance, projectBearing, relativeBearing, DOOR_RING, ROOM_RADIUS, type Door, type Pose } from "./lib/navigation";
import { RELATION_META, jobActive, jobLabel } from "./lib/rooms";
import type { World, WorldRoom } from "./lib/types";

const MAP_SCALE = 11; // px per meter in the minimap

function doorTitle(world: World, door: Door): string {
  const target = world.rooms[door.path];
  if (door.kind === "back") return door.label;
  return target ? target.title : door.label;
}

function doorColor(world: World, door: Door): string {
  if (door.kind === "back") return "#d7dccb";
  const target = world.rooms[door.path];
  return target ? RELATION_META[target.relation].color : "#c7deaa";
}

function Portal({ world, door, pose, onEnter }: { world: World; door: Door; pose: Pose; onEnter: (door: Door) => void }) {
  const x = projectBearing(relativeBearing(pose, door));
  if (x === null) return null;
  const target = world.rooms[door.path];
  const distance = doorDistance(pose, door);
  const scale = Math.max(0.72, Math.min(1.3, 2.6 / Math.max(distance, 0.8)));
  const scan = target?.jobs.scan;
  const state = door.kind === "back" ? "Return" : target?.media.arrival ? "Reactor room ready" : jobLabel(scan);
  return <button className={`rw-portal${door.kind === "back" ? " rw-portal-back" : ""}`}
    style={{ left: `${x * 100}%`, "--rw-scale": scale, "--rw-door": doorColor(world, door) } as CSSProperties}
    aria-label={door.kind === "back" ? door.label : `Enter ${door.label}`} data-door={door.path}
    onPointerDown={event => event.stopPropagation()} onClick={() => onEnter(door)}>
    <span className="rw-portal-frame">
      {target?.media.arrival ? <img src={target.media.arrival} alt="" draggable={false} /> : <i className={jobActive(scan) ? "rw-spinner" : "rw-portal-empty"} />}
    </span>
    <span className="rw-portal-copy">
      <small>{door.kind === "back" ? "Back" : target ? RELATION_META[target.relation].label : "Room"}</small>
      <strong>{door.kind === "back" ? door.label : target?.door_label || doorTitle(world, door)}</strong>
      <em>{distance.toFixed(1)} m · {state}</em>
    </span>
  </button>;
}

function Compass({ world, pose, doors }: { world: World; pose: Pose; doors: Door[] }) {
  const ticks = [-90, -60, -30, 0, 30, 60, 90];
  return <div className="rw-compass" aria-label={`Heading ${Math.round(pose.yaw)} degrees`}>
    {ticks.map(tick => <span key={tick} className="rw-compass-tick" style={{ left: `${50 + tick / 1.8}%` }} />)}
    {doors.map(door => {
      const relative = relativeBearing(pose, door);
      if (Math.abs(relative) > 90) return null;
      return <i key={door.path} className="rw-compass-door" title={doorTitle(world, door)}
        style={{ left: `${50 + relative / 1.8}%`, background: doorColor(world, door) }} />;
    })}
    <b className="rw-compass-caret" />
  </div>;
}

function MiniMap({ world, pose, doors, onEnter }: { world: World; pose: Pose; doors: Door[]; onEnter: (door: Door) => void }) {
  const size = ROOM_RADIUS * MAP_SCALE + 8;
  return <div className="rw-minimap">
    <div className="rw-minimap-heading"><span className="rw-eyebrow">ROOM MAP</span><b>{Math.round(pose.yaw)}°</b></div>
    <svg viewBox={`${-size} ${-size} ${size * 2} ${size * 2}`} aria-label="Map of doorways in this room">
      <circle r={ROOM_RADIUS * MAP_SCALE} fill="#202a1f" stroke="#4b5a43" />
      <circle r={DOOR_RING * MAP_SCALE} fill="none" stroke="#3a4735" strokeDasharray="2 3" />
      {doors.map(door => <g key={door.path} role="button" tabIndex={0} className="rw-map-door"
        aria-label={`Map: ${doorTitle(world, door)}`} onClick={() => onEnter(door)}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onEnter(door); } }}>
        <title>{doorTitle(world, door)}</title>
        <circle cx={door.x * MAP_SCALE} cy={-door.z * MAP_SCALE} r={5} fill={doorColor(world, door)} />
      </g>)}
      <g transform={`translate(${pose.x * MAP_SCALE},${-pose.z * MAP_SCALE}) rotate(${pose.yaw})`} className="rw-map-player">
        <circle r="10" fill="#c0d9a5" opacity=".1" /><path d="m0-7 4 10-4-2-4 2Z" fill="#e2f0c9" />
      </g>
    </svg>
  </div>;
}

export function WorldHud({ world, room, pose, doors, nearDoor, notice, onEnterDoor }: {
  world: World; room: WorldRoom; pose: Pose; doors: Door[]; nearDoor: Door | null; notice: string | null;
  onEnterDoor: (door: Door) => void;
}) {
  const meta = RELATION_META[room.relation];
  return <>
    <div className="rw-portals">
      {doors.map(door => <Portal key={door.path} world={world} door={door} pose={pose} onEnter={onEnterDoor} />)}
    </div>
    <Compass world={world} pose={pose} doors={doors} />
    <div className="rw-task-card">
      <span className="rw-kicker"><i style={{ background: meta.color }} />{meta.label}{room.depth > 0 && <> · depth {room.depth}</>}</span>
      <h1>{room.title}</h1>
      <p>{room.task.goal}</p>
    </div>
    <MiniMap world={world} pose={pose} doors={doors} onEnter={onEnterDoor} />
    {nearDoor && <div className="rw-enter-hint" role="status">
      Press <kbd>E</kbd> to enter <strong>{doorTitle(world, nearDoor)}</strong>
    </div>}
    {notice && <div className="rw-notice" role="status"><i className="rw-spinner" />{notice}</div>}
    <div className="rw-controls-hint" aria-hidden="true">
      <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk</span>
      <span><kbd>←</kbd><kbd>→</kbd> or drag to look</span>
      <span><kbd>R</kbd><kbd>F</kbd> up / down</span>
      <span><kbd>⇧</kbd> turn faster</span>
      <span><kbd>E</kbd> enter</span>
    </div>
  </>;
}
