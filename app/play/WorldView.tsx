"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import { EYE_HEIGHT, movePlayer, physicsToView, roomAt, viewToPhysics, walkingRoute } from "./movement";
import type { Family, PlayerState, TaskProgress, Vec3, WorldCatalog, WorldCommand, WorldSession } from "./types";
import styles from "./play.module.css";

export interface WorldHandle { walkTo: (room: Family) => void; interact: () => void; leave: () => void; move: (key: string, active: boolean) => void }
interface Props {
  session: WorldSession; catalog: WorldCatalog; stateRef: MutableRefObject<TaskProgress | null>; disabled: boolean;
  onCommand: (command: WorldCommand) => void; onCanvas: (canvas: HTMLCanvasElement | null) => void;
  onPlayer: (player: PlayerState) => void; onHint: (hint: string) => void;
}

export const WorldView = forwardRef<WorldHandle, Props>(function WorldView(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const actions = useRef<WorldHandle>({ walkTo() {}, interact() {}, leave() {}, move() {} });
  const [error, setError] = useState("");
  useImperativeHandle(ref, () => ({ walkTo: r => actions.current.walkTo(r), interact: () => actions.current.interact(), leave: () => actions.current.leave(), move: (k, a) => actions.current.move(k, a) }), []);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const { session, catalog } = current.current;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" }); }
    catch { setError("Enable hardware acceleration and reload to enter this 3D world."); return; }
    renderer.setPixelRatio(1);
    renderer.setSize(1280, 704, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Walkable task world. WASD to move, drag to look, E to use a station, Escape to leave.");
    parent.appendChild(canvas);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#d9dfd3");
    const camera = new THREE.PerspectiveCamera(66, 1280 / 704, .035, 70);
    camera.rotation.order = "YXZ";
    const native = new THREE.Group();
    native.rotation.x = -Math.PI / 2;
    scene.add(native);
    scene.add(new THREE.HemisphereLight("#fff9e9", "#7e8e75", 1.7));
    const sun = new THREE.DirectionalLight("#fff3d5", 2.4);
    sun.position.set(-5, 12, -3); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 10, bottom: -10, near: .1, far: 40 });
    sun.shadow.normalBias = .035; scene.add(sun);
    const fill = new THREE.DirectionalLight("#d9eaf5", 1.1); fill.position.set(5, 7, 10); scene.add(fill);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const meshes: THREE.Mesh[] = [];
    const groups = new Map<number, THREE.Group>();
    const bodyNames = new Map<string, number>();
    const clothMeshes: THREE.Mesh[] = [];
    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, group: THREE.Object3D = native) => {
      geometries.add(geometry); materials.add(material);
      const item = new THREE.Mesh(geometry, material); item.castShadow = true; item.receiveShadow = true; group.add(item); return item;
    };
    const material = (color: THREE.ColorRepresentation, roughness = .8) => new THREE.MeshStandardMaterial({ color, roughness });
    const box = (size: Vec3, position: Vec3, color: string) => {
      const item = mesh(new THREE.BoxGeometry(...size), material(color)); item.position.fromArray(position); return item;
    };
    function texture(width: number, height: number, draw: (c: CanvasRenderingContext2D) => void) {
      const surface = document.createElement("canvas"); surface.width = width; surface.height = height;
      const context = surface.getContext("2d")!; draw(context);
      const map = new THREE.CanvasTexture(surface); map.colorSpace = THREE.SRGBColorSpace; textures.add(map); return { map, context };
    }
    function sign(text: string, caption: string, position: Vec3, width = 2.6, color = "#283c30") {
      const { map } = texture(1024, 256, c => {
        c.clearRect(0, 0, 1024, 256); c.fillStyle = color; c.font = "600 82px Arial"; c.textAlign = "center";
        c.fillText(text, 512, 105); c.font = "27px monospace"; c.fillText(caption, 512, 174);
      });
      const item = mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }));
      item.position.fromArray(position); item.rotation.x = Math.PI / 2; return item;
    }
    for (const geom of session.geoms) {
      let group = groups.get(geom.body_id);
      if (!group) { group = new THREE.Group(); groups.set(geom.body_id, group); native.add(group); }
      bodyNames.set(geom.body_name, geom.body_id);
      let geometry: THREE.BufferGeometry;
      if (geom.type === "box") geometry = new THREE.BoxGeometry(...geom.size.map(n => 2 * n) as Vec3);
      else if (geom.type === "sphere") geometry = new THREE.SphereGeometry(geom.size[0], 20, 12);
      else { geometry = new THREE.CylinderGeometry(geom.size[0], geom.size[0], geom.size[1] * 2, 32); geometry.rotateX(Math.PI / 2); }
      const item = mesh(geometry, material(new THREE.Color(...geom.color.slice(0, 3) as Vec3).convertSRGBToLinear(), geom.body_name.includes("plate") ? .3 : .8), group);
      item.position.fromArray(geom.position);
      const q = geom.quaternion; item.quaternion.set(q[1], q[2], q[3], q[0]);
      item.userData = { bodyId: geom.body_id, name: geom.body_name, movable: geom.movable };
      if (geom.body_name === "laundry_garment") clothMeshes.push(item);
      meshes.push(item);
    }
    // Room detail is authored from the observed task stations. Physics still owns all movable props.
    for (const [index, room] of session.spec.rooms.entries()) {
      const x = room.origin[0];
      const rug = mesh(new THREE.PlaneGeometry(5.8, 5.7), material(room.color));
      rug.position.set(x, 3, .003); rug.receiveShadow = true;
      box([.075, .12, 2.65], [x - .95, -.06, 1.325], "#658269");
      box([.075, .12, 2.65], [x + .95, -.06, 1.325], "#658269");
      sign(`${String(index + 1).padStart(2, "0")}  ${room.title}`, "OBSERVE · PRACTICE · EXPLORE", [x, -.12, 2.94], 3.0);
      sign(room.title.toUpperCase(), "SMALL ACTIONS. REAL PROGRESS.", [x, 5.95, 2.65], 3.2);
      for (const side of [-1, 1]) {
        box([.95, .09, 1.15], [x + side * 2.05, 5.94, 2.05], "#809a84");
        box([.83, .1, 1.03], [x + side * 2.05, 5.87, 2.05], "#dce6dc");
        box([.035, .12, 1.05], [x + side * 2.05, 5.8, 2.05], "#fcf2d9");
      }
      const poster = new THREE.TextureLoader().load(catalog.media[room.id].posterUrl);
      poster.colorSpace = THREE.SRGBColorSpace; textures.add(poster);
      const photo = mesh(new THREE.PlaneGeometry(1.4, .79), new THREE.MeshBasicMaterial({ map: poster }));
      photo.rotation.x = Math.PI / 2; photo.position.set(x + 2.4, .14, 1.8);
      // Face into the room so a returning player can see the source reference.
      photo.rotation.x = -Math.PI / 2;
      box([1.47, .08, .86], [x + 2.4, .10, 1.8], "#394d3b");
      for (const y of [.45, .85, 1.25]) box([.1, .18, .005], [x, y, .008], "#53725c");
    }
    for (let x = -8; x <= 8; x += .65) box([.23, .025, .006], [x, -1.5, .009], "#82927c");
    sign("FIELDWORK", "THREE ROOMS / NINE POSSIBILITIES", [0, -2.97, 2.3], 4.5).rotation.x = -Math.PI / 2;
    // Faucet and water are visual tool affordances; rinse checks use the plate's physical position.
    const pipeMat = material("#6b837b", .24);
    const pipe = mesh(new THREE.CylinderGeometry(.027, .027, .55, 16), pipeMat);
    pipe.rotation.x = Math.PI / 2; pipe.position.set(-7.7, 4.85, 1.2);
    const spout = mesh(new THREE.CylinderGeometry(.027, .027, .36, 16), pipeMat);
    spout.position.set(-7.7, 4.68, 1.475);
    const water = mesh(new THREE.CylinderGeometry(.025, .05, .49, 12), new THREE.MeshStandardMaterial({ color: "#8fcae2", transparent: true, opacity: .45, roughness: .2 }));
    water.rotation.x = Math.PI / 2; water.position.set(-7.7, 4.5, 1.21);
    const destination = (x: number, y: number, z: number, width: number, height: number) => {
      const { map } = texture(256, 256, c => { c.strokeStyle = "#eaf5c6"; c.lineWidth = 8; c.setLineDash([17, 12]); c.strokeRect(10, 10, 236, 236); c.font = "bold 26px monospace"; c.fillStyle = "#f7ffde"; c.textAlign = "center"; c.fillText("PLACE HERE", 128, 140); });
      const item = mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false })); item.position.set(x, y, z);
    };
    destination(-5.65, 4.5, .941, .59, .59); destination(1.1, 4.25, .767, .98, .93);
    // A textile pattern gives the folded proxy a legible surface and creases.
    const cloth = texture(256, 256, c => {
      c.fillStyle = "#98bba6"; c.fillRect(0, 0, 256, 256); c.strokeStyle = "#729981"; c.lineWidth = 2;
      for (let i = 8; i < 256; i += 20) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 256); c.stroke(); }
      c.strokeStyle = "#dce6c8"; c.lineWidth = 4; c.strokeRect(8, 8, 240, 240);
      c.setLineDash([8, 8]); c.beginPath(); c.moveTo(128, 0); c.lineTo(128, 256); c.stroke();
    });
    clothMeshes.forEach(m => { const mat = m.material as THREE.MeshStandardMaterial; mat.map = cloth.map; mat.color.set("#ffffff"); });
    for (let i = 0; i < 7; i++) box([.012, 1.86, .003], [-1.6 + i * .52, 4.25, .662], "#b6bd64");
    const paper = texture(512, 600, () => {});
    const paperMesh = mesh(new THREE.PlaneGeometry(.84, .98), new THREE.MeshBasicMaterial({ map: paper.map }));
    paperMesh.position.set(6.85, 4.45, .941);
    paperMesh.userData = { name: "drawing_paper", bodyId: 0 };
    meshes.push(paperMesh);
    box([.33, .11, .018], [6.85, 4.99, .95], "#929f94");
    const dirt = texture(256, 256, () => {});
    const plateGroup = groups.get(bodyNames.get("dishes_plate")!)!;
    const dirtMesh = mesh(new THREE.PlaneGeometry(.405, .405), new THREE.MeshBasicMaterial({ map: dirt.map, transparent: true, depthWrite: false, side: THREE.DoubleSide }), plateGroup);
    dirtMesh.position.z = .036;
    dirtMesh.userData = { name: "dishes_plate", bodyId: bodyNames.get("dishes_plate"), movable: true };
    meshes.push(dirtMesh);
    let inkKey = "", dirtKey = "";
    function paintSurfaces(snapshot: TaskProgress) {
      const nextInk = `${snapshot.active.drawing}:${snapshot.details.ink.join(",")}`;
      if (nextInk !== inkKey) {
        inkKey = nextInk; const c = paper.context;
        c.fillStyle = "#f9f4e5"; c.fillRect(0, 0, 512, 600);
        const task = snapshot.active.drawing;
        for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) {
          const u = (x + .5) / 32, v = (y + .5) / 32, width = task === "shade" ? .13 : .035;
          if ((u > .15 && u < .85 && Math.abs(v - .5) < width) || (task !== "line" && v > .15 && v < .85 && Math.abs(u - .5) < width)) {
            c.fillStyle = "#bdc9b8"; c.fillRect(x * 16, (31 - y) * 18.75, 16, 18.75);
          }
        }
        c.fillStyle = "#46554c";
        snapshot.details.ink.forEach(cell => c.fillRect((cell % 32) * 16, (31 - Math.floor(cell / 32)) * 18.75, 16, 18.75));
        paper.map.needsUpdate = true;
      }
      const nextDirt = snapshot.details.clean_cells.join(",");
      if (nextDirt !== dirtKey || dirtKey === "") {
        dirtKey = nextDirt; const c = dirt.context; c.clearRect(0, 0, 256, 256);
        const clean = new Set(snapshot.details.clean_cells);
        for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) {
          if (!clean.has(y * 32 + x) && Math.hypot(x - 15.5, y - 15.5) < 14 && (x * 7 + y * 13) % 5 < 3) {
            c.fillStyle = "#a8986ba8"; c.fillRect(x * 8, (31 - y) * 8, 7, 7);
          }
        }
        dirt.map.needsUpdate = true;
      }
    }

    let position = [...session.spec.spawn] as Vec3, yaw = 0, pitch = -.09;
    const keys = new Set<string>();
    let route: [number, number][] = [];
    let pointerDown: { x: number; y: number; lastX: number; lastY: number; fold?: number[]; uv?: number[] } | null = null;
    let dragging = false;
    let frame = 0, last = performance.now(), lastPose = 0, lastSend = 0;
    let previousStation: Family | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane();
    const hitPoint = new THREE.Vector3();
    const cameraTarget = new THREE.Vector3();
    const desiredCamera = new THREE.Vector3();
    const desiredRotation = new THREE.Quaternion();
    const poseCamera = new THREE.PerspectiveCamera();
    const command = (c: WorldCommand) => current.current.onCommand(c);
    const snapshot = () => current.current.stateRef.current ?? session.state;
    const player = (): PlayerState => {
      const room = roomAt(position[0], position[1]);
      const station = session.spec.rooms.find(r => r.id === room);
      return { position: [...position], yaw, pitch, room, near: !!station && Math.hypot(position[0] - station.station[0], position[1] - station.station[1]) < 1.85 };
    };
    const sendPose = () => command({ type: "player", player: { position, yaw, pitch } });
    const release = () => {
      if (dragging) command({ type: "release" });
      dragging = false; pointerDown = null;
    };
    const leaveStation = () => { release(); keys.clear(); command({ type: "station", active: false }); canvas.focus(); };
    const interact = () => {
      if (current.current.disabled) return;
      if (snapshot().station) { leaveStation(); return; }
      const p = player();
      if (p.room && p.near) { sendPose(); command({ type: "station", family: p.room, active: true }); route = []; keys.clear(); }
      else current.current.onHint("Walk closer to a work surface to use its station.");
    };
    actions.current = {
      walkTo(family) { if (current.current.disabled) return; leaveStation(); route = walkingRoute(position, session.spec.rooms.find(r => r.id === family)!.origin[0]); keys.clear(); },
      interact, leave: leaveStation,
      move(key, active) { if (active) { keys.add(key); route = []; } else keys.delete(key); },
    };
    function ray(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      scene.updateMatrixWorld(true); raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(meshes)[0];
    }
    function clothUV(point: THREE.Vector3) {
      const local = groups.get(bodyNames.get("laundry_garment")!)!.worldToLocal(point.clone());
      return [THREE.MathUtils.clamp(local.x / .9 + .5, 0, 1), THREE.MathUtils.clamp(local.y / .65 + .5, 0, 1)];
    }
    function stroke(hit: THREE.Intersection | undefined) {
      if (!hit || !pointerDown) return;
      const state = snapshot();
      if (state.station === "dishes" && state.tools.dishes === "sponge" && hit.object.userData.name === "dishes_plate") {
        command({ type: "stroke", point: viewToPhysics(hit.point.toArray()) });
      } else if (state.station === "drawing" && hit.object.userData.name === "drawing_paper" && hit.uv) {
        const uv = hit.uv.toArray(); command({ type: "stroke", start: pointerDown.uv ?? uv, end: uv }); pointerDown.uv = uv;
      } else pointerDown.uv = undefined;
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || current.current.disabled) return;
      canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
      pointerDown = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY };
      const state = snapshot(); if (!state.station) return;
      const hit = ray(event); if (!hit) return;
      if (state.station === "laundry" && hit.object.userData.name === "laundry_garment" && state.details.folds < state.details.fold_goal) {
        pointerDown.fold = clothUV(hit.point); return;
      }
      if (state.tools[state.station] === "hand" && hit.object.userData.movable && hit.object.userData.name.startsWith(`${state.station}_`)) {
        dragging = true;
        const height = state.station === "dishes" ? 1.22 : .99;
        dragPlane.set(new THREE.Vector3(0, 1, 0), -height);
        command({ type: "grab", body_id: hit.object.userData.bodyId, point: viewToPhysics(hit.point.toArray()) });
      } else stroke(hit);
    };
    const move = (event: PointerEvent) => {
      if (current.current.disabled) return;
      const state = snapshot();
      if (!state.station) {
        if (pointerDown) {
          yaw -= (event.clientX - pointerDown.lastX) * .0035;
          pitch = THREE.MathUtils.clamp(pitch - (event.clientY - pointerDown.lastY) * .003, -.95, .75);
          pointerDown.lastX = event.clientX; pointerDown.lastY = event.clientY; route = [];
        }
        return;
      }
      const hit = ray(event);
      canvas.style.cursor = hit?.object.userData.name?.includes(state.station) ? (state.tools[state.station] === "hand" ? "grab" : "crosshair") : "default";
      if (!pointerDown || performance.now() - lastSend < 32) return;
      lastSend = performance.now();
      if (dragging) {
        if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) command({ type: "move", target: viewToPhysics(hitPoint.toArray()) });
      } else if (!pointerDown.fold) stroke(hit);
    };
    const up = (event: PointerEvent) => {
      // Pointer movement is throttled; always deliver its final position before release.
      if (dragging && !current.current.disabled) {
        ray(event);
        if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) command({ type: "move", target: viewToPhysics(hitPoint.toArray()) });
      }
      if (pointerDown?.fold && !current.current.disabled) {
        const hit = ray(event);
        if (hit?.object.userData.name === "laundry_garment") command({ type: "fold", start: pointerDown.fold, end: clothUV(hit.point) });
      }
      release();
    };
    const blur = () => { keys.clear(); route = []; release(); };
    const keydown = (event: KeyboardEvent) => {
      if (current.current.disabled || (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,dialog"))) return;
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(key)) {
        event.preventDefault(); keys.add(key); route = [];
      } else if (key === "e" && !event.repeat) interact();
      else if (key === "escape") { blur(); if (snapshot().station) leaveStation(); }
    };
    const keyup = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", blur); canvas.addEventListener("lostpointercapture", release);
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
    camera.position.fromArray(physicsToView([position[0], position[1], EYE_HEIGHT]));
    camera.rotation.set(pitch, yaw, 0, "YXZ");
    let wasDisabled = current.current.disabled;
    function animate(now: number) {
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      const state = snapshot();
      if (current.current.disabled && !wasDisabled) blur();
      wasDisabled = current.current.disabled;
      for (const [id, group] of groups) {
        const p = state.bodies[id]; if (p) { group.position.set(p[0], p[1], p[2]); group.quaternion.set(p[4], p[5], p[6], p[3]); }
      }
      const scale = state.details.folds === 0 ? 1 : state.details.folds === 1 ? .6 : .34;
      clothMeshes.forEach(m => { m.scale.x += (scale - m.scale.x) * Math.min(1, dt * 7); m.scale.z += ((1 + state.details.folds * .6) - m.scale.z) * Math.min(1, dt * 7); });
      paintSurfaces(state);
      if (state.station !== previousStation) { release(); keys.clear(); previousStation = state.station; }
      if (!current.current.disabled && !state.station) {
        if (route.length) {
          const [x, y] = route[0], dx = x - position[0], dy = y - position[1], distance = Math.hypot(dx, dy);
          if (distance < .09) route.shift();
          else {
            const direction = Math.atan2(-dx, dy);
            yaw += Math.atan2(Math.sin(direction-yaw), Math.cos(direction-yaw)) * Math.min(1, dt * 6);
            pitch += (-.08 - pitch) * dt * 4;
            const step = Math.min(distance, 3.4 * dt);
            position = movePlayer(position, dx / distance * step, dy / distance * step, session.spec.colliders);
          }
        } else {
          if (keys.has("arrowleft")) yaw += dt * 1.5;
          if (keys.has("arrowright")) yaw -= dt * 1.5;
          const forward = Number(keys.has("w") || keys.has("arrowup")) - Number(keys.has("s") || keys.has("arrowdown"));
          const strafe = Number(keys.has("d")) - Number(keys.has("a"));
          const speed = (keys.has("shift") ? 4 : 2.6) * dt / Math.max(1, Math.hypot(forward, strafe));
          position = movePlayer(position, (-Math.sin(yaw)*forward + Math.cos(yaw)*strafe)*speed, (Math.cos(yaw)*forward + Math.sin(yaw)*strafe)*speed, session.spec.colliders);
        }
      }
      if (state.station) {
        const room = session.spec.rooms.find(r => r.id === state.station)!;
        const x = room.origin[0];
        const close = state.station === "drawing";
        desiredCamera.fromArray(physicsToView(close ? [x-.15, 3.55, 2.1] : [x, 2.55, state.station === "laundry" ? 2.7 : 3.0]));
        cameraTarget.fromArray(physicsToView(close ? [x-.15, 4.45, .94] : [x, 4.45, state.station === "laundry" ? .66 : .95]));
        poseCamera.position.copy(desiredCamera); poseCamera.lookAt(cameraTarget); desiredRotation.copy(poseCamera.quaternion);
      } else {
        desiredCamera.fromArray(physicsToView([position[0], position[1], EYE_HEIGHT]));
        desiredRotation.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      }
      camera.position.lerp(desiredCamera, Math.min(1, dt * 10)); camera.quaternion.slerp(desiredRotation, Math.min(1, dt * 12));
      if (now - lastPose > 100) {
        lastPose = now; const p = player(); current.current.onPlayer(p);
        if (!current.current.disabled) sendPose();
        canvas.dataset.room = p.room ?? "corridor"; canvas.dataset.position = `${position[0].toFixed(2)},${position[1].toFixed(2)}`;
        canvas.dataset.station = state.station ?? "";
      }
      renderer.render(scene, camera); frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    current.current.onCanvas(canvas);
    return () => {
      blur(); cancelAnimationFrame(frame); current.current.onCanvas(null);
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", blur); canvas.removeEventListener("lostpointercapture", release);
      window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur);
      textures.forEach(t => t.dispose()); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    };
  }, [props.session, props.catalog]);
  return <div ref={host} className={styles.canvasHost}>{error && <div className={styles.empty} role="alert">{error}</div>}</div>;
});
