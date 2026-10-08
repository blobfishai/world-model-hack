import { roomBadges } from "./lib/rooms";
import type { WorldRoom } from "./lib/types";

export function GymBadges({ room, empty }: { room: WorldRoom; empty?: string }) {
  const badges = roomBadges(room);
  if (!badges.length) return empty ? <p className="rw-badges-empty">{empty}</p> : null;
  return <ul className="rw-badges" aria-label={`Verification for ${room.title}`}>
    {badges.map(badge => <li key={badge.id} className={`rw-badge rw-badge-${badge.id}`}>
      <i aria-hidden="true">✓</i>{badge.label}{badge.detail && <small>{badge.detail}</small>}
    </li>)}
  </ul>;
}
