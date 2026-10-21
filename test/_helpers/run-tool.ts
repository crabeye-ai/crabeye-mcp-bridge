export function viaRunTool(name: string, args: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return { name: "run_tool", arguments: { name, arguments: args }, ...params };
}
