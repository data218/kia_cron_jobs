
const labelPlugin = {
  id:'labelPlugin',
  afterDraw(chart) {
    const {ctx,data} = chart;
    if(!data?.datasets?.length) return;
    ctx.save();
    ctx.font = 'bold 10px Inter,sans-serif';
    ctx.textAlign = 'center';
    for(let ds=0; ds<data.datasets.length; ds++) {
      const meta = chart.getDatasetMeta(ds);
      if(!meta?.data?.length) continue;
      meta.data.forEach((el,i)=>{
        let val = data.datasets[ds].data[i];
        if(val==null||val===0) return;
        const label = (data.datasets[ds].label||'').toLowerCase();
        if(label.includes('premium')||label.includes('idv')) val = '₹'+(val/100).toFixed(1)+'L';
        ctx.fillStyle = '#6b7280';
        ctx.textBaseline = 'bottom';
        if(chart.config.type==='doughnut') {
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 11px Inter,sans-serif';
          ctx.textBaseline = 'middle';
          const angle = el.startAngle + (el.endAngle - el.startAngle)/2;
          const r = el.outerRadius * 0.65;
          const x = el.x + r * Math.cos(angle);
          const y = el.y + r * Math.sin(angle);
          ctx.fillText(val, x, y);
        } else if(chart.config._config.options?.indexAxis==='y') {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(val, el.x + 4, el.y);
        } else {
          ctx.textBaseline = 'bottom';
          ctx.fillText(val, el.x, el.y - 4);
        }
      });
    }
    ctx.restore();
  }
};
Chart.register(labelPlugin);
let allData=[], vinDetail=[], charts={};
let curView='all', curChart='trend', curYear='all', curModel='all', curCompany='all';

async function refreshAll() {
  document.getElementById('mainArea').innerHTML = '<div class="loader"><div class="spin"></div>Loading...</div>';
  await loadData();
}

async function loadData() {
  try {
    const [dR, aR, vR] = await Promise.all([
      fetch('/api/data'), fetch('/api/renewal-analysis'), fetch('/api/renewal-detail')
    ]);
    const d=await dR.json(), a=await aR.json(), v=await vR.json();
    if(d.error) throw Error(d.error);
    allData=d.rows; vinDetail=v.detail||[];
    const yrs = [...new Set(allData.map(r=>r.create_date?.substring(0,4)).filter(Boolean))].sort();
    const sel = document.getElementById('yearSelect');
    sel.innerHTML = '<option value="all">All Years</option>' + yrs.map(y=>'<option value="'+y+'">'+y+'</option>').join('');
    const fromSel = document.getElementById('yearFrom'), toSel = document.getElementById('yearTo');
    const opts = yrs.map(y=>'<option value="'+y+'">'+y+'</option>').join('');
    fromSel.innerHTML = opts; toSel.innerHTML = opts;
    if(yrs.length>1) { fromSel.value=yrs[yrs.length-2]; toSel.value=yrs[yrs.length-1]; }
    const models = [...new Set(allData.map(r=>r.model).filter(Boolean))].sort();
    const mSel = document.getElementById('modelSelect');
    mSel.innerHTML = '<option value="all">All Models</option>' + models.map(m=>'<option value="'+m+'">'+m+'</option>').join('');
    const companies = [...new Set(allData.map(r=>r.insurancecompany).filter(Boolean))].sort();
    const cSel = document.getElementById('companySelect');
    cSel.innerHTML = '<option value="all">All Companies</option>' + companies.map(c=>'<option value="'+c+'">'+c+(c.length>25?'':'')+'</option>').join('');
    document.getElementById('updatedAt').textContent = new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
    render();
  } catch(e) {
    document.getElementById('mainArea').innerHTML = `<div class="loader" style="color:var(--red)">❌ ${e.message}</div>`;
  }
}

function setView(v) {
  curView=v;
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===v));
  render();
}
function setChart(c) {
  curChart=c;
  document.querySelectorAll('[data-chart]').forEach(b=>b.classList.toggle('active',b.dataset.chart===c));
  const isCmp = c==='comparison';
  document.getElementById('yearFilterGroup').style.display = isCmp ? 'none' : 'flex';
  document.getElementById('yearCompareGroup').style.display = isCmp ? 'flex' : 'none';
  render();
}
function setYear(y) {
  curYear=y;
  render();
}
function setModel(m) {
  curModel=m;
  render();
}
function setCompany(c) {
  curCompany=c;
  render();
}

function getData() {
  let d = allData;
  if(curChart==='comparison') {
    const y1 = document.getElementById('yearFrom')?.value;
    const y2 = document.getElementById('yearTo')?.value;
    if(y1&&y2) d = d.filter(r=>r.create_date?.startsWith(y1)||r.create_date?.startsWith(y2));
  } else if(curYear!=='all') {
    d = d.filter(r=>r.create_date?.startsWith(curYear));
  }
  if(curModel!=='all') d = d.filter(r=>r.model===curModel);
  if(curCompany!=='all') d = d.filter(r=>r.insurancecompany===curCompany);
  if(curView==='new') d = d.filter(r=>r.policytype==='New');
  else if(curView==='renewal') d = d.filter(r=>r.policytype==='Renewal');
  else if(curView==='high') d = d.filter(r=>(Number(r.grosspremium)||0)>=50000);
  return d;
}

function fmt(n) { return (n||0).toLocaleString('en-IN'); }

function render() {
  const d = getData();
  const area = document.getElementById('mainArea');
  let chartHtml='', tableHtml='';

  // KPI
  const tp = d.reduce((s,r)=>s+(Number(r.grosspremium)||0),0);
  const tidv = d.reduce((s,r)=>s+(Number(r.totalidv)||0),0);
  const nc = d.filter(r=>r.policytype==='New').length;
  const rc = d.filter(r=>r.policytype==='Renewal').length;
  const co = new Set(d.map(r=>r.insurancecompany)).size;
  const mo = new Set(d.map(r=>r.model)).size;

  const kpis = `
    <div class="kpi-row">
      <div class="kpi"><div class="k-label">Policies</div><div class="k-value">${fmt(d.length)}</div><div class="k-sub">${nc} New · ${rc} Renewal</div></div>
      <div class="kpi b-blue"><div class="k-label">Gross Premium</div><div class="k-value">₹${(tp/100000).toFixed(1)}L</div><div class="k-sub">Avg ₹${fmt(Math.round(tp/(d.length||1)))}</div></div>
      <div class="kpi b-green"><div class="k-label">Unique VINs</div><div class="k-value">${fmt(new Set(d.map(r=>r.vinno).filter(Boolean)).size)}</div><div class="k-sub">${mo} models</div></div>
      <div class="kpi b-red"><div class="k-label">Total IDV</div><div class="k-value">₹${(tidv/10000000).toFixed(1)}Cr</div><div class="k-sub">${co} insurers</div></div>
    </div>`;

  // CHART
  chartHtml = `<div class="chart-section"><h3>${chartTitle()} <span class="hint">${chartHint()}</span></h3><div class="chart-wrap"><canvas id="mainChart"></canvas></div></div>`;

  // TABLE
  let rows = getTableData(d);
  tableHtml = `<div class="table-section"><div class="t-header"><h3>${tableTitle()}</h3><span class="t-info">${rows.length} entries</span></div><div class="table-wrap"><table><thead><tr>${tableHeaders()}</tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;

  if(curChart==='calculations') {
    area.innerHTML = drawCalculations(d);
  } else {
    area.innerHTML = kpis + chartHtml + tableHtml;
    destroyCharts();
    drawChart(d);
  }
}

function chartTitle() {
  const t = { trend:'📈 Monthly Trend', model:'🚗 Model Distribution', company:'🏢 Insurance Companies', state:'🗺️ State Distribution', renewal:'🔄 Renewal Analysis', comparison:'📊 Year-over-Year Comparison', calculations:'🧮 Calculations & Logic' };
  return t[curChart]||'Chart';
}
function chartHint() {
  const h = { trend:'Policies & premium per month', model:'Most insured KIA models', company:'Share by insurer', state:'Geographic spread', renewal:'Same VIN year-over-year comparison', comparison:'Compare policies & premium across selected years', calculations:'How each metric is derived' };
  return h[curChart]||'';
}

function destroyCharts() {
  Object.values(charts).forEach(c=>{try{c.destroy()}catch(e){}});
  charts={};
}

function drawChart(d) {
  if(curChart==='trend') drawTrend(d);
  else if(curChart==='model') drawModel(d);
  else if(curChart==='company') drawCompany(d);
  else if(curChart==='state') drawState(d);
  else if(curChart==='renewal') drawRenewal();
  else if(curChart==='comparison') drawComparison(d);
  else if(curChart==='calculations') {} // rendered inline in chartHtml
}

function drawTrend(d) {
  const m = {}; d.forEach(r=>{const k=r.create_date?.substring(0,7); if(!k)return; if(!m[k])m[k]={p:0,pr:0}; m[k].p++; m[k].pr+=Number(r.grosspremium)||0;});
  const labels=Object.keys(m).sort(), policies=labels.map(k=>m[k].p), premiums=labels.map(k=>Math.round(m[k].pr/1000));
  const ctx=document.getElementById('mainChart').getContext('2d');
  charts.main=new Chart(ctx,{type:'bar',data:{labels,datasets:[
    {label:'Policies',data:policies,backgroundColor:'#f59e0b',borderRadius:4,order:1},
    {label:'Premium (₹K)',data:premiums,backgroundColor:'#3b82f6',borderRadius:4,yAxisID:'y1',order:0}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{boxWidth:10,color:'#6b7280',padding:8}}},scales:{
    x:{ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}},
    y:{beginAtZero:true,ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'},title:{display:true,text:'Policies',color:'#6b7280'}},
    y1:{position:'right',beginAtZero:true,ticks:{color:'#6b7280',font:{size:10}},grid:{drawOnChartArea:false},title:{display:true,text:'Premium (₹K)',color:'#6b7280'}}
  }}});
}

function drawModel(d) {
  const m={}; d.forEach(r=>{const k=r.model; if(k)m[k]=(m[k]||0)+1;});
  const s=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  const ctx=document.getElementById('mainChart').getContext('2d');
  charts.main=new Chart(ctx,{type:'bar',data:{labels:s.map(x=>x[0]),datasets:[{label:'Policies',data:s.map(x=>x[1]),backgroundColor:'#22c55e',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}},y:{ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}}}}});
}

function drawCompany(d) {
  const m={}; d.forEach(r=>{const k=r.insurancecompany; if(k)m[k]=(m[k]||0)+1;});
  const s=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  const colors=['#f59e0b','#3b82f6','#22c55e','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899'];
  const ctx=document.getElementById('mainChart').getContext('2d');
  charts.main=new Chart(ctx,{type:'doughnut',data:{labels:s.map(x=>x[0].length>25?x[0].substring(0,22)+'...':x[0]),datasets:[{data:s.map(x=>x[1]),backgroundColor:colors.slice(0,s.length),borderWidth:2,borderColor:'#ffffff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:10,color:'#6b7280',font:{size:10},padding:6}}},cutout:'60%'}});
}

function drawState(d) {
  const m={}; d.forEach(r=>{const k=r.state; if(k)m[k]=(m[k]||0)+1;});
  const s=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  const ctx=document.getElementById('mainChart').getContext('2d');
  charts.main=new Chart(ctx,{type:'bar',data:{labels:s.map(x=>x[0]),datasets:[{label:'Policies',data:s.map(x=>x[1]),backgroundColor:'#3b82f6',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}},y:{ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}}}}});
}

function drawRenewal() {
  const m = {};
  const valid = allData.filter(r=>r.vinno&&r.create_date);
  const vm = {};
  valid.forEach(r=>{const ym=r.create_date.substring(0,7); if(!vm[ym])vm[ym]=new Set(); vm[ym].add(r.vinno);});
  const yms=Object.keys(vm).sort();
  const labels=yms, renewed=[], overdue=[], newCust=[];
  yms.forEach(ym=>{
    const [y,mth]=ym.split('-').map(Number);
    const pv=`${y-1}-${String(mth).padStart(2,'0')}`, nx=`${y+1}-${String(mth).padStart(2,'0')}`;
    const cv=vm[ym], pvSet=vm[pv]||new Set();
    renewed.push([...cv].filter(v=>pvSet.has(v)).length);
    overdue.push([...cv].filter(v=>!pvSet.has(v)).length);
    newCust.push([...cv].filter(v=>!pvSet.has(v)).length);
  });
  const ctx=document.getElementById('mainChart').getContext('2d');
  charts.main=new Chart(ctx,{type:'bar',data:{labels,datasets:[
    {label:'Renewed',data:renewed,backgroundColor:'#22c55e',borderRadius:3},
    {label:'New',data:newCust,backgroundColor:'#3b82f6',borderRadius:3},
    {label:'Overdue',data:overdue,backgroundColor:'#ef4444',borderRadius:3}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{boxWidth:10,color:'#6b7280',padding:8}}},scales:{
    x:{stacked:!0,ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}},
    y:{beginAtZero:true,stacked:!0,ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}}
  }}});
}

function drawComparison(d) {
  const y1 = document.getElementById('yearFrom').value;
  const y2 = document.getElementById('yearTo').value;
  const m = {};
  d.forEach(r=>{
    const ym = r.create_date?.substring(0,7); if(!ym) return;
    const [y,mth] = ym.split('-'); const mo = parseInt(mth);
    if(!m[mo]) m[mo] = {};
    if(!m[mo][y]) m[mo][y] = {p:0,pr:0};
    m[mo][y].p++; m[mo][y].pr += Number(r.grosspremium)||0;
  });
  const labels = Object.keys(m).sort((a,b)=>a-b).map(mo=>{const d=new Date(2024,mo-1); return d.toLocaleString('en',{month:'short'});});
  const y1p = [], y1pr = [], y2p = [], y2pr = [];
  Object.keys(m).sort((a,b)=>a-b).forEach(mo=>{
    y1p.push(m[mo][y1]?.p||0); y1pr.push(Math.round((m[mo][y1]?.pr||0)/1000));
    y2p.push(m[mo][y2]?.p||0); y2pr.push(Math.round((m[mo][y2]?.pr||0)/1000));
  });
  const ctx=document.getElementById('mainChart').getContext('2d');
  charts.main=new Chart(ctx,{type:'bar',data:{labels,datasets:[
    {label:y1+' Policies',data:y1p,backgroundColor:'#f59e0b',borderRadius:3,order:2},
    {label:y2+' Policies',data:y2p,backgroundColor:'#f97316',borderRadius:3,order:2},
    {label:y1+' Premium (₹K)',data:y1pr,backgroundColor:'#3b82f6',borderRadius:3,yAxisID:'y1',order:1},
    {label:y2+' Premium (₹K)',data:y2pr,backgroundColor:'#06b6d4',borderRadius:3,yAxisID:'y1',order:1}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{boxWidth:10,color:'#6b7280',font:{size:9},padding:6}}},scales:{
    x:{ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}},
    y:{beginAtZero:true,ticks:{color:'#6b7280',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'},title:{display:true,text:'Policies',color:'#6b7280',font:{size:10}}},
    y1:{position:'right',beginAtZero:true,ticks:{color:'#6b7280',font:{size:10}},grid:{drawOnChartArea:false},title:{display:true,text:'Premium (₹K)',color:'#6b7280',font:{size:10}}}
  }}});
}

function drawCalculations(d) {
  const tp = d.reduce((s,r)=>s+(Number(r.grosspremium)||0),0);
  const tidv = d.reduce((s,r)=>s+(Number(r.totalidv)||0),0);
  const nc = d.filter(r=>r.policytype==='New').length;
  const rc = d.filter(r=>r.policytype==='Renewal').length;
  const uv = new Set(d.map(r=>r.vinno).filter(Boolean)).size;
  const co = new Set(d.map(r=>r.insurancecompany)).size;
  const mo = new Set(d.map(r=>r.model)).size;
  const rows = [
    ['KPI: Policies', 'count of all rows after filters', fmt(d.length), '-'],
    ['KPI: New Policies', 'count where policytype === "New"', fmt(nc), '-'],
    ['KPI: Renewal Policies', 'count where policytype === "Renewal"', fmt(rc), '-'],
    ['KPI: Gross Premium', 'sum of grosspremium for filtered rows', '₹'+(tp/100000).toFixed(1)+'L', '₹'+(tp/100000).toFixed(1)+'L / ₹'+(tp/10000000).toFixed(1)+'Cr'],
    ['KPI: Avg Premium', 'gross premium / policy count', '₹'+fmt(Math.round(tp/(d.length||1))), '-'],
    ['KPI: Unique VINs', 'count of distinct vinno values', fmt(uv), '-'],
    ['KPI: Total IDV', 'sum of totalidv for filtered rows', '₹'+(tidv/10000000).toFixed(1)+'Cr', '-'],
    ['', '', '', ''],
    ['Filter: Year', 'create_date starts with selected year', curYear==='all' ? 'All' : curYear, 'getData() → create_date?.startsWith(year)'],
    ['Filter: Model', 'model === selected model', curModel==='all' ? 'All' : curModel, 'getData() → r.model===curModel'],
    ['Filter: View (New)', 'policytype === "New"', curView==='new' ? 'Active' : '-', 'getData() → r.policytype==="New"'],
    ['Filter: View (Renewal)', 'policytype === "Renewal"', curView==='renewal' ? 'Active' : '-', 'getData() → r.policytype==="Renewal"'],
    ['Filter: View (High)', 'grosspremium >= ₹50,000', curView==='high' ? 'Active' : '-', 'getData() → grosspremium>=50000'],
    ['', '', '', ''],
    ['Chart: Trend', 'monthly policies count & premium sum', 'bar chart (dual Y-axis)', 'group by create_date (YYYY-MM); policies=count(rows), premium=round(sum/1000)'],
    ['Chart: Model', 'policies per model (horizontal bar)', 'horizontal bar chart', 'group by model; sort descending; top entries shown'],
    ['Chart: Company', 'policies per insurer (doughnut)', 'doughnut chart', 'group by insurancecompany; colored slices'],
    ['Chart: State', 'policies per state (horizontal bar)', 'horizontal bar chart', 'group by state; sorted by count'],
    ['Chart: Renewal', 'stacked bar: Renewed / New / Overdue', 'stacked bar chart', 'compare same VIN & month across consecutive years'],
    ['Chart: Comparison', 'year-over-year side-by-side bars', 'grouped bar chart', '2 years × 2 metrics (policies + premium) per month'],
    ['', '', '', ''],
    ['Renewal: Active', 'VIN present in month Y and same month Y-1', 'count of matching VINs', 'vm[YYYY-MM] ∩ vm[YYYY-1-MM]'],
    ['Renewal: New', 'VIN present in month Y but not in Y-1', 'count of new VINs', 'vm[YYYY-MM] - vm[YYYY-1-MM]'],
    ['Renewal: Overdue', 'VIN expected in Y but only found in Y-1', 'count of missing VINs', 'vm[YYYY-1-MM] - vm[YYYY-MM]'],
    ['', '', '', ''],
    ['Label: Premium', 'bar data labels show ₹ + lakhs', '₹26.8L format', 'labelPlugin: if dataset label has "premium" → val/100 + "L"'],
    ['Label: Doughnut', 'values rendered inside arc segments', 'white text, centered', 'labelPlugin: doughnut type → fillText at arc center'],
    ['Label: Count', 'values rendered above bars', 'gray text above bar', 'labelPlugin: bar type → fillText at el.y - 4'],
    ['Format: Premium', 'Gross Premium KPI', '₹337.5L', 'tp/100000 → lakhs; tp/10000000 → crores'],
    ['Format: IDV', 'Total IDV KPI', '₹117.8Cr', 'tidv/10000000 → crores'],
    ['Format: Avg', 'Average Premium KPI', '₹29,504', 'Math.round(tp / count)'],
  ];
  const closeBtn = '<button onclick="setChart(\'trend\')" style="float:right;padding:4px 12px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--muted);font-size:11px;cursor:pointer">✕ Close</button>';
  return `<div class="chart-section" style="overflow:auto"><h3>${closeBtn}🧮 Calculations & Logic <span class="hint">How each metric is derived</span></h3><div style="overflow:auto;max-height:400px"><table style="font-size:11px;width:100%"><thead><tr><th style="position:sticky;top:0;background:var(--panel);padding:6px 10px;text-align:left">Metric</th><th style="position:sticky;top:0;background:var(--panel);padding:6px 10px;text-align:left">Logic</th><th style="position:sticky;top:0;background:var(--panel);padding:6px 10px;text-align:left">Current Value</th><th style="position:sticky;top:0;background:var(--panel);padding:6px 10px;text-align:left">Formula</th></tr></thead><tbody>${
    rows.map(r=>r[0]?'<tr>'+r.map(c=>'<td style="padding:5px 10px;border-bottom:1px solid var(--border);color:'+(r[0].startsWith('KPI')?'var(--accent)':'var(--text)')+'">'+c+'</td>').join('')+'</tr>':'').join('')
  }</tbody></table></div></div>`;
}

function tableHeaders() {
  if(curChart==='renewal') return '<th>VIN</th><th>Customer</th><th>Model</th><th>Status</th><th>Premium</th><th>Last Date</th>';
  return '<th>Policy No</th><th>Customer</th><th>Model</th><th>Insurance</th><th>Premium</th><th>Date</th>';
}

function tableTitle() {
  if(curChart==='renewal') return '🔍 VIN Status Overview';
  if(curView==='high') return '⭐ Highest Premium Policies';
  return '📋 Recent Policies';
}

function getTableData(d) {
  if(curChart==='renewal') {
    let v = vinDetail;
    if(curYear!=='all') v=v.filter(r=>r.lastDate?.startsWith(curYear));
    if(curView==='new') v=v.filter(r=>r.status==='New');
    else if(curView==='renewal') v=v.filter(r=>r.status==='Active');
    else if(curView==='high') v=v.filter(r=>r.lastPremium>=50000);
    return v.slice(0,15).map(r=>`<tr><td style="font-family:monospace;font-size:10px">${r.vin}</td><td>${r.customer}</td><td>${r.model}</td><td><span class="badge ${r.status==='Active'?'green':r.status==='New'?'blue':'red'}">${r.status}</span></td><td>₹${fmt(r.lastPremium)}</td><td>${r.lastDate}</td></tr>`);
  }
  const sorted=[...d].sort((a,b)=>(Number(b.grosspremium)||0)-(Number(a.grosspremium)||0));
  return sorted.slice(0,15).map(r=>`<tr><td style="font-family:monospace;font-size:10px">${r.policyno||'-'}</td><td>${r.customer_name||'-'}</td><td>${r.model||'-'}</td><td>${(r.insurancecompany||'-').substring(0,22)}</td><td><strong>₹${fmt(Number(r.grosspremium)||0)}</strong></td><td>${r.create_date||'-'}</td></tr>`);
}

loadData();
