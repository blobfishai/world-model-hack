import type { Metadata } from "next";
import Lab from "./Lab";

export const metadata: Metadata = { title: "Task Lab — Rooms", description: "Footage-derived MuJoCo Playground tasks with Reactor video rendering." };
export default function LabPage() { return <Lab />; }
