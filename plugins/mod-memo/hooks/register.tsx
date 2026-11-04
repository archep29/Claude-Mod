import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MemoLines } from '../types'

// 오른쪽 패널에 메모 탭을 띄운다. 모든 창이 메모 하나를 같이 쓴다. /mod-memo로 열고 닫는다.
// 입력칸은 끝에 글자를 붙이고 지우기만 되고 Enter를 치면 비워진다. 그래서 Enter마다 한 줄씩 쌓고, 줄을 누르면 고친다.

const PANE = 'memo'
const TITLE = '메모'
// 한 줄에 메모 한 줄. 두 계정이 같이 쓰고, .claude 동기화로 다른 PC에도 간다.
const MEMO_FILE = '.claude/plugins/mod-memo.txt'
const REFRESH_MS = 5_000
const NOT_EDITING = -1

// null이면 파일을 못 읽은 것: 입력칸을 내지 않아 빈 메모로 덮어쓰는 일을 막는다.
const linesAtom = atom({ plugin: 'mod-memo', key: 'lines' } as const, null as MemoLines)
const editingAtom = atom({ plugin: 'mod-memo', key: 'editing' } as const, NOT_EDITING)

const memoPath = async ($: EngineInterface) => `${await $.env.get('USERPROFILE')}/${MEMO_FILE}`

async function loadLines($: EngineInterface): Promise<string[]> {
  const path = await memoPath($)
  if (!(await $.fs.exists(path))) return []
  return (await $.fs.read(path)).split(/\r?\n/).filter(line => line.trim())
}

async function refresh($: EngineInterface) {
  try {
    const lines = await loadLines($)
    const shown = await read($, linesAtom)
    if (lines.join('\n') !== shown?.join('\n')) await update($, linesAtom, () => lines)
  } catch (error) {
    $.ui.log(`메모 읽기 실패: ${error}`, { to: 'debug' })
  }
}

// 다른 탭이 고친 줄을 덮어쓰지 않게, 저장할 때마다 파일을 새로 읽어 거기에 고친다.
async function changeLines($: EngineInterface, fn: (lines: string[]) => string[]) {
  try {
    const lines = fn(await loadLines($))
    await $.fs.write(await memoPath($), lines.join('\n'))
    await update($, linesAtom, () => lines)
  } catch (error) {
    $.ui.toast(`메모를 저장하지 못했습니다: ${error}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'mod-memo', description: '[mod] 메모 탭 열기' })
    await refresh($)
    void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: 'mod-memo' }, async $ => {
    // 열려 있으면 닫고, 닫혀 있으면 연다.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: '메모 탭을 닫았습니다.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: '메모 탭을 열었습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const lines = await read($, linesAtom)
    const editing = await read($, editingAtom)
    if (lines === null) return <Text dimColor>메모를 읽지 못했습니다.</Text>

    const add = (text: string) => {
      const line = text.trim()
      if (line) void changeLines($, all => [...all, line])
    }

    // 글자를 다 지우고 Enter를 치면 그 줄을 지운다.
    const edit = async (old: string, text: string) => {
      const line = text.trim()
      await changeLines($, all => {
        const at = all.indexOf(old)
        if (at < 0) return all
        return [...all.slice(0, at), ...(line ? [line] : []), ...all.slice(at + 1)]
      })
      await update($, editingAtom, () => NOT_EDITING)
    }

    return (
      <Box flexDirection="column">
        {lines.map((line, index) =>
          index === editing ? (
            <Input
              key={`edit:${index}`}
              value={line}
              submitLabel="저장"
              autoFocus
              onSubmit={value => void edit(line, value)}
            />
          ) : (
            <Button
              key={`line:${index}`}
              plain
              label={line}
              onPress={() => void update($, editingAtom, () => index)}
            />
          ),
        )}
        <Input key="new" placeholder="메모를 적고 Enter" submitLabel="추가" autoFocus onSubmit={add} />
        <Text dimColor>Enter로 한 줄씩 추가 · 줄을 누르면 고침 · 글자를 다 지우고 Enter면 삭제</Text>
      </Box>
    )
  })
}
