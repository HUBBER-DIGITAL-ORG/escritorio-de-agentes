// Revisor automático do Escritório.
// Quando um agente termina uma frente do projeto e ninguém continua o trabalho em GRACE minutos,
// abre um Claude em modo SÓ LEITURA naquele worktree para conferir o trabalho e apontar próximos passos.
// O parecer vai para a pasta de revisões (config: saidaRevisoes) e aparece no escritório.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { CONFIG } from './config.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const STATE_FILE = path.join(HERE, 'revisor-state.json');
const KILL_FILE = path.join(HERE, 'REVISOR_DESLIGADO');
const CLAUDE_BIN = CONFIG.claudeBin;

const GRACE_MIN = CONFIG.revisor.esperaMin;       // espera o dono da frente continuar por conta própria
const MAX_PARALLEL = CONFIG.revisor.maxParalelo;
const MAX_PER_DAY = CONFIG.revisor.maxDia;
const TIMEOUT_MIN = Number(process.env.REVISOR_TIMEOUT_MIN || 25);
const LOOKBACK_MIN = 45; // ao ligar, não revisa o histórico antigo inteiro
export const AUTO_TAG = '[auto-revisão do escritório]';

const ALLOWED = [
  'Read', 'Grep', 'Glob',
  'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git merge-base:*)', 'Bash(git rev-parse:*)', 'Bash(git branch:*)',
  ...CONFIG.comandosTeste,
];
const DENIED = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'];

const bootTs = Date.now();
let st = load();
const running = new Map(); // key -> {pid, front, startedTs, file}
const ownKeys = new Set();

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { done: {}, day: '', countToday: 0, history: [] }; }
}
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }
const today = () => new Date().toLocaleDateString('sv-SE');

function head(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
}
function dirty(dir) {
  try { return execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; }
}

function verdictOf(text) {
  const v = String(text || '').match(/Veredito:?\s*\**\s*([A-Z_]{4,})/i)?.[1]?.toUpperCase();
  return v || null;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// reconcilia revisões iniciadas por outro processo ou antes de um reinício
function reconcile() {
  st = load();
  for (const h of st.history) {
    if (h.status !== 'rodando' || running.has(h.key)) continue;
    if (h.pid && alive(h.pid)) { running.set(h.key, h); continue; }
    try {
      const txt = fs.readFileSync(h.file, 'utf8');
      const age = Date.now() - fs.statSync(h.file).mtimeMs;
      h.status = verdictOf(txt) ? 'feita' : 'falhou'; h.verdict = verdictOf(txt); h.endedTs = Date.now(); void age;
    } catch { h.status = 'falhou'; }
    save();
  }
  for (const [k, h] of running) if (h.pid && !alive(h.pid) && !ownKeys.has(k)) running.delete(k);
}

function buildPrompt(c) {
  return `Revisão independente ${AUTO_TAG}
Você é o revisor que entra quando outro agente PAROU. Um ${c.author} acabou de encerrar a frente "${c.front}" neste worktree (${c.dir}). Confira o que foi feito de verdade, aponte erros e diga os próximos passos.

O que o agente anterior recebeu como tarefa (resumo):
${c.task || '(não informado)'}

O que ele declarou ao terminar:
${c.report || '(sem relatório)'}

REGRAS: SÓ LEITURA. Não edite, não crie arquivos, não faça commit/reset/checkout, não instale nada, não acesse rede, credenciais, servidores ou dados reais. Pode usar Read/Grep/Glob, git log/diff/show/status/merge-base e rodar testes locais focados com dependências já instaladas (node --test, node --import tsx --test, ./node_modules/.bin/tsc --noEmit, ./node_modules/.bin/eslint, python3 -m unittest).

COMO REVISAR:
1. Descubra o que mudou: git log --oneline $(git merge-base HEAD main)..HEAD, git diff main...HEAD --stat e o diff não commitado.
2. Compare as afirmações do relatório com o código e use a base exata da tarefa ao avaliar mudanças recentes. Se você não conseguir reproduzir um teste, diga o que impediu a sua execução e marque o resultado como não verificado nesta revisão. Isso não é evidência de que o autor nunca rodou o teste.
3. Rode os testes mais relevantes para a mudança (poucos e focados) e a checagem de tipos se for TS.
4. Procure regressões, casos de borda, vazamento entre clientes/orgs, envio real acidental, segredos no código.

RESPOSTA (português, direto, sem enrolação), começando EXATAMENTE com uma destas linhas:
Veredito: APPROVED
Veredito: NEEDS_FIX
Depois:
## Problemas (arquivo:linha, gravidade, por quê) — vazio se não houver
## O que conferi (comandos e resultados reais)
## Próximos passos (ordem de prioridade, para quem continuar a frente)`;
}

export function cleanEnv() {
  const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter) };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|OPENROUTER_|CLAUDE_CODE_OAUTH_TOKEN)/.test(k)) delete env[k];
  return env;
}

export function startReview(c, onDone) { return start(c, onDone); }

function start(c, onDone) {
  const outDir = CONFIG.saidaRevisoes;
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const file = path.join(outDir, `${c.front}-${stamp}.md`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `<!-- ${AUTO_TAG} frente=${c.front} autor=${c.author} head=${c.head} -->\n`);
  const args = ['-p', buildPrompt(c), '--allowedTools', ...ALLOWED, '--disallowedTools', ...DENIED];
  const env = cleanEnv();
  const child = spawn(CLAUDE_BIN, args, { cwd: c.dir, detached: true, stdio: ['ignore', fd, fd], env });
  fs.closeSync(fd);
  c.key = c.key || `${c.front}@${c.head}`;
  ownKeys.add(c.key);
  const entry = { key: c.key, front: c.front, author: c.author, head: c.head, file, startedTs: Date.now(), status: 'rodando', pid: child.pid };
  running.set(c.key, entry);
  st.done[c.key] = Date.now();
  st.countToday += 1;
  st.history.unshift(entry);
  st.history = st.history.slice(0, 80);
  save();
  fs.appendFileSync(path.join(outDir, 'INDEX.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'inicio', front: c.front, author: c.author, head: c.head, file: path.relative(c.project, file) }) + '\n');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* já saiu */ } }, TIMEOUT_MIN * 60e3);
  child.on('exit', (code) => {
    clearTimeout(timer);
    running.delete(c.key); ownKeys.delete(c.key);
    let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { /* */ }
    st = load();
    const h = st.history.find((x) => x.key === c.key && x.startedTs === entry.startedTs) || entry;
    h.verdict = verdictOf(txt);
    h.status = code === 0 && h.verdict ? 'feita' : 'falhou';
    h.endedTs = Date.now();
    save();
    try { onDone && onDone({ verdict: h.verdict, file, text: txt, code }); } catch (e) { console.error('[revisor] onDone', e); }
    fs.appendFileSync(path.join(outDir, 'INDEX.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'fim', front: c.front, verdict: h.verdict, exit: code, file: path.relative(c.project, file) }) + '\n');
  });
  child.unref();
  console.log(`[revisor] revisando ${c.front} (${c.author}, ${c.head})`);
  return entry;
}

// chamado a cada atualização do escritório
export function tick(state, project) {
  if (st.day !== today()) { st.day = today(); st.countToday = 0; save(); }
  reconcile();
  const enabled = CONFIG.revisor.ligado && !fs.existsSync(KILL_FILE);
  const now = Date.now();
  const graceMs = GRACE_MIN * 60e3;
  // alguém já pegou a frente depois que o agente parou? (nova sessão Claude ou o Codex mexendo nela)
  const reviewedAfter = (front, ts) => state.agents.some((a) =>
    (a.vendor === 'claude' && a.front === front && a.startedTs > ts) ||
    (a.vendor === 'codex' && (a.events || []).some((e) => e.front === front && e.ts > ts + 60e3)));

  const candidates = [];
  // A) Claude executor terminou
  for (const a of state.agents) {
    if (a.vendor !== 'claude' || a.kind !== 'implementacao' || !a.finished || !a.front || !a.cwd) continue;
    candidates.push({ front: a.front, dir: a.cwd, endedTs: a.lastTs, author: 'Claude executor', task: a.task, report: a.lastReport });
  }
  // B) subagente do Codex encerrou a vez trabalhando num worktree
  for (const a of state.agents) {
    if (a.vendor !== 'codex' || a.isLead || !a.lastCompleteTs || !a.lastDir) continue;
    if (a.turnOpen) continue;
    candidates.push({ front: a.lastFront, dir: path.join(project, a.lastDir), endedTs: a.lastCompleteTs, author: `Codex ${a.name}`, task: a.task, report: a.lastReport });
  }

  const pending = [];
  for (const c of candidates) {
    if (!c.front || !fs.existsSync(path.join(c.dir, '.git'))) continue;
    if (c.endedTs < bootTs - LOOKBACK_MIN * 60e3) continue;   // histórico antigo
    if (reviewedAfter(c.front, c.endedTs)) continue;            // alguém já continuou/revisou
    if (now - c.endedTs < graceMs) { pending.push({ ...c, why: 'esperando o Codex continuar (' + Math.ceil((graceMs - (now - c.endedTs)) / 60e3) + 'min)' }); continue; }
    c.head = head(c.dir);
    if (!c.head) continue;
    c.key = `${c.front}@${c.head}${dirty(c.dir) ? '+wip' : ''}`;
    if (st.done[c.key] || running.has(c.key)) continue;
    if ([...running.values()].some((r) => r.front === c.front)) continue;
    c.project = project;
    pending.push({ ...c, why: 'na fila' });
    if (enabled && running.size < MAX_PARALLEL && st.countToday < MAX_PER_DAY) start(c);
  }

  return {
    ligado: enabled,
    limiteDia: MAX_PER_DAY,
    hoje: st.countToday,
    esperaMin: GRACE_MIN,
    rodando: [...running.values()].map(({ front, author, startedTs }) => ({ front, author, startedTs })),
    fila: pending.filter((p) => !running.has(p.key)).map(({ front, author, why }) => ({ front, author, why })).slice(0, 10),
    recentes: st.history.slice(0, 12).map(({ front, author, status, verdict, startedTs, endedTs, file }) => ({ front, author, status, verdict, startedTs, endedTs, file: path.relative(project, file) })),
  };
}
