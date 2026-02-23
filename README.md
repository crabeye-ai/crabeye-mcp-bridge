# kokuai-bridge

A local CLI tool that aggregates multiple MCP (Model Context Protocol) servers behind a single STDIO interface. Works fully standalone, with optional connectivity to the Mike Charlie Papa service.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# Show help
./bin/kokuai-bridge --help

# Run with a config file
./bin/kokuai-bridge --config ./config.json

# Run with optional port and token
./bin/kokuai-bridge --config ./config.json --port 3000 --token mytoken
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
