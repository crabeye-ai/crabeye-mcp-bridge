export interface SearchQuery {
  tool?: string;
  provider?: string;
  category?: string;
  expand_tools?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchToolsParams {
  queries: SearchQuery[];
}

export interface RunToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface SearchToolResult {
  tool_name: string;
  source: string;
  description: string;
  input_schema: object;
  disabled?: true;
}

/** Why a server a search matched isn't connected. */
export type ProviderStatus = "starting" | "not_connected" | "needs_authorization";

export interface ProviderResult {
  name: string;
  category?: string;
  tool_count: number;
  tools: SearchToolResult[];
  /** Set when the server isn't connected. */
  status?: ProviderStatus;
  /** What the status means for the model, set with `status`. */
  message?: string;
}

export interface QueryResult {
  providers: ProviderResult[];
  total: number;
  count: number;
  remaining: number;
  offset: number;
  limit: number;
}

export interface SearchToolsResponse {
  results: QueryResult[];
}
