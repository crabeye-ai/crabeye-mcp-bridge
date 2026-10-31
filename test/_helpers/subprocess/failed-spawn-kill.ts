import { ChildHandle } from "../../../src/daemon/child-handle.js";

const child = new ChildHandle({
  command: "cbe-command-that-does-not-exist",
  args: [],
  env: {},
  onMessage: () => {},
  onClose: () => {},
  onError: () => {},
});
await child.kill(0);
setTimeout(() => process.stdout.write("survived\n"), 200);
