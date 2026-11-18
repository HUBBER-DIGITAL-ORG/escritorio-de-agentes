// Gerente 24h do Escritório de Agentes.
// A cada ciclo: lê o backlog e as prioridades, vê quem está trabalhando e quanta memória sobra,
// escolhe a próxima frente (um Claude planejador decide o escopo), cria um worktree isolado,
// despacha um executor (Claude ou Codex), manda revisar, cobra correção e marca "pronto para integrar".
// Nunca publica, faz deploy, merge em main, envia mensagens ou mexe em dados reais.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { startReview, cleanEnv } from './revisor.mjs';
import { CONFIG } from './config.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROJECT = CONFIG.projeto;
const REPO = CONFIG.repo;
const STATE_FILE = path.join(HERE, 'gerente-state.json');
const KILL_FILE = path.join(HERE, 'GERENTE_DESLIGADO');
const PRIORITIES = CONFIG.prioridades;
const OUT = CONFIG.saidaGerente;
const CLAUDE_BIN = CONFIG.claudeBin;
const CODEX_BIN = CONFIG.codexBin;

const CFG = {
  cycleSec: Number(process.env.GERENTE_CICLO_S || 60),          // checagem de andamento
  planEveryMin: CONFIG.gerente.planoMin,    // no máximo um planejamento a cada N min
  maxWorkers: CONFIG.gerente.maxParalelo,
  maxPerDay: CONFIG.gerente.maxDia,
  minFreeGiB: CONFIG.gerente.minRamGB,
  maxBusyAgents: Number(process.env.GERENTE_MAX_AGENTES || 8),  // não entope o Mac junto com o Codex
  workerTimeoutMin: 45,
  maxFixRounds: 2,
};

const WORKER_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  ...CONFIG.comandosTeste,
  'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)',
];
const WORKER_DENY = ['WebFetch', 'WebSearch', 'Agent'];

const RULES = `REGRAS FIXAS: Implemente e teste até concluir o escopo, não pare em plano. Você não está só, não reverta colegas. Trabalhe SÓ neste worktree de source. Sem arquivos privados/.env/credenciais/SSH/servidores/navegador/dados reais. Não envie mensagens, não faça ligações, não publique, não ligue flags em produção, não rode npm install, não faça commit. Testes com Mongo/fetch/DOM sintéticos; não finja respostas de LLM real. Mexa só em fonte/testes/docs do escopo. No final, descreva resultados reais, limites e o que falta para publicar.`;

let st = loadState();
const children = new Map(); // taskId -> child
let lastCycle = 0, planning = false;
const log = (...a) => console.log('[gerente]', ...a);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { tasks: [], day: '', dispatchedToday: 0, lastPlanTs: 0, lastPlan: null, founder: [], notes: [] }; }
}
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }
const today = () => new Date().toLocaleDateString('sv-SE');
const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 }).trim();

function freeGiB() {
  try {
    if (process.platform !== 'darwin') return os.freemem() / 2 ** 30;
    const out = execFileSync('vm_stat', { encoding: 'utf8' });
    const page = Number(out.match(/page size of (\d+)/)?.[1] || 16384);
    const n = (k) => Number(out.match(new RegExp(k + ':\\s+(\\d+)'))?.[1] || 0);
    return ((n('Pages free') + n('Pages inactive') + n('Pages speculative')) * page) / 2 ** 30;
  } catch { return 0; }
}

// backlog.json: [{ "id": "MK-01", "titulo": "...", "estado": "pendente|parcial|publicado", "detalhe": "...", "proximo": "..." }]
async function backlog() {
  try { return JSON.parse(fs.readFileSync(CONFIG.backlog, 'utf8')); } catch { return []; }
}

// commit base das tarefas novas (config: baseRef, ex.: main ou a tag da última versão publicada)
function baseCommit() {
  try { return git(REPO, 'rev-parse', CONFIG.baseRef); } catch { return null; }
}

function nodeModulesSource() {
  for (const p of [CONFIG.nodeModules, path.join(REPO, 'node_modules')].filter(Boolean)) {
    try { const real = fs.realpathSync(p); if (fs.existsSync(real)) return real; } catch { /* */ }
  }
  return null;
}

function busyFronts(office) {
  const set = new Set();
  for (const a of office.agents || []) {
    if (!['trabalhando', 'esperando'].includes(a.status)) continue;
    (a.fronts || []).forEach((f) => set.add(f));
    if (a.front) set.add(a.front);
  }
  try { // branches do Codex mexidas nas últimas 3h
    const out = git(REPO, 'for-each-ref', '--sort=-committerdate', '--count=40', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads');
    for (const l of out.split('\n')) { const [ref, ts] = l.split(' '); if (Date.now() / 1000 - Number(ts) < 3 * 3600) set.add(ref.replace(/^[^/]+\//, '').replace(/-\d{8}$/, '')); }
  } catch { /* */ }
  return [...set];
}

// worktree de leitura, sempre no commit base, para o planejador olhar o código certo
function baseWorktree(base) {
  const dir = path.join(PROJECT, 'gerente-base');
  if (!fs.existsSync(dir)) git(REPO, 'worktree', 'add', '--detach', dir, base);
  else if (git(dir, 'rev-parse', 'HEAD') !== base) git(dir, 'checkout', '--detach', '--force', base);
  return dir;
}

// Um item do backlog fica travado enquanto tiver tarefa ativa, pronta para integrar
// (esperando o Codex integrar) ou bloqueada (esperando decisão). Evita repetir a mesma tarefa com outro nome.
function lockedBacklogIds() {
  const ids = new Set();
  for (const t of st.tasks || []) if (t.status !== 'falhou') (t.backlogIds || []).forEach((id) => ids.add(id));
  return ids;
}
const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9_]+/).filter((w) => w.length > 3));
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.6;
}

// ---------- planejamento (Claude só leitura decide o escopo) ----------
function runClaudeJSON(prompt, cwd, tools, timeoutMin = 15) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', ...tools, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'];
    const child = spawn(CLAUDE_BIN, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMin * 60e3);
    child.on('exit', () => {
      clearTimeout(t);
      try {
        const res = JSON.parse(out).result || '';
        const m = res.match(/```json\s*([\s\S]*?)```/) || res.match(/(\{[\s\S]*\})/);
        resolve(m ? JSON.parse(m[1]) : null);
      } catch { resolve(null); }
    });
  });
}

async function plan(office, slots) {
  const prio = JSON.parse(fs.readFileSync(PRIORITIES, 'utf8'));
  const items = await backlog();
  const byId = new Map(items.map((i) => [i.id, i]));
  const lanes = prio.frentes.map((f, i) => ({
    ordem: i + 1, nome: f.nome, objetivo: f.objetivo,
    itens: (f.ids || []).map((id) => byId.get(id)).filter((x) => x && !/^(publicado|published|feito|done)$/i.test(x.estado || ''))
      .map((x) => ({ id: x.id, pedido: x.titulo, estado: x.estado, detalhe: x.detalhe, proximo: x.proximo })),
  }));
  const mine = st.tasks.slice(0, 40).map((t) => ({ frente: t.lane, backlogIds: t.backlogIds, titulo: t.title, status: t.status, bloqueio: t.blocker }));
  const lockedIds = [...lockedBacklogIds()];
  const busy = busyFronts(office);
  const reviews = fs.existsSync(path.join(CONFIG.saidaRevisoes, 'INDEX.jsonl'))
    ? fs.readFileSync(path.join(CONFIG.saidaRevisoes, 'INDEX.jsonl'), 'utf8').trim().split('\n').slice(-15) : [];

  const prompt = `Você é o GERENTE DE ENGENHARIA 24h do projeto ${CONFIG.nome}. O dono do projeto não quer precisar cobrar ninguém.
Seu trabalho agora: escolher até ${slots} próxima(s) tarefa(s) para executar AGORA, cada uma pequena o bastante para um agente implementar e testar em até 40 minutos num worktree isolado, sem publicar nada.

Você está no código-fonte (só leitura). Use Read/Grep/Glob para conferir onde o código está antes de definir o escopo. Seja concreto: arquivos reais, critérios testáveis.

PRIORIDADES DO DONO DO PROJETO (ordem importa):
${JSON.stringify(lanes, null, 1)}

FRENTES QUE OUTROS AGENTES (Codex) ESTÃO MEXENDO AGORA — NÃO pegue nada que colida com estas:
${JSON.stringify(busy)}

TAREFAS QUE EU (GERENTE) JÁ DESPACHEI:
${JSON.stringify(mine, null, 1)}

ÚLTIMAS REVISÕES AUTOMÁTICAS:
${reviews.join('\n')}

BACKLOG IDS TRAVADOS (já têm tarefa pronta, em andamento ou bloqueada aguardando decisão — NÃO escolha nada com estes ids, nem com outro título): ${JSON.stringify(lockedIds)}

Regras: não repita tarefa já despachada, pronta ou bloqueada, mesmo com outro nome; prefira a frente de maior prioridade que tenha algo executável sem login/credencial/decisão humana; tarefas que dependem do fundador (login, aprovação de terceiros, dinheiro, decisão de produto) vão para "precisaDoFundador", não para execução. Escolha "provider": "claude" por padrão; use "codex" só se a tarefa for melhor para ele.

Responda SÓ com um bloco \`\`\`json no formato:
{"tarefas":[{"frente":"<nome da frente>","backlogIds":["..."],"titulo":"<curto, em português>","slug":"<kebab-case curto, sem data>","provider":"claude|codex","objetivo":"<o que entregar>","criterios":["<testável>"],"arquivos":["<caminhos que pode mexer>"],"foraDoEscopo":"<o que não mexer>"}],
"precisaDoFundador":[{"item":"<o quê>","porque":"<bloqueio>","oQueFazer":"<ação simples do fundador>"}],
"resumo":"<2 frases: o que você decidiu e por quê>"}`;
  const base = baseCommit();
  return runClaudeJSON(prompt, base ? baseWorktree(base) : REPO, ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git ls-files:*)']);
}

// ---------- execução ----------
function createWorktree(slug, base) {
  const dirName = `${CONFIG.prefixoWorktree}${slug}-${stamp()}`;
  const dir = path.join(PROJECT, dirName);
  const branch = `gerente/${slug}-${stamp()}`;
  if (fs.existsSync(dir)) throw new Error('worktree já existe: ' + dirName);
  git(REPO, 'worktree', 'add', '-b', branch, dir, base);
  const nm = nodeModulesSource();
  if (nm) fs.symlinkSync(nm, path.join(dir, 'node_modules'));
  return { dir, dirName, branch };
}

function workerPrompt(t, review) {
  return `${RULES}

Você recebeu uma frente real do backlog do projeto ${CONFIG.nome}, escolhida pelo Gerente 24h.
FRENTE: ${t.lane}
TAREFA: ${t.title}  (backlog: ${(t.backlogIds || []).join(', ')})
OBJETIVO: ${t.goal}
CRITÉRIOS DE ACEITE (todos com teste):
${(t.criteria || []).map((c) => '- ' + c).join('\n')}
ARQUIVOS PERMITIDOS: ${(t.files || []).join(', ') || 'os do escopo'}
FORA DO ESCOPO: ${t.outOfScope || '-'}
${review ? `\nESTA É A RODADA DE CORREÇÃO ${t.round}. O revisor independente pediu correções. Corrija TODOS os pontos abaixo (ou prove com teste que não procedem):\n${review.slice(0, 6000)}` : ''}`;
}

function spawnWorker(t, review) {
  const logFile = path.join(OUT, `${t.slug}-rodada${t.round}.log`);
  const fd = fs.openSync(logFile, 'w');
  let child;
  const prompt = workerPrompt(t, review);
  if (t.provider === 'codex' && fs.existsSync(CODEX_BIN)) {
    child = spawn(CODEX_BIN, ['exec', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false', '--sandbox', 'workspace-write', '--cd', t.dir, '--output-last-message', path.join(OUT, `${t.slug}-rodada${t.round}.final.txt`), '-'],
      { cwd: t.dir, env: cleanEnv(), stdio: ['pipe', fd, fd], detached: true });
    child.stdin.end(prompt);
  } else {
    t.provider = 'claude';
    child = spawn(CLAUDE_BIN, ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', ...WORKER_TOOLS, '--disallowedTools', ...WORKER_DENY],
      { cwd: t.dir, env: cleanEnv(), stdio: ['ignore', fd, fd], detached: true });
  }
  fs.closeSync(fd);
  t.pid = child.pid; t.status = 'trabalhando'; t.workStartedTs = Date.now(); t.log = path.relative(PROJECT, logFile);
  children.set(t.id, child);
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* */ } }, CFG.workerTimeoutMin * 60e3);
  child.on('exit', (code) => { clearTimeout(timer); children.delete(t.id); onWorkerDone(t.id, code); });
  child.unref();
  save();
  log(`despachou ${t.slug} rodada ${t.round} para ${t.provider}`);
}

function workerReport(t) {
  try {
    const fin = path.join(OUT, `${t.slug}-rodada${t.round}.final.txt`);
    if (fs.existsSync(fin)) return fs.readFileSync(fin, 'utf8');
    const raw = fs.readFileSync(path.join(PROJECT, t.log), 'utf8');
    try { return JSON.parse(raw).result || raw.slice(-4000); } catch { return raw.slice(-4000); }
  } catch { return ''; }
}

function onWorkerDone(id, code) {
  st = loadState();
  const t = st.tasks.find((x) => x.id === id);
  if (!t) return;
  t.report = workerReport(t).slice(0, 4000);
  const changed = (() => { try { return git(t.dir, 'status', '--porcelain').split('\n').filter((l) => l && !/node_modules/.test(l)).length; } catch { return 0; } })();
  if (!changed) { t.status = 'bloqueado'; t.blocker = code ? `executor saiu com erro ${code} sem mudanças` : 'executor não alterou nenhum arquivo'; save(); return; }
  t.status = 'em revisão'; t.reviewStartedTs = Date.now();
  save();
  let head = 'wip';
  try { head = git(t.dir, 'rev-parse', '--short', 'HEAD') + '+r' + t.round; } catch { /* */ }
  startReview({ front: t.slug, dir: t.dir, author: `${t.provider === 'codex' ? 'Codex' : 'Claude'} executor (Gerente 24h)`, task: `${t.title}: ${t.goal}\nCritérios: ${(t.criteria || []).join('; ')}`, report: t.report, head, key: `${t.slug}@${head}`, project: PROJECT },
    (r) => onReviewDone(id, r));
}

function onReviewDone(id, r) {
  st = loadState();
  const t = st.tasks.find((x) => x.id === id);
  if (!t) return;
  t.reviews = [...(t.reviews || []), { round: t.round, verdict: r.verdict, file: path.relative(PROJECT, r.file) }];
  if (r.verdict === 'APPROVED') {
    try {
      git(t.dir, 'add', '-A', '--', '.', ':!node_modules');
      git(t.dir, '-c', 'user.name=Gerente 24h', '-c', 'user.email=gerente@localhost', 'commit', '-m', `${t.title}\n\nBacklog: ${(t.backlogIds || []).join(', ')}\nAprovado pela revisão independente automática (rodada ${t.round}).\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
      t.commit = git(t.dir, 'rev-parse', '--short', 'HEAD');
    } catch (e) { t.commitError = String(e.message || e).slice(0, 300); }
    t.status = 'pronto para integrar'; t.readyTs = Date.now();
    fs.appendFileSync(path.join(OUT, 'PRONTOS-PARA-INTEGRAR.md'),
      `\n## ${t.title}\n- Frente: ${t.lane} · backlog ${(t.backlogIds || []).join(', ')}\n- Branch: \`${t.branch}\` (commit ${t.commit || '?'}) · worktree \`${path.relative(PROJECT, t.dir)}\`\n- Revisão: ${r.file ? path.relative(PROJECT, r.file) : '-'} → APPROVED\n- Pronto em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/New_York' })}. Falta: integrar na linha de release e publicar (Codex/fundador).\n`);
    log(`${t.slug} pronto para integrar`);
  } else if (t.round < 1 + CFG.maxFixRounds) {
    t.round += 1; t.status = 'corrigindo'; save();
    spawnWorker(t, r.text || '');
    return;
  } else {
    t.status = 'bloqueado'; t.blocker = `revisão ainda pede correção após ${CFG.maxFixRounds} rodadas — precisa de decisão`;
  }
  save();
}

// reconcilia tarefas que estavam rodando quando o servidor reiniciou
function reconcile() {
  let dirty = false;
  for (const t of st.tasks) {
    if ((t.status === 'trabalhando' || t.status === 'corrigindo') && !children.has(t.id) && t.pid && !alive(t.pid)) {
      dirty = true; setImmediate(() => onWorkerDone(t.id, 0));
    }
    if (t.status === 'em revisão' && Date.now() - (t.reviewStartedTs || 0) > 40 * 60e3) {
      // a revisão rodou em outro processo: pega o veredito do índice
      const last = (t.reviewsPending = null);
      void last;
      const idx = path.join(CONFIG.saidaRevisoes, 'INDEX.jsonl');
      const lines = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
      const fim = lines.reverse().find((l) => l.event === 'fim' && l.front === t.slug);
      if (fim) { dirty = true; const text = fs.readFileSync(path.join(PROJECT, fim.file), 'utf8'); setImmediate(() => onReviewDone(t.id, { verdict: fim.verdict, file: path.join(PROJECT, fim.file), text })); }
      else { t.status = 'bloqueado'; t.blocker = 'revisão não terminou'; dirty = true; }
    }
  }
  if (dirty) save();
}

async function cycle(office) {
  fs.mkdirSync(OUT, { recursive: true });
  st = loadState();
  if (st.day !== today()) { st.day = today(); st.dispatchedToday = 0; }
  reconcile();
  const enabled = CONFIG.gerente.ligado && !fs.existsSync(KILL_FILE);
  const active = st.tasks.filter((t) => ['trabalhando', 'corrigindo', 'em revisão'].includes(t.status)).length;
  const busyAgents = (office.agents || []).filter((a) => a.status === 'trabalhando').length;
  const ram = freeGiB();
  const slots = Math.max(0, Math.min(CFG.maxWorkers - active, CFG.maxPerDay - st.dispatchedToday));
  const why = !enabled ? 'desligado' : slots <= 0 ? (st.dispatchedToday >= CFG.maxPerDay ? 'limite diário atingido' : 'equipe do gerente ocupada')
    : ram < CFG.minFreeGiB ? `memória baixa no Mac (${ram.toFixed(1)} GB livres)` : busyAgents >= CFG.maxBusyAgents ? `já há ${busyAgents} agentes trabalhando`
    : Date.now() - (st.lastPlanTs || 0) < CFG.planEveryMin * 60e3 ? 'aguardando próximo planejamento' : planning ? 'planejando' : null;
  st.status = { checkedTs: Date.now(), enabled, ram: Number(ram.toFixed(1)), busyAgents, active, slots, waitingReason: why };
  save();
  if (why) return;

  planning = true; st.lastPlanTs = Date.now(); st.status.waitingReason = 'planejando'; save();
  log('planejando próximas tarefas…');
  try {
    const decision = await plan(office, Math.min(slots, 2));
    st = loadState();
    if (!decision) { st.notes.unshift({ ts: Date.now(), text: 'planejamento não retornou JSON válido' }); save(); return; }
    st.lastPlan = { ts: Date.now(), resumo: decision.resumo || '', tarefas: (decision.tarefas || []).map((x) => x.titulo) };
    st.founder = (decision.precisaDoFundador || []).map((f) => ({ ...f, ts: Date.now() }));
    const base = baseCommit();
    for (const d of (decision.tarefas || []).slice(0, slots)) {
      const slug = slugify(d.slug || d.titulo);
      if (!slug || st.tasks.some((t) => t.slug === slug)) continue;
      const locked = lockedBacklogIds();
      if ((d.backlogIds || []).some((id) => locked.has(id))) { st.notes.unshift({ ts: Date.now(), text: `ignorou repetição: ${d.titulo}` }); continue; }
      if (st.tasks.some((t) => similar(t.title, d.titulo))) { st.notes.unshift({ ts: Date.now(), text: `ignorou repetição: ${d.titulo}` }); continue; }
      if (!base) { st.notes.unshift({ ts: Date.now(), text: 'sem commit base publicado conhecido' }); break; }
      let wt;
      try { wt = createWorktree(slug, base); } catch (e) { st.notes.unshift({ ts: Date.now(), text: `falha ao criar worktree ${slug}: ${String(e.message).slice(0, 200)}` }); continue; }
      const t = { id: `${slug}-${Date.now()}`, slug, lane: d.frente, backlogIds: d.backlogIds || [], title: d.titulo, goal: d.objetivo, criteria: d.criterios || [], files: d.arquivos || [], outOfScope: d.foraDoEscopo,
        provider: d.provider === 'codex' ? 'codex' : 'claude', base, dir: wt.dir, branch: wt.branch, round: 1, createdTs: Date.now(), status: 'planejado' };
      st.tasks.unshift(t); st.dispatchedToday += 1;
      save();
      spawnWorker(t, null);
      st = loadState();
    }
    st.tasks = st.tasks.slice(0, 60);
    save();
  } catch (e) {
    st = loadState(); st.notes.unshift({ ts: Date.now(), text: 'erro no planejamento: ' + String(e.message || e).slice(0, 200) }); save();
  } finally { planning = false; }
}

export function tick(office) {
  if (Date.now() - lastCycle >= CFG.cycleSec * 1000) {
    lastCycle = Date.now();
    cycle(office).catch((e) => console.error('[gerente]', e));
  }
  const s = st;
  return {
    ligado: CONFIG.gerente.ligado && !fs.existsSync(KILL_FILE),
    status: s.status || null,
    hoje: s.dispatchedToday || 0,
    limiteDia: CFG.maxPerDay,
    ultimoPlano: s.lastPlan,
    precisaDoFundador: s.founder || [],
    tarefas: (s.tasks || []).slice(0, 25).map((t) => ({ slug: t.slug, titulo: t.title, frente: t.lane, provider: t.provider, status: t.status, rodada: t.round, branch: t.branch, commit: t.commit, bloqueio: t.blocker, criadoTs: t.createdTs, revisoes: t.reviews || [] })),
    notas: (s.notes || []).slice(0, 5),
  };
}
