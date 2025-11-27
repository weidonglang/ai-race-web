// vite.config.js
// 多页面 + 相对路径打包配置
// 目标：dist 可直接双击 index.html 离线打开，所有页面/动画都能用。

import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  // ✅ 用相对路径，方便直接用 file:// 打开 dist/*.html
  base: './',

  // 如果你将来想把 mazes 放到 public/mazes，可以在这里保留默认即可
  // publicDir: 'public',

  build: {
    rollupOptions: {
      // ✅ 把你所有需要访问的 HTML 都声明成入口
      input: {
        // 主导航里的页面：
        index:     resolve(__dirname, 'index.html'),
        editor:    resolve(__dirname, 'editor.html'),
        arena:     resolve(__dirname, 'arena.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        lab:       resolve(__dirname, 'lab.html'),
        replays:   resolve(__dirname, 'replays.html'),
        help:      resolve(__dirname, 'help.html'),
        about:     resolve(__dirname, 'about.html'),
        faq:       resolve(__dirname, 'faq.html'),
        rl:        resolve(__dirname, 'rl.html'),

        // ✅ 一些子页面/案例页/帮助页（你目录里有的）
        case_easy:   resolve(__dirname, 'case_easy.html'),
        case_medium: resolve(__dirname, 'case_medium.html'),
        case_hard:   resolve(__dirname, 'case_hard.html'),

        help_arena_usage:      resolve(__dirname, 'help_arena_usage.html'),
        help_dashboard_usage:  resolve(__dirname, 'help_dashboard_usage.html'),
        help_exploration:      resolve(__dirname, 'help_exploration.html'),
        help_lab:              resolve(__dirname, 'help_lab.html'),
        help_navmesh:          resolve(__dirname, 'help_navmesh.html'),
        help_qlearning:        resolve(__dirname, 'help_qlearning.html'),
        help_rewards:          resolve(__dirname, 'help_rewards.html'),
        help_shortcuts:        resolve(__dirname, 'help_shortcuts.html'),
        help_world:            resolve(__dirname, 'help_world.html')
      }
    }
  }
})
