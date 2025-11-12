import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/* ---------- DOM utils ---------- */
const $ = (id) => document.getElementById(id)
const on = (el, evt, fn) => { if (el) el.addEventListener(evt, fn) }
const num = (el, def) => el ? parseFloat(el.value || `${def}`) : def
const int = (el, def) => el ? parseInt(el.value || `${def}`, 10) : def
const bool = (el, def) => el ? !!el.checked : def
const setText = (el, t) => { if (el) el.textContent = t }

/* ---------- Three.js setup ---------- */
const root = $('viewport')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(root.clientWidth, root.clientHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
root.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115')

const camera = new THREE.PerspectiveCamera(60, root.clientWidth / root.clientHeight, 0.1, 1000)
camera.position.set(10, 12, 18)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.8)
scene.add(hemi)
const dir = new THREE.DirectionalLight(0xffffff, 0.8)
dir.position.set(6, 10, 6)
scene.add(dir)

/* Ground + Grid */
const FLOOR_SIZE = 30
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, 1, 1)
floorGeo.rotateX(-Math.PI / 2)
const floorMat = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, metalness: 0.0, roughness: 1.0 })
const floor = new THREE.Mesh(floorGeo, floorMat)
floor.receiveShadow = true
floor.name = 'Floor'
scene.add(floor)
const grid = new THREE.GridHelper(FLOOR_SIZE, FLOOR_SIZE, 0x444a57, 0x303543)
grid.position.y = 0.01
scene.add(grid)

/* ---------- Scene edit state ---------- */
const raycaster = new THREE.Raycaster()
const mouseNDC = new THREE.Vector2()
let placingMode = null // 'box' | 'start' | 'end' | null
let downPos = null

const obstacles = []
let startMarker = null
let endMarker = null

let selectedObstacle = null
let draggingObstacle = null
let isDragging = false

function updateCursor() {
  renderer.domElement.style.cursor = (placingMode || rl.visual) ? 'crosshair' : 'default'
}

function makeMarker(color) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 24, 16),
    new THREE.MeshStandardMaterial({ color })
  )
}
function addObstacleAt(point) {
  const geo = new THREE.BoxGeometry(2, 2, 2)
  const mat = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, metalness: 0.2, roughness: 0.8 })
  const box = new THREE.Mesh(geo, mat)
  box.position.copy(point).y = 1.0
  box.castShadow = true
  box.receiveShadow = true
  box.name = 'Obstacle'
  box.userData.baseEmissive = (box.material.emissive ? box.material.emissive.getHex() : 0x000000)
  scene.add(box)
  obstacles.push(box)
  rlDirtyGrid()
}
function pickOnFloor(ev) {
  const rect = renderer.domElement.getBoundingClientRect()
  mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouseNDC, camera)
  const hit = raycaster.intersectObject(floor, false)[0]
  return hit ? hit.point : null
}
function pickObstacle(ev) {
  const rect = renderer.domElement.getBoundingClientRect()
  mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(mouseNDC, camera)
  const hit = raycaster.intersectObjects(obstacles, false)[0]
  return hit ? hit.object : null
}
function selectObstacle(obj){
  if (selectedObstacle && selectedObstacle !== obj)
    selectedObstacle.material.emissive?.setHex(selectedObstacle.userData.baseEmissive ?? 0x000000)
  selectedObstacle = obj || null
  if (selectedObstacle) selectedObstacle.material.emissive?.setHex(0x00ffff)
}

/* Edit interactions */
renderer.domElement.addEventListener('pointerdown', (ev) => {
  downPos = { x: ev.clientX, y: ev.clientY }
  if (!placingMode && ev.shiftKey) {
    const obj = pickObstacle(ev)
    if (obj) { isDragging = true; draggingObstacle = obj; selectObstacle(obj); controls.enabled = false; updateCursor() }
  }
})
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!isDragging || !draggingObstacle) return
  const p = pickOnFloor(ev); if (p) { draggingObstacle.position.set(p.x, 1.0, p.z); rlDirtyGrid() }
})
renderer.domElement.addEventListener('pointerup', () => {
  if (isDragging) { isDragging = false; draggingObstacle = null; controls.enabled = true; updateCursor() }
})
renderer.domElement.addEventListener('click', (ev) => {
  if (ev.button !== 0) return
  if (downPos) { const dx = ev.clientX - downPos.x, dy = ev.clientY - downPos.y; if (Math.hypot(dx, dy) > 5) return }
  if (placingMode) {
    const p = pickOnFloor(ev); if (!p) return
    if (placingMode === 'box') addObstacleAt(p)
    else if (placingMode === 'start') { if (!startMarker) { startMarker = makeMarker(0x22cc88); scene.add(startMarker) } startMarker.position.set(p.x, 0.25, p.z); placingMode=null; updateCursor(); rlDirtyGrid() }
    else if (placingMode === 'end')   { if (!endMarker)   { endMarker   = makeMarker(0xff5555); scene.add(endMarker)   } endMarker.position.set(p.x, 0.25, p.z); placingMode=null; updateCursor(); rlDirtyGrid() }
    return
  }
  const obj = pickObstacle(ev)
  if (obj) { if (ev.ctrlKey) { deleteObstacle(obj) } else { selectObstacle(obj === selectedObstacle ? null : obj) } }
  else { selectObstacle(null) }
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { placingMode = null; updateCursor() }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedObstacle) { e.preventDefault(); deleteObstacle(selectedObstacle); selectedObstacle = null }
})
function deleteObstacle(obj) {
  const idx = obstacles.indexOf(obj)
  if (idx >= 0) obstacles.splice(idx, 1)
  scene.remove(obj)
  if (selectedObstacle === obj) selectedObstacle = null
  rlDirtyGrid()
}

/* Top buttons */
on($('btnAddBox'), 'click', () => { placingMode = (placingMode === 'box') ? null : 'box'; updateCursor() })
on($('btnSetStart'), 'click', () => { placingMode = (placingMode === 'start') ? null : 'start'; updateCursor() })
on($('btnSetEnd'),   'click', () => { placingMode = (placingMode === 'end') ? null : 'end'; updateCursor() })
on($('btnClear'),    'click', () => {
  placingMode = null; updateCursor()
  obstacles.forEach(m => scene.remove(m)); obstacles.length = 0
  selectObstacle(null)
  if (startMarker) { scene.remove(startMarker); startMarker = null }
  if (endMarker)   { scene.remove(endMarker);   endMarker   = null }
  rlStop(); rlClearAll()
})

/* HUD refs */
const hud = {
  obs: $('hudObs'),
  who: $('hudWho'), epi: $('hudEpi'), ret: $('hudRet'), steps: $('hudSteps'),
  bestA: $('hudBestA'), bestB: $('hudBestB'),
  speed: $('rlSpeed'), speedVal: $('rlSpeedVal')
}

/* ---------- RL UI ---------- */
const rlUI = {
  h: $('rlH'), maxSteps: $('rlMaxSteps'),
  alpha: $('rlAlpha'), gamma: $('rlGamma'),
  epsStart: $('rlEpsStart'), epsEnd: $('rlEpsEnd'), epsDecay: $('rlEpsDecay'),
  rGoal: $('rlRGoal'), cStep: $('rlCstep'), cWall: $('rlCwall'), cRepeat: $('rlCrepeat'),
  build: $('btnRLBuild'), start: $('btnRLStart'), pause: $('btnRLPause'), stop: $('btnRLStop'),
  replayA: $('btnRLReplayA'), replayB: $('btnRLReplayB'),
  visual: $('rlVisual'), fast: $('rlFast'), showGrid: $('rlShowGrid'),
  speed: $('rlSpeed')
}

const ACTIONS = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]]

/* ---------- Environment (shared) ---------- */
const RL = {
  gridReady:false, h:0.6, nx:0, nz:0, x0:0, z0:0,
  passable:[], positions:[],
  sStart:-1, sGoal:-1
}
let rlGridLines = null

/* Agent meshes */
class AgentMesh {
  constructor(color){ this.mesh=new THREE.Mesh(new THREE.SphereGeometry(0.25,24,16), new THREE.MeshStandardMaterial({color})); this.mesh.visible=false; scene.add(this.mesh) }
  setPos(v){ this.mesh.position.copy(v); this.mesh.visible=true }
  hide(){ this.mesh.visible=false }
}
const agentA = new AgentMesh(0x00b0ff) // 蓝
const agentB = new AgentMesh(0xff6d00) // 橙

/* Learners (independent) */
function createLearner(tag){
  return {
    tag, Q:new Map(), epi:0, success:0,
    s:-1, ret:0, steps:0, done:false,
    pathIdxs:[], visits:null,  // visits 将在 buildNavGrid 后初始化为 Uint16Array(N)
    best:{steps:Infinity, path:null},
    curLine:null, bestLine:null,
    agent:(tag==='A')?agentA:agentB
  }
}
const L = { A:createLearner('A'), B:createLearner('B') }

/* Runtime */
const rl = {
  running:false, paused:false,
  visual:true, fast:false, showGrid:true,
  who:'A',
  speedMul:1.0, stepClock:0, targetHz:30
}

/* --------- RL helpers --------- */
function rlClearAll(){
  RL.gridReady=false; RL.passable=[]; RL.positions=[]; RL.sStart=-1; RL.sGoal=-1
  for (const k of ['A','B']){
    L[k].Q.clear()
    L[k].epi=0; L[k].success=0
    L[k].s=-1; L[k].ret=0; L[k].steps=0; L[k].done=false; L[k].pathIdxs=[]
    if (L[k].visits) L[k].visits = null
    if (L[k].curLine){ scene.remove(L[k].curLine); L[k].curLine=null }
    if (L[k].bestLine){ scene.remove(L[k].bestLine); L[k].bestLine=null }
    L[k].agent.hide()
  }
  if (rlGridLines){ scene.remove(rlGridLines); rlGridLines=null }
}
function rlDirtyGrid(){ RL.gridReady=false; if (rlGridLines){ scene.remove(rlGridLines); rlGridLines=null } }

function buildNavGrid(){
  if (!startMarker || !endMarker){ alert('请先设置起点与终点'); return }
  RL.h = num(rlUI.h, 0.6)
  const h = RL.h
  const half = FLOOR_SIZE/2; RL.x0=-half; RL.z0=-half
  RL.nx = Math.floor(FLOOR_SIZE/h)+1; RL.nz = Math.floor(FLOOR_SIZE/h)+1
  const N = RL.nx*RL.nz
  RL.passable = new Uint8Array(N); RL.positions = new Array(N)
  const boxes = obstacles.map(o => (new THREE.Box3()).setFromObject(o))
  for (let iz=0; iz<RL.nz; iz++){
    for (let ix=0; ix<RL.nx; ix++){
      const x=RL.x0+ix*h, z=RL.z0+iz*h
      const p3 = new THREE.Vector3(x,1.0,z)
      let free=true; for (const b of boxes){ if (b.containsPoint(p3)){ free=false; break } }
      const id=ix+iz*RL.nx
      RL.passable[id]=free?1:0
      RL.positions[id]=new THREE.Vector3(x,0.25,z)
    }
  }
  RL.sStart = nearestPassable(startMarker.position)
  RL.sGoal  = nearestPassable(endMarker.position)
  RL.gridReady = RL.sStart>=0 && RL.sGoal>=0
  if (!RL.gridReady){ alert('网格构建失败：请调整起终点或减小 h'); return }

  // 初始化/清零两名智能体的“本回合访问计数”
  L.A.visits = new Uint16Array(N)
  L.B.visits = new Uint16Array(N)

  drawGridOverlay()

  // 清当前可视化，隐藏球体
  for (const k of ['A','B']){
    if (L[k].curLine){ scene.remove(L[k].curLine); L[k].curLine=null }
    L[k].agent.hide()
  }
}
function drawGridOverlay(){
  if (rlGridLines){ scene.remove(rlGridLines); rlGridLines=null }
  if (!bool(rlUI.showGrid,true)) return
  const g = new THREE.BufferGeometry(); const verts=[]
  const h=RL.h
  for (let iz=0; iz<RL.nz; iz++){
    for (let ix=0; ix<RL.nx; ix++){
      const id=ix+iz*RL.nx; if (!RL.passable[id]) continue
      const x=RL.x0+ix*h, z=RL.z0+iz*h, y=0.02
      verts.push(x,y,z, x+h,y,z+h)
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts,3))
  rlGridLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({color:0x223044, transparent:true, opacity:0.6}))
  scene.add(rlGridLines)
}
function nearestPassable(pos){
  const ix=Math.round((pos.x-RL.x0)/RL.h), iz=Math.round((pos.z-RL.z0)/RL.h)
  let best=-1, bestd=1e9
  for (let dz=-2; dz<=2; dz++){
    for (let dx=-2; dx<=2; dx++){
      const x=ix+dx, z=iz+dz
      if (x<0||z<0||x>=RL.nx||z>=RL.nz) continue
      const id=x+z*RL.nx
      if (RL.passable[id]){
        const d=RL.positions[id].distanceTo(new THREE.Vector3(pos.x,0.25,pos.z))
        if (d<bestd){ bestd=d; best=id }
      }
    }
  }
  return best
}

/* Q-learning helpers */
function neighbors(s){
  const iz=Math.floor(s/RL.nx), ix=s-iz*RL.nx, res=[]
  for (let a=0;a<8;a++){
    const dx=ACTIONS[a][0], dz=ACTIONS[a][1], x=ix+dx, z=iz+dz
    if (x<0||z<0||x>=RL.nx||z>=RL.nz){ res.push(-1); continue }
    const id=x+z*RL.nx; res.push(RL.passable[id]?id:-1)
  }
  return res
}
function distGoal(s){ return RL.positions[s].distanceTo(RL.positions[RL.sGoal]) } // 仅用于“是否到达终点”的判定
function getQ(map,s){ let q=map.get(s); if(!q){ q=new Float32Array(8); map.set(s,q) } return q }
function epsGreedy(map,s,eps){ const q=getQ(map,s); if(Math.random()<eps) return Math.floor(Math.random()*8); let a=0,b=-1e9; for(let i=0;i<8;i++){ if(q[i]>b){b=q[i];a=i} } return a }
function qUpdate(map,s,a,r,sn,alpha,gamma){ const q=getQ(map,s), qn=getQ(map,sn); let m=-1e9; for(let i=0;i<8;i++) if(qn[i]>m) m=qn[i]; q[a]+=alpha*(r+gamma*m-q[a]) }

function lineFromPath(pathIdxs, color=0x00e5ff, opacity=1){
  const pts = pathIdxs.map(i => new THREE.Vector3(RL.positions[i].x, RL.positions[i].y+0.05, RL.positions[i].z))
  const g=new THREE.BufferGeometry().setFromPoints(pts)
  const m=new THREE.LineBasicMaterial({ color, transparent: opacity<1, opacity })
  return new THREE.Line(g,m)
}

/* Episode lifecycle */
function beginEpisode(K){ // K = L.A or L.B
  K.epi += 1; K.ret=0; K.steps=0; K.done=false
  K.s = RL.sStart; K.pathIdxs=[K.s]
  if (K.visits) K.visits.fill(0)     // 每回合清零访问计数
  K.agent.setPos(RL.positions[K.s])
  if (K.curLine){ scene.remove(K.curLine); K.curLine=null }
  K.curLine = lineFromPath(K.pathIdxs, K.tag==='A'?0x31c48d:0xf59e0b)
  scene.add(K.curLine)
}
function endEpisode(K, success){
  if (success) K.success += 1
  if (success && K.steps < K.best.steps){
    K.best.steps = K.steps
    K.best.path = K.pathIdxs.slice()
    if (K.bestLine) scene.remove(K.bestLine)
    K.bestLine = lineFromPath(K.best.path, K.tag==='A'?0x8fbfff:0xffc288, 0.65)
    scene.add(K.bestLine)
  }
  rl.who = (K.tag==='A') ? 'B' : 'A'
  beginEpisode(L[rl.who])
}

/* One step (pure exploration + penalties) */
function stepOnce(K){
  if (!RL.gridReady || K.done) return

  const alpha = num(rlUI.alpha, 0.2),  gamma = num(rlUI.gamma, 0.99)
  const eps0  = num(rlUI.epsStart, 1.0), eps1 = num(rlUI.epsEnd, 0.05), decay = int(rlUI.epsDecay, 2000)

  const R_goal = num(rlUI.rGoal, 100),
        c_step = num(rlUI.cStep, 0.05),
        c_wall = num(rlUI.cWall, 0.50),
        c_repeat = num(rlUI.cRepeat, 0.10)

  const maxSteps = int(rlUI.maxSteps, 400)

  // —— 每个智能体独立 ε 衰减 —— //
  const eps = eps1 + (eps0 - eps1) * Math.max(0, 1 - (K.epi / decay))

  const nb = neighbors(K.s)
  const a  = epsGreedy(K.Q, K.s, eps)
  const sNext = nb[a] >= 0 ? nb[a] : K.s

  // 纯“负奖励”设计：步进/撞墙/重复；仅到达终点给正奖
  let r = -c_step
  if (sNext === K.s && nb[a] < 0) r -= c_wall

  // 本回合重复访问惩罚：第2次起按次数线性扣
  if (K.visits) {
    const v = (K.visits[sNext] = (K.visits[sNext] || 0) + 1)
    if (v > 1) r -= c_repeat * (v - 1)
  }

  // 终点：一次性大奖励（不提供方向/距离线索）
  const atGoal = (sNext === RL.sGoal) || (distGoal(sNext) <= RL.h * 0.5)
  if (atGoal) { r += R_goal; K.done = true }

  qUpdate(K.Q, K.s, a, r, sNext, alpha, gamma)
  K.ret += r; K.steps += 1; K.s = sNext; K.pathIdxs.push(K.s)

  if (rl.visual){
    K.agent.setPos(RL.positions[K.s])
    K.curLine.geometry.setFromPoints(K.pathIdxs.map(i => new THREE.Vector3(RL.positions[i].x, RL.positions[i].y+0.05, RL.positions[i].z)))
  }

  if (K.steps >= maxSteps) K.done = true
  if (K.done) endEpisode(K, atGoal)
}

/* Controls */
function rlStart(){
  if (!startMarker || !endMarker){ alert('请先设置起点与终点'); return }
  if (!RL.gridReady){ buildNavGrid(); if (!RL.gridReady) return }
  rl.visual = bool(rlUI.visual, true)
  rl.fast   = bool(rlUI.fast,   false)
  rl.showGrid = bool(rlUI.showGrid, true); drawGridOverlay()
  rl.speedMul = parseFloat(hud.speed?.value || '1') || 1
  rl.stepClock = 0
  rl.who = 'A'
  beginEpisode(L.A)
  rl.running = true; rl.paused = false
}
function rlPause(){ if (!rl.running) return; rl.paused = !rl.paused }
function rlStop(){
  rl.running=false; rl.paused=false
  L.A.agent.hide(); L.B.agent.hide()
  if (L.A.curLine){ scene.remove(L.A.curLine); L.A.curLine=null }
  if (L.B.curLine){ scene.remove(L.B.curLine); L.B.curLine=null }
}

/* Bindings */
on(rlUI.build,'click', buildNavGrid)
on(rlUI.start,'click', rlStart)
on(rlUI.pause,'click', rlPause)
on(rlUI.stop,'click',  ()=>{ rlStop(); rlClearAll() })
on(rlUI.replayA,'click', ()=> replayBest('A'))
on(rlUI.replayB,'click', ()=> replayBest('B'))
on(rlUI.showGrid,'change', ()=> drawGridOverlay())

/* Speed slider */
if (hud.speed && hud.speedVal){
  const refreshSpeed = ()=>{ rl.speedMul = parseFloat(hud.speed.value || '1') || 1; setText(hud.speedVal, `${rl.speedMul.toFixed(2)}×`) }
  on(hud.speed,'input', refreshSpeed)
  refreshSpeed()
}

/* Replay best (speed-aware) */
function replayBest(tag){
  const K = (tag==='A')?L.A:L.B
  if (!K.best.path || K.best.path.length<2){ alert(`暂无最佳路径（${tag}）`); return }
  L.A.agent.hide(); L.B.agent.hide()
  let i=0, pts=K.best.path.map(id=>RL.positions[id])
  const stepIntervalMs = Math.max(5, 30 / rl.speedMul)
  const tick = () => { if (i>=pts.length) return; K.agent.setPos(pts[i]); i++; setTimeout(tick, stepIntervalMs) }
  tick()
}

/* Render loop + speed control */
let lastT = performance.now()
function onResize(){ const w=root.clientWidth, h=root.clientHeight; camera.aspect=w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h) }
window.addEventListener('resize', onResize)

function updateHUD(){
  setText(hud.obs, `${obstacles.length}`)
  setText(hud.who, rl.who)
  const K = L[rl.who]
  setText(hud.epi, `${K.epi}`)
  setText(hud.ret, K.ret.toFixed(2))
  setText(hud.steps, `${K.steps}`)
  setText(hud.bestA, L.A.best.steps<Infinity?`${L.A.best.steps}`:'—')
  setText(hud.bestB, L.B.best.steps<Infinity?`${L.B.best.steps}`:'—')
}

;(function animate(){
  requestAnimationFrame(animate)
  const now = performance.now()
  const dt = Math.min((now - lastT)/1000, 0.05)
  lastT = now

  if (rl.running && !rl.paused && RL.gridReady){
    if (rl.visual){
      // 逐步模式：用“节拍器”按速度倍率控制帧内推进步数
      const hz = rl.targetHz * rl.speedMul
      const interval = 1 / Math.max(1e-3, hz)
      rl.stepClock += dt
      while (rl.stepClock >= interval){
        rl.stepClock -= interval
        stepOnce(L[rl.who])
        if (L[rl.who].done) break
      }
    }else{
      // 快速模式：每帧批量推进，数量也随速度倍率放大
      const batch = Math.max(1, Math.round(400 * rl.speedMul))
      for (let i=0;i<batch;i++){ stepOnce(L[rl.who]); if (L[rl.who].done) break }
    }
  }

  controls.update()
  renderer.render(scene, camera)
  updateHUD()
})()
