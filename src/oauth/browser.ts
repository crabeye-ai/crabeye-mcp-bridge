import { spawn } from "node:child_process";
import { platform } from "node:os";
import { windowsPowerShellPath } from "../process/process-utils.js";

const BROWSER_URL_ENV = "CRABEYE_MCP_BRIDGE_BROWSER_URL";

function isSafeLaunchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    // Reject embedded userinfo. Browsers sometimes auto-fill credentials from
    // `https://user:pass@host`; even when they warn, opening such a URL is
    // never something the OAuth flow needs to do.
    if (u.username !== "" || u.password !== "") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort attempt to launch the user's default browser at `url`.
 *
 * - macOS: `open <url>`
 * - Linux: `xdg-open <url>`
 * - Windows: System32's `powershell -NoProfile -NonInteractive -Command Start-Process`
 *   reading the URL from an environment variable, so PowerShell never parses it
 *   as code — picked over `rundll32 url.dll,FileProtocolHandler <url>` (silent
 *   failures with embedded `,` and ANSI-only argv) and `cmd /c start "" <url>`
 *   (cmd.exe re-parses argv so `&`/`|`/`^` in the URL become command separators).
 *   PowerShell isn't detached: started detached, it has no console and runs nothing.
 *
 * Rejects non-http(s) URLs and URLs with embedded userinfo without spawning.
 *
 * Doesn't wait for the browser — never throws and never rejects.
 *
 * @returns `true` once the launcher has started (on Windows, once PowerShell has
 *   exited with code 0); `false` if spawn failed synchronously, the binary was
 *   not found, or PowerShell exited with another code or a signal.
 */
export async function openBrowser(
  url: string,
  options: { _platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  if (!isSafeLaunchUrl(url)) return false;

  const os = options._platform ?? platform();
  let command: string;
  let args: string[];
  let env = process.env;
  let waitsForExit = false;

  switch (os) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = windowsPowerShellPath();
      args = ["-NoProfile", "-NonInteractive", "-Command", `Start-Process $env:${BROWSER_URL_ENV}`];
      env = { ...process.env, [BROWSER_URL_ENV]: url };
      waitsForExit = true;
      break;
    default:
      command = "xdg-open";
      args = [url];
      break;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: !waitsForExit,
        windowsHide: true,
        env,
      });
      child.once("error", () => finish(false));
      if (waitsForExit) child.once("exit", (code) => finish(code === 0));
      child.once("spawn", () => {
        child.unref?.();
        if (!waitsForExit) finish(true);
      });
    } catch {
      finish(false);
    }
  });
}
