// version이 바뀌면 편집기가 lines를 새로 받아들인다(다른 탭에서 고쳤을 때).
export type MemoData = { lines: string[]; version: number }
// promptEdits: 입력창을 고친 횟수. 늘어나면 키보드가 메모를 떠난 것이다.
export type EditorProps = MemoData & { promptEdits: number }

declare module 'claude-code' {
  interface PluginState {
    'mod-memo': {
      memo: MemoData | null
      promptEdits: number
    }
  }
}
