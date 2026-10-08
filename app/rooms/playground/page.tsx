import type { Metadata } from "next";
import { RobotPlayground } from "./RobotPlayground";
import "../rooms.css";
import "./playground.css";

export const metadata: Metadata = { title: "Robot playground — Robofish", description: "Drive a physical robot gripper, try room tasks, and replay real training results." };

export default function PlaygroundPage() {
  return <RobotPlayground />;
}
