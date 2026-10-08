"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { WorldRoom } from "../lib/robot-worlds";
import type { RobotState, WorldSession } from "./types";

type MeshAsset = { vertices: number[]; indices: number[] };
let robotMeshes: Promise<Record<string, MeshAsset>> | null = null;
function loadRobotMeshes() {
  if (!robotMeshes) robotMeshes = fetch("/api/robot-worlds/panda-meshes").then(async response => {
    if (!response.ok) throw new Error("The Panda meshes could not be loaded");
    return response.json();
  }).catch(error => { robotMeshes = null; throw error; });
  return robotMeshes;
}

export default function RobotWorld(props: {
  session: WorldSession; stateRef: MutableRefObject<RobotState | null>; room: WorldRoom;
  children: WorldRoom[]; videoUrl: string | null; onDoor: (path: string) => void;
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const { room, session } = props;
    const theme = room.theme;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" }); }
    catch { setError("Enable WebGL to walk through this room. Robot controls and room navigation remain available."); return; }
    renderer.setPixelRatio(1); renderer.setSize(1280, 704, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "Playable robot world. W A S D walks, drag looks, arrow keys move the robot.");
    parent.appendChild(renderer.domElement); current.current.onCanvas(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(theme.wall);
    scene.fog = new THREE.Fog(theme.wall, 12, 35);
    const camera = new THREE.PerspectiveCamera(58, 1280 / 704, .025, 60); camera.up.set(0, 0, 1);
    camera.position.set(1.3, -2.6, 1.65);
    let yaw = -.46, pitch = -.22;
    const meshes: THREE.Mesh[] = [], textures: THREE.Texture[] = [], geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    let disposed = false;
    const add = (geometry: THREE.BufferGeometry, color: string, position: number[], roughness = .72, metalness = 0) => {
      const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      const mesh = new THREE.Mesh(geometry, material); mesh.position.fromArray(position);
      mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh);
      geometries.add(geometry); materials.add(material); meshes.push(mesh); return mesh;
    };
    const box = (size: number[], color: string, position: number[], roughness = .72, metalness = 0) => add(new THREE.BoxGeometry(...size as [number, number, number]), color, position, roughness, metalness);
    const cylinder = (radius: number, height: number, color: string, position: number[]) => {
      const geometry = new THREE.CylinderGeometry(radius, radius, height, 24); geometry.rotateX(Math.PI / 2); return add(geometry, color, position);
    };
    const ring = (radius: number, thickness: number, color: string, position: number[], angle = Math.PI * 2) => add(new THREE.TorusGeometry(radius, thickness, 8, 48, angle), color, position, .35, .4);
    const label = (text: string, sub: string, color: string, width = 512, height = 160) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#15221a"; context.fillRect(0, 0, width, height);
      context.fillStyle = color; context.font = "18px Arial"; context.fillText(sub, 25, 42, width - 50);
      context.fillStyle = "#edf1e4"; context.font = "29px Arial"; context.fillText(text, 25, 98, width - 50);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; textures.push(texture); return texture;
    };
    const textureLoader = new THREE.TextureLoader();
    const image = textureLoader.load(room.image, texture => { if (disposed) texture.dispose(); }); image.colorSpace = THREE.SRGBColorSpace; textures.push(image);
    const video = document.createElement("video"); video.muted = true; video.loop = true; video.playsInline = true; video.preload = "auto";
    let videoTexture: THREE.VideoTexture | null = null;
    if (props.videoUrl) { video.src = props.videoUrl; videoTexture = new THREE.VideoTexture(video); videoTexture.colorSpace = THREE.SRGBColorSpace; textures.push(videoTexture); }
    const muralMaterial = new THREE.MeshBasicMaterial({ map: image, toneMapped: false }); materials.add(muralMaterial);
    const muralGeometry = new THREE.PlaneGeometry(11.2, 6.3); geometries.add(muralGeometry);
    const mural = new THREE.Mesh(muralGeometry, muralMaterial); mural.position.set(0, 4.15, 2.7); mural.rotation.x = Math.PI / 2; scene.add(mural);
    const showVideo = () => { if (videoTexture) { muralMaterial.map = videoTexture; muralMaterial.needsUpdate = true; } };
    video.addEventListener("loadeddata", showVideo); if (props.videoUrl) void video.play().catch(() => {});
    const floor = box([8.5, 8.5, .10], theme.floor, [0, 0, -.06], .8);
    const floorCanvas = document.createElement("canvas"); floorCanvas.width = floorCanvas.height = 512;
    const floorContext = floorCanvas.getContext("2d")!;
    floorContext.fillStyle = theme.floor; floorContext.fillRect(0, 0, 512, 512);
    floorContext.strokeStyle = "#00000025"; floorContext.lineWidth = 2;
    floorContext.strokeRect(0, 0, 512, 512);
    if (theme.architecture === "laundry") { floorContext.fillStyle = "#cfd7dc"; floorContext.fillRect(0, 0, 256, 256); floorContext.fillRect(256, 256, 256, 256); }
    if (theme.architecture === "kitchen" || theme.architecture === "workshop") for (let i = 0; i < 8; i++) { floorContext.fillStyle = "#00000012"; floorContext.fillRect(0, i * 64, 512, 2); }
    const floorTexture = new THREE.CanvasTexture(floorCanvas); floorTexture.colorSpace = THREE.SRGBColorSpace; floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping; floorTexture.repeat.set(8, 8); textures.push(floorTexture);
    (floor.material as THREE.MeshStandardMaterial).map = floorTexture;
    for (const side of [-1, 1]) box([.16, 8.4, 3.2], theme.wall, [side * 3.9, 0, 1.6]);
    box([8, .12, 3.2], theme.wall, [0, -4.0, 1.6]);
    scene.add(new THREE.HemisphereLight("#fff5df", theme.floor, theme.architecture === "underwater" ? 1.5 : 2.4));
    const sun = new THREE.DirectionalLight(theme.accent, 3.0); sun.position.set(2, -3, 7); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: .1, far: 15 }); sun.shadow.normalBias = .012; scene.add(sun);
    const fill = new THREE.PointLight(theme.accent, 14, 12); fill.position.set(-2, 2, 2.6); scene.add(fill);

    // Each setting has its own real geometry in front of the generated image/video.
    if (theme.architecture === "greenhouse") {
      for (const y of [-3, 0, 3]) { const arch = ring(3.7, .04, "#b7c3ac", [0, y, 0], Math.PI); arch.rotation.x = Math.PI / 2; }
      for (const x of [-2.7, 2.7]) for (const y of [-2.6, 1.8, 3]) {
        cylinder(.23, .38, "#b67851", [x, y, .2]);
        for (let i = 0; i < 5; i++) { const leaf = add(new THREE.SphereGeometry(.27, 12, 8), i % 2 ? "#456c32" : "#6d8c45", [x + Math.sin(i * 2) * .16, y + Math.cos(i * 2) * .16, .65 + (i % 2) * .28]); leaf.scale.set(.5, .4, 1.5); }
      }
    } else if (theme.architecture === "kitchen") {
      for (const x of [-2.6, 2.6]) { box([.75, 1.9, .9], "#95744b", [x, 2.6, .45]); box([.84, 2, .07], "#ded4bf", [x, 2.6, .94]); for (const y of [2, 2.6, 3.2]) box([.04, .25, .025], "#2e3930", [x + (x > 0 ? -.4 : .4), y, .65]); }
      for (const x of [-1.3, 1.3]) { cylinder(.02, 1.4, "#665847", [x, 1.5, 3]); const lamp = cylinder(.3, .22, "#e7d5a7", [x, 1.5, 2.35]); (lamp.material as THREE.MeshStandardMaterial).emissive.set("#6e4820"); }
    } else if (theme.architecture === "warehouse") {
      for (const x of [-2.8, 2.8]) for (const y of [1.7, 3]) {
        for (const dx of [-.4, .4]) box([.07, .08, 3.2], "#cf7c33", [x + dx, y, 1.6]);
        for (let z = .1; z < 3; z += .8) { box([1, .7, .06], "#516579", [x, y, z]); for (let j = 0; j < 3; j++) box([.23, .4, .35], j % 2 ? "#9c7857" : "#b18c61", [x + (j - 1) * .28, y, z + .2]); }
      }
      for (const x of [-1.1, 1.1]) box([.035, 7, .005], "#d3a23d", [x, 0, .004]);
    } else if (theme.architecture === "orbital") {
      for (const y of [-3.4, -1, 1.4, 3.8]) { const arch = ring(3.65, .1, "#c1d1d7", [0, y, 0], Math.PI); arch.rotation.x = Math.PI / 2; }
      for (const x of [-2.65, 2.65]) { box([.6, 1.2, .9], "#8b9da3", [x, 2.6, .45], .3, .6); const light = box([.61, .04, .035], "#a3f5ff", [x, 1.98, .8]); (light.material as THREE.MeshStandardMaterial).emissive.set("#63cfdf"); }
    } else if (theme.architecture === "ceramics") {
      for (const x of [-2.7, 2.7]) { box([.6, 1.5, .75], "#ac6c4c", [x, 2.3, .375]); for (let i = 0; i < 5; i++) cylinder(.13 + (i % 2) * .05, .25 + (i % 3) * .1, "#c78d60", [x, 1.8 + i * .25, .9]); }
      cylinder(.65, 1.2, "#785647", [-2.5, -2.5, .6]); const kiln = cylinder(.4, .05, "#ff9b39", [-2.5, -2.5, 1.23]); (kiln.material as THREE.MeshStandardMaterial).emissive.set("#e85e0b");
    } else if (theme.architecture === "cleanroom") {
      for (const x of [-2, 2]) { const lamp = ring(.65, .04, "#effff5", [x, 1, 3.0]); (lamp.material as THREE.MeshStandardMaterial).emissive.set("#c8f5ee"); box([1.1, .6, .8], "#b8d1cc", [x, 2.8, .4], .2, .5); }
      for (const x of [-3, 3]) box([.08, 6, .015], "#c1fff3", [x, 0, .005]);
    } else if (theme.architecture === "laundry") {
      for (const x of [-2.6, 2.6]) for (const y of [1.5, 2.6]) {
        box([.75, .85, 1], "#d0d8df", [x, y, .5], .3, .4);
        const drum = ring(.25, .045, "#536b83", [x + (x > 0 ? -.39 : .39), y, .54]); drum.rotation.y = Math.PI / 2;
        const glass = add(new THREE.CircleGeometry(.21, 32), "#233846", [x + (x > 0 ? -.4 : .4), y, .54]); glass.rotation.y = x > 0 ? -Math.PI / 2 : Math.PI / 2;
      }
    } else if (theme.architecture === "underwater") {
      for (const x of [-3.7, 3.7]) for (const y of [-2.2, 2.2]) { const port = ring(.7, .08, "#b19a61", [x, y, 1.8]); port.rotation.y = Math.PI / 2; }
      for (const x of [-2.8, 2.8]) for (const y of [2.5, 3.0]) cylinder(.17, 1.1, "#9a9d87", [x, y, .55]);
      for (const x of [-3.2, 3.2]) { const bar = box([.04, 7, .04], "#53c6c0", [x, 0, .15]); (bar.material as THREE.MeshStandardMaterial).emissive.set("#238f90"); }
    } else if (theme.architecture === "observatory") {
      for (let i = 0; i < 6; i++) { const arch = ring(3.6, .035, "#776686", [0, 0, 0], Math.PI); arch.rotation.x = Math.PI / 2; arch.rotation.z = i * Math.PI / 6; }
      const telescope = cylinder(.2, 1.5, "#b1a079", [-2.4, 2.4, 1.7]); telescope.rotation.x = -.65;
      cylinder(.07, 1.2, "#58505d", [-2.4, 2.4, .6]);
      for (const x of [-2.6, 2.6]) box([.6, 1.7, .8], "#79505a", [x, -2.5, .4]);
    } else if (theme.architecture === "arctic") {
      for (const x of [-2.7, 2.7]) {
        box([.7, 1.8, .85], "#748896", [x, 2.4, .425], .3, .5);
        for (const y of [1.9, 2.5, 3.1]) box([.42, .4, .34], "#dd8c35", [x, y, 1.05]);
        box([.06, 7, .06], "#d6eef4", [x, 0, 2.9]);
      }
      for (const x of [-2, 0, 2]) box([.08, .08, 3.5], "#c2d7e0", [x, 3.9, 1.75], .3, .5);
    } else {
      for (const x of [-2.7, 2.7]) { box([.65, 1.6, .85], "#8c3b34", [x, 2.3, .425]); for (let i = 0; i < 5; i++) box([.02, 1.4, .025], "#c4b9a4", [x + (x > 0 ? -.34 : .34), 2.3, .12 + i * .14]); box([.07, 2, 2.6], "#355044", [x, -3.6, 1.3]); }
      for (const x of [-1.5, 1.5]) { cylinder(.025, .8, "#414b3d", [x, 2, 2.9]); cylinder(.25, .16, "#cca05b", [x, 2, 2.45]); }
    }

    const doors = props.children.map((child, index) => {
      const side = index < 5 ? -1 : 1, y = -2.8 + index % 5 * 1.4;
      const doorImage = textureLoader.load(child.image, texture => { if (disposed) texture.dispose(); }); doorImage.colorSpace = THREE.SRGBColorSpace; textures.push(doorImage);
      const geometry = new THREE.PlaneGeometry(1.08, 1.8); geometries.add(geometry);
      const material = new THREE.MeshBasicMaterial({ map: doorImage, color: "#c7cfc4", toneMapped: false }); materials.add(material);
      const mesh = new THREE.Mesh(geometry, material); mesh.position.set(side * 3.63, y, 1.05); mesh.rotation.set(Math.PI / 2, side === -1 ? Math.PI / 2 : -Math.PI / 2, 0, "ZYX");
      // Plane normal faces the central room, with its vertical axis aligned to Z.
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, side === -1 ? 1 : -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-side, 0, 0)));
      mesh.userData.path = child.path; scene.add(mesh); meshes.push(mesh);
      for (const dy of [-.58, .58]) box([.07, .04, 2.05], child.theme.accent, [side * 3.6, y + dy, 1.025]);
      box([.07, 1.2, .04], child.theme.accent, [side * 3.6, y, 2.04]);
      const signGeometry = new THREE.PlaneGeometry(1.07, .34); geometries.add(signGeometry);
      const signMaterial = new THREE.MeshBasicMaterial({ map: label(child.theme.name, `${String(index + 1).padStart(2, "0")}  /  ${child.kind.toUpperCase()}`, child.theme.accent), toneMapped: false }); materials.add(signMaterial);
      const sign = new THREE.Mesh(signGeometry, signMaterial); sign.quaternion.copy(mesh.quaternion); sign.position.set(side * 3.59, y, .32); scene.add(sign);
      return { mesh, path: child.path, point: new THREE.Vector3(side * 3.3, y, 1.65) };
    });

    const groups = new Map<number, THREE.Group>();
    for (const geom of session.geoms) {
      if (geom.body_id === 0) continue; // Visual room architecture replaces the cutaway editor shell.
      let group = groups.get(geom.body_id);
      if (!group) { group = new THREE.Group(); groups.set(geom.body_id, group); scene.add(group); }
      let geometry: THREE.BufferGeometry;
      if (geom.type === "mesh") geometry = new THREE.BufferGeometry();
      else if (geom.type === "box") geometry = new THREE.BoxGeometry(...geom.size.map(n => n * 2) as [number, number, number]);
      else if (geom.type === "sphere") geometry = new THREE.SphereGeometry(geom.size[0], 24, 16);
      else { geometry = new THREE.CylinderGeometry(geom.size[0], geom.size[0], geom.size[1] * 2, 24); geometry.rotateX(Math.PI / 2); }
      if (geom.type === "mesh") void loadRobotMeshes().then(assets => {
        if (disposed) return;
        const data = assets[String(geom.mesh_id)];
        if (!data) throw new Error("A Panda visual mesh is missing");
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.vertices, 3));
        geometry.setIndex(data.indices); geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
      }).catch(cause => { if (!disposed) setError(String(cause)); });
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(...geom.color.slice(0, 3) as [number, number, number]).convertSRGBToLinear(), roughness: geom.body_name === "table" ? .7 : .35, metalness: geom.type === "mesh" ? .22 : .12 });
      if (geom.body_name === "target") { material.emissive.set(theme.color); material.emissiveIntensity = .16; }
      const mesh = new THREE.Mesh(geometry, material); mesh.position.fromArray(geom.position);
      mesh.quaternion.set(geom.quaternion[1], geom.quaternion[2], geom.quaternion[3], geom.quaternion[0]); mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh); geometries.add(geometry); materials.add(material);
    }
    const goalMaterial = new THREE.MeshStandardMaterial({ color: "#d6ffa2", transparent: true, opacity: .42, emissive: "#6fbd34", emissiveIntensity: .7, depthWrite: false }); materials.add(goalMaterial);
    const goalGeometry = new THREE.SphereGeometry(.045, 24, 16); geometries.add(goalGeometry);
    const goal = new THREE.Mesh(goalGeometry, goalMaterial); goal.position.fromArray(session.goal); scene.add(goal);
    const goalRing = ring(.065, .006, "#d4ff9e", [session.goal[0], session.goal[1], .759]);
    const goalLight = new THREE.PointLight("#bbff80", .25, .6); goalLight.position.fromArray(session.goal); scene.add(goalLight);
    // Every articulated Panda link and both fingers use MuJoCo body transforms.
    const stationTexture = label(room.kind === "reach" ? "POSITION THE GRIPPER" : room.kind === "push" ? "MOVE TO THE GREEN GOAL" : "GRASP • CLOSE • LIFT", "PHYSICAL ROBOT TASK", theme.accent);
    const stationGeometry = new THREE.PlaneGeometry(.6, .19); geometries.add(stationGeometry);
    const stationMaterial = new THREE.MeshBasicMaterial({ map: stationTexture, toneMapped: false }); materials.add(stationMaterial);
    const stationSign = new THREE.Mesh(stationGeometry, stationMaterial); stationSign.position.set(0, -.556, .64); stationSign.rotation.x = Math.PI / 2; scene.add(stationSign);

    const keys = new Set<string>(), raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let drag: { x: number; y: number; moved: boolean } | null = null, walkTarget: typeof doors[number] | null = null, entered = false;
    const down = (event: PointerEvent) => { if (event.button !== 0) return; renderer.domElement.focus({ preventScroll: true }); renderer.domElement.setPointerCapture(event.pointerId); drag = { x: event.clientX, y: event.clientY, moved: false }; };
    const move = (event: PointerEvent) => {
      if (drag) { const dx = event.clientX - drag.x, dy = event.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; yaw -= dx * .003; pitch = THREE.MathUtils.clamp(pitch - dy * .0025, -.85, .7); drag.x = event.clientX; drag.y = event.clientY; }
      const bounds = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera); renderer.domElement.style.cursor = raycaster.intersectObjects(doors.map(d => d.mesh)).length ? "pointer" : "grab";
    };
    const up = () => { if (drag && !drag.moved) { raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(doors.map(d => d.mesh))[0]; if (hit) walkTarget = doors.find(d => d.mesh === hit.object) ?? null; } drag = null; };
    const keydown = (event: KeyboardEvent) => { if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,dialog")) return; const key = event.key.toLowerCase(); if (["w", "a", "s", "d", "shift"].includes(key)) { event.preventDefault(); keys.add(key); walkTarget = null; } };
    const keyup = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const blur = () => { keys.clear(); drag = null; walkTarget = null; };
    renderer.domElement.addEventListener("pointerdown", down); renderer.domElement.addEventListener("pointermove", move); renderer.domElement.addEventListener("pointerup", up); renderer.domElement.addEventListener("pointercancel", blur);
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
    const resize = new ResizeObserver(() => { const bounds = parent.getBoundingClientRect(); camera.aspect = bounds.width / Math.max(1, bounds.height); camera.updateProjectionMatrix(); }); resize.observe(parent);
    const clock = new THREE.Clock(); let animation = 0;
    const animate = () => {
      animation = requestAnimationFrame(animate); const dt = Math.min(.05, clock.getDelta());
      const state = current.current.stateRef.current;
      if (state) {
        for (const [id, group] of groups) { const pose = state.bodies[id]; if (pose) { group.position.fromArray(pose); group.quaternion.set(pose[4], pose[5], pose[6], pose[3]); } }
        goalMaterial.opacity = state.robot.is_success ? .7 : .32 + Math.sin(clock.elapsedTime * 3) * .1;
        goalRing.rotation.z = clock.elapsedTime * .3;
      }
      if (walkTarget && !entered) {
        const dx = walkTarget.point.x - camera.position.x, dy = walkTarget.point.y - camera.position.y, distance = Math.hypot(dx, dy);
        const targetYaw = Math.atan2(dx, dy); yaw += Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw)) * Math.min(1, dt * 5);
        pitch += (-.04 - pitch) * dt * 4;
        if (distance < .35) { entered = true; current.current.onDoor(walkTarget.path); }
        else { const step = Math.min(distance, dt * 2.3); camera.position.x += dx / distance * step; camera.position.y += dy / distance * step; }
      } else {
        const forward = Number(keys.has("w")) - Number(keys.has("s")), strafe = Number(keys.has("d")) - Number(keys.has("a"));
        const speed = (keys.has("shift") ? 3.2 : 1.7) * dt / Math.max(1, Math.hypot(forward, strafe));
        const x = camera.position.x + (Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
        const y = camera.position.y + (Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed;
        if (!(Math.abs(x) < .94 && Math.abs(y) < .71)) { camera.position.x = THREE.MathUtils.clamp(x, -3.4, 3.4); camera.position.y = THREE.MathUtils.clamp(y, -3.5, 3.5); }
        const door = doors.find(d => Math.hypot(camera.position.x - d.point.x, camera.position.y - d.point.y) < .32);
        if (door && !entered) { entered = true; current.current.onDoor(door.path); }
      }
      camera.lookAt(camera.position.x + Math.sin(yaw) * Math.cos(pitch), camera.position.y + Math.cos(yaw) * Math.cos(pitch), camera.position.z + Math.sin(pitch));
      renderer.domElement.dataset.cameraPosition = camera.position.toArray().map(n => n.toFixed(3)).join(",");
      renderer.render(scene, camera);
    };
    animate();
    return () => {
      disposed = true; cancelAnimationFrame(animation); resize.disconnect(); current.current.onCanvas(null);
      window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur);
      renderer.domElement.removeEventListener("pointerdown", down); renderer.domElement.removeEventListener("pointermove", move); renderer.domElement.removeEventListener("pointerup", up); renderer.domElement.removeEventListener("pointercancel", blur);
      video.pause(); video.removeEventListener("loadeddata", showVideo); video.removeAttribute("src"); video.load();
      textures.forEach(texture => texture.dispose()); geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [props.session.id, props.room.path, props.videoUrl]);
  return <div ref={host} style={{ position: "absolute", inset: 0 }}>{error && <p role="alert" style={{ position: "absolute", top: 150, left: 20, right: 20, padding: 20, background: "#14231c", zIndex: 3 }}>{error}</p>}</div>;
}
