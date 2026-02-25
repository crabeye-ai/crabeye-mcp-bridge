# crabeye-mcp-bridge

A local CLI tool that aggregates multiple MCP (Model Context Protocol) servers behind a single STDIO interface. Works fully standalone on your local machine.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# Show help
./bin/crabeye-mcp-bridge --help

# Run with a config file
./bin/crabeye-mcp-bridge --config ./config.json

# Run with optional port and token
./bin/crabeye-mcp-bridge --config ./config.json --port 3000 --token mytoken
```

## Development

```bash
# Build
npm run build

# Dev mode (watch)
npm run dev

# Run tests
npm test

# Test with coverage
npm run test:coverage

# Lint
npm run lint

# Type check
npm run typecheck
```

## License

MIT
