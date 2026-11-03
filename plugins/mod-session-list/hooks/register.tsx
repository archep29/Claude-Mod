import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Prefs, ScanResult, SessionRow } from '../types'

// 최근 30일 세션을 프로젝트(작업 폴더)별로 묶어 최근 대화가 위로 오게 보여주고, 누르면 새 탭에서 연다.
// /mod-session-list로 열고 닫는다. 「_ 최소화」를 누르면 패널을 닫고 입력창 위에 다시 여는 한 줄만 남긴다.
// ▲▼로 순서를 옮기고 ✎로 이름을 바꾼다. 순서는 $.store에, 이름은 scan_sessions.py가 따로 파일에 남긴다(대화 기록은 건드리지 않음).

const PANE = 'session-list'
const TITLE = '세션 목록'
const PREFS_KEY = 'prefs'
const EMPTY_PREFS: Prefs = {
  projectOrder: [], sessionOrder: {}, expanded: [], sortMode: 'manual', minimized: false,
}

const scanAtom = atom({ plugin: 'mod-session-list', key: 'scan' } as const, null)
const prefsAtom = atom({ plugin: 'mod-session-list', key: 'prefs' } as const, EMPTY_PREFS)
const editingAtom = atom({ plugin: 'mod-session-list', key: 'editing' } as const, '')
const loadingAtom = atom({ plugin: 'mod-session-list', key: 'loading' } as const, false)

type Project = { key: string; cwd: string; sessions: SessionRow[] }

// 같은 폴더라도 대소문자가 다르게 적힌 기록이 있어 소문자로 묶는다.
const projectKey = (cwd: string) => cwd.toLowerCase()

const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

// 처음 보는 것(새 대화)을 기본 순서(최근 → 오래된 것)대로 맨 위에, 그 아래 저장된 순서.
function applyOrder<T>(items: T[], saved: string[] | undefined, keyOf: (item: T) => string): T[] {
  const byKey = new Map(items.map(item => [keyOf(item), item]))
  const ordered: T[] = []
  for (const key of saved ?? []) {
    const item = byKey.get(key)
    if (item) {
      ordered.push(item)
      byKey.delete(key)
    }
  }
  return [...byKey.values(), ...ordered]
}

function buildProjects(scan: ScanResult, prefs: Prefs): Project[] {
  // 마지막으로 대화한 시각 기준. 폴더도 그 안의 가장 최근 대화가 앞서는 순서가 된다.
  const sorted = [...scan.sessions].sort((a, b) => b.updated - a.updated)
  const groups = new Map<string, Project>()
  for (const row of sorted) {
    const key = projectKey(row.cwd)
    const group = groups.get(key) ?? { key, cwd: row.cwd, sessions: [] }
    group.sessions.push(row)
    groups.set(key, group)
  }
  // 날짜순이면 ▲▼로 옮긴 순서는 쓰지 않고(지우지도 않음) 날짜대로만 보여준다.
  const byDate = prefs.sortMode === 'date'
  const projects = applyOrder([...groups.values()], byDate ? [] : prefs.projectOrder, p => p.key)
  return projects.map(p => ({
    ...p,
    sessions: applyOrder(p.sessions, byDate ? [] : prefs.sessionOrder[p.key], s => s.id),
  }))
}

// 한 칸 위(-1)·아래(+1)로 옮긴 전체 순서를 돌려준다. 끝이면 그대로.
function moved(keys: string[], key: string, step: number): string[] {
  const from = keys.indexOf(key)
  const to = from + step
  if (from < 0 || to < 0 || to >= keys.length) return keys
  const next = [...keys]
  next[from] = keys[to]
  next[to] = key
  return next
}


// 한글·한자 같은 넓은 글자는 화면에서 두 칸을 차지한다.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const cellWidth = (ch: string) => (WIDE.test(ch) ? 2 : 1)

const DAY_MS = 24 * 60 * 60 * 1000
const two = (n: number) => String(n).padStart(2, '0')
const DATE_CELLS = 10 // 「오늘 14:20」의 칸 수. 날짜를 이 폭에 맞춰 이름이 한 줄로 서게 한다.

// 정렬 기준과 같은 「마지막으로 대화한 때」를 이 PC 시각으로: 오늘 14:20 / 어제 / 10-28
const shortDate = (ms: number) => {
  const d = new Date(ms)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const text =
    ms >= today.getTime() ? `오늘 ${two(d.getHours())}:${two(d.getMinutes())}`
    : ms >= today.getTime() - DAY_MS ? '어제'
    : `${two(d.getMonth() + 1)}-${two(d.getDate())}`
  const used = [...text].reduce((sum, ch) => sum + cellWidth(ch), 0)
  return text + ' '.repeat(DATE_CELLS - used)
}

// 이보다 오래된 세션은 흐리게 보여 최근 것이 먼저 눈에 띄게 한다.
const isOld = (ms: number) => Date.now() - ms > 7 * DAY_MS

// 다음 줄로 넘어가면 들여쓰기 없이 맨 앞부터 나와 보기 나빠서, 한 줄에 맞게 자르고 …를 붙인다.
function fitLine(text: string, cells: number): string {
  const line = text.replace(/\s+/g, ' ')
  let used = 0
  let out = ''
  for (const ch of line) {
    const w = cellWidth(ch)
    if (used + w > cells - 1) return out + '…'
    out += ch
    used += w
  }
  return out
}

// 한 줄에 맞게 자른 뒤 남는 칸을 빈칸으로 채운다: 선택했을 때 줄 끝까지 칠해지게
function padLine(text: string, cells: number): string {
  const line = fitLine(text, cells)
  const used = [...line].reduce((sum, ch) => sum + cellWidth(ch), 0)
  return line + ' '.repeat(Math.max(0, cells - used))
}

// 세션 줄에서 이름 말고 차지하는 칸: 들여쓰기·표시 4 + 날짜 11 + 「 ▲ ▼ ✎」 7(마우스를 올리면 나타남)
const ROW_EXTRA = 22

const FOLDER_BG = '#3a4a5e' // 폴더 이름 배경(남회색)

async function savePrefs($: EngineInterface, fn: (prefs: Prefs) => Prefs) {
  await update($, prefsAtom, fn)
  await $.store.set(PREFS_KEY, await read($, prefsAtom))
}

const runScan = ($: EngineInterface, args: string[] = []) =>
  $.process.run(['py', '-I', `${$.plugin.root}/hooks/scan_sessions.py`, ...args], {
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 60_000,
  })

async function refresh($: EngineInterface) {
  if (await read($, loadingAtom)) return
  await update($, loadingAtom, () => true)
  try {
    const { exitCode, stdout, stderr } = await runScan($)
    if (exitCode !== 0) {
      $.ui.log(`세션 목록 읽기 실패: ${stderr.slice(0, 300)}`, { to: 'debug' })
      return
    }
    const scan = JSON.parse(stdout) as ScanResult
    await update($, scanAtom, () => scan)
  } finally {
    await update($, loadingAtom, () => false)
  }
}

// 크기는 처음 요청일 뿐이고, 테두리를 끌어 바꾼 크기가 있으면 엔진이 그쪽을 쓴다.
async function openPane($: EngineInterface) {
  await savePrefs($, p => ({ ...p, minimized: false }))
  return $.ui.open({ id: PANE, title: TITLE, columns: 48, rows: 16 })
}

async function minimize($: EngineInterface) {
  await savePrefs($, p => ({ ...p, minimized: true }))
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'mod-session-list', description: '[mod] 세션 목록 패널 열기' })
    const saved = (await $.store.get(PREFS_KEY)) as Prefs | undefined
    // 처음 쓸 때는 지금 작업 폴더만 펼쳐 둔다.
    const first = { ...EMPTY_PREFS, expanded: [projectKey(await $.session.cwd())] }
    await update($, prefsAtom, () => (saved ? { ...EMPTY_PREFS, ...saved } : first))
    void refresh($)
    if (!(await read($, prefsAtom)).minimized) void openPane($)
    // 다른 탭에서 세션을 켜고 끈 것도 보이도록 1분마다 다시 읽는다.
    $.clock.every(60_000, () => void refresh($))
    return started
  })

  on('command.run', { command: 'mod-session-list' }, async $ => {
    // 열려 있으면 닫고, 닫혀 있으면 연다.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: '세션 목록을 닫았습니다.' }
    }
    await openPane($)
    void refresh($)
    return { text: '세션 목록을 열었습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const scan = await read($, scanAtom)
    const prefs = await read($, prefsAtom)
    const editing = await read($, editingAtom)
    const loading = await read($, loadingAtom)
    const currentId = await $.session.id()
    const nameCells = Math.max(8, (e.props.bodyColumns ?? 48) - ROW_EXTRA)

    if (!scan) {
      return <Text dimColor>{loading ? '세션 읽는 중…' : '세션을 읽지 못했습니다.'}</Text>
    }

    const projects = buildProjects(scan, prefs)
    const projectKeys = projects.map(p => p.key)

    const openSession = async (row: SessionRow) => {
      if (row.id === currentId) {
        $.ui.toast('지금 이 창의 세션입니다.')
        return
      }
      if (row.running) {
        $.ui.toast('이미 다른 탭에 열려 있습니다.')
        return
      }
      const shell = ['powershell.exe', '-ExecutionPolicy', 'Bypass', '-NoExit', '-NoLogo']
      const run = scan.launcher
        ? ['-File', scan.launcher, '-Account', String(scan.account), '-Continue', '-SessionId', row.id]
        : ['-Command', 'claude', '--resume', row.id]
      const argv = [scan.wt, '-w', '0', 'new-tab', '-d', row.cwd, ...shell, ...run]
      const { exitCode, stderr } = await $.process.run(argv)
      if (exitCode !== 0) $.ui.toast(`탭을 열지 못했습니다: ${stderr.slice(0, 200)}`)
      else $.ui.toast(`새 탭에서 여는 중: ${row.title}`)
    }

    // 날짜순 ↔ 내가 ▲▼로 옮긴 순서. 옮긴 순서는 날짜순일 때도 남아 있다.
    const toggleSort = () =>
      savePrefs($, p => ({ ...p, sortMode: p.sortMode === 'date' ? 'manual' : 'date' }))

    const toggle = (key: string) =>
      savePrefs($, p => ({
        ...p,
        expanded: p.expanded.includes(key) ? p.expanded.filter(k => k !== key) : [...p.expanded, key],
      }))

    const moveProject = (key: string, step: number) =>
      savePrefs($, p => ({ ...p, sortMode: 'manual', projectOrder: moved(projectKeys, key, step) }))

    const moveSession = (project: Project, id: string, step: number) =>
      savePrefs($, p => ({
        ...p,
        sortMode: 'manual',
        sessionOrder: {
          ...p.sessionOrder,
          [project.key]: moved(project.sessions.map(s => s.id), id, step),
        },
      }))

    const rename = async (id: string, text: string) => {
      const { exitCode, stderr } = await runScan($, ['--rename', id, text.trim()])
      if (exitCode !== 0) $.ui.toast(`이름을 저장하지 못했습니다: ${stderr.slice(0, 200)}`)
      await update($, editingAtom, () => '')
      await refresh($)
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>최근 30일 · {scan.sessions.length}개</Text>
          <Button key="refresh" plain dimColor label={loading ? '읽는 중' : '↻ 새로고침'} onPress={() => void refresh($)} />
          <Button key="sort-mode" plain dimColor label={prefs.sortMode === 'date' ? '⇅ 날짜순' : '⇅ 내 순서'} onPress={() => void toggleSort()} />
          <Button key="minimize" plain dimColor label="_ 최소화" onPress={() => void minimize($)} />
        </Box>
        {projects.map(project => {
          const isOpen = prefs.expanded.includes(project.key)
          const runningCount = project.sessions.filter(s => s.running).length
          return (
            <Box key={`p:${project.key}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button key={`pt:${project.key}`} plain onPress={() => void toggle(project.key)}>
                  <Text bold backgroundColor={FOLDER_BG}>{`${isOpen ? '▾' : '▸'} ${folderName(project.cwd)} `}</Text>
                  <Text dimColor>{' '}{project.sessions.length}{runningCount ? ` · 켜짐 ${runningCount}` : ''}</Text>
                </Button>
                <Button key={`pu:${project.key}`} plain dimColor label="▲" onPress={() => void moveProject(project.key, -1)} />
                <Button key={`pd:${project.key}`} plain dimColor label="▼" onPress={() => void moveProject(project.key, 1)} />
              </Box>
              {isOpen &&
                project.sessions.map(row => {
                  const name = row.title
                  if (editing === row.id) {
                    return (
                      <Box key={`e:${row.id}`} flexDirection="row">
                        <Input
                          key={`in:${row.id}`}
                          label="  새 이름 "
                          value={name}
                          submitLabel="저장"
                          autoFocus
                          onSubmit={value => void rename(row.id, value)}
                        />
                      </Box>
                    )
                  }
                  // ◆ 이 창(빨강) · ● 다른 탭에서 켜짐(초록)
                  const mark =
                    row.id === currentId ? <Text color="error">◆</Text>
                    : row.running ? <Text color="success">●</Text>
                    : ' '
                  // 단추 안 글자를 한 가지 모양으로 둬야 선택했을 때 한 가지 배경색으로 칠해진다.
                  // 그래서 색 있는 표시는 단추 밖에 두고, 흐림은 단추 전체에 준다(선택하면 풀림).
                  return (
                    <Box key={`s:${row.id}`} flexDirection="row">
                      <Text>{'  '}{mark}</Text>
                      <Box flexDirection="row" gap={1}>
                        <Button
                          key={`so:${row.id}`}
                          plain
                          dimColor={isOld(row.updated)}
                          label={` ${shortDate(row.updated)} ${padLine(name, nameCells)}`}
                          onPress={() => void openSession(row)}
                        />
                      {/* ▲▼✎는 평소에 숨기고, 이 줄에 마우스를 올리면 나타난다 */}
                      <Box flexDirection="row" gap={1} display="none" hover={{ display: 'flex' }}>
                        <Button key={`su:${row.id}`} plain dimColor label="▲" onPress={() => void moveSession(project, row.id, -1)} />
                        <Button key={`sd:${row.id}`} plain dimColor label="▼" onPress={() => void moveSession(project, row.id, 1)} />
                        <Button key={`sr:${row.id}`} plain dimColor label="✎" onPress={() => void update($, editingAtom, () => row.id)} />
                      </Box>
                      </Box>
                    </Box>
                  )
                })}
            </Box>
          )
        })}
        <Text dimColor>
          <Text color="error">◆</Text> 이 창 · <Text color="success">●</Text> 다른 탭에서 켜짐 · 줄에 마우스를 올리면 ▲▼✎
        </Text>
      </Box>
    )
  })

  // 최소화했을 때만 입력창 위에 한 줄을 띄운다. 누르면 패널을 다시 연다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, prefsAtom)).minimized) return next(e)
    const { Button } = $.ui.resolve(e)
    return <Button key="restore" plain dimColor label="▸ 세션 목록" onPress={() => void openPane($)} />
  })
}
