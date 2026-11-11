/**
 * dsh-code-studio client — 外观主题（皮肤）运行时状态。
 *
 * 设置来源：dsh-code-studio 命名空间的 appearance 字段（皮肤设置页可调）。
 * 客户端 settings 订阅经 appearanceApply 写入，根节点经 syncAppearanceAttribute
 * 同步 data-cs-skin 属性（CSS 皮肤层据此切换）。
 *
 * 设计要点：
 * 1. 皮肤值存于**文档根**（document.documentElement）而非每个 [data-edrv-view]：
 *    浮层经 portal 挂 body、根节点各自带 data-edrv-view，若逐个同步会漏；
 *    挂根节点则一条 CSS 选择器通吃，且浮层天然继承。
 * 2. 皮肤层用 [data-cs-skin='glass'] 双属性选择器覆盖既有样式；
 *    未设置该属性时走既有样式（classic = 原版观感），实现零风险回退。
 * 3. 密度（density）通过 data-cs-density 属性驱动，供紧凑模式使用。
 *
 * @author dsh-code-studio 2026-11-10
 */

/** 可选皮肤标识。 */
export type SkinId = 'glass' | 'classic'

/** 可选界面密度。 */
export type DensityId = 'comfortable' | 'compact'

/** 皮肤根属性名（挂 document.documentElement）。 */
const SKIN_ATTR = 'data-cs-skin'
/** 密度根属性名。 */
const DENSITY_ATTR = 'data-cs-density'

/** 默认皮肤：精致现代玻璃质感。 */
export const DEFAULT_SKIN: SkinId = 'glass'
/** 默认密度。 */
export const DEFAULT_DENSITY: DensityId = 'comfortable'

/** 全部可选皮肤（设置页渲染用）。 */
export const SKIN_OPTIONS: ReadonlyArray<{ id: SkinId; label: string; hint: string }> = [
  { id: 'glass', label: '精致玻璃', hint: '柔和半透明层叠 + 细腻动效，默认外观' },
  { id: 'classic', label: '经典原生', hint: '保持原版 VSCode 式紧凑观感' },
]

/** 全部可选密度。 */
export const DENSITY_OPTIONS: ReadonlyArray<{ id: DensityId; label: string }> = [
  { id: 'comfortable', label: '宽松' },
  { id: 'compact', label: '紧凑' },
]

let currentSkin: SkinId = DEFAULT_SKIN
let currentDensity: DensityId = DEFAULT_DENSITY

/**
 * 归一化皮肤值：非法值回落默认。
 * @author dsh-code-studio 2026-11-10
 * @param value 原始值（设置文档来的任意 JSON 值）
 * @returns 合法皮肤标识
 */
export function normalizeSkin(value: unknown): SkinId {
  return value === 'classic' ? 'classic' : DEFAULT_SKIN
}

/**
 * 归一化密度值：非法值回落默认。
 * @author dsh-code-studio 2026-11-10
 * @param value 原始值
 * @returns 合法密度标识
 */
export function normalizeDensity(value: unknown): DensityId {
  return value === 'compact' ? 'compact' : DEFAULT_DENSITY
}

/**
 * 把皮肤与密度写入根节点属性（CSS 皮肤层的开关）。
 *
 * 同时挂 `<html>` 与 `<body>`：
 * - `<html>`：作为全局祖先，覆盖所有插件 UI 与 body 下的 portal 浮层；
 * - `<body>`：兼容把样式挂在 body 作用域的宿主（部分 DSH 版本的设置 slot
 *   会脱离常规 DOM 层级，仅有 html 祖先）。
 * 两者同值不冲突；CSS 用 `:where()` 降低特异性，避免压过组件自身样式。
 *
 * @author dsh-code-studio 2026-11-10
 * @param skin 皮肤标识
 * @param density 密度标识
 */
function writeAttributes(skin: SkinId, density: DensityId): void {
  if (typeof document === 'undefined') return
  for (const root of [document.documentElement, document.body]) {
    if (!root) continue
    root.setAttribute(SKIN_ATTR, skin)
    root.setAttribute(DENSITY_ATTR, density)
  }
}

/**
 * 应用设置值并同步根节点属性（client/index.ts 设置订阅同步调用）。
 *
 * 同步后广播一次 `cs2:appearance` 窗口事件，让设置页的「当前皮肤/密度」
 * 读数条能实时刷新（无需重建整个设置页）。
 *
 * @author dsh-code-studio 2026-11-10
 * @param skin 皮肤设置值
 * @param density 密度设置值
 * @returns 生效的皮肤标识
 */
export function appearanceApply(skin: unknown, density: unknown): SkinId {
  currentSkin = normalizeSkin(skin)
  currentDensity = normalizeDensity(density)
  writeAttributes(currentSkin, currentDensity)
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: { skin: currentSkin, density: currentDensity } }))
    } catch (error) {
      /* 事件构造失败（极旧宿主）静默：不影响皮肤本身生效 */
    }
  }
  return currentSkin
}

/** 外观变更事件名（设置页读数条订阅）。 */
export const APPEARANCE_EVENT = 'cs2:appearance'

/**
 * 读取当前生效的皮肤标识。
 * @author dsh-code-studio 2026-11-10
 * @returns 当前皮肤
 */
export function getSkin(): SkinId {
  return currentSkin
}

/**
 * 读取当前生效的密度标识。
 * @author dsh-code-studio 2026-11-10
 * @returns 当前密度
 */
export function getDensity(): DensityId {
  return currentDensity
}

/**
 * 初始化：把默认皮肤写入根节点（装配期调用，早于任何设置到达）。
 * 幂等——重复调用只会覆写为同一默认值。
 *
 * 装配期 `document.body` 可能尚未就绪，故在 DOMContentLoaded 后再补写一次；
 * 已就绪时立即生效，不留首帧闪烁。
 * @author dsh-code-studio 2026-11-10
 */
export function initAppearance(): void {
  writeAttributes(currentSkin, currentDensity)
  if (typeof document === 'undefined') return
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => writeAttributes(getSkin(), getDensity()), { once: true })
  }
}
