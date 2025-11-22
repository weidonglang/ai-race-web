// src/main.js
// 首页入口脚本：轮播 + 可交互粒子背景
//
// 功能：
//   1. 初始化首页顶部的 Swiper 轮播（介绍各个子页面）；
//   2. 在首页 body 背后铺一层 Canvas 粒子背景：
//      - 粒子缓慢漂浮；
//      - 鼠标移动时附近粒子被“推开”；
//      - 靠得近的粒子之间会画连线，形成网络效果。

import Swiper from 'swiper'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import { Navigation, Pagination, A11y } from 'swiper/modules'

// ---------- 1. 初始化首页轮播 ----------
//
// Swiper 的基本用法：
//   new Swiper(容器选择器, 配置对象)
//
// 这里：
//   - modules: 使用导航箭头 / 分页点 / 无障碍模块；
//   - loop: true 让轮播无限循环；
//   - navigation / pagination：指定左右箭头和小圆点的 DOM 选择器。
new Swiper('.swiper', {
  modules: [Navigation, Pagination, A11y],
  loop: true,
  spaceBetween: 24,
  slidesPerView: 1,
  navigation: {
    nextEl: '.swiper-button-next',
    prevEl: '.swiper-button-prev'
  },
  pagination: {
    el: '.swiper-pagination',
    clickable: true
  }
})

// ---------- 2. 初始化交互背景画布 ----------
//
// 在 index.html 中预先放了一个 <canvas id="bgCanvas">，
// 这里只负责找到它并启动动画。
initInteractiveBackground()

/**
 * 创建一个“会被鼠标扰动的粒子网络”作为背景。
 *
 * 设计要点：
 *   - 粒子在屏幕上缓慢漂浮（随机速度 / 随机方向）； 
 *   - 鼠标移到某处时，附近粒子受到“斥力”被推开一点点； 
 *   - 任意两粒子距离足够近时，会用一条线把它们连起来；
 *   - 整体使用 Canvas 2D 实现，避免引入 Three.js，减少开销。
 */
function initInteractiveBackground () {
  const canvas = document.getElementById('bgCanvas')

  // 如果当前页面根本没有 bgCanvas（比如不是首页），直接退出即可。
  if (!canvas || !canvas.getContext) return

  const ctx = canvas.getContext('2d')

  // 记录画布尺寸（以 CSS 像素为单位）
  let width = window.innerWidth
  let height = window.innerHeight
  // DPR（devicePixelRatio）用于适配高 DPI 屏幕（例如 Retina）
  let dpr = window.devicePixelRatio || 1

  // 粒子数组，每个粒子都是一个 JS 对象：{x, y, vx, vy, radius, hue}
  const particles = []
  const MAX_PARTICLES = 90 // 上限，避免 N 太大时 O(N^2) 连线计算太卡

  // 鼠标状态，用于交互
  const mouse = {
    x: 0,
    y: 0,
    active: false // 鼠标是否在画布上方（离开页面就设为 false）
  }

  /**
   * 根据窗口尺寸重设画布大小（适配高 DPI）
   *
   * 思路：
   *   - canvas.width / height 使用“实际像素”（乘以 dpr）；
   *   - canvas.style.width / height 使用 CSS 像素；
   *   - ctx.setTransform(dpr, 0, 0, dpr, 0, 0) 把坐标系缩放回来，
   *     这样之后绘制时仍然用 width / height 这套“CSS 像素”坐标。
   */
  function resize () {
    width = window.innerWidth
    height = window.innerHeight
    dpr = window.devicePixelRatio || 1

    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'

    // 让后续绘制使用“缩放后的坐标系”
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /**
   * 创建一个随机粒子
   *
   * 每个粒子字段说明：
   *   - x, y：初始位置（随机撒在屏幕上）；
   *   - vx, vy：速度向量（随机方向 + 随机速度）；
   *   - radius：半径（1.5 ~ 4 像素之间）；
   *   - hue：色相值，用于 HSL 色彩，主要是偏蓝/青色。
   */
  function createParticle () {
    // 速度大小在 [0.2, 1.0] 之间
    const speed = 0.2 + Math.random() * 0.8
    const angle = Math.random() * Math.PI * 2

    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 1.5 + Math.random() * 2.5,
      // 色相在 200 ~ 260 这个范围（蓝色 -> 青色）
      hue: 200 + Math.random() * 60
    }
  }

  /**
   * 初始化所有粒子：
   *   - 粒子数量与屏幕面积有关，屏幕越大粒子越多；
   *   - 但总数不会超过 MAX_PARTICLES。
   */
  function initParticles () {
    particles.length = 0
    const targetCount = Math.min(
      MAX_PARTICLES,
      Math.round((width * height) / 15000)
    )

    for (let i = 0; i < targetCount; i++) {
      particles.push(createParticle())
    }
  }

  // 事件：窗口缩放时重新布局粒子
  //   - resize：更新 canvas 尺寸
  //   - initParticles：让粒子数量与新窗口大小匹配
  window.addEventListener('resize', () => {
    resize()
    initParticles()
  })

  // 事件：鼠标移动，记录位置
  //   这里监听 window 即可，不需要给 canvas 单独加 pointer-events。
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX
    mouse.y = e.clientY
    mouse.active = true
  })

  // 鼠标离开窗口时，设置 active=false，停用“斥力效果”
  window.addEventListener('mouseleave', () => {
    mouse.active = false
  })

  // 初始时先做一次尺寸设置 + 粒子初始化
  resize()
  initParticles()

  /**
   * 每一帧的绘制逻辑
   *
   * 大致流程：
   *   1. 用一个略透明的深色矩形清屏，形成“拖尾效果”； 
   *   2. 更新所有粒子的位置 + 应用鼠标斥力； 
   *   3. 画出粒子本体； 
   *   4. 计算任意两粒子间距离，近的画连线； 
   *   5. 鼠标附近画一个淡圈，视觉上更有“交互感”； 
   *   6. requestAnimationFrame(tick) 循环。
   */
  function tick () {
    // 1. 背景稍微透明一点，形成“残影 / 拖尾”效果
    ctx.fillStyle = 'rgba(2, 6, 23, 0.92)'
    ctx.fillRect(0, 0, width, height)

    // 2. 更新并绘制粒子
    for (const p of particles) {
      // 基本漂移动作：位置 += 速度
      p.x += p.vx
      p.y += p.vy

      // 出屏幕后从另一侧回到场景，形成“环绕世界”效果
      const margin = 20
      if (p.x < -margin) p.x = width + margin
      else if (p.x > width + margin) p.x = -margin

      if (p.y < -margin) p.y = height + margin
      else if (p.y > height + margin) p.y = -margin

      // 鼠标轻微斥力：把靠得太近的粒子推开一点
      if (mouse.active) {
        const dx = p.x - mouse.x
        const dy = p.y - mouse.y
        const dist2 = dx * dx + dy * dy
        const influence = 140 // 鼠标影响半径（像素）

        if (dist2 > 0.01 && dist2 < influence * influence) {
          const dist = Math.sqrt(dist2)
          const force = (influence - dist) / influence // 0 ~ 1
          const nx = dx / dist
          const ny = dy / dist

          // 通过在速度上加一个小改动，呈现被推开的效果
          p.vx += nx * force * 0.05
          p.vy += ny * force * 0.05
        }
      }

      // 画粒子本体（小圆点）
      ctx.beginPath()
      // 使用 HSL 颜色， hue 不同，饱和度 / 亮度固定，alpha 稍透明
      ctx.fillStyle = `hsla(${p.hue}, 80%, 70%, 0.9)`
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
      ctx.fill()
    }

    // 3. 画粒子之间的连线（近距离才连；O(N^2) 但 N 已限制在较小范围）
    const maxDist = 140
    const maxDist2 = maxDist * maxDist
    ctx.lineWidth = 1

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j]

        const dx = p.x - q.x
        const dy = p.y - q.y
        const dist2 = dx * dx + dy * dy

        if (dist2 < maxDist2) {
          // alpha 越近越大，线越亮，越远越淡
          const alpha = 1 - dist2 / maxDist2
          ctx.strokeStyle = `rgba(56, 189, 248, ${alpha * 0.7})`
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(q.x, q.y)
          ctx.stroke()
        }
      }
    }

    // 4. 鼠标附近画一个淡淡的圆圈，增加“可交互感”
    if (mouse.active) {
      ctx.beginPath()
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)'
      ctx.lineWidth = 2
      ctx.arc(mouse.x, mouse.y, 40, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 5. 下一帧
    requestAnimationFrame(tick)
  }

  // 启动第一帧
  requestAnimationFrame(tick)
}
