#!/usr/bin/env node
// Export and import one OntoForge ontology's schema and data as JSON files,
// each part separately or both together. Node 18+, no dependencies.
//
// Token handling: the Bearer token comes from the file named by --env-file or
// from ONTOFORGE_API_TOKEN, lives only in this process, is sent only to the
// base URL (redirects are refused), and is never printed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node export-import.mjs <command> [options]

Commands (all but "ontologies" need --ontology <key>):
  ontologies                        List the server's ontologies
  export-schema -o <file>           Design: types, lenses, agents, saved queries
  export-data   -o <file>           Entities and relations, documents in full
  export        --dir <dir>         Both: <dir>/schema.json and <dir>/data/data.json
  import-schema <file>              Create the ontology if missing, import the design
  import-data   <file>              Import entities, then relations, then rebuild search data
  import        --dir <dir>         import-schema, then import-data
  rebuild-search                    Rebuild keyword, document and embedding search data
  verify        --dir <dir> | [--schema <file>] [--data <file>]
                                    Compare the files' keys and counts with the server
  delete-ontology --confirm <key>   Delete the ontology (repeat its key to confirm)

Options:
  --ontology <key>    Target ontology (or ONTOFORGE_ONTOLOGY)
  --base-url <url>    Server URL (or ONTOFORGE_BASE_URL; default http://localhost:8000)
  --env-file <path>   File holding ONTOFORGE_API_TOKEN (and optionally ONTOFORGE_BASE_URL)
                      as KEY=value lines, or holding only the token
  --lens <key>        Lens for the data commands (default: the unscoped lens)
  --language <lang>   english|german, when import creates the ontology and the
                      schema file has no textSearchLanguage
  --no-rebuild        import-data / import: skip the search data rebuild
  -h, --help

Token: taken from --env-file, else from ONTOFORGE_API_TOKEN, else no token.
Sent only to the base URL as "Authorization: Bearer <token>", never printed.`;

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const LANGUAGES = ['english', 'german'];
const PAGE_SIZE = 200;
const TOKEN_HELP =
  'Ask the user for the token source: ONTOFORGE_API_TOKEN set in the environment ' +
  'Claude Code runs in, or a file path to pass as --env-file.';

class CliError extends Error {}

class HttpError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 2000)}`);
    this.status = status;
    this.body = body;
  }
}

function fail(message) {
  throw new CliError(message);
}

// --- Connection and token ---------------------------------------------------

function unquote(value) {
  const quoted = value.match(/^(["'])(.*)\1(\s+#.*)?$/);
  return quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
}

// Reads only ONTOFORGE_API_TOKEN and ONTOFORGE_BASE_URL. Error messages name
// the file, never its content.
function readEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read --env-file ${path}: ${err.code ?? 'read error'}`);
  }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(ONTOFORGE_API_TOKEN|ONTOFORGE_BASE_URL)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = unquote(m[2]);
  }
  if (!vars.ONTOFORGE_API_TOKEN) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1 && !lines[0].includes('=')) vars.ONTOFORGE_API_TOKEN = lines[0];
  }
  if (!vars.ONTOFORGE_API_TOKEN) {
    fail(`--env-file ${path} holds no ONTOFORGE_API_TOKEN line. ${TOKEN_HELP}`);
  }
  return vars;
}

function resolveConnection(opts) {
  const fileVars = opts['env-file'] ? readEnvFile(opts['env-file']) : {};
  let token = null;
  let tokenSource = 'none';
  if (fileVars.ONTOFORGE_API_TOKEN) {
    token = fileVars.ONTOFORGE_API_TOKEN;
    tokenSource = '--env-file';
  } else if (process.env.ONTOFORGE_API_TOKEN) {
    token = process.env.ONTOFORGE_API_TOKEN.trim();
    tokenSource = 'ONTOFORGE_API_TOKEN';
  }
  const baseUrl = (
    opts['base-url'] ??
    fileVars.ONTOFORGE_BASE_URL ??
    process.env.ONTOFORGE_BASE_URL ??
    'http://localhost:8000'
  ).replace(/\/+$/, '');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    fail(`invalid base URL "${baseUrl}"`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail(`base URL must be http(s): "${baseUrl}"`);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(url.hostname);
  if (token && url.protocol === 'http:' && !local) {
    console.error(`warning: sending the token over plain http to ${url.hostname}`);
  }
  return { baseUrl, token, tokenSource };
}

// --- HTTP ---------------------------------------------------------------------

let conn;

async function http(method, path, { body, raw = false } = {}) {
  const headers = {};
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(conn.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
  } catch (err) {
    fail(`cannot reach ${conn.baseUrl} (${err.cause?.code ?? err.message}). Is the server running?`);
  }
  if (res.status >= 300 && res.status < 400) {
    fail(`${conn.baseUrl} redirected to ${res.headers.get('location')}; pass the final URL as --base-url`);
  }
  if (res.status === 401 || res.status === 403) {
    fail(
      conn.token
        ? `${res.status} from ${conn.baseUrl}: the token (from ${conn.tokenSource}) was rejected. ${TOKEN_HELP}`
        : `${res.status} from ${conn.baseUrl}: the server needs a token. ${TOKEN_HELP}`,
    );
  }
  if (!res.ok) throw new HttpError(method, path, res.status, await res.text());
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;
const modelPath = (key) => `/api/ontologies/${enc(key)}/model`;
const runtimePath = (key, lens) => `/api/ontologies/${enc(key)}/runtime/lenses/${enc(lens)}`;

async function paginate(path) {
  const items = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await http('GET', `${path}${sep}limit=${PAGE_SIZE}&offset=${offset}`);
    items.push(...page.items);
    if (items.length >= page.total || page.items.length < PAGE_SIZE) return items;
  }
}

// A 404 on a type route means the lens does not show that type.
async function ifVisible(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

// --- Files --------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read ${file}: ${err instanceof SyntaxError ? 'not valid JSON' : (err.code ?? 'read error')}`);
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function dirFiles(dir) {
  const schema = join(dir, 'schema.json');
  const data = [join(dir, 'data', 'data.json'), join(dir, 'data.json')].find((f) => existsSync(f));
  return { schema: existsSync(schema) ? schema : null, data: data ?? null };
}

// --- Ontology and lens --------------------------------------------------------

async function listOntologies() {
  const res = await http('GET', '/api/ontologies');
  return Array.isArray(res) ? res : (res?.items ?? []);
}

async function getDesign(key) {
  try {
    return await http('GET', `${modelPath(key)}/export`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      fail(`no ontology "${key}" on ${conn.baseUrl} (see the "ontologies" command)`);
    }
    throw err;
  }
}

function pickLens(design, opts) {
  const lenses = design.lenses ?? [];
  if (opts.lens) {
    if (!lenses.some((l) => l.key === opts.lens)) fail(`no lens "${opts.lens}" in this ontology`);
    return opts.lens;
  }
  const unscoped = lenses.find((l) => !l.includes);
  if (unscoped) return unscoped.key;
  if (!lenses.length) fail('the ontology has no lens; import its schema first');
  console.error(`warning: no unscoped lens; using "${lenses[0].key}", which covers only the types it shows`);
  return lenses[0].key;
}

function schemaSummary(d) {
  const lenses = d.lenses ?? [];
  const count = (field) => lenses.reduce((n, l) => n + (l[field]?.length ?? 0), 0);
  return (
    `${d.entityTypes?.length ?? 0} entity types, ${d.relationTypes?.length ?? 0} relation types, ` +
    `${lenses.length} lenses, ${count('aiAgents')} agents, ${count('savedQueries')} saved queries`
  );
}

const total = (groups) => Object.values(groups ?? {}).reduce((n, list) => n + list.length, 0);

// --- Commands -----------------------------------------------------------------

async function exportSchema(key, file) {
  const design = await getDesign(key);
  writeJson(file, design);
  console.log(`exported schema of "${key}" to ${file}: ${schemaSummary(design)}`);
}

async function exportData(key, file, opts) {
  const design = await getDesign(key);
  const prefix = runtimePath(key, pickLens(design, opts));
  const entities = {};
  const relations = {};
  for (const et of design.entityTypes ?? []) {
    // Document values come back as {document: true, length} stubs unless the
    // `fields` projection names them; name every property plus the system fields.
    let path = `${prefix}/entities/${enc(et.key)}`;
    const props = et.properties ?? [];
    if (props.some((p) => p.dataType === 'document')) {
      const fields = ['_entityTypeKey', '_createdAt', '_updatedAt', ...props.map((p) => p.key)];
      path += '?' + fields.map((f) => `fields=${enc(f)}`).join('&');
    }
    const items = await ifVisible(paginate(path));
    if (items?.length) entities[et.key] = items;
  }
  for (const rt of design.relationTypes ?? []) {
    const items = await ifVisible(paginate(`${prefix}/relations/${enc(rt.key)}`));
    if (items?.length) relations[rt.key] = items;
  }
  writeJson(file, { formatVersion: '1.0', exportedAt: new Date().toISOString(), entities, relations });
  for (const [type, list] of Object.entries(entities)) console.error(`  ${type}: ${list.length} entities`);
  for (const [type, list] of Object.entries(relations)) console.error(`  ${type}: ${list.length} relations`);
  console.log(`exported data of "${key}" to ${file}: ${total(entities)} entities, ${total(relations)} relations`);
  const stubs = Object.values(entities)
    .flat()
    .flatMap((e) => Object.values(e))
    .filter((v) => v && typeof v === 'object' && v.document === true).length;
  if (stubs) {
    console.error(`warning: ${stubs} document values are stubs, not full text`);
    process.exitCode = 1;
  }
}

async function ensureOntology(key, fileLanguage, opts) {
  const existing = (await listOntologies()).find((o) => o.key === key);
  if (existing) return existing;
  if (!KEY_PATTERN.test(key)) {
    fail(`"${key}" is not a valid ontology key (${KEY_PATTERN.source}), e.g. "${key.toLowerCase().replace(/[^a-z0-9_]/g, '_')}"`);
  }
  if (fileLanguage && opts.language && fileLanguage !== opts.language) {
    fail(`--language ${opts.language} contradicts the schema file's textSearchLanguage "${fileLanguage}"`);
  }
  const language = fileLanguage ?? opts.language;
  if (language && !LANGUAGES.includes(language)) fail(`--language must be one of: ${LANGUAGES.join(', ')}`);
  const created = await http('POST', '/api/ontologies', {
    body: language ? { key, textSearchLanguage: language } : { key },
  });
  const lang = created?.textSearchLanguage ? ` (textSearchLanguage ${created.textSearchLanguage})` : '';
  console.error(`created ontology "${key}"${lang}`);
  return created ?? { key };
}

async function importSchema(key, file, opts) {
  const payload = readJson(file);
  if (!Array.isArray(payload.lenses)) fail(`${file} is not an OntoForge schema export (no "lenses" array)`);
  const target = await ensureOntology(key, payload.textSearchLanguage, opts);
  // 5.1+ requires the payload's language to equal the target's, which is fixed
  // at creation. Older exports have none: take the target's (in memory only).
  if (target.textSearchLanguage) {
    payload.textSearchLanguage ??= target.textSearchLanguage;
    if (payload.textSearchLanguage !== target.textSearchLanguage) {
      fail(
        `${file} has textSearchLanguage "${payload.textSearchLanguage}", ontology "${key}" has ` +
          `"${target.textSearchLanguage}" (fixed at creation). Import into a new ontology key.`,
      );
    }
  }
  try {
    await http('POST', `${modelPath(key)}/import`, { body: payload });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      fail(`ontology "${key}" already holds keys from ${file}:\n${err.body}\nImport into a new key, or ask the user before deleting "${key}".`);
    }
    if (err instanceof HttpError && err.status === 422) {
      fail(`the server rejected ${file}:\n${err.body}\nFix a copy of the file (often a name that changed between server versions) and run again.`);
    }
    throw err;
  }
  console.log(`imported schema from ${file} into "${key}": ${schemaSummary(payload)}`);
}

// Keys starting with "_" are system fields (_id, _createdAt, ...); the server assigns new ones.
function withoutSystemFields(record) {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith('_')));
}

async function importData(key, file, opts) {
  const data = readJson(file);
  if (!data.entities && !data.relations) fail(`${file} is not a data export (no "entities" or "relations")`);
  const design = await getDesign(key);
  const prefix = runtimePath(key, pickLens(design, opts));
  const idMap = new Map();
  let entities = 0;
  let relations = 0;
  let skipped = 0;
  try {
    for (const [type, list] of Object.entries(data.entities ?? {})) {
      for (const entity of list) {
        const created = await http('POST', `${prefix}/entities/${enc(type)}`, { body: withoutSystemFields(entity) });
        idMap.set(entity._id, created._id);
        entities++;
      }
      console.error(`  ${type}: ${list.length} entities`);
    }
    for (const [type, list] of Object.entries(data.relations ?? {})) {
      for (const { fromEntityId, toEntityId, ...rest } of list) {
        const from = idMap.get(fromEntityId);
        const to = idMap.get(toEntityId);
        if (!from || !to) {
          skipped++;
          continue;
        }
        await http('POST', `${prefix}/relations/${enc(type)}`, {
          body: { ...withoutSystemFields(rest), fromEntityId: from, toEntityId: to },
        });
        relations++;
      }
      console.error(`  ${type}: ${list.length} relations`);
    }
  } catch (err) {
    fail(
      `${err.message}\nimport-data stopped after ${entities} entities and ${relations} relations; ` +
        `ontology "${key}" is now partly filled. Ask the user before deleting it and importing again from the schema.`,
    );
  }
  console.log(`imported data from ${file} into "${key}": ${entities} entities, ${relations} relations`);
  if (skipped) {
    console.error(`warning: ${skipped} relations skipped, their endpoints are not in ${file}`);
    process.exitCode = 1;
  }
  if (!opts['no-rebuild']) await rebuildSearch(key);
}

async function rebuildSearch(key) {
  let res;
  try {
    res = await http('POST', `${modelPath(key)}/rebuild-search-data`, { raw: true });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
    // Servers before 5.1 name the endpoint rebuild-embeddings.
    res = await ifVisible(http('POST', `${modelPath(key)}/rebuild-embeddings`, { raw: true }));
    if (!res) throw err;
  }
  let summary = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const take = (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'summary') summary = event;
    } catch {
      // progress lines only; ignore anything unparsable
    }
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.filter((l) => l.trim()).forEach(take);
  }
  if (buffer.trim()) take(buffer);
  if (!summary) fail('the rebuild ended without a summary; run rebuild-search again');
  const skipped = summary.embeddingsSkipped ? ' (embeddings skipped: no embedding provider)' : '';
  console.log(`rebuilt search data of "${key}": ${summary.totalProcessed} processed, ${summary.totalFailed} failed${skipped}`);
  if (summary.totalFailed) process.exitCode = 1;
}

function compareKeys(label, fileItems, serverItems) {
  const f = new Set(fileItems);
  const s = new Set(serverItems);
  const missing = [...f].filter((k) => !s.has(k));
  const extra = [...s].filter((k) => !f.has(k));
  const detail = [missing.length && `missing on server: ${missing.join(', ')}`, extra.length && `only on server: ${extra.join(', ')}`];
  return { label, file: f.size, server: s.size, ok: !missing.length && !extra.length, note: detail.filter(Boolean).join('; ') };
}

async function verify(key, opts) {
  const files = opts.dir ? dirFiles(opts.dir) : { schema: opts.schema ?? null, data: opts.data ?? null };
  if (!files.schema && !files.data) fail('verify needs --dir <dir>, --schema <file> or --data <file>');
  const design = await getDesign(key);
  const rows = [];
  if (files.schema) {
    const s = readJson(files.schema);
    const keys = (list) => (list ?? []).map((x) => x.key);
    const nested = (d, field) => (d.lenses ?? []).flatMap((l) => (l[field] ?? []).map((x) => `${l.key}/${x.key}`));
    rows.push(
      compareKeys('entity types', keys(s.entityTypes), keys(design.entityTypes)),
      compareKeys('relation types', keys(s.relationTypes), keys(design.relationTypes)),
      compareKeys('lenses', keys(s.lenses), keys(design.lenses)),
      compareKeys('agents', nested(s, 'aiAgents'), nested(design, 'aiAgents')),
      compareKeys('saved queries', nested(s, 'savedQueries'), nested(design, 'savedQueries')),
    );
  }
  if (files.data) {
    const d = readJson(files.data);
    const prefix = runtimePath(key, pickLens(design, opts));
    for (const [kind, group, types] of [
      ['entities', d.entities, design.entityTypes],
      ['relations', d.relations, design.relationTypes],
    ]) {
      const all = new Set([...Object.keys(group ?? {}), ...(types ?? []).map((t) => t.key)]);
      for (const type of all) {
        const fileCount = group?.[type]?.length ?? 0;
        const page = await ifVisible(http('GET', `${prefix}/${kind}/${enc(type)}?limit=1`));
        const serverCount = page ? page.total : 'not visible';
        rows.push({ label: `${kind} ${type}`, file: fileCount, server: serverCount, ok: fileCount === serverCount, note: '' });
      }
    }
  }
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(`${r.ok ? 'ok  ' : 'DIFF'}  ${r.label.padEnd(width)}  file ${r.file}  server ${r.server}${r.note ? `  (${r.note})` : ''}`);
  }
  const diffs = rows.filter((r) => !r.ok).length;
  console.log(diffs ? `verify: ${diffs} of ${rows.length} checks differ` : `verify: all ${rows.length} checks match`);
  if (diffs) process.exitCode = 1;
}

async function run(command, positionals, opts) {
  if (command === 'ontologies') {
    const list = await listOntologies();
    for (const o of list) {
      const extra = [o.textSearchLanguage, o.displayName].filter(Boolean).join(', ');
      console.log(extra ? `${o.key}  (${extra})` : o.key);
    }
    if (!list.length) console.log('(no ontologies)');
    return;
  }
  const key = opts.ontology ?? process.env.ONTOFORGE_ONTOLOGY;
  if (!key) fail('no ontology key: pass --ontology <key> (list keys with the "ontologies" command)');
  const need = (value, flag) => value ?? fail(`${command} needs ${flag}`);
  switch (command) {
    case 'export-schema':
      return exportSchema(key, need(opts.out, '-o <file>'));
    case 'export-data':
      return exportData(key, need(opts.out, '-o <file>'), opts);
    case 'export': {
      const dir = need(opts.dir, '--dir <dir>');
      await exportSchema(key, join(dir, 'schema.json'));
      return exportData(key, join(dir, 'data', 'data.json'), opts);
    }
    case 'import-schema':
      return importSchema(key, need(positionals[0], '<file>'), opts);
    case 'import-data':
      return importData(key, need(positionals[0], '<file>'), opts);
    case 'import': {
      const files = dirFiles(need(opts.dir, '--dir <dir>'));
      if (!files.schema || !files.data) {
        fail(`${opts.dir} needs schema.json and data/data.json; for one part use import-schema or import-data`);
      }
      await importSchema(key, files.schema, opts);
      return importData(key, files.data, opts);
    }
    case 'rebuild-search':
      return rebuildSearch(key);
    case 'verify':
      return verify(key, opts);
    case 'delete-ontology':
      if (opts.confirm !== key) fail(`delete-ontology needs --confirm ${key} (the same key again)`);
      await http('DELETE', `/api/ontologies/${enc(key)}`);
      console.log(`deleted ontology "${key}"`);
      return;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

// --- Main -----------------------------------------------------------------------

// Exit through process.exitCode: process.exit() can cut off output piped on macOS.
async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        ontology: { type: 'string' },
        'base-url': { type: 'string' },
        'env-file': { type: 'string' },
        out: { type: 'string', short: 'o' },
        dir: { type: 'string' },
        lens: { type: 'string' },
        language: { type: 'string' },
        schema: { type: 'string' },
        data: { type: 'string' },
        confirm: { type: 'string' },
        'no-rebuild': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(`Error: ${err.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const [command, ...positionals] = args.positionals;
  if (args.values.help || !command) {
    console.log(USAGE);
    if (!args.values.help) process.exitCode = 1;
    return;
  }

  try {
    conn = resolveConnection(args.values);
    console.error(`server ${conn.baseUrl}, token ${conn.token ? `from ${conn.tokenSource}` : 'none'}`);
    await run(command, positionals, args.values);
  } catch (err) {
    if (!(err instanceof CliError || err instanceof HttpError)) throw err;
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

await main();
