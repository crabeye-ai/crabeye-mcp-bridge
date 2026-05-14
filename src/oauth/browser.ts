import { spawn } from "node:child_process";
import { platform } from "node:os";

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
 * - Windows: `powershell -NoProfile -Command Start-Process <url>` — picked
 *   over `rundll32 url.dll,FileProtocolHandler <url>` (silent failures with
 *   embedded `,` and ANSI-only argv) and `cmd /c start "" <url>` (cmd.exe
 *   re-parses argv so `&`/`|`/`^` in the URL become command separators).
 *   `Start-Process` passes the URL via .NET — no shell re-parsing.
 *
 * Rejects non-http(s) URLs and URLs with embedded userinfo without spawning.
 *
 * Fire-and-forget — never throws and never rejects.
 *
 * @returns `true` if the launcher spawned (i.e. the child process started
 *   successfully); `false` if spawn failed synchronously or the binary was
 *   not found. The return value waits on Node's `spawn`/`error` events so
 *   callers get an accurate signal instead of an `setImmediate`-rate guess.
 */
export async function openBrowser(
  url: string,
  options: { _platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  if (!isSafeLaunchUrl(url)) return false;

  const os = options._platform ?? platform();
  let command: string;
  let args: string[];

  switch (os) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "powershell";
      args = ["-NoProfile", "-Command", "Start-Process", url];
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
        detached: true,
      });
      child.once("error", () => finish(false));
      // `spawn` fires when the child process is actually running. Listening
      // here (instead of `setImmediate`) means we don't return `true` for a
      // missing binary that emits `error` slightly later.
      child.once("spawn", () => {
        child.unref?.();
        finish(true);
      });
    } catch {
      finish(false);
    }
  });
}
