import React from 'react'

/** 工作区工具统一使用 16px 线性图标，不依赖字体符号。 */
const paths = {
  branch: 'M6 6v8m0-3h3a6 6 0 0 0 5.7-4M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm9-11a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
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
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.45, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    React.createElement('path', { d: paths[name] }))
}
