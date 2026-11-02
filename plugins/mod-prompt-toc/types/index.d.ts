/** 체크한 질문들: 질문 글 앞 200자 목록 */
export type Marks = string[]

declare module 'claude-code' {
  interface PluginState {
    'mod-prompt-toc': { marks: Marks }
  }
}
