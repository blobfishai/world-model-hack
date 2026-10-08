"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Command, PhysicsState, SimulationSession } from "./types";

export function RoomViewer({ session, stateRef, onCommand, onCanvas, onSelect, interactive = true, goal }: {
  session: SimulationSession;
  stateRef: MutableRefObject<PhysicsState | null>;
  onCommand: (command: Command) => void;
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
  onSelect: (name: string) => void;
  interactive?: boolean;
  goal?: number[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      setError("This viewer needs WebGL. Enable hardware acceleration and reload the page.");
      return;
    }
    // Keep the drawing buffer stable for Reactor. Only CSS responds to layout changes.
    renderer.setPixelRatio(1);
    renderer.setSize(1280, 704, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute("aria-label", "Interactive room simulation");
    renderer.domElement.setAttribute("role", "img");
    parent.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#e7e7de");
    const camera = new THREE.PerspectiveCamera(42, 1280 / 704, .05, 100);
    camera.up.set(0, 0, 1);
    const extent = Math.max(...session.spec.dimensions.slice(0, 2));
    camera.position.set(extent * 1.15, -extent * 1.5, extent * 1.08);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, .1, .65);
    if (goal) {
      camera.position.set(goal[0] + .9, goal[1] - 1.3, goal[2] + .9);
      controls.target.set(goal[0] * .4, goal[1], goal[2] - .1);
    }
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * .48;
    controls.minDistance = .8;
    controls.maxDistance = extent * 4;
    controls.update();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8b8b74, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, -3, 7); light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.left = -extent; light.shadow.camera.right = extent;
    light.shadow.camera.top = extent; light.shadow.camera.bottom = -extent;
    light.shadow.normalBias = .025;
    scene.add(light);
    const groups = new Map<number, THREE.Group>();
    const meshes: THREE.Mesh[] = [];
    if (goal) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(.045, 24, 16), new THREE.MeshStandardMaterial({ color: "#96de62", transparent: true, opacity: .55, emissive: "#3a641d", emissiveIntensity: .3 }));
      marker.position.fromArray(goal); scene.add(marker); meshes.push(marker);
    }
    for (const geom of session.geoms) {
      let group = groups.get(geom.body_id);
      if (!group) { group = new THREE.Group(); groups.set(geom.body_id, group); scene.add(group); }
      let geometry: THREE.BufferGeometry;
      if (geom.type === "box") geometry = new THREE.BoxGeometry(...geom.size.map(n => n * 2) as [number, number, number]);
      else if (geom.type === "sphere") geometry = new THREE.SphereGeometry(geom.size[0], 20, 12);
      else { geometry = new THREE.CylinderGeometry(geom.size[0], geom.size[0], geom.size[1] * 2, 24); geometry.rotateX(Math.PI / 2); }
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(...geom.color.slice(0, 3) as [number, number, number]), roughness: .78 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.fromArray(geom.position);
      const q = geom.quaternion; mesh.quaternion.set(q[1], q[2], q[3], q[0]);
      mesh.castShadow = geom.body_id !== 0; mesh.receiveShadow = true;
      mesh.userData = { bodyId: geom.body_id, movable: geom.movable, name: geom.body_name };
      group.add(mesh); meshes.push(mesh);
    }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane();
    const hitPoint = new THREE.Vector3();
    let dragging = false;
    let selected: THREE.Mesh | null = null;
    let frame = 0;
    let lastMove = 0;
    function ray(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
    }
    function down(event: PointerEvent) {
      if (!interactive || event.button !== 0) return;
      ray(event);
      const hit = raycaster.intersectObjects(meshes)[0];
      if (!hit || !hit.object.userData.movable) return;
      event.stopImmediatePropagation();
      controls.enabled = false; dragging = true;
      renderer.domElement.setPointerCapture(event.pointerId);
      selected = hit.object as THREE.Mesh;
      (selected.material as THREE.MeshStandardMaterial).emissive.set("#645432");
      dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
      onCommand({ type: "grab", body_id: hit.object.userData.bodyId, point: hit.point.toArray() });
      onSelect(hit.object.userData.name);
    }
    function move(event: PointerEvent) {
      if (!interactive) return;
      ray(event);
      if (!dragging) {
        const hit = raycaster.intersectObjects(meshes)[0];
        renderer.domElement.style.cursor = hit?.object.userData.movable ? "grab" : "default";
        return;
      }
      event.stopImmediatePropagation();
      if (performance.now() - lastMove < 25) return;
      if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
        onCommand({ type: "move", target: hitPoint.toArray() }); lastMove = performance.now();
      }
    }
    function up() {
      if (!dragging) return;
      dragging = false; controls.enabled = true;
      if (selected) (selected.material as THREE.MeshStandardMaterial).emissive.set(0x000000);
      selected = null;
      onCommand({ type: "release" });
    }
    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("pointermove", move, true);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("lostpointercapture", up);
    window.addEventListener("pointerup", up);
    window.addEventListener("blur", up);
    function animate() {
      const snapshot = stateRef.current ?? session.state;
      for (const [id, group] of groups) {
        const pose = snapshot.bodies[id];
        if (pose) { group.position.set(pose[0], pose[1], pose[2]); group.quaternion.set(pose[4], pose[5], pose[6], pose[3]); }
      }
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    }
    animate();
    onCanvas(canvas);
    return () => {
      up(); onCanvas(null); cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", down, true); canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      window.removeEventListener("pointerup", up); window.removeEventListener("blur", up);
      controls.dispose();
      meshes.forEach(mesh => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); });
      renderer.dispose(); canvas.remove();
    };
  }, [session, stateRef, onCommand, onCanvas, onSelect, interactive, goal]);
  return <div ref={host} className="room-canvas">{error && <div className="room-empty">{error}</div>}</div>;
}
