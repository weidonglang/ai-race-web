import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { init as initRecast, NavMeshQuery } from 'recast-navigation'
import { generateSoloNavMesh } from 'recast-navigation/generators'
import { NavMeshHelper } from '@recast-navigation/three'

/* ---------- three.js 基础 ---------- */
const root = document.getElementById('viewport')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(root.clientWidth, root.clientHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
root.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0f1115')

const camera = new THREE.PerspectiveCamera(60, root.clientWidth / root.clientHeight, 0.1, 1000)
camera.position.set(10, 12, 18)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.7)
scene.add(hemi)
const dir = new THREE.DirectionalLight(0xffffff, 0.8)
dir.position.set(6, 10, 6)
scene.add(dir)

/* 地面 + 网格 */
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

/* ---------- 状态 ---------- */
const raycaster = new THREE.Raycaster()
const mouseNDC = new THREE.Vector2()
let placingMode = null                  // 'box' | 'start' | 'end' | null
const obstacles = []
let startMarker = null
let endMarker = null
let navQuery = null
let navHelper = null
let pathLine = null
let lastPathPoints = null               // THREE.Vector3[]（最近一次寻路折线）
let downPos = null                      // pointerdown 位置用于区分拖动/点击

// 选中/拖动
let selectedObstacle = null
let draggingObstacle = null
let isDragging = false

const updateCursor = () => {
  renderer.domElement.style.cursor = (placingMode || isDragging) ? 'crosshair' : 'default'
}

/* ---------- 工具 ---------- */
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
  // 记录基础自发光色用于高亮恢复
  box.userData.baseEmissive = (box.material.emissive ? box.material.emissive.getHex() : 0x000000)
  scene.add(box)
  obstacles.push(box)
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
function selectObstacle(obj) {
  if (selectedObstacle && selectedObstacle !== obj) {
    if (selectedObstacle.material.emissive) {
      selectedObstacle.material.emissive.setHex(selectedObstacle.userData.baseEmissive ?? 0x000000)
    }
  }
  selectedObstacle = obj || null
  if (selectedObstacle && selectedObstacle.material.emissive) {
    selectedObstacle.material.emissive.setHex(0x00ffff)
  }
}
function deleteObstacle(obj) {
  const idx = obstacles.indexOf(obj)
  if (idx >= 0) obstacles.splice(idx, 1)
  scene.remove(obj)
  if (selectedObstacle === obj) selectedObstacle = null
}

/* ---------- 几何转数组（地面 + 障碍） ---------- */
function getPositionsAndIndicesFromMeshes(meshes) {
  const positions = []
  const indices = []
  let indexOffset = 0
  for (const mesh of meshes) {
    const geom = mesh.geometry.clone()
    geom.applyMatrix4(mesh.matrixWorld)
    const nonIdx = geom.index ? geom.toNonIndexed() : geom
    const arr = nonIdx.getAttribute('position').array
    for (let i = 0; i < arr.length; i += 3) positions.push(arr[i], arr[i + 1], arr[i + 2])
    const triCount = arr.length / 9
    for (let t = 0; t < triCount; t++) {
      indices.push(indexOffset + t * 3 + 0, indexOffset + t * 3 + 1, indexOffset + t * 3 + 2)
    }
    indexOffset += triCount * 3
  }
  return [positions, indices]
}

/* ---------- NavMesh 烘焙 ---------- */
async function bakeNavMesh() {
  if (navHelper) { scene.remove(navHelper); navHelper = null }
  if (pathLine) { scene.remove(pathLine); pathLine = null }
  lastPathPoints = null

  // 隐藏所有 agent（避免视觉残留）
  agentSolo.stop(); agentSolo.mesh.visible = false
  agentA.stop();    agentA.mesh.visible = false
  agentB.stop();    agentB.mesh.visible = false

  const inputMeshes = [floor, ...obstacles]
  const [positions, indices] = getPositionsAndIndicesFromMeshes(inputMeshes)
  await initRecast()

  const cfg = {
    cs: 0.25, ch: 0.2,
    walkableHeight: 1.8,
    walkableRadius: 0.4,
    walkableClimb: 0.4,
    walkableSlopeAngle: 45
  }
  const { success, navMesh } = generateSoloNavMesh(positions, indices, cfg)
  if (!success) { alert('NavMesh 生成失败，请调整参数或几何！'); return }

  navQuery = new NavMeshQuery(navMesh)
  navHelper = new NavMeshHelper(navMesh)
  scene.add(navHelper)
}

/* ---------- 寻路（高层 API） ---------- */
function findPathAndDraw() {
  if (!navQuery || !startMarker || !endMarker) { alert('请先设置起点/终点并烘焙 NavMesh'); return }

  const { success, path, error } = navQuery.computePath(
    { x: startMarker.position.x, y: startMarker.position.y, z: startMarker.position.z },
    { x: endMarker.position.x,   y: endMarker.position.y,   z: endMarker.position.z }
  )
  if (!success || !path || path.length < 2) {
    console.warn('computePath 失败：', error)
    alert('寻路失败：起点/终点可能不在可走区域附近，或区域不连通')
    return
  }

  lastPathPoints = path.map(p => new THREE.Vector3(p.x, p.y, p.z))

  // 折线可视化
  const pts = lastPathPoints.map(v => new THREE.Vector3(v.x, v.y + 0.05, v.z))
  const g = new THREE.BufferGeometry().setFromPoints(pts)
  const m = new THREE.LineBasicMaterial({ linewidth: 2, color: 0x00e5ff })
  if (pathLine) scene.remove(pathLine)
  pathLine = new THREE.Line(g, m)
  scene.add(pathLine)

  // 不自动显示/复位 agent，避免复位重叠
}

/* ---------- Agent ---------- */
class Agent {
  constructor(color = 0x00d084) {
    this.speed = 3.0
    this.turnK = 10.0
    this.radius = 0.25
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius, 24, 16),
      new THREE.MeshStandardMaterial({ color })
    )
    this.mesh.castShadow = true
    this.mesh.visible = false    // 显示时机：start() 时
    scene.add(this.mesh)

    this.path = null
    this.i = 0
    this.running = false
    this.done = false
  }
  resetToStart() {
    if (!lastPathPoints || lastPathPoints.length < 2) {
      this.path = null; this.running = false; this.done = false; this.mesh.visible = false; return
    }
    this.path = lastPathPoints
    this.i = 0; this.running = false; this.done = false
    const p0 = this.path[0]
    this.mesh.position.set(p0.x, 0.25, p0.z)
  }
  start() {
    if (!this.path || this.path.length < 2) return false
    this.mesh.visible = true
    this.running = true; this.done = false; return true
  }
  pauseToggle() { this.running = !this.running }
  stop() { this.running = false }
  update(dt) {
    if (!this.running || this.done || !this.path) return
    const pos = this.mesh.position
    let target = this.path[this.i + 1]
    if (!target) { this.done = true; this.running = false; return }
    const dir = new THREE.Vector3().subVectors(target, pos); dir.y = 0
    const dist = dir.length()
    if (dist < 0.05) {
      this.i++
      target = this.path[this.i + 1]
      if (!target) { this.done = true; this.running = false; return }
    }
    dir.normalize()
    pos.addScaledVector(dir, this.speed * dt)
    const yaw = Math.atan2(dir.x, dir.z)
    this.mesh.rotation.y += (yaw - this.mesh.rotation.y) * Math.min(1, this.turnK * dt)
  }
}

/* ---------- 单人回合控制 ---------- */
const agentSolo = new Agent(0x00d084)  // 绿
let episode = { running: false, paused: false, finished: false, tStart: 0, tAccum: 0, pathLen: 0, lastTimeMs: 0 }

function computePathLength(pts) {
  if (!pts || pts.length < 2) return 0
  let L = 0; for (let i = 0; i < pts.length - 1; i++) L += pts[i].distanceTo(pts[i + 1])
  return L
}
function startEpisode() {
  if (!lastPathPoints || lastPathPoints.length < 2) { alert('请先完成寻路。'); return }
  agentSolo.resetToStart()
  if (!agentSolo.start()) { alert('未找到可用路径'); return }
  episode = { running: true, paused: false, finished: false, tStart: performance.now(), tAccum: 0, pathLen: computePathLength(lastPathPoints), lastTimeMs: 0 }
}
function togglePause() {
  if (!episode.running && !episode.paused) return
  if (!episode.paused) { agentSolo.stop(); episode.paused = true; episode.tAccum += performance.now() - episode.tStart }
  else { agentSolo.running = true; episode.paused = false; episode.tStart = performance.now() }
}
function resetEpisode() {
  episode.running = false; episode.paused = false; episode.finished = false; episode.tAccum = 0; episode.lastTimeMs = 0
  agentSolo.resetToStart()
  agentSolo.mesh.visible = false
}
function saveSoloResult(timeMs) {
  const rec = { timeMs: Math.round(timeMs), pathLen: Number(episode.pathLen.toFixed(3)), ts: Date.now() }
  const key = 'ai_runs'
  const arr = JSON.parse(localStorage.getItem(key) || '[]'); arr.push(rec)
  localStorage.setItem(key, JSON.stringify(arr))
}

/* ---------- A/B 竞速 ---------- */
const agentA = new Agent(0x00b0ff)  // 蓝
const agentB = new Agent(0xff6d00)  // 橙
agentA.speed = 3.0; agentA.turnK = 10
agentB.speed = 2.8; agentB.turnK = 12

let race = {
  running: false, paused: false,
  finishedA: false, finishedB: false,
  tStartA: 0, tStartB: 0, tAccumA: 0, tAccumB: 0,
  timeA: 0, timeB: 0,
  pathLen: 0
}

function raceStart() {
  if (!lastPathPoints || lastPathPoints.length < 2) { alert('请先完成寻路。'); return }
  agentA.resetToStart(); agentB.resetToStart()
  if (!agentA.start() || !agentB.start()) { alert('未找到可用路径'); return }
  race = {
    running: true, paused: false,
    finishedA: false, finishedB: false,
    tStartA: performance.now(), tStartB: performance.now(),
    tAccumA: 0, tAccumB: 0, timeA: 0, timeB: 0,
    pathLen: computePathLength(lastPathPoints)
  }
}
function racePauseToggle() {
  if (!race.running && !race.paused) return
  if (!race.paused) {
    agentA.stop(); agentB.stop()
    race.paused = true
    const now = performance.now()
    race.tAccumA += now - race.tStartA
    race.tAccumB += now - race.tStartB
  } else {
    agentA.running = true; agentB.running = true
    race.paused = false
    race.tStartA = performance.now(); race.tStartB = performance.now()
  }
}
function raceReset() {
  race.running = false; race.paused = false
  race.finishedA = race.finishedB = false
  race.tAccumA = race.tAccumB = 0; race.timeA = race.timeB = 0
  agentA.resetToStart(); agentB.resetToStart()
  agentA.mesh.visible = false; agentB.mesh.visible = false
}
function saveRaceResult() {
  const winner = race.timeA === race.timeB ? 'tie' : (race.timeA < race.timeB ? 'A' : 'B')
  const rec = {
    A: { timeMs: Math.round(race.timeA) },
    B: { timeMs: Math.round(race.timeB) },
    winner,
    pathLen: Number(race.pathLen.toFixed(3)),
    ts: Date.now()
  }
  const key = 'ai_dual_runs'
  const arr = JSON.parse(localStorage.getItem(key) || '[]'); arr.push(rec)
  localStorage.setItem(key, JSON.stringify(arr))
}

/* ---------- 放置/选择/移动/删除 ---------- */
renderer.domElement.addEventListener('pointerdown', (ev) => {
  downPos = { x: ev.clientX, y: ev.clientY }
  // Shift + 鼠标按下：开始拖动物体
  if (!placingMode && ev.shiftKey) {
    const obj = pickObstacle(ev)
    if (obj) {
      isDragging = true
      draggingObstacle = obj
      selectObstacle(obj)
      controls.enabled = false
      updateCursor()
    }
  }
})
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!isDragging || !draggingObstacle) return
  const p = pickOnFloor(ev)
  if (p) draggingObstacle.position.set(p.x, 1.0, p.z)
})
renderer.domElement.addEventListener('pointerup', () => {
  if (isDragging) {
    isDragging = false
    draggingObstacle = null
    controls.enabled = true
    updateCursor()
  }
})
renderer.domElement.addEventListener('click', (ev) => {
  if (ev.button !== 0) return
  // 拖动不当作“点击”
  if (downPos) {
    const dx = ev.clientX - downPos.x, dy = ev.clientY - downPos.y
    if (Math.hypot(dx, dy) > 5) return
  }
  // 1) 放置模式
  if (placingMode) {
    const p = pickOnFloor(ev); if (!p) return
    if (placingMode === 'box') addObstacleAt(p)
    else if (placingMode === 'start') {
      if (!startMarker) { startMarker = makeMarker(0x22cc88); scene.add(startMarker) }
      startMarker.position.set(p.x, 0.25, p.z)
      placingMode = null; updateCursor()
    } else if (placingMode === 'end') {
      if (!endMarker) { endMarker = makeMarker(0xff5555); scene.add(endMarker) }
      endMarker.position.set(p.x, 0.25, p.z)
      placingMode = null; updateCursor()
    }
    return
  }
  // 2) 非放置模式：删除 / 选择
  const obj = pickObstacle(ev)
  if (obj) {
    if (ev.ctrlKey) {
      deleteObstacle(obj)         // Ctrl + 点击：快速删除
    } else {
      selectObstacle(obj === selectedObstacle ? null : obj)
    }
  } else {
    selectObstacle(null)          // 空白处取消选中
  }
})
// 全局键盘：Esc 取消放置；Delete/Backspace 删除选中（修复点）
const keydownHandler = (e) => {
  if (e.key === 'Escape') { placingMode = null; updateCursor() }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedObstacle) {
    e.preventDefault()
    deleteObstacle(selectedObstacle)
    selectedObstacle = null
  }
}
window.addEventListener('keydown', keydownHandler)
document.addEventListener('keydown', keydownHandler)

/* ---------- UI 绑定 ---------- */
document.getElementById('btnAddBox').onclick   = () => { placingMode = (placingMode === 'box') ? null : 'box'; updateCursor() }
document.getElementById('btnSetStart').onclick = () => { placingMode = (placingMode === 'start') ? null : 'start'; updateCursor() }
document.getElementById('btnSetEnd').onclick   = () => { placingMode = (placingMode === 'end') ? null : 'end'; updateCursor() }
document.getElementById('btnBake').onclick     = () => bakeNavMesh()
document.getElementById('btnFind').onclick     = () => { findPathAndDraw() }
document.getElementById('btnClear').onclick    = () => {
  placingMode = null; updateCursor()
  obstacles.forEach(m => scene.remove(m)); obstacles.length = 0
  selectObstacle(null)
  if (startMarker) { scene.remove(startMarker); startMarker = null }
  if (endMarker)   { scene.remove(endMarker);   endMarker = null }
  if (pathLine)    { scene.remove(pathLine);    pathLine = null }
  if (navHelper)   { scene.remove(navHelper);   navHelper = null }
  navQuery = null
  lastPathPoints = null
  agentSolo.stop(); agentSolo.mesh.visible = false
  raceReset()
  agentA.mesh.visible = false; agentB.mesh.visible = false
}

/* 单人回合按钮 */
document.getElementById('btnRun').onclick   = () => startEpisode()
document.getElementById('btnPause').onclick = () => togglePause()
document.getElementById('btnReset').onclick = () => resetEpisode()

/* 竞速按钮 */
document.getElementById('btnRace').onclick       = () => raceStart()
document.getElementById('btnRacePause').onclick  = () => racePauseToggle()
document.getElementById('btnRaceReset').onclick  = () => raceReset()

/* ---------- HUD ---------- */
const $ = (id) => document.getElementById(id)
const hud = {
  obs: $('hudObs'), nav: $('hudNav'),
  pathLen: $('hudPathLen'), pts: $('hudPts'),
  soloStatus: $('hudSoloStatus'), soloSpeed: $('hudSoloSpeed'), soloTime: $('hudSoloTime'),
  raceA: $('hudRaceA'), raceB: $('hudRaceB'), winner: $('hudWinner')
}
function fmtMs(ms){
  if (!ms || ms <= 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms/1000).toFixed(2)} s`
}
function updateHUD(nowMs){
  hud.obs.textContent = String(obstacles.length)
  const navReady = !!navQuery
  hud.nav.textContent = navReady ? '已就绪' : '未烘焙'
  hud.nav.className = `tag ${navReady ? 'ok' : 'bad'}`
  const len = lastPathPoints ? computePathLength(lastPathPoints) : 0
  hud.pathLen.textContent = len.toFixed(2)
  hud.pts.textContent = lastPathPoints ? String(lastPathPoints.length) : '0'
  hud.soloSpeed.textContent = `${agentSolo.speed.toFixed(2)} m/s`
  let soloState = 'Idle', soloT = 0
  if (episode.running && !episode.paused) { soloState = 'Running'; soloT = episode.tAccum + (nowMs - episode.tStart) }
  else if (episode.paused) { soloState = 'Paused'; soloT = episode.tAccum }
  else if (episode.finished) { soloState = 'Done'; soloT = episode.lastTimeMs }
  hud.soloStatus.textContent = soloState
  hud.soloTime.textContent = fmtMs(soloT)
  const curA = race.finishedA ? race.timeA : race.tAccumA + (race.running && !race.paused ? (nowMs - race.tStartA) : 0)
  const curB = race.finishedB ? race.timeB : race.tAccumB + (race.running && !race.paused ? (nowMs - race.tStartB) : 0)
  const stA = race.finishedA ? 'Done' : (race.paused ? (race.running ? 'Paused' : 'Idle') : (race.running ? 'Running' : 'Idle'))
  const stB = race.finishedB ? 'Done' : (race.paused ? (race.running ? 'Paused' : 'Idle') : (race.running ? 'Running' : 'Idle'))
  hud.raceA.textContent = `${stA} — ${fmtMs(curA)}`
  hud.raceB.textContent = `${stB} — ${fmtMs(curB)}`
  hud.winner.textContent = (race.finishedA && race.finishedB) ? (race.timeA === race.timeB ? '平局' : (race.timeA < race.timeB ? 'A' : 'B')) : '—'
}

/* ---------- 渲染循环 ---------- */
let lastT = performance.now()
function onResize() {
  const w = root.clientWidth, h = root.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}
window.addEventListener('resize', onResize)

;(function animate() {
  requestAnimationFrame(animate)
  const now = performance.now()
  const dt = Math.min((now - lastT) / 1000, 0.05)
  lastT = now

  // 单人回合
  if (episode.running && !episode.paused && !episode.finished) {
    agentSolo.update(dt)
    if (agentSolo.done) {
      episode.finished = true; episode.running = false
      const tUsed = episode.tAccum + (performance.now() - episode.tStart)
      episode.lastTimeMs = tUsed
      saveSoloResult(tUsed)
      console.log(`单人回合完成：${Math.round(tUsed)} ms，路径 ${episode.pathLen.toFixed(3)} m`)
    }
  }

  // A/B 竞速
  if (race.running && !race.paused) {
    if (!race.finishedA) agentA.update(dt)
    if (!race.finishedB) agentB.update(dt)
    const nowMs = performance.now()
    if (!race.finishedA && agentA.done) { race.finishedA = true; race.timeA = race.tAccumA + (nowMs - race.tStartA); console.log(`A 到达：${Math.round(race.timeA)} ms`) }
    if (!race.finishedB && agentB.done) { race.finishedB = true; race.timeB = race.tAccumB + (nowMs - race.tStartB); console.log(`B 到达：${Math.round(race.timeB)} ms`) }
    if (race.finishedA && race.finishedB) { race.running = false; saveRaceResult(); console.log(`竞速完成，A=${Math.round(race.timeA)}ms，B=${Math.round(race.timeB)}ms`) }
  }

  controls.update()
  renderer.render(scene, camera)
  updateHUD(now)
})()