import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type {
  ConnectionStatus,
  StatusChangeCallback,
  ToolsChangedCallback,
  UpstreamClient,
} from "../../src/upstream/types.js";

export interface RecordedToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** An upstream client whose state a test drives by hand. */
export class ScriptedUpstreamClient implements UpstreamClient {
  status: ConnectionStatus = "disconnected";
  tools: Tool[] = [];
  instructions: string | undefined;
  connects = 0;
  retries = 0;
  closed = false;
  readonly calls: RecordedToolCall[] = [];
  /** What a connect attempt does; by default it connects. */
  attempt: () => Promise<void> = async () => this.setStatus("connected");
  /** What a tool call returns; by default a text result naming the tool. */
  answer: (call: RecordedToolCall) => Promise<CallToolResult> = async (call) => ({
    content: [{ type: "text", text: `called ${call.name}` }],
  });
  private readonly _status = new Set<StatusChangeCallback>();
  private readonly _tools = new Set<ToolsChangedCallback>();

  constructor(readonly name: string) {}

  setStatus(current: ConnectionStatus, error?: Error): void {
    const previous = this.status;
    if (previous === current) return;
    this.status = current;
    for (const listener of [...this._status]) listener({ previous, current, ...(error && { error }) });
  }

  setTools(tools: Tool[]): void {
    this.tools = tools;
    for (const listener of [...this._tools]) listener(tools);
  }

  async connect(): Promise<void> {
    this.connects++;
    this.setStatus("connecting");
    try {
      await this.attempt();
    } catch (err) {
      this.setStatus("disconnected", err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async retryNow(): Promise<void> {
    this.retries++;
    if (this.status === "connected") return;
    await this.connect().catch(() => {});
  }

  async reconnect(): Promise<void> {
    await this.connect();
  }

  async ping(): Promise<void> {}

  async callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<CallToolResult> {
    if (this.status !== "connected") throw new Error(`Cannot call tool "${params.name}": client "${this.name}" is not connected`);
    const call = { ...params, ...(options?.signal && { signal: options.signal }) };
    this.calls.push(call);
    return this.answer(call);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.setStatus("disconnected");
  }

  onStatusChange(callback: StatusChangeCallback): () => void {
    this._status.add(callback);
    return () => this._status.delete(callback);
  }

  onToolsChanged(callback: ToolsChangedCallback): () => void {
    this._tools.add(callback);
    return () => this._tools.delete(callback);
  }
}

export function tool(name: string): Tool {
  return { name, inputSchema: { type: "object" } };
}
