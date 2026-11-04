// version이 바뀌면 편집기가 lines를 새로 받아들인다(다른 탭에서 고쳤을 때).
export type MemoData = { lines: string[]; version: number }

declare module 'claude-code' {
  interface PluginState {
    'mod-memo': {
      memo: MemoData | null
    }
  }
}
