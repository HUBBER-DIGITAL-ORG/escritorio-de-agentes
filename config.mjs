// Configuração do Escritório de Agentes.
// Lê config.json (na mesma pasta) e aceita variáveis de ambiente por cima.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
let file = {};
try { file = JSON.parse(fs.readFileSync(process.env.OFFICE_CONFIG || path.join(HERE, 'config.json'), 'utf8')); } catch { /* usa padrões */ }

const projeto = path.resolve((process.env.OFFICE_PROJECT || file.projeto || process.cwd()).replace(/^~/, os.homedir()));
const abs = (p) => (path.isAbsolute(p) ? p : path.join(projeto, p));

export const CONFIG = {
  here: HERE,
  nome: process.env.OFFICE_NAME || file.nome || path.basename(projeto),
  projeto,
  repo: abs(file.repo || '.'),
  porta: Number(process.env.PORT || file.porta || 4777),
  janelaHoras: Number(file.janelaHoras || 12),
  demo: process.env.DEMO === '1' || file.demo === true,
  codexDir: path.join(os.homedir(), '.codex'),
  claudeDir: path.join(os.homedir(), '.claude/projects'),
  quadro: file.quadro ? abs(file.quadro) : abs('.codex/live-work-status.json'),
  backlog: abs(file.backlog || 'backlog.json'),
  prioridades: abs(file.prioridades || path.join(HERE, 'prioridades.json')),
  baseRef: file.baseRef || 'main',
  prefixoWorktree: file.prefixoWorktree || 'wt-',
  nodeModules: file.nodeModules ? abs(file.nodeModules) : null,
  saidaRevisoes: abs(file.saidaRevisoes || 'output/auto-revisoes'),
  saidaGerente: abs(file.saidaGerente || 'output/gerente'),
  comandosTeste: file.comandosTeste || [
    'Bash(node --test:*)', 'Bash(node --import tsx --test:*)', 'Bash(npm test:*)',
    'Bash(./node_modules/.bin/tsc --noEmit:*)', 'Bash(./node_modules/.bin/eslint:*)', 'Bash(python3 -m unittest:*)', 'Bash(pytest:*)',
  ],
  revisor: { ligado: file.revisor?.ligado !== false, esperaMin: Number(file.revisor?.esperaMin || 15), maxDia: Number(file.revisor?.maxDia || 15), maxParalelo: Number(file.revisor?.maxParalelo || 2) },
  gerente: { ligado: file.gerente?.ligado === true, maxParalelo: Number(file.gerente?.maxParalelo || 2), maxDia: Number(file.gerente?.maxDia || 12), minRamGB: Number(file.gerente?.minRamGB || 2), planoMin: Number(file.gerente?.planoMin || 20) },
  claudeBin: process.env.CLAUDE_BIN || file.claudeBin || 'claude',
  codexBin: process.env.CODEX_BIN || file.codexBin || 'codex',
};

// Claude Code guarda sessões em ~/.claude/projects/<caminho com / e . trocados por ->
export const CLAUDE_PROJECT_KEY = CONFIG.projeto.replace(/[^a-zA-Z0-9]/g, '-');

const wtCache = new Map();
// "frente" = pasta de primeiro nível dentro do projeto que é um worktree git (tem arquivo .git)
export function frontDirFromPath(p) {
  p = String(p || '').replace(/^file:\/\//, '');
  const root = CONFIG.projeto + '/';
  const i = p.indexOf(root);
  if (i < 0) return null;
  const seg = p.slice(i + root.length).split(/[/\s'"]/)[0];
  if (!seg || seg.startsWith('.')) return null;
  if (!wtCache.has(seg)) {
    let ok = false;
    try { ok = fs.statSync(path.join(CONFIG.projeto, seg, '.git')).isFile(); } catch { /* */ }
    wtCache.set(seg, ok);
  }
  return wtCache.get(seg) ? seg : null;
}
export function frontFromPath(p) {
  const d = frontDirFromPath(p);
  return d ? d.replace(new RegExp('^' + CONFIG.prefixoWorktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '').replace(/-\d{8}$/, '') : null;
}
