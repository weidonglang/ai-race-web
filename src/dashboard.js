// 训练 & 对抗 数据看板
// 读取 localStorage 中的多种历史记录，并用 Chart.js 绘制趋势图。
// Chart.js 支持线图 / 柱状图等多种类型，这里主要用 line + bar。:contentReference[oaicite:1]{index=1}

const loadArray = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]') || [];
  } catch (e) {
    console.error('解析 localStorage 失败：', key, e);
    return [];
  }
};

const soloRuns  = loadArray('ai_runs');       // 单人回合（编辑器）
const dualRuns  = loadArray('ai_dual_runs');  // A/B 竞速（编辑器）
const arenaRuns = loadArray('arena_runs');    // 对抗 Arena

const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

function makeLineChart (canvasId, labels, datasets, title, yLabel = '数值') {
  const el = document.getElementById(canvasId);
  if (!el || !labels.length) return;
  const ctx = el.getContext('2d');
  /* global Chart */
  new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      stacked: false,
      plugins: {
        legend: { position: 'top' },
        title: { display: true, text: title }
      },
      scales: {
        x: { title: { display: true, text: '回合序号' } },
        y: { title: { display: true, text: yLabel } }
      }
    }
  });
}

function makeBarChart (canvasId, labels, datasets, title, yLabel = '数值') {
  const el = document.getElementById(canvasId);
  if (!el || !labels.length) return;
  const ctx = el.getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top' },
        title: { display: true, text: title }
      },
      scales: {
        x: { title: { display: true, text: '难度' } },
        y: {
          title: { display: true, text: yLabel },
          beginAtZero: true
        }
      }
    }
  });
}

/* -------------------- 单人回合：ai_runs -------------------- */

(function setupSolo () {
  const box = document.getElementById('statsSolo');
  if (!soloRuns.length) {
    box.innerHTML = '<p>当前没有单人训练数据。请先在“编辑器”页运行几次 <code>开始回合</code>。</p>';
    return;
  }

  const labels  = soloRuns.map((_, i) => i + 1);
  const times   = soloRuns.map(r => (r.timeMs || 0) / 1000);
  const pathLen = soloRuns.map(r => r.pathLen || 0);

  makeLineChart('chartSolo', labels, [
    { label: '用时 (s)',     data: times,   fill: false, tension: 0.15 },
    { label: '路径长度 (m)', data: pathLen, fill: false, tension: 0.15 }
  ], '单人回合 - 用时 / 路径', '数值');

  const last = soloRuns.slice(-5);
  const avgTimeAll  = avg(times);
  const avgTimeLast = avg(last.map(r => (r.timeMs || 0) / 1000));
  const bestTime    = Math.min(...times);

  box.innerHTML = `
    <p>共记录 <b>${soloRuns.length}</b> 条单人训练。</p>
    <ul>
      <li>全局平均用时：<b>${avgTimeAll.toFixed(2)} s</b></li>
      <li>最近 ${last.length} 回合平均用时：<b>${avgTimeLast.toFixed(2)} s</b></li>
      <li>历史最佳时间：<b>${bestTime.toFixed(2)} s</b></li>
    </ul>
  `;
})();

/* -------------------- A/B 竞速：ai_dual_runs -------------------- */

(function setupDual () {
  const box = document.getElementById('statsDual');
  if (!dualRuns.length) {
    box.innerHTML = '<p>当前没有 A/B 竞速数据。请先在“编辑器”页运行几次 <code>开始竞速 A/B</code>。</p>';
    return;
  }

  const labels = dualRuns.map((_, i) => i + 1);
  const timesA = dualRuns.map(r => (r.A?.timeMs || 0) / 1000);
  const timesB = dualRuns.map(r => (r.B?.timeMs || 0) / 1000);

  makeLineChart('chartDual', labels, [
    { label: 'Agent A (s)', data: timesA, fill: false, tension: 0.15 },
    { label: 'Agent B (s)', data: timesB, fill: false, tension: 0.15 }
  ], 'A/B 竞速 - 用时对比', '用时 (s)');

  const last = dualRuns.slice(-10);
  const avgA = avg(timesA);
  const avgB = avg(timesB);
  const winsA = dualRuns.filter(r => r.winner === 'A').length;
  const winsB = dualRuns.filter(r => r.winner === 'B').length;
  const ties  = dualRuns.filter(r => r.winner === 'tie').length;

  box.innerHTML = `
    <p>共记录 <b>${dualRuns.length}</b> 场 A/B 竞速。</p>
    <ul>
      <li>全局平均用时：A = <b>${avgA.toFixed(2)} s</b>，B = <b>${avgB.toFixed(2)} s</b></li>
      <li>最近 ${last.length} 场平均用时：
        A = <b>${avg(last.map(r => (r.A?.timeMs || 0)/1000)).toFixed(2)} s</b>，
        B = <b>${avg(last.map(r => (r.B?.timeMs || 0)/1000)).toFixed(2)} s</b>
      </li>
      <li>胜负统计：A 赢 <b>${winsA}</b> 场，B 赢 <b>${winsB}</b> 场，平局 <b>${ties}</b> 场</li>
    </ul>
  `;
})();

/* -------------------- 对抗 Arena：arena_runs -------------------- */

(function setupArena () {
  const box = document.getElementById('statsArena');
  if (!arenaRuns.length) {
    box.innerHTML = '<p>当前没有 Arena 对抗数据。请先在 Arena 页面运行几局对抗。</p>';
    return;
  }

  // 1) 原有：按对局序号画积分趋势
  const labels = arenaRuns.map(r => r.ep ?? '?');
  const scoreA = arenaRuns.map(r => r.scoreA ?? 0);
  const scoreB = arenaRuns.map(r => r.scoreB ?? 0);

  makeLineChart('chartArenaScore', labels, [
    { label: 'Agent A 积分', data: scoreA, fill: false, tension: 0.15 },
    { label: 'Agent B 积分', data: scoreB, fill: false, tension: 0.15 }
  ], 'Arena 对抗 - 积分趋势', '积分');

  const last = arenaRuns.slice(-10);

  const avgScoreA    = avg(scoreA);
  const avgScoreB    = avg(scoreB);
  const avgExploreA  = avg(arenaRuns.map(r => r.exploredA ?? 0));
  const avgExploreB  = avg(arenaRuns.map(r => r.exploredB ?? 0));
  const avgTrapsA    = avg(arenaRuns.map(r => r.trapsA ?? 0));
  const avgTrapsB    = avg(arenaRuns.map(r => r.trapsB ?? 0));

  const winsA = arenaRuns.filter(r => r.winner === 'A').length;
  const winsB = arenaRuns.filter(r => r.winner === 'B').length;
  const ties  = arenaRuns.filter(r => r.winner === '平局' || r.winner === 'tie').length;

  box.innerHTML = `
    <p>共记录 <b>${arenaRuns.length}</b> 局 Arena 对抗。</p>
    <ul>
      <li>平均积分：A = <b>${avgScoreA.toFixed(1)}</b>，B = <b>${avgScoreB.toFixed(1)}</b></li>
      <li>平均探索格子数：A ≈ <b>${avgExploreA.toFixed(1)}</b>，B ≈ <b>${avgExploreB.toFixed(1)}</b></li>
      <li>平均陷阱命中：A ≈ <b>${avgTrapsA.toFixed(2)}</b>，B ≈ <b>${avgTrapsB.toFixed(2)}</b></li>
      <li>胜负统计：A 赢 <b>${winsA}</b> 局，B 赢 <b>${winsB}</b> 局，平局 <b>${ties}</b> 局</li>
      <li>最近 ${last.length} 局的积分范围：
        A ∈ [${Math.min(...last.map(r => r.scoreA ?? 0)).toFixed(1)}, ${Math.max(...last.map(r => r.scoreA ?? 0)).toFixed(1)}]，
        B ∈ [${Math.min(...last.map(r => r.scoreB ?? 0)).toFixed(1)}, ${Math.max(...last.map(r => r.scoreB ?? 0)).toFixed(1)}]
      </li>
    </ul>
  `;

  // 2) 新增：按难度聚合 —— 平均耗时 / 平均路径长度 / 对局数量分布
  const groups = {};
  for (const r of arenaRuns) {
    const diff = (r.mazeDiff || 'unknown').toLowerCase();
    if (!groups[diff]) {
      groups[diff] = {
        count: 0,
        timeA: [],
        timeB: [],
        pathA: [],
        pathB: []
      };
    }
    groups[diff].count += 1;
    // timeA / timeB 已经是秒
    if (typeof r.timeA === 'number') groups[diff].timeA.push(r.timeA);
    if (typeof r.timeB === 'number') groups[diff].timeB.push(r.timeB);
    if (typeof r.pathLenA === 'number') groups[diff].pathA.push(r.pathLenA);
    if (typeof r.pathLenB === 'number') groups[diff].pathB.push(r.pathLenB);
  }

  // 自定义排序：easy / medium / hard / 其他
  const allDiffs = Object.keys(groups);
  const order = { easy: 0, medium: 1, hard: 2 };
  const diffLabels = allDiffs.sort((a, b) => {
    const ra = (order[a] ?? 99);
    const rb = (order[b] ?? 99);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  const avgTimeAByDiff  = diffLabels.map(d => avg(groups[d].timeA));
  const avgTimeBByDiff  = diffLabels.map(d => avg(groups[d].timeB));
  const avgPathAByDiff  = diffLabels.map(d => avg(groups[d].pathA));
  const avgPathBByDiff  = diffLabels.map(d => avg(groups[d].pathB));
  const countByDiff     = diffLabels.map(d => groups[d].count);

  // 不同难度 - 平均耗时
  makeBarChart(
    'chartArenaTimeByDiff',
    diffLabels,
    [
      { label: 'A 平均耗时 (s)', data: avgTimeAByDiff },
      { label: 'B 平均耗时 (s)', data: avgTimeBByDiff }
    ],
    '不同难度 - 平均耗时',
    '时间 (s)'
  );

  // 不同难度 - 平均路径长度
  makeBarChart(
    'chartArenaPathByDiff',
    diffLabels,
    [
      { label: 'A 平均路径长度 (m)', data: avgPathAByDiff },
      { label: 'B 平均路径长度 (m)', data: avgPathBByDiff }
    ],
    '不同难度 - 平均路径长度',
    '路径长度 (m)'
  );

  // 不同难度 - 对局数量分布
  makeBarChart(
    'chartArenaDiffCount',
    diffLabels,
    [
      { label: '对局数量', data: countByDiff }
    ],
    '不同难度 - 对局数量分布',
    '局数'
  );
})();
