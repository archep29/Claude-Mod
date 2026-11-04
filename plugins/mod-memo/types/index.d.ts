// null이면 메모 파일을 못 읽은 것
export type MemoText = string | null

declare module 'claude-code' {
  interface PluginState {
    'mod-memo': {
      text: MemoText
    }
  }
}
