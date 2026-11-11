/** 文件、搜索、Git 三个工作区入口。 */
import React from 'react'
import { IconFolderOpenOutline16, IconSearchOutline16 } from '../../ui/icons.js'
import { FileExplorer } from './FileExplorer.js'
import { SearchPanel } from './SearchPanel.js'
import type { SidebarPanelDef } from '../types.js'
export function createFilePanel(): SidebarPanelDef { return { id: 'explorer', title: '文件', icon: IconFolderOpenOutline16, order: 10, render: ctx => React.createElement(FileExplorer, { ctx }) } }
export function createSearchPanel(): SidebarPanelDef { return { id: 'search', title: '搜索', icon: IconSearchOutline16, order: 15, render: ctx => React.createElement(SearchPanel, { ctx }) } }
export { createGitPanel } from './GitPanel.js'
