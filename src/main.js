// src/main.js
// Home page: swiper + interactive background + background music

import Swiper from 'swiper'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import { Navigation, Pagination, A11y } from 'swiper/modules'

// ---------- 1. init home swiper ----------
new Swiper('.swiper', {
  modules: [Navigation, Pagination, A11y],
  loop: true,
  spaceBetween: 24,
  slidesPerView: 1,
  navigation: { nextEl: '.swiper-button-next', prevEl: '.swiper-button-prev' },
  pagination: {
    el: '.swiper-pagination',
    clickable: true
  },
  a11y: {
    prevSlideMessage: '上一页',
    nextSlideMessage: '下一页'
  }
})

// ---------- 2. interactive background ----------
initInteractiveBackground()

/**
 * Simple particle network background on a full-screen canvas.
 */
function initInteractiveBackground () {
  const canvas = document.getElementById('bgCanvas')
  if (!canvas || !canvas.getContext) return
  const ctx = canvas.getContext('2d')

  let width = window.innerWidth
  let height = window.innerHeight
  let dpr = window.devicePixelRatio || 1

  const CONFIG = {
    MAX_PARTICLES: 95,
    MAX_DIST: 150,
    MOUSE_RADIUS: 140,
    BASE_HUE: 210,
    HUE_RANGE: 70,
    SLOW_RATIO: 0.65,
    GLOW_CHANCE: 0.12
  }

  const particles = []

  const mouse = { x: 0, y: 0, active: false }

  function resize () {
    width = window.innerWidth
    height = window.innerHeight
    dpr = window.devicePixelRatio || 1

    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  window.addEventListener('resize', resize)
  resize()

  function createParticle () {
    const speedBase = 0.18 + Math.random() * 0.7
    const angle = Math.random() * Math.PI * 2
    const isSlow = Math.random() < CONFIG.SLOW_RATIO
    const speed = speedBase * (isSlow ? 0.55 : 1.6)
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 1.2 + Math.random() * 2.8,
      hue: CONFIG.BASE_HUE + Math.random() * CONFIG.HUE_RANGE,
      seed: Math.random() * Math.PI * 2,
      glow: Math.random() < CONFIG.GLOW_CHANCE
    }
  }

  for (let i = 0; i < CONFIG.MAX_PARTICLES; i++) {
    particles.push(createParticle())
  }

  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect()
    mouse.x = e.clientX - rect.left
    mouse.y = e.clientY - rect.top
    mouse.active = true
  })

  window.addEventListener('mouseleave', () => { mouse.active = false })

  function tick () {
    const now = performance.now()
    const pulse = 0.7 + 0.3 * Math.sin(now * 0.002)
    ctx.clearRect(0, 0, width, height)

    // update particles
    for (const p of particles) {
      if (mouse.active) {
        const dx = p.x - mouse.x
        const dy = p.y - mouse.y
        const distSq = dx * dx + dy * dy
        const radius = CONFIG.MOUSE_RADIUS
        if (distSq < radius * radius && distSq > 0.0001) {
          const dist = Math.sqrt(distSq)
          const force = 1.5 * (1 - dist / radius)
          p.vx += (dx / dist) * force * 0.03
          p.vy += (dy / dist) * force * 0.03
        }
      }

      p.vx *= 0.98
      p.vy *= 0.98

      p.x += p.vx
      p.y += p.vy

      const margin = 40
      if (p.x < -margin) p.x = width + margin
      if (p.x > width + margin) p.x = -margin
      if (p.y < -margin) p.y = height + margin
      if (p.y > height + margin) p.y = -margin
    }

    // draw particles
    for (const p of particles) {
      const hueShift = Math.sin(now * 0.0006 + p.seed) * 6
      const hue = p.hue + hueShift
      ctx.beginPath()
      ctx.fillStyle = `hsla(${hue}, 75%, 72%, 0.85)`
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
      ctx.fill()

      if (p.glow) {
        const glowR = p.radius * 10
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR)
        g.addColorStop(0, `hsla(${hue}, 90%, 70%, 0.12)`)
        g.addColorStop(1, 'rgba(6, 10, 18, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // draw lines
    const MAX_DIST = CONFIG.MAX_DIST
    const MAX_DIST_SQ = MAX_DIST * MAX_DIST
    for (let i = 0; i < particles.length; i++) {
      const p1 = particles[i]
      for (let j = i + 1; j < particles.length; j++) {
        const p2 = particles[j]
        const dx = p1.x - p2.x
        const dy = p1.y - p2.y
        const distSq = dx * dx + dy * dy
        if (distSq < MAX_DIST_SQ) {
          const alpha = pulse * 0.6 * (1 - distSq / MAX_DIST_SQ)
          ctx.beginPath()
          ctx.strokeStyle = `rgba(59, 130, 246, ${alpha})`
          ctx.lineWidth = 1 + (1 - distSq / MAX_DIST_SQ) * 0.3
          ctx.moveTo(p1.x, p1.y)
          ctx.lineTo(p2.x, p2.y)
          ctx.stroke()
        }
      }
    }

    if (mouse.active) {
      ctx.beginPath()
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.45)'
      ctx.lineWidth = 2
      ctx.arc(mouse.x, mouse.y, 42, 0, Math.PI * 2)
      ctx.stroke()
    }

    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

// ---------- 3. background music: auto-play random track under public/music ----------
const musicButton = document.getElementById('bgMusicToggle')
const musicVolumeEl = document.getElementById('bgMusicVolume')
const musicSelectEl = document.getElementById('bgMusicSelect')

if (musicButton) {
  const audioModules = import.meta.glob('../public/music/*.{mp3,ogg,wav,flac}', {
    eager: true,
    import: 'default'
  })

  const tracks = Object.keys(audioModules)
    .map((path) => {
      const url = audioModules[path]
      const fileName = path.split('/').pop() || ''
      const name = decodeURIComponent(fileName.replace(/\.[^.]+$/, ''))
      return { url, name }
    })
    .filter(t => t.url)

  if (!tracks.length) {
    musicButton.disabled = true
    musicButton.textContent = '🎵无可用音乐'
    if (musicSelectEl) musicSelectEl.disabled = true
  } else {
    const bgAudio = new Audio()
    bgAudio.loop = true
    bgAudio.volume = 0.5
    if (musicVolumeEl) musicVolumeEl.value = '0.5'

    let currentTrack = tracks[Math.floor(Math.random() * tracks.length)]
    bgAudio.src = currentTrack.url

    let isPlaying = false

    const updateSelect = () => {
      if (musicSelectEl) {
        musicSelectEl.value = currentTrack.url
      }
    }

    if (musicSelectEl) {
      musicSelectEl.innerHTML = ''
      tracks.forEach((track) => {
        const opt = document.createElement('option')
        opt.value = track.url
        opt.textContent = track.name
        musicSelectEl.appendChild(opt)
      })
    }

    updateSelect()

    async function startPlay (isAuto = false) {
      if (isPlaying) return
      try {
        await bgAudio.play()
        isPlaying = true
        musicButton.classList.add('is-playing')
        musicButton.textContent = '🎵音乐：开'
      } catch (err) {
        if (!isAuto) {
          console.error('播放失败:', err)
        }
        throw err
      }
    }

    const switchTrack = (track) => {
      const shouldResume = isPlaying
      bgAudio.pause()
      isPlaying = false
      currentTrack = track
      bgAudio.src = track.url
      updateSelect()
      if (shouldResume) {
        startPlay().catch(() => {})
      }
    }

    // Try to play on load; if blocked by browser, wait for first user gesture
    startPlay(true).catch(() => {
      const onceHandler = () => {
        startPlay().catch(() => {})
        window.removeEventListener('pointerdown', onceHandler)
      }
      window.addEventListener('pointerdown', onceHandler, { once: true })
    })

    musicButton.addEventListener('click', async () => {
      if (!isPlaying) {
        await startPlay()
      } else {
        bgAudio.pause()
        isPlaying = false
        musicButton.classList.remove('is-playing')
        musicButton.textContent = '🎵音乐：关'
      }
    })

    if (musicSelectEl) {
      musicSelectEl.addEventListener('change', () => {
        const selectedUrl = musicSelectEl.value
        const nextTrack = tracks.find(t => t.url === selectedUrl)
        if (nextTrack) {
          switchTrack(nextTrack)
        }
      })
    }

    if (musicVolumeEl) {
      musicVolumeEl.addEventListener('input', () => {
        const v = Number(musicVolumeEl.value)
        bgAudio.volume = Math.min(1, Math.max(0, isNaN(v) ? 0.5 : v))
      })
    }
  }
}

// ---------- 4. idle trigger: after 60s no interaction, open arcade Easter egg ----------
(function initIdleArcadeTrigger () {
  // Only run on home page to avoid surprising navigation elsewhere
  if (!document.body.classList.contains('home-bg')) return

  const IDLE_MS = 60 * 1000
  let timer = null

  const reset = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      window.location.href = '/game-arcade/index.html'
    }, IDLE_MS)
  }

  ['pointermove', 'click', 'keydown', 'scroll'].forEach(evt => {
    window.addEventListener(evt, reset, { passive: true })
  })

  reset()
})()

// ---------- 5. small on-page timer badge ----------
function initPageTimer () {
  const el = document.getElementById('pageTimer')
  if (!el) return
  const start = Date.now()

  const pad = (n) => (n < 10 ? '0' + n : '' + n)

  const tick = () => {
    const diff = Math.floor((Date.now() - start) / 1000)
    const m = Math.floor(diff / 60)
    const s = diff % 60
    el.textContent = `在线 ${pad(m)}:${pad(s)}`
  }

  tick()
  setInterval(tick, 1000)
}

initPageTimer()
