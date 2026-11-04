import type { ClientKeyEvent, ClientModule, ClientPointerEvent } from 'claude-code'

import type { MemoData } from '../types'

// 메모 편집기. 입력칸은 Tab·Backspace를 받지 못해 키를 직접 받아 그린다.
// 파일은 마크다운 목록(- 상위 / 「  - 하위」 / - [x] 완료)이고, 바뀔 때마다 줄 전체를 register.tsx로 보낸다.

type Item = { sub: boolean; done: boolean; folded: boolean; text: string }
type Snapshot = { items: Item[]; row: number; col: number }
type State = Snapshot & { version: number; top: number; undo: Snapshot[]; lastEdit: string }
type VisualRow = { row: number; start: number; chars: string[] }

const FOLD_MARK = ' <!--접음-->' // 마크다운에 접기가 없어, 보기 프로그램에서 안 보이는 주석으로 남긴다
const LINE = /^(\s*)(?:[-*+](?: |$))?(?:\[[xX]\] )?/
const UNDO_LIMIT = 100
const BUTTON_CELLS = 7 // 줄 오른쪽 「▲ ▼ ×」 칸
const FALLBACK_COLUMNS = 40 // 처음 그릴 때는 칸 수를 아직 모른다
const CURSOR_BG = '#c0c0c0'
const CURSOR_FG = '#000000'
const SPECIAL_KEYS = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'escape',
  'pageup', 'pagedown', 'home', 'end', 'insert',
])

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const cellWidth = (ch: string) => (WIDE.test(ch) ? 2 : 1)
const charsOf = (text: string) => [...text]

function parseLine(raw: string): Item {
  const folded = raw.endsWith(FOLD_MARK)
  const line = folded ? raw.slice(0, -FOLD_MARK.length) : raw
  const head = LINE.exec(line)?.[0] ?? ''
  return { sub: /^\s/.test(line), done: /\[[xX]\] $/.test(head), folded, text: line.slice(head.length) }
}

const formatLine = (item: Item) =>
  `${item.sub ? '  ' : ''}- ${item.done ? '[x] ' : ''}${item.text}${item.folded ? FOLD_MARK : ''}`

const emptyItem = (sub: boolean): Item => ({ sub, done: false, folded: false, text: '' })

const hasChildren = (items: Item[], row: number) => !items[row].sub && items[row + 1]?.sub === true

// 접힌 상위 아래의 하위 줄은 건너뛴다.
function visibleRows(items: Item[]): number[] {
  const rows: number[] = []
  let hidden = false
  items.forEach((item, row) => {
    if (!item.sub) hidden = item.folded
    if (!item.sub || !hidden) rows.push(row)
  })
  return rows
}

// row 줄과 그 하위 줄들이 끝나는 다음 번호
function blockEnd(items: Item[], row: number): number {
  let end = row + 1
  while (end < items.length && items[end].sub) end++
  return end
}

// 한 칸 위(-1)·아래(+1)로. 상위 줄은 하위 줄과 함께 옆 묶음과 자리를 바꾼다. 끝이면 그대로.
function movedItems(items: Item[], row: number, step: number): Item[] {
  if (items[row].sub) {
    const to = row + step
    return to < 0 || to >= items.length ? items : items.with(row, items[to]).with(to, items[row])
  }
  const end = blockEnd(items, row)
  if (step < 0) {
    if (row === 0) return items
    let start = row - 1
    while (start > 0 && items[start].sub) start--
    return [...items.slice(0, start), ...items.slice(row, end), ...items.slice(start, row), ...items.slice(end)]
  }
  if (end >= items.length) return items
  const nextEnd = blockEnd(items, end)
  return [...items.slice(0, row), ...items.slice(end, nextEnd), ...items.slice(row, end), ...items.slice(nextEnd)]
}

// edit가 같으면(글자를 이어 칠 때) 되돌리기 한 번에 묶는다.
function changed(s: State, items: Item[], row: number, col: number, edit = ''): State {
  const undo = edit && edit === s.lastEdit
    ? s.undo
    : [...s.undo, { items: s.items, row: s.row, col: s.col }].slice(-UNDO_LIMIT)
  return { ...s, items, row, col, undo, lastEdit: edit }
}

const setItem = (s: State, patch: Partial<Item>) => s.items.with(s.row, { ...s.items[s.row], ...patch })

function typeText(s: State, text: string): State {
  const chars = charsOf(s.items[s.row].text)
  const typed = charsOf(text.replace(/\r?\n/g, ' '))
  chars.splice(s.col, 0, ...typed)
  return changed(s, setItem(s, { text: chars.join('') }), s.row, s.col + typed.length, 'type')
}

// 커서 뒤 글자는 다음 줄로 내려간다. 펼친 상위 줄이면 첫 하위 줄이 된다.
function pressEnter(s: State): State {
  const item = s.items[s.row]
  const chars = charsOf(item.text)
  const at = item.folded ? blockEnd(s.items, s.row) : s.row + 1
  const sub = item.sub || (hasChildren(s.items, s.row) && !item.folded)
  const next = { ...emptyItem(sub), text: chars.slice(s.col).join('') }
  const items = setItem(s, { text: chars.slice(0, s.col).join('') }).toSpliced(at, 0, next)
  return changed(s, items, at, 0)
}

function setLevel(s: State, sub: boolean): State {
  if (s.items[s.row].sub === sub || (sub && s.row === 0)) return s
  // 접힌 상위 밑으로 들어가면 안 보이게 되므로 그 상위를 펼친다.
  let parent = s.row - 1
  while (parent > 0 && s.items[parent].sub) parent--
  const items = setItem(s, sub ? { sub, folded: false } : { sub })
  return changed(s, sub ? items.with(parent, { ...items[parent], folded: false }) : items, s.row, s.col)
}

// 앞 줄 끝에 이 줄 글자를 붙이고 이 줄을 없앤다.
function mergeInto(s: State, target: number, source: number): State {
  const joinAt = charsOf(s.items[target].text).length
  const items = s.items
    .with(target, { ...s.items[target], text: s.items[target].text + s.items[source].text })
    .toSpliced(source, 1)
  return changed(s, items, target, joinAt)
}

const neighbor = (s: State, step: number) => {
  const rows = visibleRows(s.items)
  return rows[rows.indexOf(s.row) + step]
}

function pressBackspace(s: State): State {
  if (s.col > 0) {
    const chars = charsOf(s.items[s.row].text)
    chars.splice(s.col - 1, 1)
    return changed(s, setItem(s, { text: chars.join('') }), s.row, s.col - 1, 'erase')
  }
  const before = neighbor(s, -1)
  return before === undefined ? s : mergeInto(s, before, s.row)
}

function pressDelete(s: State): State {
  const chars = charsOf(s.items[s.row].text)
  if (s.col < chars.length) {
    chars.splice(s.col, 1)
    return changed(s, setItem(s, { text: chars.join('') }), s.row, s.col, 'erase')
  }
  const after = neighbor(s, 1)
  return after === undefined ? s : mergeInto(s, s.row, after)
}

function moveCursor(s: State, step: number, atEnd?: boolean): State {
  const row = neighbor(s, step)
  if (row === undefined) return s
  const length = charsOf(s.items[row].text).length
  return { ...s, row, col: atEnd ? length : Math.min(s.col, length), lastEdit: '' }
}

function moveLeftRight(s: State, step: number): State {
  const col = s.col + step
  if (col < 0) return moveCursor({ ...s, col: 0 }, -1, true)
  if (col > charsOf(s.items[s.row].text).length) return { ...moveCursor(s, 1), col: 0 }
  return { ...s, col, lastEdit: '' }
}

function moveItem(s: State, row: number, step: number): State {
  const item = s.items[row]
  const items = movedItems(s.items, row, step)
  return items === s.items ? s : changed(s, items, items.indexOf(item), s.col)
}

function removeItem(s: State, row: number): State {
  if (s.items.length === 1) return changed(s, [emptyItem(false)], 0, 0)
  const items = s.items.toSpliced(row, 1)
  return changed(s, items, Math.min(row, items.length - 1), 0)
}

const toggleDone = (s: State, row: number) =>
  changed(s, s.items.with(row, { ...s.items[row], done: !s.items[row].done }), s.row, s.col)

function toggleFold(s: State, row: number): State {
  const folded = !s.items[row].folded
  const items = s.items.with(row, { ...s.items[row], folded })
  // 접어서 커서 줄이 숨으면 상위 줄로 옮긴다.
  const hidden = folded && s.row > row && s.row < blockEnd(items, row)
  return changed(s, items, hidden ? row : s.row, hidden ? 0 : s.col)
}

function undo(s: State): State {
  const last = s.undo.at(-1)
  return last ? { ...s, ...last, undo: s.undo.slice(0, -1), lastEdit: '' } : s
}

function pressKey(s: State, e: ClientKeyEvent): State {
  if (e.ctrl) {
    if (e.key === 'z') return undo(s)
    if (e.key === 'k') return toggleDone(s, s.row) // Ctrl+D는 Claude Code의 종료 키라 쓰지 않는다
    if (e.key === 'up') return moveItem(s, s.row, -1)
    if (e.key === 'down') return moveItem(s, s.row, 1)
    return s
  }
  if (e.meta) return s
  switch (e.key) {
    case 'return':
    case 'enter': return pressEnter(s)
    case 'tab': return setLevel(s, !e.shift)
    case 'backspace': return pressBackspace(s)
    case 'delete': return pressDelete(s)
    case 'up': return moveCursor(s, -1)
    case 'down': return moveCursor(s, 1)
    case 'left': return moveLeftRight(s, -1)
    case 'right': return moveLeftRight(s, 1)
    case 'home': return { ...s, col: 0, lastEdit: '' }
    case 'end': return { ...s, col: charsOf(s.items[s.row].text).length, lastEdit: '' }
    case 'space': return typeText(s, ' ')
    default: return SPECIAL_KEYS.has(e.key) || /^f\d+$/.test(e.key) ? s : typeText(s, e.key)
  }
}

// 줄 앞 칸: 접기 2칸 + 불렛 2칸, 하위는 2칸 더 들여쓴다.
const bulletCell = (item: Item) => (item.sub ? 4 : 2)
const textStart = (item: Item) => bulletCell(item) + 2

// 칸 수에 맞춰 줄을 나눈다. 빈 줄도 화면 한 줄을 차지한다.
function wrapItem(item: Item, row: number, cells: number): VisualRow[] {
  const rows: VisualRow[] = []
  let start = 0
  let chars: string[] = []
  let used = 0
  charsOf(item.text).forEach((ch, index) => {
    const width = cellWidth(ch)
    if (used + width > cells) {
      rows.push({ row, start, chars })
      start = index
      chars = []
      used = 0
    }
    chars.push(ch)
    used += width
  })
  rows.push({ row, start, chars })
  return rows
}

function colAtCell(visual: VisualRow, cell: number): number {
  let used = 0
  for (let index = 0; index < visual.chars.length; index++) {
    used += cellWidth(visual.chars[index])
    if (cell < used) return visual.start + index
  }
  return visual.start + visual.chars.length
}

function pressPointer(s: State, rows: VisualRow[], top: number, e: ClientPointerEvent): State {
  const visual = rows[top + e.y]
  if (!visual) return s
  const item = s.items[visual.row]
  const isFirst = visual.start === 0
  if (isFirst && e.x < 2 && hasChildren(s.items, visual.row)) return toggleFold(s, visual.row)
  if (isFirst && e.x >= bulletCell(item) && e.x < textStart(item)) return toggleDone(s, visual.row)
  return { ...s, row: visual.row, col: colAtCell(visual, e.x - textStart(item)), lastEdit: '' }
}

function fromProps(memo: MemoData, old: State | undefined): State {
  const items = memo.lines.length ? memo.lines.map(parseLine) : [emptyItem(false)]
  const row = Math.min(old?.row ?? 0, items.length - 1)
  return {
    items, row, col: Math.min(old?.col ?? 0, charsOf(items[row].text).length),
    version: memo.version, top: old?.top ?? 0, undo: [], lastEdit: '',
  }
}

const MemoEditor: ClientModule<MemoData, State> = (memo, surface) => {
  const { Box, Text, Button } = surface.elements
  const old = surface.state
  const s = old && old.version === memo.version ? old : fromProps(memo, old)

  const columns = surface.columns || FALLBACK_COLUMNS
  const rowsShown = Math.max(1, (surface.rows || 12) - 1) // 맨 아래 한 줄은 되돌리기 단추

  const apply = (next: State) => {
    if (next === s) return
    surface.setState(next)
    if (next.items !== s.items) surface.post({ lines: next.items.map(formatLine) })
  }

  const rows = visibleRows(s.items).flatMap(row => {
    const cells = Math.max(4, columns - textStart(s.items[row]) - BUTTON_CELLS)
    return wrapItem(s.items[row], row, cells)
  })

  // 커서가 있는 화면 줄이 보이게 위치를 맞춘다.
  const cursorRow = rows.findLastIndex(v => v.row === s.row && v.start <= s.col)
  const top = Math.min(Math.max(s.top, cursorRow - rowsShown + 1), cursorRow)
  s.top = top

  surface.onKey(e => apply(pressKey(s, e)))
  surface.onPointer(e => {
    if (e.type === 'down' && e.button === 'left') apply(pressPointer(s, rows, top, e))
  })

  const drawText = (visual: VisualRow, index: number, item: Item) => {
    const isCursorRow = index === cursorRow
    const look = { dimColor: item.done, strikethrough: item.done }
    if (!isCursorRow) return <Text {...look}>{visual.chars.join('')}</Text>
    const at = s.col - visual.start
    return (
      <Text>
        <Text {...look}>{visual.chars.slice(0, at).join('')}</Text>
        <Text backgroundColor={CURSOR_BG} color={CURSOR_FG}>{visual.chars[at] ?? ' '}</Text>
        <Text {...look}>{visual.chars.slice(at + 1).join('')}</Text>
      </Text>
    )
  }

  const prefix = (visual: VisualRow) => {
    const item = s.items[visual.row]
    if (visual.start > 0) return ' '.repeat(textStart(item))
    const fold = hasChildren(s.items, visual.row) ? (item.folded ? '▸ ' : '▾ ') : '  '
    const bullet = item.done ? '☑ ' : item.sub ? '◦ ' : '• '
    return `${item.sub ? `${fold}  ` : fold}${bullet}`
  }

  return (
    <Box flexDirection="column">
      {rows.slice(top, top + rowsShown).map((visual, offset) => {
        const index = top + offset
        const item = s.items[visual.row]
        const showButtons = visual.row === s.row && visual.start === 0
        return (
          <Box key={`r:${visual.row}:${visual.start}`} flexDirection="row">
            <Box width={columns - BUTTON_CELLS} flexDirection="row">
              <Text>{prefix(visual)}</Text>
              {drawText(visual, index, item)}
            </Box>
            {showButtons && (
              <Box flexDirection="row" gap={1}>
                <Button key="up" plain dimColor label="▲" onPress={() => apply(moveItem(s, s.row, -1))} />
                <Button key="down" plain dimColor label="▼" onPress={() => apply(moveItem(s, s.row, 1))} />
                <Button key="del" plain dimColor label="×" onPress={() => apply(removeItem(s, s.row))} />
              </Box>
            )}
          </Box>
        )
      })}
      <Button key="undo" plain dimColor label="↶ 되돌리기" onPress={() => apply(undo(s))} />
    </Box>
  )
}

export default MemoEditor
