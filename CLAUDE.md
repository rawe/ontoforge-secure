# CLAUDE.md

Reference setup for putting OntoForge behind a Caddy auth gateway: Basic Auth
for the UI, a Bearer token for API and MCP clients, OntoForge images unchanged.
Runs locally with Docker Compose; `k8s/` shows the same setup for Kubernetes.

Read `README.md` first. It explains the purpose, how to start the stack, and
which document in `docs/` to read for what.

Do not read `.env` or `env/*.local.env`; they hold credentials and are not
part of the repository.
