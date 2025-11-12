// 从 localStorage 读取训练历史，绘制折线
const histKey = 'airace_runs';
const history = JSON.parse(localStorage.getItem(histKey) || '[]');

const labels = history.map(x => x.ep);
const dataA = history.map(x => x.timeA);
const dataB = history.map(x => x.timeB);

const ctx = document.getElementById('chart').getContext('2d');
/* global Chart */
new Chart(ctx, {
  type: 'line',
  data: {
    labels,
    datasets: [
      { label: 'Agent A (s)', data: dataA, fill:false, tension:0.1 },
      { label: 'Agent B (s)', data: dataB, fill:false, tension:0.1 }
    ]
  },
  options: {
    responsive: true,
    plugins: { legend: { position: 'top' }, title: { display: true, text: '回合用时趋势' } },
    scales: { x: { title: { display: true, text: 'Episode' } }, y: { title: { display: true, text: 'Time (s)' } } }
  }
});

const last = history.slice(-5);
const avg = arr => arr.reduce((s,x)=>s+x,0)/Math.max(arr.length,1);
const stats = `
  <p style="color:#9db0c6">
    最近 ${last.length} 回合平均：A=${avg(last.map(x=>x.timeA)).toFixed(2)}s，
    B=${avg(last.map(x=>x.timeB)).toFixed(2)}s
  </p>`;
document.getElementById('stats').innerHTML = stats;
