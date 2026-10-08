# world-model-hack

## Reactor rendering for the physics labs

Open `/worlds?mode=physics` and choose **Start high fidelity view**. The live
1280×704 MuJoCo camera is streamed to `reactor/sana-streaming` at 24 fps; the
generated frames fill the main world view. Walking, joint control, contact checks
and task rewards continue in MuJoCo. **Simulation** shows the source camera,
and **Reactor view** shows the generated output. Natural, Studio and Evening shift
lighting and a short appearance prompt update the same model session.

The model re-anchors to the source every five chunks to reduce drift. Live status
requires both generated chunks and decoded video frames. Room changes reuse the
camera track and session. A stalled stream exposes the simulation; leaving,
hiding the tab or two idle minutes releases the session. `REACTOR_API_KEY` enables this paid renderer. Generated video can lag
or alter visual details; it does not determine physical success.

Run `WORLDS_TEST_URL=http://127.0.0.1:3003 node scripts/check-reactor-physics.mjs`
for an explicit live model check with screenshots, camera/control checks and
session cleanup. Normal browser tests mock Reactor authentication.

## MuJoCo Playground task library

`/lab` catalogs the rooms generated from `data/` footage. Each task exposes its
source recording and time, Reactor walkthrough, native robot demonstration and
Reactor-rendered demonstration when available. **Build gym + render** resumes
the reconstruction → native demo → Reactor render → MJX export pipeline. The
library distinguishes playable simulations from training bundles whose complete
demonstrations passed native MuJoCo and MJX replay. Failed tasks remain visible
with the reason they need review.

Exports register with MuJoCo Playground and include PPO training scripts and a
Colab notebook. Native and JAX environments share the ordered task contract:
lift requires a continuous one-second hold; place requires reaching, grasping,
lifting, carrying, settling, releasing and retreating. At 25 Hz the policy sees
71 state values and controls eight joint/gripper actuators. Task-stage bonuses,
phase shaping and a completion bonus drive the reward; successful completion
terminates the episode. A wrapper limits training episodes to 30 seconds.

The environment uses approximate rigid geometry reconstructed from generated
video, with estimated scale. Human footage supplies the setting and task context,
not robot action labels. Cloth and fluid simulation and trained policy weights
are not included. The library's “Training ready” label requires a current task
contract, successful JIT checks and a successful complete MJX demonstration replay.

## Playable task world

The default page, `/play`, opens **Fieldwork**: one connected 3D world with dishes,
laundry, and drawing rooms, each containing three tasks. A skippable ten-second
demonstration introduces the world. The source footage comes from the local
`data/` recordings; prepare small clips and posters once with:

```bash
pnpm install
pnpm world:prepare
pnpm rooms:dev
```

Open [http://127.0.0.1:3000/play](http://127.0.0.1:3000/play). Use **W A S D**
to walk, **Shift** to move faster, drag to look, and **E** to use a nearby
station. **Esc** returns to walking. Room cards walk the avatar through the
shared corridor and doorways. Drag the sponge, plate, garment edges, or pencil
at a station; task instructions and progress appear below the view. Room state
and completed tasks persist while the same world session remains open.

**Start live Reactor view** sends the moving Three.js camera to the real
`reactor/sana-streaming` model at 1280×704 / 24 fps. One session remains connected
as the avatar walks between rooms, with room and task prompts updated in place.
Reactor supplies generated video appearance; the Three.js camera and shared
MuJoCo scene supply movement, collisions, objects, and task outcomes. Generated
video can lag or drift from that physical state. `REACTOR_API_KEY` in `.env`
enables this optional paid view; walking and tasks work without it. Disconnecting
or leaving the page closes the model session and camera track.

These nine tasks are interactive practice scenarios. Folding uses scripted
creases on a rigid proxy, and rinsing checks the plate's position under the tap.
They do not provide cloth or fluid simulation, or automatically become robot
training tasks. The separate robot gym workflows below provide that interface.

`pnpm test:play` verifies all nine tasks with actual browser pointer input,
walking, demos, media seeking, and error handling without starting Reactor.
`pnpm test:rooms` and `uv run --extra test pytest tests/test_task_world.py` cover
movement, physics, task rules, and session cleanup. To explicitly verify one
paid live session against a running app, run `pnpm world:reactor-check` (set
`PLAY_BASE_URL` for a nondefault port); screenshots and the result are saved
under `.task-rooms/world/reactor-check-*`.

## Generated robot worlds

Open `/worlds` for a fullscreen **Reactor LingBot World 2** experiment in eleven
distinct places. **Enter Reactor world** starts a real session anchored to the
room's image. W A S D, drag and arrow keys send native camera/movement commands
directly to the world model. The room, robot and objects are generated video.
**Reach**, **Close fingers**, **Lift / Push / Align**, and **Place** change the
robot instruction layer; E advances through these instructions. **New variation**
changes the seed and task variation. These instructions steer a visual experiment;
they do not measure joint state or prove a grasp succeeded. **Save 10 s clip**
downloads the real Reactor recording. Room navigation reuses the connection and
reseeds it for the destination; leaving, hiding the tab, or two idle minutes
releases it. At 45 idle seconds generation pauses, but the session still exists.

**Direct the robot** accepts a short task description and sends it to Reactor's
live prompt layer in the same room and session. Camera movement preserves this
instruction; choosing a phase or a new variation returns to the standard task.

**Run task** asks Reactor to generate the complete reach, push, or lift sequence.
Each step advances only after the model reports frames generated with that exact
instruction. Movement, dragging, a manual task phase, or **Stop sequence** returns
control to the user. The progress bar measures generated video, not physical
success. **Direct the world** changes lighting, materials, and surroundings in the
same live session; scene instructions persist while walking and directing the robot.
The **next room** portal generates a doorway approach and forward walk before
reseeding the destination. Directory cards remain immediate room changes.

Session creation is serialized. Readiness and SDP polling can wait on the same
session across multiple checks, with a separate bounded transport timeout.
A quota response shows a countdown,
honors Reactor's retry hint, and makes at most two automatic retries with backoff
within two minutes. Cooldowns persist across reloads and tabs on the same origin;
**Cancel automatic retry** stops the pending request. Browsing the recorded rooms
continues without opening a live session.

Recorded previews work without starting a paid session. References remain in
`public/robot-worlds`; new LingBot scans and their provenance live in
`public/reactor-gyms` and `.task-rooms/reactor-gyms`. To record missing worlds:

```bash
uv run python -m task_rooms.reactor_gyms --seed-source reference
```

This serial, bounded command uses real Reactor sessions and retries transient
capacity errors up to three times. It marks outputs `needs_review`; only records
reviewed and marked `ready` appear as new previews. This review covers usable
room appearance, not accurate robot articulation or successful manipulation.
Cached generations already present in the workspace are reused with their
original receipts. `--seed-source footage`
first attempts a SANA edit of `data/000/3_video.mp4`. The initial greenhouse edit
was rejected for distorted imagery and is not used in the app. Reference mode
explicitly records the existing images' imagegen provenance. No Reactor image
generation API is used. Reactor's hosted video models do not return textured
meshes, depth, calibrated robot dynamics, or MJCF. Generating a faithful physical
gym still requires an additional geometry/asset reconstruction stage.

For one explicit paid live verification, run
`WORLDS_TEST_URL=http://127.0.0.1:3003 node scripts/check-reactor-gym.mjs`.
It checks decoded frames, movement, task prompt changes, room switching, and
disconnect cleanup; screenshots still require visual review for task correctness.

The opt-in `node scripts/check-reactor-director.mjs` additionally checks a full
task sequence, scene direction, movement interruption, custom robot instructions,
and a generated doorway walk within one connection. It writes screenshots and a
JSON report under `.task-rooms/qa/reactor-director-*` and always releases the session.

**Physics prototype** opens the articulated MuJoCo experience at
`/worlds?mode=physics`, with a glasshouse,
kitchen, warehouse, orbital lab, pottery studio, cleanroom, laundry, underwater
outpost, observatory, assembly workshop, and polar research lab. Every room has
ten child doors, each leading to a setting different from its current room.
Walk with **W A S D**, drag to look, and click a door or directory card to enter.
Use the arrow keys to move the robot, **R / F** to raise/lower it, and **Space**
to open/close the gripper. Touch controls, reset, and physical task demos are included.
Completion is measured from MuJoCo state and physical finger contacts.
The arm is the seven-joint Franka Emika Panda from MuJoCo Menagerie, with its
licensed visual meshes, mass/inertia, joint limits, full arm collisions, and
coupled fingers. Cartesian commands are solved into joint actuator targets;
the arm and objects are never teleported to complete a task. The mesh assets
and Apache-2.0 license are vendored under `server/room_sim/assets/panda`.

The image → video → 3D workflow uses built-in imagegen for the eleven room images,
then real `reactor/sana-streaming` sessions to animate them. Generated images,
cached videos, and image prompts live in `public/robot-worlds/`. Reactor runtime
schemas, session receipts, hashes, prompts, and captured originals are under
`.task-rooms/world-visuals/`. Regenerate missing videos with:

```bash
uv run python -m task_rooms.world_videos
```

This older appearance command uses paid Reactor sessions, caches results by image/output hash, serializes
requests, and releases each session. The current runtime accepts a video track,
so each image is encoded as an eight-second reference clip before animation.
No Reactor image API is used. Images and videos provide appearance; generated
scenery is combined with distinct procedural 3D interiors and physical workbenches.
**Live Reactor** can additionally publish the moving 3D camera and robot to the
world model. Its generated view may visually drift from the physical state.

**Export training gym** downloads the room's MuJoCo scene, articulated Panda,
task/reward definitions, standalone `PandaGym` Gymnasium runtime, and generated
appearance references. Install the bundle's `requirements.txt`, then import
`PandaGym` from `env.py`. The four actions move the Cartesian target and open or
close the fingers; inverse kinematics drives all seven joint actuators.
This is a native MuJoCo/Gymnasium gym; MJX integration with
MuJoCo Playground remains separate. Robot tasks use rigid reach/push/lift actions;
the background artwork is not a recovered collision model or a robot demonstration.
When a reviewed LingBot world exists, its recording, seed and provenance are
included as visual references in the export. They do not replace the prototype's
collision shapes or articulated robot dynamics.

Additional native LingBot recordings, starting frames, prompts and hashes are
cached in `public/robot-worlds/generated` and `.task-rooms/world-generation`.
These provide a fallback when a reviewed `public/reactor-gyms` preview is not
available. `uv run python -m task_rooms.world_assets --theme orbital` regenerates
a missing cached world through a bounded Reactor session.

With the app running, browser checks use `WORLDS_TEST_URL=http://127.0.0.1:3003
pnpm test:robot-worlds-browser`. These tests never start paid Reactor sessions.

## Reactor world gym (`/world`)

A training gym built from one start video: **realistic worlds** generated by Reactor, **real tasks** read from
the footage, and **rewards checked by code** in MuJoCo, exported as MuJoCo Playground environments.

1. **Beginning image.** Pick a recording in `data/000/` and a start time. The server takes the sharpest well-lit
   frame within 1.5 s of that time and crops it to LingBot's 1664×960 frame. Gemini then plans a hub and six task
   rooms (similar, subskill, harder, variation) from what is visible. Each room gets a LingBot prompt and a
   Franka Panda subtask, such as placing the glass tumbler on the drying mat.
2. **Realistic world (Reactor `reactor/lingbot-world-2`).** The hub starts from the real beginning image, and you
   walk it with WASD and mouse-look at 1664×960 @ 48 fps.
   - Each room is recorded by one scripted session (about 20 s). The session levels the downward egocentric view,
     turns toward the room's door, walks in under the room's prompt, and pans around.
   - The frame where the walk ends seeds the live world when you enter that room. Doors are waypoints over the
     generated video, using position estimated from the model's own per-chunk action reports.
3. **Physics.** Gemini reconstructs each room from its Reactor scan: 12 frames, up to three repair passes, and
   MuJoCo validation.
4. **Real task, checked by code.** The room's subtask becomes an ordered step program, checked against simulator
   state: reach → grasp → lift → carry → place → release (or reach → grasp → lift → hold).
   - The simulation is the exact scene that gets exported: a Panda on a pedestal beside the task surface, driven
     from the browser (arrow keys, R/F, Space).
   - **Watch demo** runs a scripted pick-and-place that shows the task is solvable.
   - Reactor `sana-streaming` renders the robot simulation, live in the browser and as the recorded demo. The
     room's Reactor arrival frame is the backdrop, so the robot appears inside the generated room.
     Physics stays the ground truth.
5. **Training gym (MuJoCo Playground, MJX).** **Export to MuJoCo Playground** writes a `PandaPickCube`-based
   environment in the robot frame.
   - Geometry is MJX-safe: boxes and planes only.
   - Code-checked metrics: `grasped`, `lifted`, `in_goal`, `released`, `task_success`.
   - Scripts:
     - `smoke_test.py`: native MuJoCo and MJX checks plus jitted steps.
     - `train.py`: Playground's tuned Brax PPO, logging `eval/episode_task_success`.
     - `replay_demo.py`: replays the website demo through MJX and checks success.
     - `preview.py`, `colab.ipynb`.
   - `manifest.json` records source, Reactor sessions, reconstruction, checks and file hashes.

```bash
uv sync --inexact --extra playground --extra test   # playground==0.2.0 (JAX, MJX, Brax)
pnpm rooms:dev                                      # then open http://127.0.0.1:3000/world
```

Headless pipeline:

```bash
pnpm reactor-world:cli sources
pnpm reactor-world:cli plan --source 3 --t 0
pnpm reactor-world:cli scan --world <id> --room 0          # paid LingBot session
pnpm reactor-world:cli reconstruct --world <id> --room 0   # Gemini
pnpm reactor-world:cli export --world <id> --room 0 --output .task-rooms/playground/<name>
pnpm reactor-world:probe                                   # paid LingBot capability gate (hub + one room)
```

**Costs** (from Reactor's pricing API):
- LingBot World 2 is $0.007/s: about $0.14 per room scan, about $1 per world (hub plus six rooms), and $0.42/min
  of live play. Idle live sessions pause after 60 s and end after 120 s.
- `sana-streaming` is $0.0017/s.
- Reactor's 429 quota and capacity responses are retried with backoff. `REACTOR_WORLD_SESSIONS` sets server
  concurrency (default 1); the account allows 5 concurrent sessions and 10 new ones per minute.

**Verified on 2026-10-08:**
- The LingBot capability probe passed (`.task-rooms/reactor-worlds/ddad4a6c1a86068e/probe-report.json`): the
  camera followed the commands, the scene stayed consistent with the seed, and prompt steering entered a new room.
- The browser streamed live LingBot at 1664×960 @ 48 fps.
- World `f4915a2ff0cf4c75` (from `3_video.mp4`) scanned all seven rooms. In room 0 (*Place cup on drying mat*),
  the scripted demo completed 6/6 steps and Reactor rendered it.
- `PandaPickCubeRoom_f4915a2f_0` passed the MJX JAX smoke test (JIT 4.9 s), and replaying the demo gave
  `task_success` 1.0.
- Training at scale is meant for an NVIDIA GPU (`python train.py --impl warp` or the bundled Colab notebook) and
  was not run here.

**Limitations:**
- The world model has no ground-truth geometry, so navigation is a logical layer over generated video.
- Physics is a primitive reconstruction with estimated scale. Furniture is static, and non-task objects are welded.
- As in Playground's Panda models, only the hand and finger pads collide.
- Reactor renders appearance only; it never decides task success.

Code: `server/reactor_world/`, `app/world/`, `tests/test_reactor_world_*.py`, `tests/test_playground_export.py`,
`tests/reactor-world*.{mjs,ts}`.

## Walk through task experiments

Open [http://127.0.0.1:3000/explore](http://127.0.0.1:3000/explore) after running
`pnpm dev`. Walk with **W A S D**, drag to look, and click a doorway to walk
through it. The directory and map also navigate through doors. Each room has
one task and ten children: four similar tasks, two subskills, two advanced
tasks, and two variations. Use the back arrow, breadcrumb trail, or browser
history to return. Room URLs can be bookmarked.

The kitchen, laundry area, bedroom, and drawing desk use footage from `data/`.
Descendants always use the same original environment. The 3D space is a video
gallery for navigation, rather than a recovered physical model of the home.

**Reactor on entry** starts a real `reactor/sana-streaming` experiment when
entering a new child room. Turn it off to explore without new generation.
Returning to a room reuses its saved video; **Run again** creates another
attempt. New experiments incur Reactor charges. One experiment runs at a time,
with at most two waiting, and each Reactor session has a 180-second lease.
No Reactor image API or physical webcam is used.

Set `REACTOR_API_KEY` in `.env`; `GOOGLE_API_KEY` enables automatic action
review. Artifacts are saved under `.task-rooms/experiments/`. Playable output
and task correctness are separate: rejected and unreviewed footage can be
inspected, with its status visible. While waiting, the source is labeled as
reference footage. Task specifications can be saved as JSON. The explorer's
robot gym button opens `/rooms/playground`, where you can drive the gripper,
connect Reactor to its live camera, and replay actual saved PPO evaluations.
The physical editor exports gripper gyms. Video task proposals still need explicit
robot task definitions. The separate physics editor is at `/rooms/simulation`, and
the Helios demo is at `/helios`.

```bash
pnpm test:rooms
pnpm test:worker
pnpm test:browser
pnpm typecheck
pnpm build
```

Browser tests disable automatic generation and never start paid sessions.

Room videos become editable MuJoCo scenes, with direct physical interaction
and a live Reactor video-to-video view at `/rooms/simulation`. The task explorer
remains at `/rooms`, and the original Helios demo is available at `/helios`.

## Room simulations

Requires Node.js 22.14+, pnpm 9.15, Python 3.12, uv, and FFmpeg / FFprobe.
Install and run both local services:

```bash
pnpm install --frozen-lockfile
uv sync --extra test
pnpm rooms:dev
```

Open [http://127.0.0.1:3000/rooms/simulation](http://127.0.0.1:3000/rooms/simulation).
Alternatively run `pnpm rooms:server` and `pnpm dev` in separate terminals.
The physics service binds to `127.0.0.1:8000`; this is a local development app.

- Kitchen, living room, bedroom, and bathroom each have a clearly labeled example
  scene. These examples are available without a model API call.
- Upload a 1–180 second MP4, MOV, or WebM (up to 100 MB). Show the layout from
  several angles and demonstrate doors or drawers you want to reconstruct.
  An optional reference such as “the counter is 95 cm high” helps estimate scale.
- Reconstruction uses `GOOGLE_API_KEY` and `gemini-3.8-flash` by default.
  Twelve timestamped frames ground the scene; every inferred object cites evidence.
  The model uses physical furniture templates, and receives up to two repair
  passes when schema or physics checks fail. Failed candidates remain editable.
- Drag movable objects and handles, drag empty space to orbit, and scroll to zoom.
  The simulation applies forces, with working joints and hollow containers.
  Pause, reset, and replay use fixed simulation ticks. Replay files are saved when
  sessions close. Scene edits validate physics and invalidate older sessions.
- **Start Reactor view** publishes the live simulation canvas to
  `reactor/sana-streaming`; it uses a paid Reactor session and `REACTOR_API_KEY`.
  The drawing buffer stays at 1280×704, captured at 24 fps. Prompt edits and
  periodic source anchoring control appearance. Use the physical view for picking
  and task state; generated video can lag or visually drift.

Room models are functional approximations. Scale is labeled estimated unless
calibrated against the supplied reference. Mass and friction use material priors;
uncertain or occluded geometry may need manual corrections. Original and generated
footage can provide scene references; generated actions are not assumed to be valid
robot demonstrations. Detailed scanning, fluid dynamics, and fabric simulation
are outside this version.

The robot gym panel exports the current room as a portable Gymnasium environment
with a Cartesian gripper, scene provenance, source footage, and a training script.
Its reach, push, and lift goals use simulator state. Video supplies scene references;
it does not provide successful robot demonstrations. These approximate gyms need
task and policy evaluation before use with hardware.

Artifacts live under the ignored `data/room-sim/`: source videos, evidence frames,
reconstruction attempts, provenance hashes, scene JSON/MJCF, and interaction logs.
`ROOM_SIM_HOME` can change that directory. Public HTTP interfaces are proxied by
Next.js at `/api/rooms` and `/api/room-builds`; browser physics uses the local
service's `/sessions/{id}` WebSocket. `ROOM_SIM_URL`, `ROOM_SIM_PORT`, and
`NEXT_PUBLIC_ROOM_SIM_WS_URL` support another local service port.

```bash
pnpm test:worker
pnpm build
pnpm typecheck
```

The room tests cover all four scenes, physical movement and joints, container
cavities, repeatable replay, validation, source evidence, persistence, and
WebSocket cleanup. The implementation adapts
[Video2World's](https://github.com/AetherLabsAI/Video2World) construction loop;
its room packages use our own schema and are not benchmark submissions.
Native MuJoCo runs on CPU. The MJCF scenes can underpin a later
[MuJoCo Playground](https://github.com/google-deepmind/mujoco_playground) robot environment.

## Robot RL gym

Start `pnpm rooms:dev` and open [the robot playground](http://127.0.0.1:3000/rooms/playground).
Click the physical scene and use **WASD** to move across the table, **Q/E** for
height, and **Space** to open or close the gripper. The on-screen buttons work
with mouse or touch. Choose a task, run its scripted demonstration, pause, or
reset with a repeatable seed. Scripted demonstrations are separate from trained
policies; push tasks currently use manual control.

**Start Reactor view** sends the gripper's live 1280×704 camera stream to
`reactor/sana-streaming` at 24 fps. Its generated video appears next to the
physical scene. Edit the appearance prompt and apply it during a session.
Reactor supplies the visual transformation; MuJoCo supplies movement, contact,
and reward. Disconnect to end the paid Reactor session. Changing the room or
task disconnects it automatically.

The kitchen opens with a playable recording of a real SANA session that rendered
the scripted mug lift. It is labeled **Recorded preview** until you start a live
session. The saved clip is in `public/robot-playground/`; its provenance JSON
records source/output hashes and the actual connection check. Reactor's visual
output can change object details and is not a measurement of grasp success.

The playground reads `.task-rooms/training/<room>-ppo/report.json`, verifies the
hash of `scene.json`, and lets you replay every reported evaluation seed using
`policy.zip`. Policy playback uses its frozen training scene and original task.
The current reconstruction remains separately selectable for manual control.
The saved kitchen baseline achieved 1/10 successes after 20,224 PPO steps.
Sessions advance only when controlled or replaying, and close when you leave.

The simulation page includes **Download robot gym**. Choose a starting task to
export the current room revision, an actuated Cartesian gripper, source footage
and evidence, and standalone Python training code. Example rooms remain explicitly
labeled. Existing saved rooms are used without another generation call.

From this repository:

```bash
uv sync --extra train --extra test
uv run rooms-gym list --room kitchen
uv run rooms-gym export --room kitchen --output .task-rooms/gyms/kitchen
uv run rooms-gym check --bundle .task-rooms/gyms/kitchen
uv run rooms-gym rollout --bundle .task-rooms/gyms/kitchen --output .task-rooms/reach.npz
uv run --extra train rooms-train --bundle .task-rooms/gyms/kitchen --timesteps 20000 --output .task-rooms/training/kitchen-ppo
```

Use a new output directory for each export/training run. `--task` selects a task
ID listed in the manifest. `rooms-gym export --video path/to/clip.mp4` adds another
video reference; it is never converted into robot action labels. Matched local
Reactor probe footage includes the original failed action-review report.

An unzipped export runs independently with Python 3.12:

```bash
pip install -r requirements.txt
python train.py --bundle . --timesteps 20000 --output training
```

The environment implements the [Gymnasium interface](https://gymnasium.farama.org/introduction/create_custom_env/)
and trains with [Stable Baselines3 PPO](https://stable-baselines3.readthedocs.io/en/master/modules/ppo.html):

```python
import gymnasium as gym
import room_sim.gym_env

env = gym.make("RoomRobot-v0", scene_path=".task-rooms/gyms/kitchen/scene.json")
observation, info = env.reset(seed=42)
observation, reward, terminated, truncated, info = env.step(env.action_space.sample())
env.close()
```

- The four continuous actions are XYZ position increments (up to 2.5 cm per
  control step) and gripper opening (`-1` closes, `+1` opens). MuJoCo integrates
  at 500 Hz with 20 Hz robot commands. Actuators and contacts move objects.
- Tasks reach above movable objects, push them to supported goals where room
  geometry permits, or lift objects small enough for the gripper. Lift success
  requires two-finger contact; success must persist for three control steps.
  Layout feasibility and learned manipulation performance require evaluation.
- Observations include the room/robot joint state, commanded positions, episode
  time, success dwell counter, achieved goal, and desired goal. These are privileged
  simulator observations. RGB rendering is optional, not video-conditioned control.
- Rewards measure goal progress, distance, effort, and task completion. Dropped
  or out-of-room objects end manipulation episodes; time limits truncate them.
  Seeded resets randomize robot starts and mass/friction by up to 10%.
- Training saves `policy.zip`, the exact scene, episode logs, and evaluation
  success rates on separate seeds. A short smoke run does not establish a useful
  policy. Exported manifests hash the scene, model, runtime, and evidence files.

To record a rollout, add `--video .task-rooms/reach.mp4` (requires OpenGL and
FFmpeg). The default rollout controller is scripted reaching. Use
`--policy .task-rooms/training/kitchen-ppo/policy.zip` to evaluate learned actions.
Headless training does not create a renderer. The gripper is a Cartesian robot
approximation; this does not provide a calibrated hardware-arm or sim-to-real policy.

## Earlier task-video generation experiment

The separate task-video experiment starts with the real videos in `data/` and
tests whether Reactor can generate new actions from footage. Its proposed task
rooms and gym conversion remain gated on that capability. The room simulation
above generates movement through MuJoCo and does not depend on this experiment.

Run the bounded capability probe with Python 3.12, [uv](https://docs.astral.sh/uv/),
FFmpeg, and `REACTOR_API_KEY` / `GOOGLE_API_KEY` in `.env`:

```bash
uv sync --extra test
pnpm reactor:probe
pnpm test:worker
```

The probe uses a ten-second segment of `data/000/3_video.mp4` to test a new
placement goal, an additional action step, and a harder handoff task. It calls
Reactor and incurs normal session charges. Sessions are limited to 180 seconds
and released after each attempt. To choose a different clip or seed:

```bash
uv run rooms-reactor-probe --source data/000/3_video.mp4 --start 8 --seconds 10 --seed 42
```

It checks the live model's schema before choosing the video transport. The
current `reactor/sana-streaming` deployment accepts a `camera` video track but
does not expose the documented `set_mode` / `set_video` commands. For this
deployment, the adapter plays the local clip into the video track at its frame
rate. No physical webcam or Reactor image conditioning is used.

Evidence is saved under `.task-rooms/probes/<run>/`: source and generated videos,
storyboards, runtime schemas, model events, hashes, provenance, and `report.json`.
The Gemini reviewer (default `gemini-3.8-flash`, configurable with `GEMINI_MODEL`)
checks task execution, changed action, scene and object identity, and temporal
coherence. All three cases must pass, followed by a visual review. A failed or
blocked probe does not qualify the task-room feature or any training gym.

The live run on **2026-10-08** failed all three action tests. Its generated
videos preserved the kitchen but repeated the source's sequence of lifting a
plate, adding soap and water, and scrubbing. None performed the requested
placement, rotation sequence, or handoff. The automated video reviews rejected
all three, and visual inspection of the saved storyboards confirmed the repeated
actions. The tested deployment therefore has not qualified for task generation;
that experiment stopped at this gate. Its findings and evidence are retained.

The local evidence is in
`.task-rooms/probes/20261008T154530Z-246425/report.json`, alongside the original
clip, three generated MP4s, and their storyboards. This finding applies to the
tested model deployment, prompts, clip, and seed; it does not establish a general
limit for every Reactor model.

Runtime data, datasets, credentials, and the Python environment are excluded
from Git. The existing Helios demo below remains available during this gate.

## Run locally

Use Node.js 22.14+ and pnpm 9.15.0.

```bash
pnpm install --frozen-lockfile
pnpm reactor:check
pnpm dev
```

Open [http://localhost:3000/helios](http://localhost:3000/helios), click **Connect**, then
choose a prompt or image to start generating. You can change the prompt while
video is streaming, pause or reset generation, and capture a clip. Click
**Disconnect** when finished to release the session.

The existing local `.env` contains `REACTOR_API_KEY`. Next.js loads it on the
server; the browser receives only a short-lived token scoped to
`reactor/helios` or `reactor/sana-streaming`. Keep the development server on localhost: the demo's token
endpoint is intended for local use.

For a new clone, copy `.env.example` to `.env` and fill in `REACTOR_API_KEY`.
Preserve any existing `.env` entries. `GOOGLE_API_KEY` is optional and is not
used by the Reactor demo. Local environment files are excluded from Git.

## Verify

```bash
pnpm reactor:check
pnpm build
pnpm typecheck
```

`reactor:check` verifies the API key and access to `reactor/helios` by minting
a scoped token. It does not create a model session or generate video. The
check never prints the API key or token.

## Code

- `app/api/reactor/token/route.ts` exchanges the server's API key for a
  session-scoped token.
- `app/HeliosApp.tsx` configures the SDK and memoizes the token for its lifetime.
- `app/components/` contains the connection, prompt, image, video, and clip controls.
- `app/lib/prompts.ts` contains the starter scenes and prompt continuations.

Setup follows the [Reactor quickstart](https://docs.reactor.inc/quickstart)
and [authentication guide](https://docs.reactor.inc/authentication).
