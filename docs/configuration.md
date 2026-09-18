# Configuration

Three places, each with one job:

| File | Job | In git |
|---|---|---|
| `.env` | The compose stack: hosts, TLS mode, gateway credentials, image version, database password | no, copy from `.env.example` |
| `env/ontoforge.env` | OntoForge feature settings: embeddings, AI, documents. Works as-is with the features off | yes |
| `env/ontoforge.local.env` | Your private values for the same settings: provider URLs, API keys. Read after `ontoforge.env`, same keys win | no, optional |

How they are loaded:

- `.env` is read by Docker Compose itself, automatically, to fill the
  `${...}` placeholders in `docker-compose.yml`. No container sees the file.
- The two `env/` files are listed under `env_file:` of the `ontoforge-server`
  service in `docker-compose.yml`. Compose passes their contents as
  environment variables into that one container, in order: `ontoforge.env`,
  then `ontoforge.local.env` (same key wins), then the service's own
  `environment:` block, which holds the `DB_*` wiring and `PUBLIC_URL`, and
  wins over both.

To see the merged result inside the server container (contains API keys):

```bash
docker compose exec ontoforge-server printenv | sort
```

## `.env`

| Variable | Default | Meaning |
|---|---|---|
| `VERSION` | `latest` | Tag of both OntoForge images |
| `POSTGRES_PASSWORD` | `changeme` | Database password, used by PostgreSQL and the server |
| `FRONTEND_HOST` | `https://ontoforge.localhost` | Public address of the UI facade |
| `API_HOST` | `https://api.ontoforge.localhost` | Public address of the API facade |
| `CADDY_TLS_MODE` | `internal` | `internal`, `acme` or `off`, see [gateway.md](gateway.md#tls) |
| `ACME_EMAIL` | `admin@example.com` | ACME contact, `acme` mode only |
| `BASIC_AUTH_USER` | `admin` | Basic Auth user |
| `BASIC_AUTH_HASH` | hash of `ontoforge` | bcrypt hash of the Basic Auth password |
| `ONTOFORGE_API_TOKEN` | `local-testing-token-replace-me` | Bearer token for the API facade |

The two credentials in `.env.example` are for local testing only. Compose
refuses to start when either is empty.

### Changing the Basic Auth password

```bash
scripts/hash-password.sh          # prompts, prints BASIC_AUTH_HASH=...
```

Replace the line in `.env`, then `docker compose up -d caddy`. The `$$` in
the printed value is compose's escape for a literal `$`; the script writes it
that way on purpose.

### Changing the API token

```bash
scripts/gen-token.sh              # prints ONTOFORGE_API_TOKEN=...
```

Replace the line in `.env`, then `docker compose up -d caddy`, then hand the
new token to every API client.

### Changing the hosts

Set `FRONTEND_HOST` and `API_HOST` with scheme. With `CADDY_TLS_MODE=off`
they must be `http://` addresses. Browsers resolve any `*.localhost` name to
`127.0.0.1` without any DNS or hosts-file entry.

## `env/ontoforge.env` and `env/ontoforge.local.env`

All optional features are off by default. Enable one by uncommenting its
block in `env/ontoforge.env`, or by putting the complete block with your real
values into `env/ontoforge.local.env`. The local file is the right place as
soon as an API key is involved.

| Feature | Variables | Notes |
|---|---|---|
| Semantic search | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_DIMENSIONS` | Provider `ollama` or `openai`. Changing model or dimensions on an existing database needs a rebuild of the search data, see the OntoForge README. |
| AI features | `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY`, `AI_REASONING_EFFORT` | Provider `ollama` or `openai`. The model must support tool calling. |
| Documents | `DOCUMENT_CHUNK_SIZE`, `DOCUMENT_CHUNK_OVERLAP` | Chunking for document properties |

Ollama on the host machine is reached from the containers as
`http://host.docker.internal:11434`.

`PUBLIC_URL`, the address OntoForge advertises in agent cards (A2A), is not a
feature setting: compose sets it to `API_HOST`, so agents are always pointed
at the Bearer-protected API facade.

After changing either file: `docker compose up -d ontoforge-server`.

## Pinning an OntoForge version

Set `VERSION` in `.env` to a released tag, for example `5.0.0`, and
`docker compose up -d`. Both images share the tag.
