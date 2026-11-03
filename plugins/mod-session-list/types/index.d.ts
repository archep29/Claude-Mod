export type SessionRow = {
  id: string
  cwd: string
  title: string
  started: string
  updated: number
  running: boolean
}

export type ScanResult = { account: number; wt: string; launcher: string; sessions: SessionRow[] }

export type Prefs = {
  projectOrder: string[]
  sessionOrder: Record<string, string[]>
  expanded: string[]
  sortMode: 'date' | 'manual'
  minimized: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mod-session-list': {
      scan: ScanResult | null
      prefs: Prefs
      editing: string
      loading: boolean
    }
  }
}
