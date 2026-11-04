// null이면 메모 파일을 못 읽은 것
export type MemoLines = string[] | null

declare module 'claude-code' {
  interface PluginState {
    'mod-memo': {
      lines: MemoLines
      editing: number
    }
  }
}
