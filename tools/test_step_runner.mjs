import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** 一个步骤拥有自己的进程树及墙钟期限；成功、失败和中止都等待回收。 / Own one step's process tree and wall-clock deadline through completion. */
export async function runTestStep(step, { cwd, env = process.env, captureOutput = false, signal, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs <= 0) throw new Error("test step requires a positive timeoutMs");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256) throw new Error("invalid test output limit");
  if (signal?.aborted) return { status: "aborted", exitCode: 130, output: "", error: "matrix interrupted before step startup" };
  const workingDirectory = path.resolve(cwd ?? process.cwd());
  const windows = process.platform === "win32";
  const windowsRoot = process.env.SystemRoot ?? process.env.windir;
  if (windows && (!windowsRoot || !path.isAbsolute(windowsRoot))) throw new Error("SystemRoot is required to locate the Windows step owner");
  const command = windows
    ? path.join(windowsRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : process.execPath;
  const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(import.meta.dirname, "test_step_job.ps1"), "-Executable", step.command,
    "-ArgumentsBase64", Buffer.from(JSON.stringify(step.args)).toString("base64"), "-WorkingDirectory", workingDirectory]
    : [path.join(import.meta.dirname, "test_step_group.mjs"), Buffer.from(JSON.stringify({ command: step.command, args: step.args })).toString("base64")];
  const stdio = captureOutput ? ["inherit", "pipe", "pipe"] : ["inherit", "inherit", "inherit"];
  if (!windows) stdio.push("ipc");
  const child = spawn(command, args, {
    cwd: workingDirectory, env, windowsHide: true, shell: false, detached: !windows,
    stdio,
  });
  const headLimit = maxOutputBytes - Math.min(64 * 1024, Math.floor(maxOutputBytes / 4));
  const tailLimit = maxOutputBytes - headLimit;
  // 固定两块缓冲，避免大量小 chunk 的 Buffer/数组元数据绕过字节上限。 / Fixed buffers also bound metadata from tiny chunks.
  const head = Buffer.allocUnsafe(captureOutput ? headLimit : 0);
  const tail = Buffer.allocUnsafe(captureOutput ? tailLimit : 0);
  let headBytes = 0, tailBytes = 0, tailOffset = 0, totalBytes = 0;
  let termination, spawnError, cleanupError, cleanupDeadline, reportedExit;
  const cleanupTasks = [];
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  child.once("close", (code, signalName) => finish({ code, signalName }));
  child.on("message", message => {
    if (message?.kind === "step-exit" && Number.isInteger(message.exitCode)) reportedExit = message;
  });
  function collect(chunk) {
    totalBytes += chunk.length;
    const first = chunk.subarray(0, Math.min(chunk.length, headLimit - headBytes));
    if (first.length) { first.copy(head, headBytes); headBytes += first.length; }
    const rest = chunk.subarray(first.length);
    if (rest.length >= tailLimit) {
      rest.subarray(-tailLimit).copy(tail);
      tailBytes = tailLimit;
      tailOffset = 0;
    } else if (rest.length) {
      const length = Math.min(rest.length, tailLimit - tailOffset);
      rest.copy(tail, tailOffset, 0, length);
      if (length < rest.length) rest.copy(tail, 0, length);
      tailOffset = (tailOffset + rest.length) % tailLimit;
      tailBytes = Math.min(tailLimit, tailBytes + rest.length);
    }
  }
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const hasGroup = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  function killGroup(signalName) {
    try { process.kill(-child.pid, signalName); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  function terminate(status) {
    if (termination) return;
    termination = status;
    if (!child.pid) return;
    cleanupDeadline = setTimeout(() => {
      cleanupError = "process cleanup did not complete within 5000ms; abort the remaining matrix";
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ code: null, signalName: null });
    }, 5_000);
    try { if (windows) {
      // 终结 job 的唯一持有者会连同后代回收；不按名称或外部 PID 枚举清理。 / Closing the sole job owner reclaims descendants without global PID searches.
      if (child.exitCode === null && !child.kill()) cleanupError = "could not terminate Windows job owner";
    } else {
      cleanupTasks.push((async () => {
        killGroup("SIGTERM");
        await delay(250);
        if (hasGroup()) killGroup("SIGKILL");
        return false;
      })().catch(error => { cleanupError = error.message; return false; }));
    } } catch (error) { cleanupError = error.message; }
  }
  const onAbort = () => terminate("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => terminate("timed-out"), step.timeoutMs);
  child.on("error", error => { spawnError = error.message; });
  child.on("exit", () => {
    if (windows || termination || !child.pid) return;
    cleanupTasks.push((async () => {
      for (let attempt = 0; attempt < 50 && hasGroup(); attempt++) await delay(10);
      if (!hasGroup()) return false;
      killGroup("SIGKILL");
      return true;
    })().catch(error => { cleanupError = error.message; return true; }));
  });
  const ended = await completion;
  let leaked = false;
  for (const cleanup of cleanupTasks) leaked = await cleanup || leaked;
  clearTimeout(timer);
  clearTimeout(cleanupDeadline);
  signal?.removeEventListener("abort", onAbort);
  const tailStart = (tailOffset - tailBytes + tailLimit) % tailLimit;
  const tailContent = tailStart + tailBytes <= tailLimit ? tail.subarray(tailStart, tailStart + tailBytes)
    : Buffer.concat([tail.subarray(tailStart), tail.subarray(0, tailOffset)]);
  const output = head.subarray(0, headBytes).toString("utf8")
    + (totalBytes > maxOutputBytes ? `\n[test-step] output truncated (${totalBytes - maxOutputBytes} bytes omitted)\n` : "")
    + tailContent.toString("utf8");
  const exitCode = termination === "timed-out" ? 124 : termination === "aborted" ? 130
    : leaked || cleanupError ? 125 : reportedExit?.exitCode ?? ended.code ?? 1;
  return { status: termination ?? (exitCode === 0 ? "passed" : "failed"), exitCode,
    signal: ended.signalName ?? undefined, output, outputTruncated: totalBytes > maxOutputBytes,
    error: cleanupError ?? spawnError ?? reportedExit?.error ?? (leaked ? "command left descendant processes" : termination === "timed-out" ? `step exceeded ${step.timeoutMs}ms` : termination === "aborted" ? "matrix interrupted" : undefined),
    cleanupFailed: Boolean(cleanupError) };
}
