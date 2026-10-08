"""Files of a standalone MuJoCo Playground bundle. `__KEY__` placeholders are filled by playground_export."""
from __future__ import annotations

import json
import re
from typing import Callable

ROOM_PICK = '''"""Franka Panda task in a Reactor-generated room, for MuJoCo Playground (MJX).

__ROBOT_TASK__. Uses PandaPickCube's actuators and state observations with the website's ordered
task contract, task-specific rewards, randomized resets and termination on successful completion.
"""
from typing import Any, Dict, Optional, Union

from etils import epath
import jax
import jax.numpy as jp
from ml_collections import config_dict

from mujoco_playground._src import mjx_env
from mujoco_playground._src.manipulation.franka_emika_panda import panda
from mujoco_playground._src.manipulation.franka_emika_panda import pick
from mujoco_playground._src.mjx_env import State
from .task_kernel import advance, shaping, CONTRACT_VERSION, HOLD_SECONDS

ENV_NAME = "__ENV_NAME__"
XML_PATH = epath.Path(__file__).parent / "xmls" / "__XML_NAME__"
SPAWN_LOW = __SPAWN_LOW__
SPAWN_HIGH = __SPAWN_HIGH__
TARGET_LOW = __TARGET_LOW__
TARGET_HIGH = __TARGET_HIGH__
TASK_KIND = "__TASK_KIND__"
LIFT_HEIGHT = __LIFT_HEIGHT__  # meters above the spawn height that count as lifted
GOAL_TOLERANCE = 0.02
CHECKS = ("grasped", "lifted", "in_goal", "released", "task_success", "task_progress", "task_reward")
TOTAL_STEPS = {"reach": 2, "push": 4, "lift": 4, "place": 6}[TASK_KIND]


def default_config() -> config_dict.ConfigDict:
  config = pick.default_config()
  # Portable default; pass config_overrides={"impl": "warp"} on NVIDIA GPUs.
  config.impl = "jax"
  config.njmax = 256
  config.ctrl_dt = 0.04  # same 25 Hz control rate as the browser simulation
  config.episode_length = 750  # 30 seconds for the complete manipulation sequence
  return config


class RoomPick(pick.PandaPickCube):
  """PandaPickCube with this room's geometry, object and target region."""

  def __init__(
      self,
      config: Optional[config_dict.ConfigDict] = None,
      config_overrides: Optional[Dict[str, Union[str, int, list[Any]]]] = None,
  ):
    mjx_env.ensure_menagerie_exists()
    panda.PandaBase.__init__(self, XML_PATH, config or default_config(), config_overrides)
    self._post_init(obj_name="box", keyframe="home")
    self._sample_orientation = False
    self._floor_hand_found_sensor = [
        self._mj_model.sensor(f"{geom}_floor_found").id
        for geom in ["left_finger_pad", "right_finger_pad", "hand_capsule"]
    ]
    self._pad_box_sensors = [
        self._mj_model.sensor_adr[self._mj_model.sensor(f"{pad}_box_found").id]
        for pad in ("left_finger_pad", "right_finger_pad")
    ]
    self._finger_qposadr = self._robot_qposadr[-2]
    self._obj_dofadr = self._mj_model.jnt_dofadr[self._mj_model.body_jntadr[self._obj_body]]
    self._hold_steps = max(1, round(HOLD_SECONDS / self.dt))

  def _task_observation(self, data, info):
    contacts = sum((data.sensordata[adr] > 0).astype(int) for adr in self._pad_box_sensors)
    return (data.site_xpos[self._gripper_site], data.xpos[self._obj_body], info["item_start"],
            jp.linalg.norm(data.qvel[self._obj_dofadr:self._obj_dofadr + 3]), contacts,
            data.qpos[self._finger_qposadr], jp.array(TARGET_LOW), jp.array(TARGET_HIGH))

  def _get_obs(self, data, info):
    # The policy sees task history, hold duration and the actual randomized starting position.
    return jp.concatenate([super()._get_obs(data, info),
                           jp.array([info["task_index"] / TOTAL_STEPS, info["task_held"] / self._hold_steps]),
                           info["item_start"]])

  def step(self, state: State, action: jax.Array) -> State:
    previous = state.info["task_index"]
    state = super().step(state, action)
    observation = self._task_observation(state.data, state.info)
    index, held, checks = advance(jp, TASK_KIND, previous, state.info["task_held"], *observation, self._hold_steps)
    dense = shaping(jp, TASK_KIND, previous, held, *observation, self._hold_steps)
    success = checks["task_success"]
    # Stage bonuses and a completion bonus; the running cost discourages stalling at an easy stage.
    reward = (2.0 * (index - previous) + 10.0 * success
              + self.dt * (dense - 1.0 - .01 * jp.mean(jp.square(action))) - 5.0 * state.done)
    reward = jp.where(previous == TOTAL_STEPS, 0.0, reward)
    info = {**state.info, "task_index": index, "task_held": held}
    metrics = {**state.metrics, **{name: value.astype(float) for name, value in checks.items()},
               "task_progress": index.astype(float) / TOTAL_STEPS, "task_reward": reward}
    return state.replace(info=info, obs=self._get_obs(state.data, info), reward=reward,
                         done=jp.maximum(state.done, success.astype(float)), metrics=metrics)

  def reset(self, rng: jax.Array) -> State:
    rng, rng_box, rng_target = jax.random.split(rng, 3)
    box_pos = jax.random.uniform(rng_box, (3,), minval=jp.array(SPAWN_LOW), maxval=jp.array(SPAWN_HIGH))
    target_pos = jax.random.uniform(rng_target, (3,), minval=jp.array(TARGET_LOW), maxval=jp.array(TARGET_HIGH))
    if TASK_KIND == "reach":
      target_pos = box_pos + jp.array([0.0, 0.0, 0.03])
    init_q = jp.array(self._init_q).at[self._obj_qposadr : self._obj_qposadr + 3].set(box_pos)
    data = mjx_env.make_data(
        self._mj_model,
        qpos=init_q,
        qvel=jp.zeros(self._mjx_model.nv, dtype=float),
        ctrl=self._init_ctrl,
        impl=self._mjx_model.impl.value,
        naconmax=self._config.naconmax,
        naccdmax=self._config.naccdmax,
        njmax=self._config.njmax,
    )
    data = data.replace(
        mocap_pos=data.mocap_pos.at[self._mocap_target, :].set(target_pos),
        mocap_quat=data.mocap_quat.at[self._mocap_target, :].set(jp.array([1.0, 0.0, 0.0, 0.0])),
    )
    metrics = {
        "out_of_bounds": jp.array(0.0, dtype=float),
        **{k: 0.0 for k in self._config.reward_config.scales.keys()},
        **{name: jp.array(0.0, dtype=float) for name in CHECKS},
    }
    info = {"rng": rng, "target_pos": target_pos, "reached_box": 0.0, "item_start": box_pos,
            "task_index": jp.array(0, dtype=int), "task_held": jp.array(0, dtype=int)}
    obs = self._get_obs(data, info)
    reward, done = jp.zeros(2)
    return State(data, obs, reward, done, metrics, info)
'''

INIT = '''"""Registers __ENV_NAME__ with MuJoCo Playground's manipulation registry."""
from mujoco_playground import manipulation

from . import room_pick
from .room_pick import ENV_NAME, RoomPick, default_config

manipulation.register_environment(ENV_NAME, RoomPick, default_config)

__all__ = ["ENV_NAME", "RoomPick", "default_config", "room_pick"]
'''

SMOKE_TEST = '''"""Check __ENV_NAME__ in native MuJoCo and MJX, then run a few jitted steps. Exit 1 on failure."""
import argparse
import json
import sys
import time

import jax
import jax.numpy as jp
import mujoco
from mujoco import mjx
import numpy as np

from mujoco_playground import registry
from mujoco_playground._src import mjx_env
from mujoco_playground._src.manipulation.franka_emika_panda import panda
import room_envs


def native_checks():
  mjx_env.ensure_menagerie_exists()
  model = mujoco.MjModel.from_xml_string(room_envs.room_pick.XML_PATH.read_text(), assets=panda.get_assets())
  data = mujoco.MjData(model)
  key = model.key("home").id
  mujoco.mj_resetDataKeyframe(model, data, key)
  mujoco.mj_forward(model, data)
  robot = {model.geom(name).id for name in ("left_finger_pad", "right_finger_pad", "hand_capsule")}
  touching = sum(1 for c in data.contact[: data.ncon] if (c.geom1 in robot or c.geom2 in robot) and c.dist < 0)
  box = model.body("box").id
  start = data.xpos[box].copy()
  for _ in range(200):  # one second with the arm holding its home pose
    data.ctrl[:] = model.key_ctrl[key]
    mujoco.mj_step(model, data)
  cylinders = sum(1 for i in range(model.ngeom) if model.geom_type[i] == mujoco.mjtGeom.mjGEOM_CYLINDER
                  and (model.geom_contype[i] or model.geom_conaffinity[i]))
  mjx.put_model(model, impl="jax")  # raises on features the MJX JAX backend cannot simulate
  return {"compiled": True, "mjx_jax_put_model": True, "nq": int(model.nq), "ngeom": int(model.ngeom),
          "home_robot_contacts": int(touching), "settle_displacement_m": round(float(np.linalg.norm(data.xpos[box] - start)), 4),
          "colliding_cylinders": int(cylinders), "native_finite": bool(np.isfinite(data.qpos).all())}


def mjx_checks(impl, steps):
  env = registry.load(room_envs.ENV_NAME, config_overrides={"impl": impl})
  reset, step = jax.jit(env.reset), jax.jit(env.step)
  started = time.time()
  state = step(reset(jax.random.PRNGKey(0)), jp.zeros(env.action_size))
  jax.block_until_ready(state.obs)
  compiled = time.time() - started
  rewards = []
  for _ in range(steps):
    state = step(state, jp.zeros(env.action_size))
    rewards.append(float(state.reward))
  obs = np.asarray(state.obs)
  assert set(room_envs.room_pick.CHECKS) <= set(state.metrics), "task checks are missing from metrics"
  return {"impl": impl, "jit_seconds": round(compiled, 1), "observation_size": int(obs.shape[-1]),
          "task_checks": ",".join(room_envs.room_pick.CHECKS), "task_contract": room_envs.room_pick.CONTRACT_VERSION,
          "action_size": int(env.action_size), "steps": steps, "mean_reward": round(float(np.mean(rewards)), 4),
          "episode_done": bool(float(state.done)), "mjx_finite": bool(np.isfinite(obs).all() and np.isfinite(rewards).all())}


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--impl", choices=["jax", "warp"], default="jax")
  parser.add_argument("--steps", type=int, default=10)
  parser.add_argument("--json", help="also write the checks to this file")
  args = parser.parse_args()
  checks = native_checks()
  checks.update(mjx_checks(args.impl, args.steps))
  checks["passed"] = bool(checks["home_robot_contacts"] == 0 and checks["settle_displacement_m"] < 0.01
                          and checks["colliding_cylinders"] == 0 and checks["native_finite"]
                          and checks["mjx_finite"] and not checks["episode_done"])
  print(json.dumps(checks, indent=2))
  if args.json:
    with open(args.json, "w") as handle:
      json.dump(checks, handle, indent=2)
  sys.exit(0 if checks["passed"] else 1)


if __name__ == "__main__":
  main()
'''

TRAIN = '''"""Train __ENV_NAME__ with MuJoCo Playground's tuned Brax PPO settings for PandaPickCube."""
import argparse
import functools
import json
import pathlib
import time

import jax
from brax.io import model as brax_model
from brax.training.agents.ppo import networks as ppo_networks
from brax.training.agents.ppo import train as ppo
from mujoco_playground import registry
from mujoco_playground import wrapper
from mujoco_playground.config import manipulation_params
import room_envs


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--impl", choices=["jax", "warp"], default="jax", help="warp is fastest on NVIDIA GPUs")
  parser.add_argument("--num-timesteps", type=int, help="default: Playground's PandaPickCube budget")
  parser.add_argument("--num-envs", type=int, help="parallel environments (smaller for CPU runs)")
  parser.add_argument("--seed", type=int, default=0)
  parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("training"))
  parser.add_argument("--video", action="store_true", help="render one deterministic rollout to OUTPUT/rollout.mp4")
  args = parser.parse_args()
  args.output.mkdir(parents=True, exist_ok=True)
  overrides = {"impl": args.impl}
  env = registry.load(room_envs.ENV_NAME, config_overrides=overrides)
  eval_env = registry.load(room_envs.ENV_NAME, config_overrides=overrides)
  # The PandaPickCube prefix selects Playground's tuned PPO hyperparameters for this task family.
  params = manipulation_params.brax_ppo_config(room_envs.ENV_NAME, args.impl)
  if args.num_timesteps:
    params.num_timesteps = args.num_timesteps
  if args.num_envs:
    params.num_envs = args.num_envs
    params.batch_size = min(params.batch_size, args.num_envs)
    if "num_eval_envs" in params:
      params.num_eval_envs = min(params.num_eval_envs, args.num_envs)
  training = params.to_dict()
  factory = functools.partial(ppo_networks.make_ppo_networks, **training.pop("network_factory"))
  training["seed"] = args.seed
  history, started = [], time.time()

  def progress(step, metrics):
    entry = {"step": int(step), "seconds": round(time.time() - started, 1),
             "eval_reward": float(metrics.get("eval/episode_reward", float("nan"))),
             # Task success is checked in code by the environment (room_envs.room_pick.task_checks).
             "eval_task_success": float(metrics.get("eval/episode_task_success", float("nan")))}
    history.append(entry)
    print(json.dumps(entry), flush=True)

  make_inference_fn, policy_params, _ = ppo.train(
      environment=env, eval_env=eval_env, wrap_env_fn=wrapper.wrap_for_brax_training,
      network_factory=factory, progress_fn=progress, **training)
  brax_model.save_params(str(args.output / "policy_params"), policy_params)
  (args.output / "metrics.json").write_text(json.dumps({"env": room_envs.ENV_NAME, "impl": args.impl,
                                                        "config": training, "history": history}, indent=2, default=str))
  if args.video:
    import mediapy
    policy = jax.jit(make_inference_fn(policy_params, deterministic=True))
    reset, step = jax.jit(eval_env.reset), jax.jit(eval_env.step)
    rng = jax.random.PRNGKey(args.seed)
    state = reset(rng)
    trajectory = [state]
    for _ in range(int(eval_env._config.episode_length)):
      rng, key = jax.random.split(rng)
      action, _ = policy(state.obs, key)
      state = step(state, action)
      trajectory.append(state)
    frames = eval_env.render(trajectory, height=480, width=640)
    mediapy.write_video(str(args.output / "rollout.mp4"), frames, fps=1.0 / eval_env.dt)
  print(f"Saved policy parameters and metrics to {args.output}")


if __name__ == "__main__":
  main()
'''

PREVIEW = '''"""Render the exported room at its home keyframe with the target marker (native MuJoCo, offscreen)."""
import argparse

import mujoco
import numpy as np
from PIL import Image

from mujoco_playground._src import mjx_env
from mujoco_playground._src.manipulation.franka_emika_panda import panda
import room_envs


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--output", default="preview.png")
  parser.add_argument("--width", type=int, default=1280)
  parser.add_argument("--height", type=int, default=960)
  args = parser.parse_args()
  mjx_env.ensure_menagerie_exists()
  model = mujoco.MjModel.from_xml_string(room_envs.room_pick.XML_PATH.read_text(), assets=panda.get_assets())
  data = mujoco.MjData(model)
  mujoco.mj_resetDataKeyframe(model, data, model.key("home").id)
  low, high = np.array(room_envs.room_pick.TARGET_LOW), np.array(room_envs.room_pick.TARGET_HIGH)
  data.mocap_pos[model.body("mocap_target").mocapid[0]] = (low + high) / 2
  mujoco.mj_forward(model, data)
  camera = mujoco.MjvCamera()
  # Behind and to the right of the Panda, looking along +x over the task surface.
  camera.lookat[:] = [0.45, 0.0, 0.05]
  camera.distance, camera.azimuth, camera.elevation = 1.75, 25, -30
  with mujoco.Renderer(model, args.height, args.width) as renderer:
    renderer.update_scene(data, camera)
    Image.fromarray(renderer.render()).save(args.output)
  print(f"Wrote {args.output}")


if __name__ == "__main__":
  main()
'''


REPLAY = '''"""Replay the website's scripted demo through __ENV_NAME__ (MJX) and report its code-checked task success."""
import argparse
import json
import sys

import jax
import jax.numpy as jp
import numpy as np

from mujoco_playground import registry
import room_envs


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--impl", choices=["jax", "warp"], default="jax")
  parser.add_argument("--json", help="also write the result to this file")
  args = parser.parse_args()
  demo = np.load("demo_ctrl.npz")
  env = registry.load(room_envs.ENV_NAME, config_overrides={"impl": args.impl})
  state = jax.jit(env.reset)(jax.random.PRNGKey(0))
  # Start from the demo's object position and target, as on the website.
  adr = env._obj_qposadr
  data = state.data.replace(qpos=state.data.qpos.at[adr:adr + 3].set(demo["box"]),
                            mocap_pos=state.data.mocap_pos.at[env._mocap_target, :].set(demo["goal"]))
  state = state.replace(data=data, info={**state.info, "target_pos": jp.asarray(demo["goal"], dtype=float),
                                       "item_start": jp.asarray(demo["box"], dtype=float)})
  step = jax.jit(env.step)
  per_tick = max(1, round(1 / float(demo["control_hz"]) / env.dt))
  scale = float(env._config.action_scale)
  checks = {name: 0.0 for name in room_envs.room_pick.CHECKS}
  success_done, success_reward = False, False
  for target in demo["ctrl"]:
    for _ in range(per_tick):
      action = np.clip((target - np.asarray(state.data.ctrl)) / scale, -1, 1)
      state = step(state, jp.asarray(action, dtype=float))
      for name in checks:
        checks[name] = max(checks[name], float(state.metrics[name]))
      if float(state.metrics["task_success"]) >= 1:
        success_done = bool(float(state.done))
        success_reward = float(state.reward) > 0
        break
    if success_done:
      break
  result = {"impl": args.impl, "demo_steps": int(len(demo["ctrl"])), "env_steps": int(len(demo["ctrl"]) * per_tick),
            "replay_success_terminates": success_done, "replay_success_reward": success_reward,
            **{f"replay_{name}": value for name, value in checks.items()}}
  print(json.dumps(result, indent=2))
  if args.json:
    with open(args.json, "w") as handle:
      json.dump(result, handle, indent=2)
  sys.exit(0 if checks["task_success"] >= 1 and success_done and success_reward else 1)


if __name__ == "__main__":
  main()
'''

README = '''# __ROOM_TITLE__ — MuJoCo Playground environment

`__ENV_NAME__` is a Franka Emika Panda task generated from a Reactor LingBot World 2 room.

- **Task:** __TASK_TITLE__. __TASK_GOAL__
- **Robot task:** __ROBOT_TASK__ (MJX, built on Playground's `PandaPickCube`).
- **World:** `__WORLD_ID__`, from `__SOURCE_FILE__` at __SOURCE_T__ s.

## Run

```bash
pip install -r requirements.txt          # add "jax[cuda12]" on NVIDIA GPUs
python smoke_test.py                     # native MuJoCo + MJX checks, a few jitted steps (CPU is fine)
python train.py --impl warp --video      # Playground's tuned PPO budget; use an NVIDIA GPU
python train.py --impl jax --num-envs 64 --num-timesteps 200000   # short CPU pipeline check
python preview.py                        # preview.png at the home keyframe
python replay_demo.py                    # replays the website's scripted demo; checks task_success in code
```

`import room_envs` registers the environment, so Playground tools work too:

```python
import room_envs
from mujoco_playground import registry
env = registry.load(room_envs.ENV_NAME, config_overrides={"impl": "warp"})
```

`colab.ipynb` runs the same steps on a Colab GPU. Upload this bundle's zip when prompted.

## Contents

- `room_envs/xmls/__XML_NAME__`: the room as MJX-safe boxes and planes. It includes Menagerie's `mjx_panda.xml` and
  Playground's `sensor.xml`.
- `room_envs/room_pick.py`: `PandaPickCube` with this room's object spawn and target regions.
- `room_envs/task_kernel.py`: the same ordered success contract used by the browser simulator.
- `manifest.json`: provenance (source video, Reactor session, reconstruction), checks, file hashes.
- `references/`: the beginning image, the Reactor arrival frame and scan video, the plan and the reconstruction.

## Notes

Actions are eight joint/gripper actuator increments at 25 Hz. Observations include robot/object state,
the current task stage, hold duration and randomized object start. Episodes end on ordered task success,
invalid simulation state, an out-of-bounds object, or the 30-second training wrapper limit.
Rewards combine phase-specific distance shaping, a bonus for each completed step and a completion bonus.
Lift requires both finger contacts and a continuous one-second hold. Place requires reach, grasp, lift,
carry, settling, then release and gripper retreat, in order. This is a rigid-object robot subtask derived
from human footage; cloth deformation, washing and fluid dynamics are not simulated.

The room is a primitive approximation reconstructed from a Reactor-generated walkthrough, with estimated scale.
Furniture is static, and only the gripper's hand capsule and finger pads collide, following Playground's Panda models.
Evaluate any policy before using it on hardware.

Source footage: __ATTRIBUTION__ (__SOURCE_URL__).
'''

REQUIREMENTS = '''playground==__PLAYGROUND_VERSION__
mediapy
pillow
# NVIDIA GPUs: pip install "jax[cuda12]" and run with --impl warp
'''


def notebook(values: dict) -> str:
    def code(source: str) -> dict:
        return {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": source}

    def markdown(source: str) -> dict:
        return {"cell_type": "markdown", "metadata": {}, "source": source}

    cells = [
        markdown(f"# {values['ROOM_TITLE']}: MuJoCo Playground on a Colab GPU\n\n"
                 f"Trains `{values['ENV_NAME']}` ({values['ROBOT_TASK']}) with Playground's tuned PPO settings. "
                 "Use a GPU runtime."),
        code(f"!pip install -q -U \"playground=={values['PLAYGROUND_VERSION']}\" \"jax[cuda12]\" mediapy"),
        code("from google.colab import files\nuploaded = files.upload()  # choose this bundle's .zip\n"
             "name = next(iter(uploaded))\n!unzip -o -q \"$name\" -d /content/bundle"),
        code(f"%cd /content/bundle/{values['BUNDLE']}\n!python smoke_test.py --impl warp"),
        code("!python train.py --impl warp --video --output training"),
        code("import mediapy\nmediapy.show_video(mediapy.read_video('training/rollout.mp4'), fps=50)"),
    ]
    return json.dumps({"cells": cells, "metadata": {"accelerator": "GPU", "kernelspec": {"name": "python3", "display_name": "Python 3"}},
                       "nbformat": 4, "nbformat_minor": 5}, indent=1) + "\n"


FILES: dict[str, str | Callable[[dict], str]] = {
    "room_envs/__init__.py": INIT,
    "room_envs/room_pick.py": ROOM_PICK,
    "smoke_test.py": SMOKE_TEST,
    "train.py": TRAIN,
    "preview.py": PREVIEW,
    "replay_demo.py": REPLAY,
    "README.md": README,
    "requirements.txt": REQUIREMENTS,
    "colab.ipynb": notebook,
}


def render(template: str | Callable[[dict], str], values: dict) -> str:
    if callable(template):
        return template(values)
    safe = {key: str(value).replace('"""', "'''") for key, value in values.items()}
    return re.sub(r"__([A-Z_]+)__", lambda match: safe.get(match.group(1), match.group(0)), template)
