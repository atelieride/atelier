// Contents atelierd installs in its folder. They live here as text so they end up in the bundle.
import { powerShellQuote } from '@shared/shell-kind';
import { DROPPED, DROPPED_PREFIXES } from './env';

/**
 * Hook bridge: forwards the event to atelierd. Decides nothing for Claude and always exits 0; it prints only what
 * atelierd sends back, which is nothing or a session name for Claude (session name sync: `hookSpecificOutput
 * .sessionTitle` on UserPromptSubmit/SessionStart).
 */
export const HOOK_SCRIPT = `#!/bin/sh
# Atelier: Claude Code hook bridge. Observation only, plus the session name Atelier hands back.
case "$ATELIER_TERMINAL_ID" in ''|*[!0-9a-f-]*) cat >/dev/null; exit 0;; esac
case "$ATELIER_HOOK_TOKEN" in ''|*[!0-9a-f]*) cat >/dev/null; exit 0;; esac
[ -S "$ATELIER_SOCK" ] || { cat >/dev/null; exit 0; }
{ printf '{"t":"hook","token":"%s","term":"%s"}\\n' "$ATELIER_HOOK_TOKEN" "$ATELIER_TERMINAL_ID"; cat; } \\
  | /usr/bin/nc -U -w 1 "$ATELIER_SOCK" 2>/dev/null
exit 0
`;

/** Status line bridge: copies the data to Atelier and returns the user's status line untouched. */
export const STATUSLINE_SCRIPT = `#!/bin/sh
# Atelier: status line bridge. The output is the user's status line, identical.
input=$(cat)
ok=1
case "$ATELIER_TERMINAL_ID" in ''|*[!0-9a-f-]*) ok=0;; esac
case "$ATELIER_HOOK_TOKEN" in ''|*[!0-9a-f]*) ok=0;; esac
if [ "$ok" = 1 ] && [ -S "$ATELIER_SOCK" ]; then
  # In the background and detached from stdout/stderr: Claude must not wait for delivery.
  ( { printf '{"t":"status","token":"%s","term":"%s"}\\n' "$ATELIER_HOOK_TOKEN" "$ATELIER_TERMINAL_ID"; printf '%s' "$input"; } \\
    | /usr/bin/nc -U -w 1 "$ATELIER_SOCK" ) </dev/null >/dev/null 2>&1 &
fi
if [ -s "$ATELIER_HOME/user-statusline.sh" ]; then
  printf '%s' "$input" | /bin/sh "$ATELIER_HOME/user-statusline.sh"
fi
exit 0
`;

// zsh files. ATELIER_USER_ZDOTDIR exists only if the user had a ZDOTDIR: otherwise ZDOTDIR must be unset
// before loading their files, so `\${ZDOTDIR:-...}` in their .zshenv works as in a normal shell.
const USER_DIR = `if [[ -n "\${ATELIER_USER_ZDOTDIR+x}" ]]; then ZDOTDIR="$ATELIER_USER_ZDOTDIR"; else unset ZDOTDIR; fi`;
const REMEMBER = `if [[ -n "\${ZDOTDIR+x}" ]]; then ATELIER_USER_ZDOTDIR="$ZDOTDIR"; else unset ATELIER_USER_ZDOTDIR; fi`;

// Each file loads the user's counterpart with their ZDOTDIR, remembers any changes, then switches back to Atelier.
const load = (file: string) => `ATELIER_ZDOTDIR="$ZDOTDIR"
${USER_DIR}
[[ -r "\${ZDOTDIR:-$HOME}/${file}" ]] && source "\${ZDOTDIR:-$HOME}/${file}"
${REMEMBER}
ZDOTDIR="$ATELIER_ZDOTDIR"
`;

// Gives ZDOTDIR back to the user as it was (or unset, if they had none).
const RESTORE = `${USER_DIR}
`;

// macOS's /etc/zshrc sets HISTFILE=\${ZDOTDIR:-$HOME}/.zsh_history while ZDOTDIR is still Atelier's:
// without a fix the history would end up in an Atelier file instead of the user's.
const FIX_HISTFILE = `if [[ "$HISTFILE" == "$ZDOTDIR/.zsh_history" ]]; then HISTFILE="\${ATELIER_USER_ZDOTDIR:-$HOME}/.zsh_history"; fi
`;

// Shared by both zsh profiles: the terminal's initial command and the claude function.
const ATELIER_ZSH = `# Atelier: the terminal's initial command (New session, Resume), run once right before the first
# prompt, when all of the user's configuration is loaded. Typing it earlier would expose it to any questions
# asked during startup (e.g. the oh-my-zsh update), which would swallow its first letters.
if [[ -n "$ATELIER_INIT_CMD" ]]; then
  ATELIER_INIT_PENDING="$ATELIER_INIT_CMD"
  unset ATELIER_INIT_CMD
  function _atelier_init {
    add-zsh-hook -d precmd _atelier_init
    local c="$ATELIER_INIT_PENDING"
    unset ATELIER_INIT_PENDING
    print -s -- "$c"
    print -r -- "$c"
    eval "$c"
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd _atelier_init
fi

# Atelier: ⌘←/⌘→ arrive as Home/End (ESC[H/ESC[F, or ESC O H/F in application cursor mode). A plain zsh config has no
# binding for them (in vi mode the ESC would even switch to command mode): bound to the line's ends in the emacs and
# vi insert keymaps, only where the user's config left them unbound. One fork per keymap, at startup only.
() {
  local m k bound
  local -A ends=( '^[[H' beginning-of-line '^[[F' end-of-line '^[OH' beginning-of-line '^[OF' end-of-line )
  for m in emacs viins; do
    bound=$'\\n'"$(bindkey -M $m)"$'\\n'
    for k in \${(k)ends}; do
      [[ "$bound" == *$'\\n'"\\"$k\\" "* ]] || bindkey -M $m -- "$k" "\${ends[$k]}"
    done
  done
}

# Atelier: \`claude\` launched from here brings Atelier's hooks along, without touching ~/.claude.
# A user's claude alias or function stays: Atelier's function goes through them.
if (( \${+aliases[claude]} )); then ATELIER_CLAUDE_ALIAS="\${aliases[claude]}"; unalias claude; fi
if (( \${+functions[claude]} )); then functions -c claude _atelier_user_claude; unfunction claude; fi
function claude {
  local -a base words pre
  if [[ -n "$ATELIER_CLAUDE_BIN" ]]; then base=("$ATELIER_CLAUDE_BIN")
  elif [[ -n "$ATELIER_E2E" ]]; then
    # e2e tests only ever run the fake claude: never the user's real Claude Code, whatever PATH says.
    print -ru2 -- REAL-CLAUDE-BLOCKED
    return 97
  elif (( \${+functions[_atelier_user_claude]} )); then base=(_atelier_user_claude)
  elif [[ -n "$ATELIER_CLAUDE_ALIAS" ]]; then words=(\${(z)ATELIER_CLAUDE_ALIAS})
  # Atelier profile: the user's alias (or claude on PATH) as captured from their shell, which isn't loaded here.
  elif [[ -n "$ATELIER_USER_CLAUDE" ]]; then words=(\${(z)ATELIER_USER_CLAUDE})
  else base=(command claude)
  fi
  # Variables an alias sets in front (another Claude account's CLAUDE_CONFIG_DIR) hold for this claude only, ~
  # expanded, as the alias would set them. (z) only splits the alias's text into words: nothing runs here.
  while (( $#words )) && [[ \${words[1]} =~ '^[A-Za-z_][A-Za-z0-9_]*=' ]]; do pre+=("\${words[1]}"); shift words; done
  if (( $#words )); then eval "base=(\${words[*]})"; elif (( $#pre )); then base=(command claude); fi
  if (( $#pre )); then eval "local -x \${pre[*]}"; fi
  # An alias such as claude='claude --flag' would call this function again.
  [[ "\${base[1]}" == claude ]] && base=(command "\${base[@]}")
  if [[ -z "$ATELIER_SOCK" || ! -r "$ATELIER_CLAUDE_SETTINGS" ]]; then "\${base[@]}" "$@"; return; fi
  # Subcommands start no session the hooks could follow, and Claude Code refuses --settings before remote-control.
  case "$1" in
    agents|attach|auth|auto-mode|config|doctor|gateway|import|install|logs|mcp|migrate-installer|plugin|plugins|\\
    purge|rc|remote-control|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade)
      "\${base[@]}" "$@"; return;;
  esac
  local a
  for a in "$@"; do
    case "$a" in -p|--print|--print=*) "\${base[@]}" "$@"; return;; esac
  done
  "\${base[@]}" --settings "$ATELIER_CLAUDE_SETTINGS" "$@"
}
`;

/** Claude subcommands that start no session (no --settings), as the zsh function lists them. */
export const ATELIER_ZSH_SUBCOMMANDS: readonly string[] = /case "\$1" in\n\s*([^)]+)\)/.exec(ATELIER_ZSH)![1]!.replace(/\\\n\s*/g, '').split('|');

/** The same list for PowerShell (a test keeps the two equal). */
export const POWERSHELL_SUBCOMMANDS: readonly string[] = [
  'agents', 'attach', 'auth', 'auto-mode', 'config', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp',
  'migrate-installer', 'plugin', 'plugins', 'purge', 'rc', 'remote-control', 'respawn', 'rm', 'setup-token', 'stop',
  'kill', 'ultrareview', 'update', 'upgrade'
];

/**
 * Windows: Atelier's PowerShell integration, dot-sourced after the user's own profile in every
 * Atelier terminal (the built-in profiles). It keeps the user's prompt and adds: OSC 7 with the folder (Windows has no
 * API for another process's cwd); in the Atelier profile only, OSC 133 command marks with the terminal's nonce (read
 * once, then dropped from the environment); the terminal's initial command, run once before the first prompt; and
 * `claude` with Atelier's hooks (`--settings`), skipping subcommands and -p, as the zsh function does. No backtick
 * escapes: Windows PowerShell 5.1 has no `e, the control characters come from [char] codes.
 */
export const ATELIER_PS1 = `# Atelier: PowerShell integration. Loaded after your profile; your prompt and settings stay yours.
# Loaded: a script the initial command runs, blocked by a policy, shows its own error, not "blocks Atelier's integration".
$global:__atelierLoaded = $true
$global:__atelierEsc = [string][char]27
$global:__atelierBel = [string][char]7
$global:__atelierMark = $null
if ($env:ATELIER_MARK_NONCE -match '^[0-9a-f]+$') { $global:__atelierMark = ';atelier=' + $env:ATELIER_MARK_NONCE }
Remove-Item Env:ATELIER_MARK_NONCE -ErrorAction SilentlyContinue
# Your profile has no command marks: its prompt only tells atelierd it is back (a Claude killed there is gone).
$global:__atelierPromptSignal = $null
if ($null -eq $global:__atelierMark -and $env:ATELIER_PROMPT_NONCE -match '^[0-9a-f]+$') { $global:__atelierPromptSignal = ';atelier=' + $env:ATELIER_PROMPT_NONCE }
Remove-Item Env:ATELIER_PROMPT_NONCE -ErrorAction SilentlyContinue

# Windows' environment as a new sign-in gets it: what was installed after atelierd started (Git, Node, Python) is in the
# registry, not in the environment atelierd hands on. Variables you don't have yet are added and PATH gets the folders
# it lacks; nothing already set changes.
function global:__atelierRegistryEnv {
  $vars = @{}
  $paths = @()
  $keys = @([Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'))
  foreach ($k in $keys) {
    if ($null -eq $k) { continue }
    try {
      foreach ($n in $k.GetValueNames()) {
        $v = [string]$k.GetValue($n, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($n -eq 'Path') { $paths += $v } else { $vars[$n] = $v }
      }
    } finally { $k.Close() }
  }
  $vars['Path'] = $paths -join ';'
  $vars
}

# Never added: what atelierd keeps out of terminals, and the Claude account Atelier chose for this terminal.
$global:__atelierNeverAdd = @(${[...DROPPED, 'CLAUDE_CONFIG_DIR'].map((n) => `'${n}'`).join(', ')})
$global:__atelierNeverAddPrefixes = @(${[...DROPPED_PREFIXES, 'ATELIER_'].map((n) => `'${n}'`).join(', ')})

function global:__atelierFreshen([hashtable] $reg, [string] $startPath) {
  $added = @(foreach ($n in @($reg.Keys)) {
    if (-not $n -or $n -eq 'Path' -or -not $reg[$n] -or $global:__atelierNeverAdd -contains $n) { continue }
    $kept = $false
    foreach ($p in $global:__atelierNeverAddPrefixes) { if ($n.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) { $kept = $true; break } }
    if ($kept -or $null -ne [Environment]::GetEnvironmentVariable($n)) { continue }
    # A name Windows refuses skips only itself.
    try { [Environment]::SetEnvironmentVariable($n, $reg[$n]); $n } catch { }
  })
  # Expanded once all are in: a new variable may name another new one (%JAVA_HOME%\\bin).
  foreach ($n in $added) { [Environment]::SetEnvironmentVariable($n, [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable($n))) }
  # Folders PATH had when the terminal started count as there: your profile may have taken some off on purpose.
  $have = @{}
  foreach ($d in (($env:Path + ';' + $startPath) -split ';')) { if ($d) { $have[$d.TrimEnd('\\')] = $true } }
  $more = @(foreach ($d in ([string]$reg['Path'] -split ';')) {
    $x = [Environment]::ExpandEnvironmentVariables($d)
    if ($x -and -not $have.ContainsKey($x.TrimEnd('\\'))) { $have[$x.TrimEnd('\\')] = $true; $x }
  })
  if ($more.Count) { $env:Path = (@($env:Path -split ';' | Where-Object { $_ }) + $more) -join ';' }
}

try { __atelierFreshen (__atelierRegistryEnv) ([string]$env:ATELIER_START_PATH) } catch { }
Remove-Item Env:ATELIER_START_PATH -ErrorAction SilentlyContinue
# Claude's settings call atelier-bridge by name when its path needs quoting: Git Bash and PowerShell find it here. atelierd
# put it first; back in front if your profile rebuilt PATH without it.
if ($env:ATELIER_HOME) {
  $__atelierBin = Join-Path $env:ATELIER_HOME 'bin'
  if (-not (($env:Path -split ';') -contains $__atelierBin)) { $env:Path = $__atelierBin + ';' + [string]$env:Path }
  Remove-Variable __atelierBin
}
$global:__atelierRunning = $false
$global:__atelierHooked = $false
$global:__atelierUserPrompt = $function:prompt

function global:__atelierOsc([string] $body) { $global:__atelierEsc + ']' + $body + $global:__atelierBel }

# The command start mark (C) when a line is accepted: PSReadLine's read is wrapped once it is loaded.
function global:__atelierHookReadLine {
  $global:__atelierHooked = $true
  if (-not (Test-Path Function:PSConsoleHostReadLine)) { return }
  $global:__atelierReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = & $global:__atelierReadLine
    if ($line -and $line.Trim()) {
      $global:__atelierRunning = $true
      if ($null -ne $global:__atelierMark) { [Console]::Write((__atelierOsc ('133;C' + $global:__atelierMark))) }
    }
    $line
  }
}

function global:prompt {
  $ok = $global:?
  $code = $global:LASTEXITCODE
  if (-not $global:__atelierHooked) { __atelierHookReadLine }
  $out = ''
  if ($null -ne $global:__atelierMark -and $global:__atelierRunning) {
    $status = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }
    $out += __atelierOsc ('133;D;' + $status + $global:__atelierMark)
  }
  $global:__atelierRunning = $false
  $loc = $ExecutionContext.SessionState.Path.CurrentLocation
  if ($loc.Provider.Name -eq 'FileSystem') { $out += __atelierOsc ('7;' + ([uri]$loc.ProviderPath).AbsoluteUri) }
  if ($null -ne $global:__atelierMark) { $out += __atelierOsc ('133;A' + $global:__atelierMark) }
  if ($null -ne $global:__atelierPromptSignal) { $out += __atelierOsc ('133;P' + $global:__atelierPromptSignal) }
  # The user's prompt (oh-my-posh, starship) reads $? to show a failure: set it back to the command's.
  $p = if ($global:__atelierUserPrompt) {
    if (-not $ok) { Write-Error 'failed' -ErrorAction Ignore }
    & $global:__atelierUserPrompt
  } else { 'PS ' + $loc + '> ' }
  $global:LASTEXITCODE = $code
  $out += [string]($p -join '')
  if ($null -ne $global:__atelierMark) { $out += __atelierOsc ('133;B' + $global:__atelierMark) }
  $out
}

# claude launched from here brings Atelier's hooks along, without touching ~/.claude. A claude function or alias of
# yours stays: Atelier's function goes through it.
$global:__atelierSubcommands = @(${POWERSHELL_SUBCOMMANDS.map((c) => `'${c}'`).join(', ')})
$global:__atelierUserClaude = $null
$global:__atelierClaudeAlias = $null
if (Test-Path Function:claude) { $global:__atelierUserClaude = $function:claude; Remove-Item Function:claude }
$__atelierAlias = Get-Alias claude -ErrorAction SilentlyContinue
if ($__atelierAlias) { $global:__atelierClaudeAlias = $__atelierAlias.Definition; Remove-Item Alias:claude -Force }
Remove-Variable __atelierAlias

function global:claude {
  if ($env:ATELIER_CLAUDE_BIN) { $base = $env:ATELIER_CLAUDE_BIN }
  elseif ($env:ATELIER_E2E) {
    # e2e tests only ever run the fake claude: never the user's real Claude Code, whatever PATH says.
    [Console]::Error.WriteLine('REAL-CLAUDE-BLOCKED')
    $global:LASTEXITCODE = 97
    return
  }
  elseif ($global:__atelierUserClaude) { $base = $global:__atelierUserClaude }
  elseif ($global:__atelierClaudeAlias -and $global:__atelierClaudeAlias -ne 'claude') { $base = $global:__atelierClaudeAlias }
  else {
    # Claude's native installer puts claude.exe in ~/.local/bin without adding it to PATH.
    $app = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $local = [IO.Path]::Combine($env:USERPROFILE, '.local', 'bin', 'claude.exe')
    $base = if ($app) { $app.Source } elseif (Test-Path -LiteralPath $local) { $local } else { 'claude.exe' }
  }
  if (-not $env:ATELIER_SOCK -or -not $env:ATELIER_CLAUDE_SETTINGS -or -not (Test-Path -LiteralPath $env:ATELIER_CLAUDE_SETTINGS)) { & $base @args; return }
  # Subcommands start no session the hooks could follow, and Claude Code refuses --settings before remote-control.
  if ($args.Count -gt 0 -and $global:__atelierSubcommands -contains [string]$args[0]) { & $base @args; return }
  foreach ($x in $args) { if ($x -eq '-p' -or $x -eq '--print' -or ([string]$x).StartsWith('--print=')) { & $base @args; return } }
  & $base --settings $env:ATELIER_CLAUDE_SETTINGS @args
}

# The terminal's initial command (New session, Resume): run once, before the first prompt, with your profile loaded.
if ($env:ATELIER_INIT_CMD) {
  $__atelierInit = $env:ATELIER_INIT_CMD
  Remove-Item Env:ATELIER_INIT_CMD -ErrorAction SilentlyContinue
  try { [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($__atelierInit) } catch { }
  Write-Host $__atelierInit
  Invoke-Expression $__atelierInit
}
`;

// A Group Policy execution policy (AllSigned, scripts off) beats -ExecutionPolicy Bypass: the terminal says why it has
// no states, and its command (New Session, Resume) still runs. Single quotes only: PowerShell 5.1 mangles double quotes
// on its command line.
const POLICY_BLOCKED = 'if ($global:__atelierLoaded) { throw }; '
  + "Write-Warning 'Atelier: a Group Policy on this PC blocks PowerShell scripts, Atelier''s integration included. "
  + "This terminal works, but Claude sessions started here show no state.'; "
  + 'Remove-Item Env:ATELIER_MARK_NONCE, Env:ATELIER_PROMPT_NONCE, Env:ATELIER_START_PATH -ErrorAction SilentlyContinue; '
  + 'if ($env:ATELIER_INIT_CMD) { $c = $env:ATELIER_INIT_CMD; Remove-Item Env:ATELIER_INIT_CMD; Write-Host $c; Invoke-Expression $c }';

/** PowerShell's arguments for an Atelier terminal: the integration dot-sourced, the policy bypassed for this process only. */
export function powerShellArgs(script: string): string[] {
  // Every quote PowerShell ends a string on is doubled (‘ ’ ‚ ‛ too: a profile named D’Angelo).
  const load = `. ${powerShellQuote(script)}`;
  return ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `try { ${load} } catch [System.Management.Automation.PSSecurityException] { ${POLICY_BLOCKED} }`];
}

/**
 * Windows: Atelier's Git Bash integration, the file Git Bash terminals start with (`bash --rcfile <it> -i`). A login
 * bash ignores --rcfile, so it first reads what `bash -l` would; then, as "PowerShell (your profile)": Atelier's bin
 * first on PATH (the bridge by name), OSC 7 with the folder and the prompt signal atelierd reads (OSC 133;P with the
 * terminal's nonce) at every prompt. Nothing else changes: the user's prompt, PATH, aliases and history stay theirs.
 * bash 3.2-compatible (macOS runs the same file in tests), safe under the user's `set -u`.
 */
export const ATELIER_BASH = `# Atelier: Git Bash integration. Atelier starts Git Bash as \`bash --rcfile <this file> -i\`: a login bash would ignore
# --rcfile, so this file reads what \`bash -l\` reads. Your prompt, PATH and aliases stay yours.

# The prompt signal's nonce (hex only): read first and dropped at once, so nothing started here sees it, not even what
# your login files start.
__atelier_signal=
case "\${ATELIER_PROMPT_NONCE:-}" in
  ''|*[!0-9a-f]*) ;;
  *) __atelier_signal=";atelier=\${ATELIER_PROMPT_NONCE}" ;;
esac
unset ATELIER_PROMPT_NONCE

if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile
fi

if command -v cygpath >/dev/null 2>&1; then __atelier_cygpath=1; else __atelier_cygpath=; fi

# Claude's settings may call atelier-bridge by name (a home that needs quoting): Atelier's bin first, back in front if
# your files moved it, and only once.
if [ -n "\${ATELIER_HOME:-}" ]; then
  if [ -n "$__atelier_cygpath" ]; then __atelier_bin="$(cygpath -u "$ATELIER_HOME")/bin"; else __atelier_bin="$ATELIER_HOME/bin"; fi
  __atelier_path=":\${PATH:-}:"
  while [ "\${__atelier_path#*":$__atelier_bin:"}" != "$__atelier_path" ]; do
    __atelier_path="\${__atelier_path//":$__atelier_bin:"/:}"
  done
  __atelier_path="\${__atelier_path#:}"
  __atelier_path="\${__atelier_path%:}"
  PATH="$__atelier_bin\${__atelier_path:+:$__atelier_path}"
  export PATH
  unset __atelier_bin __atelier_path
fi

# Your aliases as bash holds them: from BASH_ALIASES (bash 4 and later, every Git Bash: nothing to parse, no extra
# process), else from \`alias -p\`, where a value counts only as one whole single-quoted string, unquoted here and never
# evaluated. No alias text runs at startup.
__atelier_unquote() {
  local q="'" b='\\'
  local re="^$q([^$q]|$q[$b]$q$q)*$q"
  re+='$'
  [[ $1 =~ $re ]] || return 1
  __atelier_value=\${1:1:\${#1}-2}
  __atelier_value=\${__atelier_value//"$q$b$q$q"/$q}
}
__atelier_alias_value() {
  if [ "\${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
    [ -n "\${BASH_ALIASES[$1]+set}" ] || return 1
    __atelier_value=\${BASH_ALIASES[$1]}
  else
    local def
    def=$(alias -- "$1" 2>/dev/null) || return 1
    __atelier_unquote "\${def#*=}"
  fi
}
# Calls "$1 <name> <value>" for each alias.
__atelier_each_alias() {
  local name line
  if [ "\${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
    for name in "\${!BASH_ALIASES[@]}"; do "$1" "$name" "\${BASH_ALIASES[$name]}"; done
  else
    while IFS= read -r line; do
      case "$line" in "alias "*=\\'*) ;; *) continue ;; esac
      name=\${line#alias }
      name=\${name#-- }
      name=\${name%%=*}
      if __atelier_unquote "\${line#*=}"; then "$1" "$name" "$__atelier_value"; fi
    done <<< "$(alias -p)"
  fi
}
# A command's text split into the variable assignments in front (__atelier_pre, spaces kept) and the rest.
__atelier_split() {
  local assign="^[A-Za-z_][A-Za-z0-9_]*=('[^']*'|\\"[^\\"]*\\"|[^[:space:]'\\"])*[[:space:]]+"
  __atelier_pre=
  __atelier_rest=$1
  if [[ $__atelier_rest =~ ^[[:space:]]+ ]]; then __atelier_pre=\${BASH_REMATCH[0]}; __atelier_rest=\${__atelier_rest:\${#__atelier_pre}}; fi
  while [[ $__atelier_rest =~ $assign ]]; do __atelier_pre+=\${BASH_REMATCH[0]}; __atelier_rest=\${__atelier_rest:\${#BASH_REMATCH[0]}}; done
}

# \`claude\` launched from here brings Atelier's hooks along, without touching ~/.claude. A claude alias or function of
# yours stays: Atelier's function goes through it. Variables your alias sets in front (another Claude account's
# CLAUDE_CONFIG_DIR) are set again for each claude.
__atelier_claude_alias=
__atelier_claude_pre=
if __atelier_alias_value claude; then
  __atelier_split "$__atelier_value"
  __atelier_claude_pre=$__atelier_pre
  __atelier_claude_alias=$__atelier_rest
  unalias claude
fi
if declare -F claude >/dev/null 2>&1; then
  __atelier_def=$(declare -f claude)
  eval "_atelier_user_claude\${__atelier_def#claude}"
  unset -f claude
fi
unset __atelier_def

# The rules, with the first $1 words as the way to run Claude: subcommands and -p start no session the hooks could
# follow (and Claude Code refuses --settings before remote-control); outside an Atelier terminal nothing is added.
__atelier_claude_run() {
  local n=$1 a
  shift
  local -a base
  base=("\${@:1:$n}")
  shift "$n"
  if [ -z "\${ATELIER_SOCK:-}" ] || [ ! -r "\${ATELIER_CLAUDE_SETTINGS:-}" ]; then "\${base[@]}" "$@"; return; fi
  case "\${1:-}" in
    ${POWERSHELL_SUBCOMMANDS.join('|')}) "\${base[@]}" "$@"; return ;;
  esac
  for a in "$@"; do
    case "$a" in -p|--print|--print=*) "\${base[@]}" "$@"; return ;; esac
  done
  "\${base[@]}" --settings "$ATELIER_CLAUDE_SETTINGS" "$@"
}

claude() {
  local -a base
  local pre=
  if [ -n "\${ATELIER_CLAUDE_BIN:-}" ]; then base=("$ATELIER_CLAUDE_BIN")
  elif [ -n "\${ATELIER_E2E:-}" ]; then
    # e2e tests only ever run the fake claude: never the user's real Claude Code, whatever PATH says.
    printf '%s\\n' REAL-CLAUDE-BLOCKED >&2
    return 97
  elif declare -F _atelier_user_claude >/dev/null 2>&1; then base=(_atelier_user_claude)
  elif [ -n "$__atelier_claude_alias" ]; then eval "base=($__atelier_claude_alias)"; pre=$__atelier_claude_pre
  elif type -P claude >/dev/null 2>&1; then base=(command claude)
  # Claude's native installer puts claude.exe there without always adding the folder to PATH.
  elif [ -n "$__atelier_cygpath" ] && [ -n "\${USERPROFILE:-}" ] && [ -f "$(cygpath -u "$USERPROFILE")/.local/bin/claude.exe" ]; then
    base=("$(cygpath -u "$USERPROFILE")/.local/bin/claude.exe")
  else base=(command claude)
  fi
  # An alias such as claude='claude --flag' would call this function again.
  if [ "\${base[0]}" = claude ]; then base=(command "\${base[@]}"); fi
  # As the alias would: exported to this claude only, ~ expanded.
  if [ -n "$pre" ]; then eval "local -x $pre"; fi
  __atelier_claude_run "\${#base[@]}" "\${base[@]}" "$@"
}

# Your aliases that run Claude's binary directly (cc='~/.local/bin/claude.exe'), as they are when the terminal starts,
# go through the same rules with that same binary; variables they set in front stay.
__atelier_claude_with() {
  if [ -n "\${ATELIER_CLAUDE_BIN:-}" ]; then set -- "$ATELIER_CLAUDE_BIN" "\${@:2}"
  elif [ -n "\${ATELIER_E2E:-}" ]; then
    printf '%s\\n' REAL-CLAUDE-BLOCKED >&2
    return 97
  fi
  __atelier_claude_run 1 "$@"
}
__atelier_reroute() {
  local first="^('[^']*'|\\"[^\\"]*\\"|[^[:space:]'\\";|&<>()]+)" word bare
  __atelier_split "$2"
  [[ $__atelier_rest =~ $first ]] || return 0
  word=\${BASH_REMATCH[1]}
  # Plain claude already reaches Atelier's function.
  [ "$word" = claude ] && return 0
  bare=$word
  case "$bare" in \\'*\\'|\\"*\\") bare=\${bare:1:\${#bare}-2} ;; esac
  case "\${bare##*/}" in
    [Cc][Ll][Aa][Uu][Dd][Ee]|[Cc][Ll][Aa][Uu][Dd][Ee].[Ee][Xx][Ee]) ;;
    *) return 0 ;;
  esac
  alias -- "$1=\${__atelier_pre}__atelier_claude_with $__atelier_rest"
}
__atelier_each_alias __atelier_reroute
unset -f __atelier_reroute __atelier_each_alias __atelier_alias_value __atelier_unquote __atelier_split
unset __atelier_value __atelier_pre __atelier_rest

# A folder as the path of a file: URI, percent-encoded byte by byte (run in a subshell: LC_ALL=C stays there).
__atelier_encode() {
  local s=$1 out= c n i
  for (( i = 0; i < \${#s}; i++ )); do
    c=\${s:i:1}
    case "$c" in
      [A-Za-z0-9/._~:-]) out+=$c ;;
      *) printf -v n '%d' "'$c"; if (( n < 0 )); then n=$(( n + 256 )); fi; printf -v c '%%%02X' "$n"; out+=$c ;;
    esac
  done
  printf '%s' "$out"
}

# At every prompt, before your own prompt commands (which still see the last command's status): the folder for Atelier
# (OSC 7, worked out again only when it changed) and the prompt signal atelierd reads (a Claude killed here is gone).
__atelier_pwd=
__atelier_url=
__atelier_prompt() {
  local s=$? p
  if [ "$PWD" != "$__atelier_pwd" ]; then
    __atelier_pwd=$PWD
    p=$PWD
    if [ -n "$__atelier_cygpath" ]; then p=$(cygpath -m "$PWD" 2>/dev/null) || p=$PWD; fi
    case "$p" in /*) ;; *) p="/$p" ;; esac
    # A plain assignment: as a prefix of a function call LC_ALL wouldn't switch bash's own locale.
    __atelier_url="file://$(LC_ALL=C; __atelier_encode "$p")"
    # Under your \`set -a\` every assignment is exported: these stay in this shell.
    export -n __atelier_pwd __atelier_url
  fi
  printf '\\033]7;%s\\007' "$__atelier_url"
  if [ -n "$__atelier_signal" ]; then printf '\\033]133;P%s\\007' "$__atelier_signal"; fi
  return $s
}
# First, so bash-preexec's own last command stays last: an array PROMPT_COMMAND (bash 5.1+) gets it in its first
# element, its other elements untouched. Your prompt commands see the last command's $?; PIPESTATUS and $_ are this
# function's by then.
if [ -n "\${PROMPT_COMMAND:-}" ]; then
  PROMPT_COMMAND="__atelier_prompt"$'\\n'"$PROMPT_COMMAND"
else
  PROMPT_COMMAND=__atelier_prompt
fi
# Not handed to programs started here: a shell started from this one (or an editor's terminals) would run a prompt
# function it doesn't have. Each new shell's own files set its PROMPT_COMMAND.
export -n PROMPT_COMMAND
export -n __atelier_signal __atelier_cygpath __atelier_claude_alias __atelier_claude_pre __atelier_pwd __atelier_url
`;

/** The same list as the Git Bash function has it (a test keeps the three equal). */
export const ATELIER_BASH_SUBCOMMANDS: readonly string[] = /case "\$\{1:-\}" in\n\s*([^)]+)\)/.exec(ATELIER_BASH)![1]!.split('|');

/** Git Bash's arguments for an Atelier terminal: the integration as its rcfile (forward slashes), interactive. */
export function gitBashArgs(rcfile: string): string[] {
  return ['--rcfile', rcfile.replace(/\\/g, '/'), '-i'];
}

export const ZSH_FILES: Record<string, string> = {
  '.zshenv': `# Atelier\n${load('.zshenv')}`,
  '.zprofile': `# Atelier\n${load('.zprofile')}`,
  '.zshrc': `# Atelier\n${FIX_HISTFILE}${load('.zshrc')}source "$ATELIER_ZDOTDIR/atelier.zsh"
# Non-login shell: .zlogin won't be read, so ZDOTDIR goes back to the user right away.
[[ -o login ]] || { ${USER_DIR}; }
`,
  '.zlogin': `# Atelier\n${load('.zlogin')}${RESTORE}`,
  'atelier.zsh': ATELIER_ZSH
};

// Atelier profile: zsh with Atelier's own clean config. The user's startup files are never read here: their
// environment (PATH, nvm, pyenv…) arrives already captured by atelierd (shell-env.ts).
// Colors follow Aurora as in Settings › Terminal's preview: path --text-4, branch violet, error rose.
const DIM = '#646285';
const VIOLET = '#C4B5FD';
const ROSE = '#FB7185';

const ATELIER_RC = `# Atelier profile
# History: one private file for every Atelier terminal, shared as you type, without duplicates.
HISTFILE="$ATELIER_HOME/shell/history"
HISTSIZE=50000
SAVEHIST=50000
setopt share_history hist_ignore_all_dups hist_ignore_space hist_reduce_blanks hist_verify
setopt interactive_comments no_beep auto_cd auto_pushd pushd_ignore_dups pushd_silent complete_in_word always_to_end
setopt no_prompt_subst

# Emacs keys whatever $EDITOR says. ⌥←/⌥→ move by word (xterm.js sends ESC[1;3D/C), ⌘←/⌘→ go to the line's ends
# (Home/End in their various encodings, or ESC[1;9D/C); a path's slashes separate words.
bindkey -e
bindkey '^[[1;3D' backward-word
bindkey '^[[1;3C' forward-word
bindkey '^[[1;9D' beginning-of-line
bindkey '^[[1;9C' end-of-line
bindkey '^[[H' beginning-of-line
bindkey '^[[F' end-of-line
bindkey '^[OH' beginning-of-line
bindkey '^[OF' end-of-line
bindkey '^[[1~' beginning-of-line
bindkey '^[[4~' end-of-line
bindkey '^[[3~' delete-char
WORDCHARS=\${WORDCHARS//\\/}

# ls colors close to Aurora's ANSI palette: BSD ls (-G) or GNU ls from coreutils.
export LSCOLORS='Exgxfxdxcxegedabagacad'
export LS_COLORS='di=1;34:ln=36:so=35:pi=33:ex=32:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;43'
if [[ "\${commands[ls]}" == /bin/ls ]]; then alias ls='ls -G'; else alias ls='ls --color=auto'; fi

export GPG_TTY="$TTY"

# Completion: case-insensitive, menu, cached. The dump is used without checks (fast); once a day it is rebuilt in
# the background so newly installed completions show up.
typeset -U fpath
fpath=(/opt/homebrew/share/zsh/site-functions(N/) /usr/local/share/zsh/site-functions(N/) $fpath)
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
zstyle ':completion:*' menu select
zstyle ':completion:*' list-colors \${(s.:.)LS_COLORS}
autoload -Uz compinit
() {
  local dump="$ATELIER_HOME/shell/zcompdump"
  if [[ -f "$dump" ]]; then
    compinit -C -d "$dump"
    local -a stale=( "$dump"(N.mh+24) )
    if (( \${#stale} )); then
      { compinit -i -d "$dump.$$" && zmodload -F zsh/files b:zf_mv && zf_mv -f "$dump.$$" "$dump" } >/dev/null 2>&1 &!
    fi
  else
    compinit -i -d "$dump"
  fi
}

source "$ZDOTDIR/atelier.zsh"

# Prompt like Settings › Terminal: dim path, branch in bold violet inside a git work tree, dim › (rose after a
# failed command). The branch is read from .git/HEAD without running git; git only for unusual layouts.
function _atelier_branch {
  REPLY=''
  local d="$PWD"
  while [[ ! -e "$d/.git" ]]; do
    [[ "$d" == / || -z "$d" ]] && return
    d="\${d:h}"
  done
  local g="$d/.git" head=''
  if [[ -f "$g" ]]; then
    local line=''
    read -r line < "$g"
    g="\${line#gitdir: }"
    [[ "$g" == /* ]] || g="$d/$g"
  fi
  [[ -r "$g/HEAD" ]] && read -r head < "$g/HEAD"
  if [[ "$head" == 'ref: refs/heads/'* && "$head" != 'ref: refs/heads/.invalid' ]]; then REPLY="\${head#ref: refs/heads/}"; return; fi
  if [[ (\${#head} == 40 || \${#head} == 64) && "$head" != *[^0-9a-f]* ]]; then REPLY="\${head[1,7]}"; return; fi
  REPLY="$(builtin cd -q "$d" && { git --no-optional-locks symbolic-ref --short -q HEAD || git --no-optional-locks rev-parse --short HEAD; } 2>/dev/null)"
}
function _atelier_prompt {
  _atelier_branch
  # The branch comes from a file anyone can craft (a cloned repo's HEAD): control characters would reach the
  # terminal as escape sequences, so only printable ones are kept.
  REPLY="\${REPLY//[^[:print:]]/}"
  local p='%F{${DIM}}%~%f'
  [[ -n "$REPLY" ]] && p+=" %B%F{${VIOLET}}\${REPLY//\\%/%%}%f%b"
  PROMPT="$_atelier_mark_a$p %(?.%F{${DIM}}.%F{${ROSE}})›%f $_atelier_mark_b"
}
RPROMPT=''
autoload -Uz add-zsh-hook
add-zsh-hook precmd _atelier_prompt

# Command blocks: OSC 133 shell integration marks (also understood by other terminals). A and B wrap the prompt (a
# redraw repeats them), C when a command starts, D;<exit code> when it ends. Interactive shells only. The terminal's
# initial command runs inside precmd, without preexec: it gets no C/D. The end mark goes first among the precmd
# functions, so $? is still the command's. Every mark ends with the terminal's nonce (;atelier=<hex>) so Atelier tells
# them from marks a program prints; the variable leaves the environment at once, the shell's programs never see it.
# A continuation prompt (for>, quote>…) ends with B too: the text typed after it is part of the command.
_atelier_mark_a='' _atelier_mark_b=''
if [[ -o interactive ]]; then
  typeset -g _atelier_mark_p="\${ATELIER_MARK_NONCE//[^0-9a-f]/}"
  unset ATELIER_MARK_NONCE
  [[ -n "$_atelier_mark_p" ]] && _atelier_mark_p=";atelier=$_atelier_mark_p"
  _atelier_mark_a=$'%{\\e]133;A'"$_atelier_mark_p"$'\\a%}' _atelier_mark_b=$'%{\\e]133;B'"$_atelier_mark_p"$'\\a%}'
  PS2="%_> $_atelier_mark_b"
  typeset -gi _atelier_cmd_running=0
  function _atelier_mark_end {
    local code=$?
    (( _atelier_cmd_running )) && print -n -- "\\e]133;D;$code$_atelier_mark_p\\a"
    _atelier_cmd_running=0
  }
  function _atelier_mark_start {
    _atelier_cmd_running=1
    print -n -- "\\e]133;C$_atelier_mark_p\\a"
  }
  precmd_functions=(_atelier_mark_end \${precmd_functions:#_atelier_mark_end})
  add-zsh-hook preexec _atelier_mark_start
fi

# Non-login shell: .zlogin won't be read, so ZDOTDIR goes back to the user right away (a nested zsh is theirs).
[[ -o login ]] || { ${USER_DIR}; }
`;

export const ATELIER_PROFILE_FILES: Record<string, string> = {
  // /etc/zprofile's path_helper moves the system folders first: the captured order is put back in .zprofile.
  '.zshenv': `# Atelier profile\n_atelier_path="$PATH"\n`,
  '.zprofile': `# Atelier profile
typeset -U path
path=(\${(s.:.)_atelier_path} $path)
unset _atelier_path
`,
  '.zshrc': ATELIER_RC,
  // The user's aliases (captured by atelierd, spec aliases) come last: aliases expand when code is parsed, global ones
  // anywhere on a line, so Atelier's functions and hooks are all parsed before them. Code parsed when it runs ($(…),
  // eval of the initial command) still sees them, as in the user's own shell; claude is never imported, so the
  // initial `claude …` stays Atelier's. One if-block: parsed whole before it runs.
  '.zlogin': `# Atelier profile
${RESTORE}if [[ -n "\${ATELIER_USER_ALIASES+x}" ]]; then
  eval "$ATELIER_USER_ALIASES" 2>/dev/null
  unset ATELIER_USER_ALIASES
fi
`,
  'atelier.zsh': ATELIER_ZSH
};
