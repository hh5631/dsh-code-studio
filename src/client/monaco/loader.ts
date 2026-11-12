// @ts-nocheck
/**
 * dsh-code-studio client — Monaco 加载与语言映射（AMD 构建，离线随包分发）。
 * 迁移自原 src/client/index.ts 的 MONACO_BASE/LANG_BY_EXT/langOf/loadMonaco，语义不改。
 * 作者 ddj 2026-08-20
 */
import { applyOfficial, registerThemes } from './theme.js'

import { transportUrl } from '../../shared/remoteChannel.js'
import { loadFailureText, probeStatus } from '../loadFailure.js'

export const MONACO_BASE = transportUrl('/cstudio/vendor/monaco/vs')
let monacoPromise = null
let monacoStage = { phase: 'idle', progress: 0, message: '准备加载 Monaco…' }
const stageListeners = new Set()

/**
 * Monaco 加载阶段：这是阶段进度而非网络字节进度，避免误导用户。
 * @author ddj 2026年08月22号
 */
export const MONACO_STAGES = {
  loader: { progress: 18, message: '加载 Monaco 引导模块…' },
  core: { progress: 72, message: '加载编辑器核心模块…' },
  ready: { progress: 100, message: 'Monaco 编辑器已就绪' },
  error: { progress: 0, message: 'Monaco 编辑器加载失败' },
}

/**
 * 发布 Monaco 加载阶段，监听器异常不得影响编辑器加载。
 * @author ddj 2026年08月22号
 * @param phase 阶段名
 * @param progress 阶段百分比
 * @param message 用户可读状态
 */
function publishStage(phase, progress, message) {
  monacoStage = { phase, progress, message }
  for (const listener of stageListeners) {
    try { listener(monacoStage) } catch (error) { /* UI 回调异常忽略 */ }
  }
}

/**
 * 订阅 Monaco 加载阶段。
 * @author ddj 2026年08月22号
 * @param listener 阶段回调
 * @returns 取消订阅函数
 */
function subscribeStage(listener) {
  if (typeof listener !== 'function') return () => {}
  stageListeners.add(listener)
  listener(monacoStage)
  return () => stageListeners.delete(listener)
}

export { LANG_BY_EXT, langOf, snippetLanguageOf } from '../fileLanguages.js'

/**
 * 加载 Monaco Editor（AMD 构建，随插件包离线分发）：注入 loader.js → require.config → editor.main。
 * @author ddj 2026年08月20号 / 2026年09月22号
 * @returns Promise<object> window.monaco
 */
export function loadMonaco(onProgress) {
  const unsubscribe = subscribeStage(onProgress)
  if (!monacoPromise) {
    publishStage('loader', MONACO_STAGES.loader.progress, MONACO_STAGES.loader.message)
    monacoPromise = new Promise((resolve, reject) => {
      // 注入期间临时屏蔽全局 module/exports：Monaco loader.js 的 Environment._detect 用
      // `typeof module < 'u' && !!module.exports` 判运行环境，其他插件（如 dsh-backup）注入的
      // 全局 module 会让它误判为 Node 环境 → 只写 module.exports、不挂 window.require →
      // 后续 window.require.config 抛 TypeError（issue #3 根因之一）。onload/onerror 后还原。
      const hasModule = Object.prototype.hasOwnProperty.call(globalThis, 'module')
      const hasExports = Object.prototype.hasOwnProperty.call(globalThis, 'exports')
      const savedModule = globalThis.module
      const savedExports = globalThis.exports
      const hideNodeGlobals = () => {
        try { delete globalThis.module } catch (error) { /* 只读/不可删忽略 */ }
        try { delete globalThis.exports } catch (error) { /* 只读/不可删忽略 */ }
      }
      const restoreNodeGlobals = () => {
        if (hasModule) globalThis.module = savedModule
        else { try { delete globalThis.module } catch (error) { /* 只读/不可删忽略 */ } }
        if (hasExports) globalThis.exports = savedExports
        else { try { delete globalThis.exports } catch (error) { /* 只读/不可删忽略 */ } }
      }
      // 移除已注入的 loader 标签：失败/残留时防止下次命中残留分支同步 boot()（require 未就绪）
      const removeLoaderTag = () => {
        const existing = document.querySelector('script[data-edrv-monaco-loader]')
        if (existing?.parentNode) existing.parentNode.removeChild(existing)
      }
      const fail = (error) => {
        monacoPromise = null
        removeLoaderTag()
        restoreNodeGlobals()
        publishStage('error', MONACO_STAGES.error.progress, MONACO_STAGES.error.message)
        reject(error)
      }
      const inject = () => {
        const s = document.createElement('script')
        s.src = MONACO_BASE + '/loader.js'
        s.dataset.edrvMonacoLoader = '1'
        s.onload = boot
        s.onerror = async () => {
          // 保留首次失败真实原因（网络/HTTP 层），不让后续 TypeError 覆盖；
          // 探测真实状态码，把 403（Host 围栏）/401/404/网络错误区分开，避免一律提示「资源不完整」
          const loaderUrl = MONACO_BASE + '/loader.js'
          const status = await probeStatus(loaderUrl)
          fail(new Error(loadFailureText('Monaco loader 加载失败', loaderUrl, status)))
        }
        hideNodeGlobals()
        document.head.appendChild(s)
      }
      const boot = () => {
        restoreNodeGlobals()
        try {
          // loader 已执行但未挂载 require（全局 module 污染残留/文件异常）：报真实原因，
          // 不再重注入——残留标签场景已在注入前分支处理，此处重试只会无限循环
          if (typeof window.require !== 'function' || typeof window.require.config !== 'function') {
            fail(new Error('Monaco loader 未挂载 window.require（可能被其他脚本注入的全局 module 干扰）'))
            return
          }
          window.require.config({ paths: { vs: MONACO_BASE } })
          publishStage('core', MONACO_STAGES.core.progress, MONACO_STAGES.core.message)
          window.require(['vs/editor/editor.main'], () => {
            publishStage('ready', MONACO_STAGES.ready.progress, MONACO_STAGES.ready.message)
            // 主题：注册现役双套（幂等）+ 应用跟随官方的令牌主题（令牌缺失时回落现役）
            try {
              registerThemes(window.monaco)
              applyOfficial(window.monaco)
            } catch (error) { /* 主题失败不阻塞编辑器 */ }
            resolve(window.monaco)
          }, (err) => fail(new Error('Monaco 模块加载失败：' + String(err))))
        } catch (error) {
          fail(error)
        }
      }
      const existing = document.querySelector('script[data-edrv-monaco-loader]')
      if (existing && typeof window.require === 'function' && typeof window.require.config === 'function') {
        // 残留标签但 require 已就绪（上次注入已生效）：直接 boot，不重复注入
        boot()
      } else if (existing) {
        // 残留标签但 require 缺失（上次失败未清掉）：移除后重新注入，避免同步 boot() 二次踩坑
        removeLoaderTag()
        inject()
      } else {
        inject()
      }
    })
  }
  return monacoPromise.finally(unsubscribe)
}
