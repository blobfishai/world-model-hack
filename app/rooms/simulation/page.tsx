import type { Metadata } from "next";
import { RoomsApp } from "../RoomsApp";
import "../rooms.css";

export const metadata: Metadata = {
  title: "Room simulations — Robofish",
  description: "Turn room footage into editable physical scenes and a live Reactor view.",
};

export default function SimulationPage() {
  return <RoomsApp />;
}
