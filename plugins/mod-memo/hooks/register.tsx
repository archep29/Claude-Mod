import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MemoLines } from '../types'

// 오른쪽 패널에 메모 탭을 띄운다. 모든 창이 메모 하나를 같이 쓴다. /mod-memo로 열고 닫는다.
// 입력칸은 끝에 글자를 붙이고 지우기만 되고 Enter를 치면 비워진다. 그래서 Enter마다 한 줄씩 쌓고(빈칸이면 빈 줄), 줄을 누르면 고친다.
// 줄에 마우스를 올리면 ▲▼로 옮기고 →←로 하위·상위를 바꾸고 ×로 지운다. 상위 줄을 옮기면 하위 줄도 같이 간다.

const PANE = 'memo'
const TITLE = '메모'
// 한 줄에 메모 한 줄, 하위 메모는 맨 앞에 탭. 두 계정이 같이 쓰고, .claude 동기화로 다른 PC에도 간다.
const MEMO_FILE = '.claude/plugins/mod-memo.txt'
const REFRESH_MS = 5_000
// 탭은 연 순서대로 놓이고 순서를 정하는 기능이 없어, 세션목록이 열린 뒤에 열어 맨 뒤에 오게 한다.
const OPEN_DELAY_MS = 1_000
const NOT_EDITING = -1
const ROW_BUTTON_CELLS = 9 // 줄 오른쪽 「 ▲ ▼ → ×」 칸. 나타날 때 글이 밀리지 않게 미리 비워 둔다.
const SUB = '\t' // 하위 메모 표시
const SUB_TYPED = '-' // 입력칸에서 이 글자로 시작하면 하위 메모

// null이면 파일을 못 읽은 것: 입력칸을 내지 않아 빈 메모로 덮어쓰는 일을 막는다.
const linesAtom = atom({ plugin: 'mod-memo', key: 'lines' } as const, null as MemoLines)
const editingAtom = atom({ plugin: 'mod-memo', key: 'editing' } as const, NOT_EDITING)

const memoPath = async ($: EngineInterface) => `${await $.env.get('USERPROFILE')}/${MEMO_FILE}`

async function loadLines($: EngineInterface): Promise<string[]> {
  const path = await memoPath($)
  if (!(await $.fs.exists(path))) return []
  const lines = (await $.fs.read(path)).split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop() // 마지막 줄바꿈 뒤는 줄이 아니다
  return lines
}

async function refresh($: EngineInterface) {
  try {
    const lines = await loadLines($)
    const shown = await read($, linesAtom)
    if (shown === null || lines.join('\n') !== shown.join('\n')) await update($, linesAtom, () => lines)
  } catch (error) {
    $.ui.log(`메모 읽기 실패: ${error}`, { to: 'debug' })
  }
}

// 다른 탭이 고친 줄을 덮어쓰지 않게, 저장할 때마다 파일을 새로 읽어 거기에 고친다.
async function changeLines($: EngineInterface, fn: (lines: string[]) => string[]) {
  try {
    const lines = fn(await loadLines($))
    await $.fs.write(await memoPath($), lines.map(line => `${line}\n`).join(''))
    await update($, linesAtom, () => lines)
  } catch (error) {
    $.ui.toast(`메모를 저장하지 못했습니다: ${error}`)
  }
}

const isSub = (line: string) => line.startsWith(SUB)
const textOf = (line: string) => (isSub(line) ? line.slice(SUB.length) : line)
const bullet = (line: string) => (isSub(line) ? '  ◦' : textOf(line) ? '•' : ' ')

// 입력칸 글자를 파일의 한 줄로
function typedLine(text: string): string {
  const line = text.trim()
  if (!line.startsWith(SUB_TYPED)) return line
  const sub = line.slice(SUB_TYPED.length).trim()
  return sub ? SUB + sub : ''
}

// at 줄과 그 하위 줄들이 끝나는 다음 번호
function blockEnd(all: string[], at: number): number {
  let end = at + 1
  while (end < all.length && isSub(all[end])) end++
  return end
}

// 한 칸 위(-1)·아래(+1)로 옮긴 전체 줄. 상위 줄은 하위 줄과 함께 옆 묶음과 자리를 바꾼다. 끝이면 그대로.
function movedLines(all: string[], at: number, step: number): string[] {
  if (isSub(all[at])) {
    const to = at + step
    return to < 0 || to >= all.length ? all : all.with(at, all[to]).with(to, all[at])
  }
  const end = blockEnd(all, at)
  if (step < 0) {
    if (at === 0) return all
    let start = at - 1
    while (start > 0 && isSub(all[start])) start--
    return [...all.slice(0, start), ...all.slice(at, end), ...all.slice(start, at), ...all.slice(end)]
  }
  if (end >= all.length) return all
  const nextEnd = blockEnd(all, end)
  return [...all.slice(0, at), ...all.slice(end, nextEnd), ...all.slice(at, end), ...all.slice(nextEnd)]
}

// 다른 탭이 줄을 옮겼을 수 있어 번호가 안 맞으면 글자로 찾는다.
const findLine = (all: string[], index: number, line: string) =>
  all[index] === line ? index : all.indexOf(line)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'mod-memo', description: '[mod] 메모 탭 열기' })
    await refresh($)
    $.clock.after(OPEN_DELAY_MS, () => void $.ui.open({ id: PANE, title: TITLE }))
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

    const textCells = Math.max(8, (e.props.bodyColumns ?? 48) - ROW_BUTTON_CELLS)

    const add = (text: string) => void changeLines($, all => [...all, typedLine(text)])

    // 그 줄을 찾아 바꾼다. 고치던 줄이 있으면 번호가 어긋나므로 고치기를 끝낸다.
    const changeLine = async (
      index: number,
      line: string,
      fn: (all: string[], at: number) => string[],
    ) => {
      await update($, editingAtom, () => NOT_EDITING)
      await changeLines($, all => {
        const at = findLine(all, index, line)
        return at < 0 ? all : fn(all, at)
      })
    }

    // 누르자마자 칠 수 있게 커서를 입력칸으로 옮긴다.
    const startEdit = async (index: number) => {
      await update($, editingAtom, () => index)
      await $.ui.focus({ requestId: PANE, key: `edit:${index}` })
    }

    const edit = (index: number, line: string, text: string) =>
      changeLine(index, line, (all, at) => all.with(at, (isSub(line) ? SUB : '') + text.trim()))

    const remove = (index: number, line: string) =>
      changeLine(index, line, (all, at) => all.toSpliced(at, 1))

    const move = (index: number, line: string, step: number) =>
      changeLine(index, line, (all, at) => movedLines(all, at, step))

    // 상위 ↔ 하위
    const toggleLevel = (index: number, line: string) =>
      changeLine(index, line, (all, at) => all.with(at, isSub(line) ? textOf(line) : SUB + line))

    return (
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, index) =>
          index === editing ? (
            <Box key={`editrow:${index}`} flexDirection="row" gap={1}>
              <Box width={textCells} gap={1}>
                <Text>{bullet(line)}</Text>
                <Input
                  key={`edit:${index}`}
                  value={textOf(line)}
                  submitLabel="저장"
                  autoFocus
                  onSubmit={value => void edit(index, line, value)}
                />
              </Box>
              <Button key={`editdel:${index}`} plain dimColor label="삭제" onPress={() => void remove(index, line)} />
            </Box>
          ) : (
            <Box key={`row:${index}`} flexDirection="row" gap={1}>
              <Box width={textCells} gap={1}>
                <Text>{bullet(line)}</Text>
                <Button
                  key={`line:${index}`}
                  plain
                  label={textOf(line) || ' '}
                  onPress={() => void startEdit(index)}
                />
              </Box>
              {/* 평소에 숨기고, 이 줄에 마우스를 올리면 나타난다 */}
              <Box flexDirection="row" gap={1} display="none" hover={{ display: 'flex' }}>
                <Button key={`up:${index}`} plain dimColor label="▲" onPress={() => void move(index, line, -1)} />
                <Button key={`down:${index}`} plain dimColor label="▼" onPress={() => void move(index, line, 1)} />
                {textOf(line) && (
                  <Button key={`level:${index}`} plain dimColor label={isSub(line) ? '←' : '→'} onPress={() => void toggleLevel(index, line)} />
                )}
                <Button key={`del:${index}`} plain dimColor label="×" onPress={() => void remove(index, line)} />
              </Box>
            </Box>
          ),
        )}
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text>+</Text>
            <Input
              key="new"
              placeholder="적고 Enter (-로 시작: 하위, 빈칸: 빈 줄)"
              submitLabel="추가"
              autoFocus
              onSubmit={add}
            />
          </Box>
          <Text dimColor>줄 누르면 고침 · 마우스 올리면 ▲▼→×</Text>
        </Box>
      </Box>
    )
  })
}
