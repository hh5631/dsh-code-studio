import React from 'react'

/** 工作区工具统一使用 16px 线性图标，不依赖字体符号。 */
const paths = {
  branch: 'M6 3v9a4 4 0 0 0 4 4h2M6 7h5a5 5 0 0 0 5-5M6 3a2 2 0 1 0 0 .01M16 2a2 2 0 1 0 0 .01M14 16a2 2 0 1 0 0 .01',
  folder: 'M2 6V4h6l2 2h8v11H2V6Z',
  search: 'M14 14l5 5M16 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  refresh: 'M17 5V1m0 4h-4M17 5a8 8 0 1 0 1 9',
  plus: 'M10 3v14M3 10h14',
  minus: 'M3 10h14',
  discard: 'M4 6h7a6 6 0 1 1 0 12M4 6l4-4M4 6l4 4',
  down: 'm5 8 5 5 5-5',
  right: 'm8 5 5 5-5 5',
  close: 'm5 5 10 10M5 15 15 5',
  commit: 'M1 10h5m8 0h5M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  check: 'm4 10 4 4 8-9',
  filter: 'M2 5h16M5 10h10M8 15h4',
  file: 'M4 2h8l4 4v12H4V2Zm8 0v5h4',
} as const

export function StudioIcon({ name, size = 16 }: { name: keyof typeof paths; size?: number }): React.ReactElement {
  // 常见的 Git 菱形标志，单色随宿主主题，不额外引入图标字体或网络请求。
  if (name === 'branch') return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false },
    React.createElement('path', { d: 'M11 1.7a1.4 1.4 0 0 1 2 0L22.3 11a1.4 1.4 0 0 1 0 2L13 22.3a1.4 1.4 0 0 1-2 0L1.7 13a1.4 1.4 0 0 1 0-2Z', fill: 'currentColor' }),
    React.createElement('path', { d: 'm8 6 7 7M9 7v9', stroke: 'var(--cstudio-surface, #fff)', strokeWidth: 1.5, strokeLinecap: 'round' }),
    ...[[9, 7], [9, 16], [15, 13]].map(([cx, cy]) => React.createElement('circle', { key: `${cx}-${cy}`, cx, cy, r: 1.6, fill: 'var(--cstudio-surface, #fff)' })))
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.45, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    React.createElement('path', { d: paths[name] }))
}
