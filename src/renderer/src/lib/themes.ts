import type { ITheme } from '@xterm/xterm'

export interface Scheme {
  ui: 'dark' | 'light'
  terminal: ITheme
}

const dark: Scheme = {
  ui: 'dark',
  terminal: {
    background: '#1b1d23',
    foreground: '#d4d7dd',
    cursor: '#d4d7dd',
    cursorAccent: '#1b1d23',
    selectionBackground: '#3a4150',
    black: '#1b1d23',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d4d7dd',
    brightBlack: '#5c6370',
    brightRed: '#ef7e87',
    brightGreen: '#a9d48a',
    brightYellow: '#f0cd8c',
    brightBlue: '#74bdf7',
    brightMagenta: '#d58ae8',
    brightCyan: '#68c7d3',
    brightWhite: '#ffffff'
  }
}

const light: Scheme = {
  ui: 'light',
  terminal: {
    background: '#fbfbfa',
    foreground: '#2b2d31',
    cursor: '#2b2d31',
    cursorAccent: '#fbfbfa',
    selectionBackground: '#cfd8e6',
    black: '#2b2d31',
    red: '#c4352b',
    green: '#3f8a2f',
    yellow: '#a6750d',
    blue: '#2f64c4',
    magenta: '#9b3fb5',
    cyan: '#167f8c',
    white: '#d8d8d8',
    brightBlack: '#6d7078',
    brightRed: '#de4a3f',
    brightGreen: '#4ea33c',
    brightYellow: '#c28d1a',
    brightBlue: '#4479da',
    brightMagenta: '#b155cc',
    brightCyan: '#22a0b0',
    brightWhite: '#ffffff'
  }
}

const solarizedDark: Scheme = {
  ui: 'dark',
  terminal: {
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#0d4a5a',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#93a1a1',
    brightYellow: '#839496',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  }
}

const solarizedLight: Scheme = {
  ui: 'light',
  terminal: {
    ...solarizedDark.terminal,
    background: '#fdf6e3',
    foreground: '#586e75',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#e6dfc8',
    black: '#073642',
    white: '#eee8d5'
  }
}

const gruvboxDark: Scheme = {
  ui: 'dark',
  terminal: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2'
  }
}

const nord: Scheme = {
  ui: 'dark',
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4'
  }
}

export const SCHEMES: Record<string, Scheme> = {
  dark,
  light,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  'gruvbox-dark': gruvboxDark,
  nord
}

export function scheme(name: string): Scheme {
  return SCHEMES[name] ?? dark
}
