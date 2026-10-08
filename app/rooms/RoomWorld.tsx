"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { RELATIONS, type TaskRoom } from "../lib/task-rooms";

export const DOOR_POSITIONS = Array.from({ length: 10 }, (_, index) => ({
  x: index < 5 ? -9.65 : 9.65, z: -7.2 + (index % 5) * 4.0,
}));

export type WorldHandle = {
  walkToDoor: (index: number) => void;
  reset: () => void;
  move: (direction: string, active: boolean) => void;
  toggleVideo: () => boolean;
};

type Props = {
  room: TaskRoom;
  doors: TaskRoom[];
  videoUrl: string;
  posterUrl: string;
  disabled: boolean;
  onEnter: (index: number) => void;
  onHover: (index: number | null) => void;
  onPosition: (position: { x: number; z: number; yaw: number }) => void;
  onReady: (supported: boolean) => void;
};

const RoomWorld = forwardRef<WorldHandle, Props>(function RoomWorld(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<{ video: HTMLVideoElement; showPoster: () => void } | null>(null);
  const current = useRef(props);
  current.current = props;
  const actions = useRef<WorldHandle>({ walkToDoor() {}, reset() {}, move() {}, toggleVideo: () => false });
  useImperativeHandle(ref, () => ({
    walkToDoor: index => actions.current.walkToDoor(index),
    reset: () => actions.current.reset(),
    move: (direction, active) => actions.current.move(direction, active),
    toggleVideo: () => actions.current.toggleVideo(),
  }), []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      current.current.onReady(false);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute("aria-label", "Walkable task room. Use W A S D to move, drag to look, and click a doorway to enter.");
    renderer.domElement.setAttribute("tabindex", "0");
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#d6dbd1");
    scene.fog = new THREE.Fog("#d6dbd1", 22, 62);
    const camera = new THREE.PerspectiveCamera(68, 1, 0.08, 100);
    camera.rotation.order = "YXZ";
    let yaw = 0.08;
    let pitch = 0.045;
    camera.position.set(0, 1.72, 8.7);
    const textures: THREE.Texture[] = [];
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    let disposed = false;
    const box = (width: number, height: number, depth: number, color: string, x: number, y: number, z: number, roughness = 0.85) => {
      const geometry = new THREE.BoxGeometry(width, height, depth);
      const material = new THREE.MeshStandardMaterial({ color, roughness });
      geometries.add(geometry); materials.add(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      scene.add(mesh);
      return mesh;
    };
    const plane = (width: number, height: number, material: THREE.Material, x: number, y: number, z: number, rotation = 0) => {
      const geometry = new THREE.PlaneGeometry(width, height);
      geometries.add(geometry); materials.add(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z); mesh.rotation.y = rotation;
      scene.add(mesh);
      return mesh;
    };
    function canvasTexture(draw: (context: CanvasRenderingContext2D) => void, width = 1024, height = 256) {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!;
      draw(context);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      textures.push(texture);
      return texture;
    }
    const floorTexture = canvasTexture(context => {
      context.fillStyle = "#b9bcb0"; context.fillRect(0, 0, 512, 512);
      context.strokeStyle = "#9ea599"; context.lineWidth = 1;
      context.strokeRect(0, 0, 512, 512);
      for (let index = 0; index < 1200; index++) {
        // A fixed, code-generated surface grain, independent of provider imagery.
        const x = (index * 137.51) % 512, y = (index * 91.37) % 512;
        context.fillStyle = index % 2 ? "#b4b9ad" : "#c0c4b8";
        context.fillRect(x, y, 2, 2);
      }
    }, 512, 512);
    floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
    floorTexture.repeat.set(10, 12);
    const floor = plane(24, 27, new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.82 }), 0, -0.01, 0);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;

    scene.add(new THREE.HemisphereLight("#faf8ef", "#6d796c", 2.3));
    const daylight = new THREE.DirectionalLight("#fff4dc", 3.4);
    daylight.position.set(-7, 14, 3); daylight.castShadow = true;
    daylight.shadow.mapSize.set(1024, 1024);
    Object.assign(daylight.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 40 });
    daylight.shadow.bias = -0.001;
    scene.add(daylight);
    box(20.4, 6.5, 0.35, "#c5c9bc", 0, 3.25, -10.1);
    box(20.4, 6.5, 0.35, "#b6beaf", 0, 3.25, 11.3);
    // Open doorways are cut into both walls; moving through a threshold changes task rooms.
    for (const side of [-1, 1]) {
      const x = side * 10.1;
      box(0.35, 2.9, 21.4, "#c5c9bd", x, 5.05, 0.6);
      for (let index = 0; index < 6; index++) {
        const z = -9.45 + index * 4;
        box(0.35, 3.6, index === 0 || index === 5 ? 1.75 : 1.3, "#c5c9bd", x, 1.8, z);
      }
    }
    for (const z of [-8.6, -2.5, 3.6, 9.7]) {
      box(20.2, 0.16, 0.22, "#8d9987", 0, 6.1, z);
      box(16, 0.035, 0.07, "#f1eedb", 0, 5.99, z);
    }
    box(12, 0.15, 1.4, "#8c9985", 0, 0.075, -8.8);
    box(10.8, 6.02, 0.24, "#353e34", 0, 3.25, -9.84);
    box(11.0, 0.045, 0.16, "#c5d7b0", 0, 0.24, -9.65);
    const screenMaterial = new THREE.MeshBasicMaterial({ color: "#8b9686", toneMapped: false });
    const screen = plane(10.4, 5.72, screenMaterial, 0, 3.26, -9.68);
    // The photograph/video is displayed as footage, never represented as a reconstructed room.
    const loader = new THREE.TextureLoader();
    const poster = loader.load(props.posterUrl, texture => {
      if (disposed) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      if (video.readyState < 2) { screenMaterial.map = texture; screenMaterial.color.set("#ffffff"); screenMaterial.needsUpdate = true; }
    });
    poster.colorSpace = THREE.SRGBColorSpace; textures.push(poster);

    const video = document.createElement("video");
    video.src = props.videoUrl; video.crossOrigin = "anonymous";
    video.loop = true; video.muted = true; video.playsInline = true; video.preload = "auto";
    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.SRGBColorSpace; textures.push(videoTexture);
    player.current = { video, showPoster() { screenMaterial.map = poster; screenMaterial.needsUpdate = true; } };
    const showVideo = () => {
      screenMaterial.map = videoTexture; screenMaterial.color.set("#ffffff"); screenMaterial.needsUpdate = true;
    };
    video.addEventListener("loadeddata", showVideo);
    void video.play().catch(() => undefined);

    const titleTexture = canvasTexture(context => {
      context.fillStyle = "#dce3d4"; context.font = "500 42px Arial";
      context.fillText(props.room.title, 28, 85, 960);
      context.fillStyle = "#9ba893"; context.font = "22px Arial";
      context.fillText("ONE TASK · TEN POSSIBILITIES", 28, 140);
    });
    plane(7.3, 1.82, new THREE.MeshBasicMaterial({ map: titleTexture, transparent: true, depthWrite: false }), 0, 0.83, -9.5);

    const portalTargets: THREE.Mesh[] = [];
    const doorFrames: THREE.Mesh[] = [];
    for (const [index, position] of DOOR_POSITIONS.entries()) {
      const door = props.doors[index];
      const color = RELATIONS[door.relation].color;
      const rotation = index < 5 ? Math.PI / 2 : -Math.PI / 2;
      const sign = index < 5 ? -1 : 1;
      const frame = box(0.2, 3.6, 2.95, "#414e3e", sign * 10.02, 1.8, position.z);
      doorFrames.push(frame);
      box(2.8, 0.05, 2.7, "#76866b", sign * 10.5, 0.02, position.z);
      const portal = plane(2.65, 3.35, new THREE.MeshBasicMaterial({ map: poster,
        color, toneMapped: false }), sign * 9.89, 1.73, position.z, rotation);
      portal.userData.doorIndex = index; portalTargets.push(portal);
      // A dark lower panel makes the task name legible without obscuring the scene reference.
      const label = canvasTexture(context => {
        context.fillStyle = "#243025"; context.fillRect(0, 0, 1024, 256);
        context.fillStyle = color; context.font = "500 31px Arial";
        context.fillText(`${String(index + 1).padStart(2, "0")}  /  ${RELATIONS[door.relation].label.toUpperCase()}`, 35, 58);
        context.fillStyle = "#eef0e5"; context.font = "500 43px Arial";
        const words = door.title.split(" ");
        let line = "", row = 0;
        for (const word of words) {
          if (context.measureText(`${line} ${word}`).width > 930 && line) {
            context.fillText(line, 35, 127 + row * 52); row++; line = word;
          } else line = line ? `${line} ${word}` : word;
        }
        if (row < 2) context.fillText(line, 35, 127 + row * 52, 930);
      });
      plane(2.65, 0.85, new THREE.MeshBasicMaterial({ map: label, toneMapped: false }), sign * 9.86, 0.48, position.z, rotation);
      for (const edge of [-1, 1]) box(0.055, 3.35, 0.035, color, sign * 9.8, 1.73, position.z + edge * 1.355);
      box(0.055, 0.04, 2.73, color, sign * 9.8, 3.42, position.z);
      // A small pool of light points to each door on the floor.
      const glow = plane(1.1, 2.1, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18,
        depthWrite: false }), sign * 9, 0.012, position.z);
      glow.rotation.x = -Math.PI / 2;
    }
    // Low, simple gallery furniture creates scale and parallax without obstructing navigation.
    for (const x of [-3.6, 3.6]) {
      box(0.72, 0.46, 3.2, "#87937e", x, 0.23, 6.8);
      box(0.84, 0.12, 3.3, "#d3c4a3", x, 0.51, 6.8);
    }
    const routeTexture = canvasTexture(context => {
      context.fillStyle = "#728069"; context.font = "600 60px Arial"; context.textAlign = "center";
      context.fillText("EXPLORE →", 512, 145);
    });
    const floorLabel = plane(3.1, 0.77, new THREE.MeshBasicMaterial({ map: routeTexture, transparent: true,
      depthWrite: false }), 0, 0.014, 4.2);
    floorLabel.rotation.x = -Math.PI / 2;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2(5, 5);
    const keys = new Set<string>();
    let pointerDown: { x: number; y: number; lastX: number; lastY: number; dragged: boolean } | null = null;
    let target: number | null = null;
    let hovered: number | null = null;
    let entered = false;
    let lastPositionTime = 0;
    const reset = () => { camera.position.set(0, 1.72, 8.7); yaw = 0.08; pitch = 0.045; target = null; keys.clear(); };
    actions.current = {
      walkToDoor(index) { if (index >= 0 && index < 10 && !current.current.disabled) { target = index; keys.clear(); renderer.domElement.focus({ preventScroll: true }); } },
      reset,
      move(direction, active) { if (active) { keys.add(direction); target = null; } else keys.delete(direction); },
      toggleVideo() { if (video.paused) { void video.play().catch(() => undefined); return true; } video.pause(); return false; },
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      renderer.domElement.focus({ preventScroll: true });
      renderer.domElement.setPointerCapture(event.pointerId);
      pointerDown = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, dragged: false };
    };
    const move = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      if (pointerDown && !current.current.disabled) {
        if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) pointerDown.dragged = true;
        yaw -= (event.clientX - pointerDown.lastX) * 0.0032;
        pitch = THREE.MathUtils.clamp(pitch - (event.clientY - pointerDown.lastY) * 0.0024, -0.65, 0.75);
        pointerDown.lastX = event.clientX; pointerDown.lastY = event.clientY;
      }
    };
    const up = () => {
      if (pointerDown && !pointerDown.dragged && hovered !== null) actions.current.walkToDoor(hovered);
      pointerDown = null;
    };
    const leave = () => { if (!pointerDown) pointer.set(5, 5); };
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[role=dialog]")) return;
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(key)) {
        event.preventDefault(); keys.add(key); target = null;
      } else if (key === "e" && hovered !== null) actions.current.walkToDoor(hovered);
      else if (key === "escape") { target = null; keys.clear(); }
    };
    const keyup = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const blur = () => { keys.clear(); pointerDown = null; };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("pointercancel", blur);
    renderer.domElement.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    const resize = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(width, height); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix();
    });
    resize.observe(element);
    const clock = new THREE.Clock();
    let animation = 0;
    const animate = () => {
      animation = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.05);
      if (!current.current.disabled && !entered) {
        if (target !== null) {
          const destination = DOOR_POSITIONS[target];
          const dx = destination.x - camera.position.x, dz = destination.z - camera.position.z;
          const distance = Math.hypot(dx, dz);
          const desiredYaw = Math.atan2(-dx, -dz);
          yaw += Math.atan2(Math.sin(desiredYaw - yaw), Math.cos(desiredYaw - yaw)) * Math.min(1, delta * 5);
          pitch += (0.0 - pitch) * delta * 3;
          if (distance > 0.62) {
            const step = Math.min(distance, delta * 7.5);
            camera.position.x += dx / distance * step; camera.position.z += dz / distance * step;
          }
        } else {
          if (keys.has("arrowleft")) yaw += delta * 1.5;
          if (keys.has("arrowright")) yaw -= delta * 1.5;
          const forward = Number(keys.has("w") || keys.has("arrowup")) - Number(keys.has("s") || keys.has("arrowdown"));
          const strafe = Number(keys.has("d")) - Number(keys.has("a"));
          const speed = (keys.has("shift") ? 5.8 : 3.4) * delta / Math.max(1, Math.hypot(forward, strafe));
          const x = camera.position.x + (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
          const z = camera.position.z + (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed;
          // Wall and bench collision; door thresholds stay open.
          const inDoor = DOOR_POSITIONS.some(door => Math.abs(z - door.z) < 1.18);
          const blockedByBench = (Math.abs(x - 3.6) < 0.7 || Math.abs(x + 3.6) < 0.7) && z > 4.85 && z < 8.75;
          if (!blockedByBench) {
            camera.position.x = THREE.MathUtils.clamp(x, inDoor ? -9.9 : -9.35, inDoor ? 9.9 : 9.35);
            camera.position.z = THREE.MathUtils.clamp(z, -9.05, 10.65);
          }
        }
        for (const [index, door] of DOOR_POSITIONS.entries()) {
          if (Math.hypot(camera.position.x - door.x, camera.position.z - door.z) < 0.65) {
            entered = true; keys.clear(); current.current.onEnter(index); break;
          }
        }
      }
      camera.rotation.set(pitch, yaw, 0, "YXZ");
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(portalTargets)[0];
      const nextHovered = hit ? Number(hit.object.userData.doorIndex) : null;
      if (nextHovered !== hovered) {
        hovered = nextHovered; current.current.onHover(hovered);
        renderer.domElement.style.cursor = hovered === null ? "grab" : "pointer";
        doorFrames.forEach((frame, index) => (frame.material as THREE.MeshStandardMaterial).color.set(index === hovered ? "#b2ca98" : "#414e3e"));
      }
      if (clock.elapsedTime - lastPositionTime > 0.1) {
        lastPositionTime = clock.elapsedTime;
        current.current.onPosition({ x: camera.position.x, z: camera.position.z, yaw });
      }
      renderer.render(scene, camera);
    };
    animate();
    current.current.onReady(true);
    return () => {
      disposed = true; cancelAnimationFrame(animation); resize.disconnect();
      window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur);
      renderer.domElement.removeEventListener("pointerdown", down); renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up); renderer.domElement.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("pointercancel", blur);
      player.current = null;
      video.pause(); video.removeEventListener("loadeddata", showVideo); video.removeAttribute("src"); video.load();
      textures.forEach(texture => texture.dispose()); geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [props.room.environment, props.room.path, props.posterUrl]);

  useEffect(() => {
    const active = player.current;
    if (active && active.video.getAttribute("src") !== props.videoUrl) {
      active.showPoster();
      active.video.src = props.videoUrl;
      active.video.load();
      void active.video.play().catch(() => undefined);
    }
  }, [props.videoUrl, props.room.environment, props.room.path]);

  return <div ref={host} className="room-world" />;
});

export default RoomWorld;
