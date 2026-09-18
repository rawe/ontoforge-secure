---
name: ontoforge-secure-export-import
description: Export or import an ontology on a secured OntoForge, where an auth gateway requires a Bearer token on every API call — schema or data alone, or both, as JSON files. Use to back up, restore, clone or move an ontology on a token-protected OntoForge server.
---

# OntoForge export and import (secured server)

For OntoForge behind an auth gateway: every API request needs `Authorization: Bearer <token>`. One script does every step: `scripts/export-import.mjs` in this skill's base directory (Node 18+, no dependencies). `--help` lists every flag.

```bash
node <skill-dir>/scripts/export-import.mjs <command> --ontology <key> --base-url <url> [--env-file <path>]
```

Behind the gateway, `--base-url` is the API host (e.g. `http://api.ontoforge.localhost`), not the UI host. Every command exits non-zero when something needs attention; its last lines say what.

## Token

The script finds the token itself: in the file passed as `--env-file`, else in `ONTOFORGE_API_TOKEN` in the environment. Without one, the gateway answers 401 and the script says so. From a file it takes only `ONTOFORGE_API_TOKEN` and `ONTOFORGE_BASE_URL`; a file holding just the token works too. Its first output line names the source it used.

Keep the token inside the script:
- Let the script make every API call, listing and deleting ontologies included.
- Hand over a token file by path. The path is all you handle; the file's content stays unread.
- To check the environment variable, test for presence only: `[ -n "$ONTOFORGE_API_TOKEN" ]`.
- On a token error, ask the user where the token lives: an environment variable set before Claude Code started, or a file path for `--env-file`. Rerun with their answer.

## Commands

| Command | Effect |
|---|---|
| `ontologies` | Lists the ontology keys (no `--ontology`) |
| `export-schema -o <file>` | Design: types, properties, lenses, agents, saved queries |
| `export-data -o <file>` | Entities and relations, documents in full |
| `export --dir <dir>` | Both, as `<dir>/schema.json` and `<dir>/data/data.json` |
| `import-schema <file>` | Creates the ontology if missing, imports the design |
| `import-data <file>` | Entities, then relations (new IDs, remapped), then rebuilds search data |
| `import --dir <dir>` | `import-schema`, then `import-data` |
| `rebuild-search` | Rebuilds keyword, document and embedding search data |
| `verify --dir <dir>` | Compares the files' keys and counts with the server (`--schema`/`--data` for one part) |
| `delete-ontology --confirm <key>` | Deletes the ontology; only when the user asked for it |

Schema comes before data: `import-data` writes into the types `import-schema` created. `import-schema` needs a fresh target and stops with 409 when the ontology already holds any of the file's keys.

Every export and import ends with `verify` on the same files. Done means it prints `all N checks match` and, after an import, the rebuild line says `0 failed`. Report the counts to the user.

## Pitfalls

- Ontology keys match `^[a-z][a-z0-9_]*$`: `poc_copy`, never `poc-copy`.
- `import-data` is not all-or-nothing. When it stops midway the target is half-filled: ask the user, then `delete-ontology` and rerun from `import-schema`.
- A schema exported from an older server version can fail with 422; the error names the cause and the valid values (5.1 renamed the agent tool `semantic_search` to `search`). Fix a copy of the file and rerun.
- `textSearchLanguage` (server 5.1+) is fixed when the ontology is created: from the schema file, else `--language english|german`, else the server default `english`. Older files get the target's language filled in, in memory only.
- Data is read and written through a lens; the script picks the unscoped one. A scoped `--lens` covers only the types it shows, and `verify` marks the rest `not visible`.
- The files use the same formats as the `ontoforge-sync` plugin scripts, so they move between both tools.
