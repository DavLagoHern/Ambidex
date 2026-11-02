import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  Activity, AppWindow, Archive, Camera, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, AtSign, Bell, Bot, Brain, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck,
  CircleStop, CircleX, Clock, Code, Columns2, Command, Copy, Cpu, Database, Ellipsis, ExternalLink, File, FilePen, Files, Folder,
  FolderOpen, GitBranch, Globe, GitCompare, GitFork, GripVertical, History, ImagePlus, Info, KeyRound, Keyboard, Layers, ListChecks, LoaderCircle, Lock, LogIn,
  MessagesSquare, Minus, Monitor, Moon, Palette, PanelBottom, PanelLeft, PanelRight, PanelsTopLeft, Paperclip, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCw,
  Play, ScrollText, Search, SendHorizontal, Settings, ShieldCheck, Sparkles, Square, SquareTerminal, Sun, Terminal, Trash2, TriangleAlert,
  Undo2, Workflow, Wrench, X, Zap
} from 'lucide-react'
import type { AgentId } from '@shared/types'
import codexLogo from '../assets/codex.png'

// Mismo grosor de trazo en toda la app
const wrap = (I: LucideIcon) =>
  function Icon({ size = 16, ...rest }: LucideProps) {
    return <I size={size} strokeWidth={1.75} absoluteStrokeWidth {...rest} />
  }

export const Icon = {
  files: wrap(Files),
  file: wrap(File),
  fileEdit: wrap(FilePen),
  folder: wrap(Folder),
  folderOpen: wrap(FolderOpen),
  git: wrap(GitFork),
  branch: wrap(GitBranch),
  compare: wrap(GitCompare),
  history: wrap(History),
  search: wrap(Search),
  chevronRight: wrap(ChevronRight),
  chevronDown: wrap(ChevronDown),
  plus: wrap(Plus),
  minus: wrap(Minus),
  undo: wrap(Undo2),
  check: wrap(Check),
  x: wrap(X),
  refresh: wrap(RefreshCw),
  up: wrap(ArrowUp),
  down: wrap(ArrowDown),
  terminal: wrap(SquareTerminal),
  prompt: wrap(Terminal),
  sparkles: wrap(Sparkles),
  send: wrap(SendHorizontal),
  stop: wrap(Square),
  stopCircle: wrap(CircleStop),
  settings: wrap(Settings),
  code: wrap(Code),
  copy: wrap(Copy),
  trash: wrap(Trash2),
  layers: wrap(Layers),
  split: wrap(Columns2),
  tool: wrap(Wrench),
  brain: wrap(Brain),
  external: wrap(ExternalLink),
  stash: wrap(Archive),
  edit: wrap(Pencil),
  chat: wrap(MessagesSquare),
  activity: wrap(Activity),
  bot: wrap(Bot),
  command: wrap(Command),
  pin: wrap(Pin),
  unpin: wrap(PinOff),
  panelLeft: wrap(PanelLeft),
  panelRight: wrap(PanelRight),
  panelBottom: wrap(PanelBottom),
  layout: wrap(PanelsTopLeft),
  play: wrap(Play),
  image: wrap(ImagePlus),
  camera: wrap(Camera),
  bell: wrap(Bell),
  database: wrap(Database),
  key: wrap(KeyRound),
  sun: wrap(Sun),
  moon: wrap(Moon),
  monitor: wrap(Monitor),
  login: wrap(LogIn),
  log: wrap(ScrollText),
  grip: wrap(GripVertical),
  at: wrap(AtSign),
  clip: wrap(Paperclip),
  spinner: wrap(LoaderCircle),
  alert: wrap(CircleAlert),
  warn: wrap(TriangleAlert),
  info: wrap(Info),
  ok: wrap(CircleCheck),
  fail: wrap(CircleX),
  clock: wrap(Clock),
  zap: wrap(Zap),
  shield: wrap(ShieldCheck),
  cpu: wrap(Cpu),
  keyboard: wrap(Keyboard),
  palette: wrap(Palette),
  workflow: wrap(Workflow),
  tasks: wrap(ListChecks),
  more: wrap(Ellipsis),
  globe: wrap(Globe),
  back: wrap(ArrowLeft),
  forward: wrap(ArrowRight),
  reload: wrap(RotateCw),
  popout: wrap(AppWindow),
  lock: wrap(Lock)
}

export type IconName = keyof typeof Icon

export function AgentLogo({ agent, size = 16 }: { agent: AgentId; size?: number }) {
  if (agent === 'claude')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="var(--claude)" aria-label="Claude">
        <path d="M12 2l1.6 6.2L19.8 6l-4.2 4.8L22 12l-6.4 1.2 4.2 4.8-6.2-2.2L12 22l-1.6-6.2L4.2 18l4.2-4.8L2 12l6.4-1.2L4.2 6l6.2 2.2z" />
      </svg>
    )
  // Logo oficial de la app de Codex (nube con >_)
  return <img className="agent-logo" src={codexLogo} width={size} height={size} alt="Codex" draggable={false} />

}
