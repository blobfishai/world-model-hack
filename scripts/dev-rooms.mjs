import { spawn } from "node:child_process";

const grouped = process.platform !== "win32";
const children = [
  spawn("uv", ["run", "--extra", "train", "rooms-server"], { stdio: "inherit", detached: grouped }),
  spawn("pnpm", ["dev"], { stdio: "inherit", detached: grouped }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try { if (grouped) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* Already stopped. */ }
  }
  const deadline = setTimeout(() => {
    for (const child of children) {
      if (!child.pid || child.exitCode !== null) continue;
      try { if (grouped) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already stopped. */ }
    }
  }, 5000);
  deadline.unref();
}
for (const child of children) {
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => { if (!stopping) stop(code ?? 1); });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
