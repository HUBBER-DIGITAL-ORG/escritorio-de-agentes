// Escritório de Agentes
// Lê, só em modo leitura, os registros locais do Codex (ChatGPT) e do Claude Code
// e serve um escritório pixel em tempo real em http://localhost:4777
// Sem dependências: node server.mjs   ·   demonstração: DEMO=1 node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { tick as revisorTick, AUTO_TAG } from './revisor.mjs';
import { tick as gerenteTick } from './gerente.mjs';
import { CONFIG, CLAUDE_PROJECT_KEY, frontFromPath, frontDirFromPath } from './config.mjs';
import { demoState } from './demo.mjs';

const PORT = CONFIG.porta;
const HOME = os.homedir();
const PROJECT = CONFIG.projeto;
const CODEX_DIR = CONFIG.codexDir;
const CLAUDE_DIR = CONFIG.claudeDir;
const WINDOW_H = CONFIG.janelaHoras; // janela de sessões exibidas
const WORKING_S = 75;     // atividade nos últimos 75s = trabalhando
const IDLE_S = 20 * 60;   // até 20min sem atividade = pausa; depois = saiu
const TAIL_BYTES = 600 * 1024;
const HEAD_BYTES = 256 * 1024;
const PUBLIC = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');

const cache = new Map(); // file -> {key, data}

async function readRange(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

function parseLines(text, dropFirst) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* linha cortada */ }
  }
  return out;
}

async function headTail(file, size) {
  const head = parseLines(await readRange(file, 0, Math.min(size, HEAD_BYTES)), false);
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = tailStart === 0 ? head : parseLines(await readRange(file, tailStart, size - tailStart), true);
  return { head, tail };
}

const clip = (s, n = 160) => {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const shortPath = (p) => {
  if (!p) return '';
  p = String(p).replace(/^file:\/\//, '');
  const i = p.indexOf(PROJECT + '/');
  if (i >= 0) p = p.slice(i + PROJECT.length + 1);
  return p.replace(HOME, '~');
};

const dirFromPath = frontDirFromPath;

function describeCommand(cmd) {
  cmd = String(cmd || '');
  const first = cmd.split('\n')[0];
  if (/\b(tsx --test|node --test|unittest|vitest|jest)\b/.test(cmd)) return 'rodando testes';
  if (/\btsc\b/.test(cmd)) return 'checando tipos (tsc)';
  if (/\beslint\b/.test(cmd)) return 'rodando lint';
  if (/^git commit/.test(first) || /\bgit commit\b/.test(cmd)) return 'fazendo commit';
  if (/\bgit (diff|status|log|show)\b/.test(cmd)) return 'revisando diff no git';
  if (/\bclaude\b.*-p\b/.test(cmd)) return 'despachando tarefa para o Claude';
  if (/\b(curl|fetch)\b/.test(cmd)) return 'consultando API';
  if (/^python3?\s+-\s*<</.test(first) || /^node\s+-\s*<</.test(first) || /^node -e/.test(first)) return 'rodando script de análise';
  if (/\bnpm run build|next build\b/.test(cmd)) return 'compilando o app';
  if (/\b(ssh|scp|rsync)\b/.test(first)) return 'mexendo no servidor';
  if (/\bgit (rev-parse|worktree|branch|checkout|switch|merge|rebase|cherry-pick)\b/.test(cmd)) return 'organizando branches';
  if (/\b(cat|sed -n|head|tail|rg|grep|ls|find)\b/.test(first)) return 'lendo código: ' + clip(first.replace(/^\S+\s+/, ''), 70);
  return clip(first, 90);
}

// ---------------- Codex (ChatGPT) ----------------
let threadNames = new Map();
async function loadThreadNames() {
  try {
    const txt = await fsp.readFile(path.join(CODEX_DIR, 'session_index.jsonl'), 'utf8');
    const m = new Map();
    for (const o of parseLines(txt, false)) if (o.id) m.set(o.id, o.thread_name);
    threadNames = m;
  } catch { /* sem índice */ }
}

async function recentFiles(root, maxDepth, filter) {
  const out = [];
  const cutoff = Date.now() - WINDOW_H * 3600e3;
  async function walk(dir, depth) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) await walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl') || (filter && !filter(p))) continue;
      try {
        const st = await fsp.stat(p);
        if (st.mtimeMs >= cutoff) out.push({ file: p, size: st.size, mtime: st.mtimeMs });
      } catch { /* sumiu */ }
    }
  }
  await walk(root, 0);
  return out;
}

function codexSessionDirs() {
  // só os últimos 3 dias para não varrer o histórico inteiro
  const dirs = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.now() - i * 864e5);
    dirs.push(path.join(CODEX_DIR, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return [...new Set(dirs)];
}

function parseCodex({ head, tail }, file) {
  const meta = head.find((o) => o.type === 'session_meta')?.payload || {};
  if (meta.cwd && !String(meta.cwd).startsWith(PROJECT)) return null; // só sessões deste projeto
  const spawn = meta.source?.subagent?.thread_spawn;
  const id = meta.id || path.basename(file);
  const agent = {
    id: 'codex:' + id,
    vendor: 'codex',
    threadId: id,
    parentThreadId: spawn?.parent_thread_id || null,
    name: spawn?.agent_nickname || (threadNames.get(id) ? clip(threadNames.get(id), 28) : 'ChatGPT'),
    role: spawn ? (spawn.agent_role === 'worker' ? 'Executor Codex' : spawn.agent_role || 'Subagente') : 'Coordenador (ChatGPT/Codex)',
    task: spawn?.agent_path ? spawn.agent_path.replace(/^\/root\/?/, '').replace(/_/g, ' ') : (threadNames.get(id) || ''),
    isLead: !spawn,
    events: [],
    messages: [],
    fronts: new Set(),
  };
  let lastTs = 0, turnOpen = false, lastAction = '', lastText = '', lastCompleteMsg = '', lastCompleteTs = 0, curDir = null, doneDir = null;
  for (const o of tail) {
    const ts = Date.parse(o.timestamp || '') || 0;
    const p = o.payload || {};
    if (ts > lastTs) lastTs = ts;
    if (p.type === 'task_started') turnOpen = true;
    if (p.type === 'task_started') curDir = null;
    if (p.type === 'task_complete') { turnOpen = false; lastCompleteMsg = p.last_agent_message || lastCompleteMsg; lastCompleteTs = ts; doneDir = curDir; }
    if (p.type === 'item_completed') {
      const it = p.item || {};
      if (it.type === 'CommandExecution') {
        const cmd = Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command;
        lastAction = describeCommand(cmd);
        const f = frontFromPath(it.cwd) || frontFromPath(cmd);
        curDir = dirFromPath(String(it.cwd || '') + '/') || dirFromPath(cmd) || curDir;
        if (f) agent.fronts.add(f);
        agent.events.push({ ts, kind: 'cmd', text: lastAction, front: f });
      } else if (it.type === 'FileChange') {
        const files = Object.keys(it.changes || {});
        lastAction = 'editando ' + files.slice(0, 2).map(shortPath).join(', ') + (files.length > 2 ? ` +${files.length - 2}` : '');
        files.forEach((x) => { const f = frontFromPath(x); if (f) agent.fronts.add(f); curDir = dirFromPath(x) || curDir; });
        agent.events.push({ ts, kind: 'edit', text: lastAction, front: frontFromPath(files[0]) });
      } else if (it.type === 'Reasoning') {
        lastAction = lastAction || 'pensando';
      } else if (it.type === 'AgentMessage') {
        const t = (it.content || []).map((c) => c.text || '').join(' ');
        if (t) { lastText = t; agent.events.push({ ts, kind: 'say', text: clip(t, 220) }); }
      } else if (it.type === 'CollabAgentToolCall' && it.tool === 'spawn_agent') {
        agent.events.push({ ts, kind: 'spawn', text: 'criou um subagente' });
      }
    }
    if (p.type === 'agent_message') {
      const head0 = (p.content || []).find((c) => c.type === 'input_text')?.text || '';
      const mt = head0.match(/Message Type:\s*(\S+)/)?.[1] || 'MESSAGE';
      const tn = head0.match(/Task name:\s*(.+)/)?.[1] || '';
      agent.messages.push({ ts, from: p.author, to: p.recipient, type: mt, task: tn.replace(/^\/root\/?/, '') });
    }
    if (p.type === 'message' && p.role === 'assistant') {
      const t = (p.content || []).map((c) => c.text || '').join(' ');
      if (t) lastText = t;
    }
  }
  agent.lastTs = lastTs;
  agent.turnOpen = turnOpen;
  agent.action = lastAction;
  agent.say = clip(lastText, 260);
  agent.lastReport = clip(lastCompleteMsg, 1500);
  agent.lastCompleteTs = lastCompleteTs;
  agent.lastDir = doneDir;
  agent.lastFront = frontFromPath(doneDir ? doneDir + '/' : '');
  agent.events = agent.events.slice(-25);
  agent.fronts = [...agent.fronts];
  return agent;
}

// ---------------- Claude Code ----------------
function parseClaude({ head, tail }, file) {
  const firstUser = head.find((o) => o.type === 'user' && o.message);
  if (!firstUser) return null;
  const cwd = firstUser.cwd || '';
  if (!cwd.startsWith(PROJECT)) return null;
  let prompt = firstUser.message.content;
  if (Array.isArray(prompt)) prompt = prompt.map((c) => c.text || '').join(' ');
  const dispatched = firstUser.entrypoint === 'sdk-cli' || firstUser.userType === 'external' && firstUser.entrypoint === 'sdk-cli';
  const front = frontFromPath(cwd);
  // a "frente" real vem depois do bloco padrão de regras do Codex
  let task = String(prompt || '');
  const cut = task.search(/Audite|Implemente|Corrija|Crie|Construa|Objetivo|Tarefa:|Frente:/);
  const taskShort = clip(cut > 200 ? task.slice(cut) : task, 300);

  const id = path.basename(file, '.jsonl');
  if (task.includes('GERENTE DE ENGENHARIA 24h')) return null; // o planejador é desenhado como o Gerente
  const isReview = /Revis[aã]o independente|revisor independente|Read-only review|independent (acceptance|review)|acceptance (review|worker)/i.test(task);
  const auto = task.includes(AUTO_TAG);
  const kind = auto ? 'revisao' : !dispatched ? 'direta' : isReview ? 'revisao' : 'implementacao';
  const agent = {
    id: 'claude:' + id,
    vendor: 'claude',
    kind,
    name: front ? 'Claude · ' + front.split('-').slice(0, 3).join(' ') : /automated run|scheduled/i.test(task) ? 'Claude · tarefa agendada' : 'Claude · conversa direta',
    auto,
    cwd,
    role: auto ? 'Revisor automático (escritório)' : kind === 'revisao' ? 'Revisor Claude (pedido pelo Codex)' : kind === 'implementacao' ? 'Executor Claude (despachado pelo Codex)' : 'Claude (sessão direta / agendada)',
    task: taskShort,
    front,
    dispatched,
    startedTs: Date.parse(firstUser.timestamp || '') || 0,
    events: [],
  };
  let lastTs = 0, lastAction = '', lastText = '', lastRole = '', lastHadTool = false;
  for (const o of tail) {
    const ts = Date.parse(o.timestamp || '') || 0;
    if (!o.message) continue;
    if (ts > lastTs) lastTs = ts;
    const c = o.message.content;
    if (o.type === 'assistant' && Array.isArray(c)) {
      lastRole = 'assistant'; lastHadTool = false;
      for (const b of c) {
        if (b.type === 'tool_use') {
          lastHadTool = true;
          const inp = b.input || {};
          let t = b.name;
          if (b.name === 'Bash') t = describeCommand(inp.command);
          else if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(b.name)) t = ({ Read: 'lendo ', Edit: 'editando ', Write: 'criando ', NotebookEdit: 'editando ' })[b.name] + shortPath(inp.file_path).replace(new RegExp('^' + (frontDirFromPath(inp.file_path) || '\u0000') + '/'), '');
          else if (b.name === 'Grep' || b.name === 'Glob') t = 'procurando ' + clip(inp.pattern, 50);
          else if (b.name === 'Agent' || b.name === 'Task') t = 'delegou: ' + clip(inp.description, 60);
          else if (b.name === 'TodoWrite') t = 'atualizando checklist';
          else if (/^mcp__/.test(b.name)) t = 'usando ' + b.name.split('__').slice(1).join(' ').replace(/_/g, ' ');
          lastAction = t;
          agent.events.push({ ts, kind: /editando|criando/.test(t) ? 'edit' : 'cmd', text: t, front });
        } else if (b.type === 'text' && b.text?.trim()) {
          lastText = b.text;
        }
      }
    } else if (o.type === 'user') {
      lastRole = 'user';
    }
  }
  agent.lastTs = lastTs;
  // terminou = última mensagem do assistente sem ferramenta pendente
  agent.finished = lastRole === 'assistant' && !lastHadTool;
  agent.turnOpen = !agent.finished;
  agent.action = lastAction;
  agent.say = clip(lastText, 260);
  agent.lastReport = agent.finished ? clip(lastText, 1500) : '';
  agent.events = agent.events.slice(-25);
  agent.fronts = front ? [front] : [];
  return agent;
}

// ---------------- Montagem do estado ----------------
async function parseCached(f, parser) {
  const key = f.size + ':' + f.mtime;
  const c = cache.get(f.file);
  if (c && c.key === key) return c.data;
  try {
    const data = parser(await headTail(f.file, f.size), f.file);
    if (data) data.mtime = f.mtime;
    cache.set(f.file, { key, data });
    return data;
  } catch (e) {
    return null;
  }
}

function statusOf(a, now) {
  const age = (now - Math.max(a.lastTs || 0, a.mtime || 0)) / 1000;
  a.ageS = Math.round(age);
  if (a.vendor === 'claude' && a.finished) return age < IDLE_S * 3 ? 'concluiu' : 'saiu';
  if (age <= WORKING_S) return 'trabalhando';
  if (age <= IDLE_S) return a.turnOpen ? 'esperando' : 'pausa';
  return 'saiu';
}

async function readJson(p) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; } }

async function buildState() {
  await loadThreadNames();
  const now = Date.now();
  const codexFiles = (await Promise.all(codexSessionDirs().map((d) => recentFiles(d, 0)))).flat();
  const claudeFiles = await recentFiles(CLAUDE_DIR, 1, (p) => p.includes(CLAUDE_PROJECT_KEY) && !p.includes('/subagents/'));

  const agents = [];
  for (const f of codexFiles) { const a = await parseCached(f, parseCodex); if (a) agents.push(a); }
  for (const f of claudeFiles) { const a = await parseCached(f, parseClaude); if (a) agents.push(a); }
  for (const a of agents) a.status = statusOf(a, now);
  // várias sessões na mesma frente: só a mais recente de cada tipo fica no escritório
  const latest = new Map();
  for (const a of agents.filter((x) => x.vendor === 'claude' && x.front)) {
    const k = a.front + '|' + a.kind, cur = latest.get(k);
    if (!cur || (a.lastTs || 0) > (cur.lastTs || 0)) latest.set(k, a);
  }
  for (const a of agents.filter((x) => x.vendor === 'claude' && x.front)) {
    if (latest.get(a.front + '|' + a.kind) !== a && a.status !== 'trabalhando') a.status = 'saiu';
  }

  // Revisão cruzada: quem terminou, alguém conferiu depois?
  const codexAgents = agents.filter((a) => a.vendor === 'codex');
  const claudeReviews = agents.filter((a) => a.vendor === 'claude' && a.kind === 'revisao');
  for (const a of agents.filter((x) => x.vendor === 'claude' && x.finished && x.status === 'concluiu')) {
    if (a.kind === 'revisao') {
      const v = (a.lastReport || '').match(/Veredito:?\s*\**\s*([A-Z_]{4,})/i)?.[1]?.toUpperCase();
      a.verdict = v || null;
      a.review = { by: null, state: v ? 'parecer: ' + ({ APPROVED: 'APROVADO', APPROVE: 'APROVADO', NEEDS_FIX: 'PRECISA CORRIGIR', REJECTED: 'REPROVADO' }[v] || v) : 'parecer entregue ao Codex' };
      continue;
    }
    if (!a.front) continue;
    const rvs = claudeReviews.filter((r) => r.front === a.front && r.startedTs > a.lastTs);
    const rv = rvs.find((r) => r.finished) || rvs[0];
    const cx = codexAgents.find((c) => c.events.some((e) => e.front === a.front && e.ts > a.lastTs));
    a.review = rv ? { by: rv.name + ' (revisor)', state: rv.finished ? 'revisado' : 'em revisão' }
      : cx ? { by: cx.name, state: 'Codex conferindo' } : { by: null, state: 'aguardando revisão' };
  }

  // Feed de passagens de bastão (handoffs)
  const handoffs = [];
  for (const a of agents.filter((x) => x.vendor === 'claude' && (x.dispatched || x.auto))) {
    handoffs.push({ ts: a.startedTs, from: a.auto ? 'Escritório (revisor automático)' : 'ChatGPT (Codex)', to: a.name, kind: a.kind === 'revisao' ? 'pediu revisão' : 'despacho', text: clip(a.task, 180), front: a.front });
    if (a.finished) handoffs.push({ ts: a.lastTs, from: a.name, to: 'ChatGPT (Codex)', kind: a.kind === 'revisao' ? 'parecer' : 'entrega', text: clip(a.lastReport, 200), front: a.front });
  }
  const byPath = new Map(codexAgents.map((c) => [c.task ? '/root/' + c.task.replace(/ /g, '_') : '/root', c.name]));
  const seenMsg = new Set();
  for (const c of codexAgents) for (const m of c.messages) {
    const k = m.ts + m.from + m.to + m.type;
    if (seenMsg.has(k)) continue; seenMsg.add(k);
    const nm = (p) => p === '/root' ? 'ChatGPT (Codex)' : byPath.get(p) || p.replace('/root/', '');
    handoffs.push({ ts: m.ts, from: nm(m.from), to: nm(m.to), kind: m.type === 'NEW_TASK' ? 'despacho' : 'mensagem', text: m.task.replace(/_/g, ' '), front: null });
  }
  handoffs.sort((x, y) => y.ts - x.ts);

  const board = await readJson(CONFIG.quadro);
  let gerente = null;
  try { gerente = gerenteTick({ agents }); } catch (e) { console.error('[gerente]', e); gerente = { erro: String(e.message || e) }; }
  if (gerente && gerente.tarefas) for (const t of gerente.tarefas) {
    if (t.criadoTs) handoffs.push({ ts: t.criadoTs, from: 'Gerente 24h', to: (t.provider === 'codex' ? 'Codex · ' : 'Claude · ') + t.slug.split('-').slice(0, 3).join(' '), kind: 'despacho', text: t.titulo + ' — ' + (t.frente || ''), front: t.slug });
  }
  handoffs.sort((x, y) => y.ts - x.ts);
  let revisor = null;
  try { revisor = revisorTick({ agents }, PROJECT); } catch (e) { console.error('[revisor]', e); revisor = { erro: String(e.message || e) }; }
  agents.sort((x, y) => (y.lastTs || 0) - (x.lastTs || 0));
  const count = (s) => agents.filter((a) => a.status === s).length;
  return {
    generatedAt: now,
    project: CONFIG.nome,
    windowHours: WINDOW_H,
    totals: { agentes: agents.length, trabalhando: count('trabalhando'), esperando: count('esperando'), pausa: count('pausa'), concluiu: count('concluiu'), saiu: count('saiu') },
    board,
    revisor,
    gerente,
    agents: agents.map(({ messages, mtime, ...rest }) => rest),
    handoffs: handoffs.slice(0, 60),
  };
}

let state = null, building = null;
async function refresh() {
  if (CONFIG.demo) { state = demoState(); return state; }
  if (building) return building;
  building = buildState().then((s) => { state = s; return s; }).catch((e) => { console.error(e); return state; }).finally(() => { building = null; });
  return building;
}

const clients = new Set();
setInterval(async () => {
  const s = await refresh();
  const data = `data: ${JSON.stringify(s)}\n\n`;
  for (const res of clients) res.write(data);
}, 3000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/state') {
    const s = state || (await refresh());
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(s));
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    clients.add(res);
    const s = state || (await refresh());
    res.write(`data: ${JSON.stringify(s)}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Escritório de Agentes${CONFIG.demo ? ' (demonstração)' : ''}: http://localhost:${PORT}  ·  projeto: ${PROJECT}`);
});

refresh();
