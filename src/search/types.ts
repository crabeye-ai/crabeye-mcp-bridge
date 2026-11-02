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

export interface ProviderResult {
  name: string;
  category?: string;
  tool_count: number;
  tools: SearchToolResult[];
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
