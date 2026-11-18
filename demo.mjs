// Modo demonstração: gera um escritório fictício que muda sozinho a cada poucos segundos.
// Útil para ver a interface sem ter Codex/Claude rodando.  DEMO=1 node server.mjs

const T0 = Date.now();
const sec = () => Math.floor((Date.now() - T0) / 1000);
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

const ACTIONS = ['rodando testes', 'checando tipos (tsc)', 'editando src/checkout/cart.ts', 'lendo src/api/orders.ts', 'revisando diff no git', 'criando tests/cart.test.ts', 'procurando calculateTax', 'rodando lint', 'pensando…'];
const FRONTS = ['carrinho-de-compras', 'login-social', 'painel-de-vendas', 'notificacoes-push', 'busca-de-produtos', 'cupons-de-desconto', 'relatorio-mensal'];

function agent(id, vendor, name, role, status, extra = {}) {
  const now = Date.now();
  const lastTs = status === 'trabalhando' ? now - 3000 : status === 'esperando' ? now - 120e3 : status === 'pausa' ? now - 8 * 60e3 : status === 'concluiu' ? now - 25 * 60e3 : now - 3 * 3600e3;
  return { id, vendor, name, role, status, lastTs, ageS: Math.round((now - lastTs) / 1000), events: [], fronts: extra.front ? [extra.front] : [], ...extra };
}

export function demoState() {
  const s = sec(), cycle = Math.floor(s / 20);
  const now = Date.now();
  const agents = [
    agent('codex:lead', 'codex', 'Coordenador', 'Coordenador (ChatGPT/Codex)', 'trabalhando', { isLead: true, action: pick(['dividindo o backlog', 'conferindo entregas', 'despachando tarefa para o Claude', 'integrando branch aprovada'], cycle) }),
    agent('codex:ana', 'codex', 'Ana', 'Executor Codex', cycle % 4 === 3 ? 'pausa' : 'trabalhando', { action: pick(ACTIONS, cycle + 1), front: 'busca-de-produtos', task: 'Busca com filtros por categoria e preço' }),
    agent('codex:bruno', 'codex', 'Bruno', 'Executor Codex', 'trabalhando', { action: pick(ACTIONS, cycle + 3), front: 'notificacoes-push', task: 'Notificações push de pedido enviado' }),
    agent('claude:1', 'claude', 'Claude · carrinho de compras', 'Executor Claude (despachado pelo Codex)', 'trabalhando', { kind: 'implementacao', front: 'carrinho-de-compras', action: pick(ACTIONS, cycle + 2), task: 'Recalcular frete ao trocar CEP sem recarregar a página' }),
    agent('claude:2', 'claude', 'Claude · login social', 'Executor Claude (despachado pelo Codex)', cycle % 3 === 2 ? 'esperando' : 'trabalhando', { kind: 'implementacao', front: 'login-social', action: pick(ACTIONS, cycle + 5), task: 'Login com Google e Apple' }),
    agent('claude:3', 'claude', 'Claude · painel de vendas', 'Revisor automático (escritório)', 'trabalhando', { kind: 'revisao', auto: true, front: 'painel-de-vendas', action: pick(['rodando testes', 'revisando diff no git', 'lendo src/dashboard/sales.tsx'], cycle), task: 'Revisão independente do painel de vendas' }),
    agent('claude:4', 'claude', 'Claude · cupons de desconto', 'Executor Claude (despachado pelo Codex)', 'concluiu', { kind: 'implementacao', front: 'cupons-de-desconto', verdict: null, lastReport: 'Cupons percentuais e de valor fixo com validade; 14 testes passando.', review: { state: 'parecer: APROVADO', by: 'Claude · cupons de desconto (revisor)' } }),
    agent('claude:5', 'claude', 'Claude · relatório mensal', 'Revisor Claude (pedido pelo Codex)', 'concluiu', { kind: 'revisao', front: 'relatorio-mensal', verdict: 'NEEDS_FIX', lastReport: 'Veredito: NEEDS_FIX — fuso horário errado no fechamento do mês.' }),
  ];
  const handoffs = [];
  for (let i = 0; i < 12; i++) {
    const ts = now - (i * 4 + (s % 4)) * 60e3;
    const f = pick(FRONTS, cycle - i);
    handoffs.push(Object.assign({}, pick([
      { from: 'ChatGPT (Codex)', to: 'Claude · ' + f.replace(/-/g, ' '), kind: 'despacho', text: 'Implementar ' + f.replace(/-/g, ' ') },
      { from: 'Claude · ' + f.replace(/-/g, ' '), to: 'ChatGPT (Codex)', kind: 'entrega', text: 'Pronto, testes passando. Falta publicar.' },
      { from: 'Gerente 24h', to: 'Claude · ' + f.replace(/-/g, ' '), kind: 'despacho', text: 'Tarefa do backlog: ' + f.replace(/-/g, ' ') },
      { from: 'Escritório (revisor automático)', to: 'Claude · ' + f.replace(/-/g, ' '), kind: 'pediu revisão', text: 'Conferir a entrega parada há 15 min' },
    ], i + cycle), { ts, front: f }));
  }
  const gerenteTasks = [
    { slug: 'carrinho-de-compras', titulo: 'Recalcular frete ao trocar CEP', frente: 'Checkout', provider: 'claude', status: 'trabalhando', rodada: 1, criadoTs: now - 12 * 60e3, revisoes: [] },
    { slug: 'login-social', titulo: 'Login com Google e Apple', frente: 'Conta', provider: 'claude', status: cycle % 2 ? 'em revisão' : 'trabalhando', rodada: 1, criadoTs: now - 30 * 60e3, revisoes: [] },
    { slug: 'relatorio-mensal', titulo: 'Fechamento mensal no fuso certo', frente: 'Relatórios', provider: 'codex', status: 'corrigindo', rodada: 2, criadoTs: now - 70 * 60e3, revisoes: [{ verdict: 'NEEDS_FIX' }] },
    { slug: 'cupons-de-desconto', titulo: 'Cupons percentuais e de valor fixo', frente: 'Checkout', provider: 'claude', status: 'pronto para integrar', rodada: 1, branch: 'gerente/cupons-de-desconto-20260101', criadoTs: now - 3 * 3600e3, revisoes: [{ verdict: 'APPROVED' }] },
    { slug: 'pagamento-pix', titulo: 'Pagamento via Pix', frente: 'Checkout', provider: 'claude', status: 'bloqueado', rodada: 1, bloqueio: 'precisa da chave do provedor de pagamento', criadoTs: now - 5 * 3600e3, revisoes: [] },
  ];
  const count = (st) => agents.filter((a) => a.status === st).length;
  return {
    generatedAt: now,
    project: 'Loja Demo',
    windowHours: 12,
    totals: { agentes: agents.length, trabalhando: count('trabalhando'), esperando: count('esperando'), pausa: count('pausa'), concluiu: count('concluiu'), saiu: count('saiu') },
    board: { updatedAt: new Date(now - 6 * 60e3).toISOString(), current: 'Integrando cupons de desconto e acompanhando o login social.', next: 'Publicar a versão de hoje depois da revisão do painel de vendas.', recent: ['Cupons: aprovados na revisão independente.', 'Relatório mensal: revisão pediu correção do fuso horário.', 'Busca: filtros por categoria em andamento.'] },
    revisor: { ligado: true, limiteDia: 15, hoje: 6, esperaMin: 15, rodando: [{ front: 'painel-de-vendas', author: 'Codex Ana', startedTs: now - 4 * 60e3 }], fila: [{ front: 'busca-de-produtos', author: 'Codex Ana', why: 'esperando o dono continuar (9min)' }], recentes: [{ front: 'cupons-de-desconto', status: 'feita', verdict: 'APPROVED', endedTs: now - 25 * 60e3, file: 'output/auto-revisoes/cupons-de-desconto.md' }, { front: 'relatorio-mensal', status: 'feita', verdict: 'NEEDS_FIX', endedTs: now - 50 * 60e3, file: 'output/auto-revisoes/relatorio-mensal.md' }] },
    gerente: {
      ligado: true, hoje: 5, limiteDia: 12,
      status: { checkedTs: now - (s % 60) * 1000, enabled: true, ram: 41.2, busyAgents: count('trabalhando'), active: 3, slots: 0, waitingReason: cycle % 5 === 0 ? 'planejando' : null },
      ultimoPlano: { ts: now - 14 * 60e3, resumo: 'Peguei o frete do carrinho e o login social porque são as duas frentes de maior prioridade sem dependência de terceiros.', tarefas: ['Recalcular frete ao trocar CEP', 'Login com Google e Apple'] },
      precisaDoFundador: [{ item: 'Chave do provedor de pagamento (Pix)', porque: 'A integração de Pix não pode ser testada sem credencial de sandbox.', oQueFazer: 'Criar a conta sandbox no provedor e colocar a chave no .env.local' }],
      tarefas: gerenteTasks, notas: [],
    },
    agents,
    handoffs,
  };
}
