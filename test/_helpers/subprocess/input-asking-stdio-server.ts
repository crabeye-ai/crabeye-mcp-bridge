import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { inputAskingServer } from "../input-asking-server.js";

serveStdio(() => inputAskingServer());
