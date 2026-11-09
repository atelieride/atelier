import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AppInfo } from '@shared/api';
import type { UpdateStatus } from '@shared/update-feed';
import { ASK_KNOWN_MAX, isDockerEngineSetting, type Settings as S } from '@shared/settings';
import { t } from '../i18n/en';
import { currentPlatform } from '@shared/platform';
import { trayCopy } from '../tray-copy';
import { useApp, type SettingsSection } from '../store';
import { kbd } from '../kbd';
import { Notes } from './Notes';
import { CHANGELOG_URL } from '@shared/whats-new';
import { Icon, type IconName } from './Icon';
import { AccountsSettings } from './AccountsSettings';
import { LaunchFlags } from './LaunchFlags';
import { ClaudeCompatibility } from './ClaudeCompatibility';
import { useAccounts } from '../accounts';
import { askAccountChoices, cleanKnown } from '../companion/known';
import { permissionOverride } from '../launch-flags';
import { Logo } from './Logo';
import { Segmented } from './Segmented';
import { FOCUS_ROOM, previewDocks } from '../settings-dock';
import { Recorder } from '../dictation/recorder';
import { playChime } from '../chime';
import { trimSilence } from '../dictation/audio';
import { profileLabel, profileOptions } from '@shared/profiles';
import { openBelow } from '../menus';
import { reloadShellEnv } from '../launch';
import { TriggersEditor } from './Triggers';
import { canCheck, channelOptions, checkedAgo, storeUpdates, updateSummary, versionChannel } from '../update-view';
import { applyUpdate } from '../update-actions';
import { portsNeedRestart, restartNotice } from '../daemon-notice';
import { isConnectorsBackKey, needsAttention } from '../connectors-view';
import { ConnectorsBack, useConnectorDetail } from './ConnectorsBack';
import { CheckedFiles } from './CheckedFiles';
import { useDocker } from '../docker/store';
import { tildePath } from '../docker/view';
import { useRedis } from '../redis/store';
import { servicesView, shellEnv } from '../features';
import { ConfirmActions, onEscCancel, useDismiss } from '../confirms/InlineConfirm';
import { themeOf } from '@shared/themes';
import { ThemePicker } from './ThemePicker';
import { FontPicker } from './FontPicker';
import { useInstalledFonts } from '../terminal/installed-fonts';
import { fontMissing } from '@shared/terminal-font';

/**
 * macOS: the zsh environment capture, the aliases it brings and Option as Meta. Windows has none of them (GUI apps inherit
 * the registry environment, Alt is Meta already).
 */
const zshEnv = shellEnv();

const SECTIONS: { id: SettingsSection; icon: IconName }[] = [
  { id: 'appearance', icon: 'appearance' }, { id: 'terminal', icon: 'terminal' }, { id: 'editor', icon: 'code' }, { id: 'scm', icon: 'git' }, { id: 'docker', icon: 'whale' }, { id: 'redis', icon: 'redis' }, { id: 'databases', icon: 'databases' },
  { id: 'claude', icon: 'sparkle' }, { id: 'connectors', icon: 'plug' }, { id: 'ask', icon: 'ask' }, { id: 'automations', icon: 'automation' }, { id: 'dictation', icon: 'mic' }, { id: 'notifications', icon: 'bell' }, { id: 'keyboard', icon: 'keyboard' }, { id: 'about', icon: 'info' }
];

// Main validates, saves and sends the settings back to all windows: the view updates from there.
const set = (patch: Partial<S>) => void window.atelier.settings.set(patch);

/** disabled: a row that depends on another setting which is off (dimmed; its control is disabled by the caller). */
/** `danger`: the warning in rose with a struck shield (launch flags that skip permissions), else amber. */
export function Row({ label, hint, warn, danger = false, disabled = false, children }: { label: string; hint?: string; warn?: string | null; danger?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <div className={`set-row${disabled ? ' is-disabled' : ''}`}>
      <div className="set-text">
        <span className="set-label">{label}</span>{hint && <span className="set-hint">{hint}</span>}
        {warn && <span className={`set-warn${danger ? ' is-danger' : ''}`} role="note"><Icon name={danger ? 'shieldOff' : 'info'} size={12} stroke={1.8} />{warn}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export function Toggle({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled} className={`switch ${value ? 'is-on' : ''}`} onClick={() => onChange(!value)}><i /></button>;
}

export function Stepper({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const fix = (v: number) => Math.round(v * 100) / 100;
  const bump = (e: React.MouseEvent<HTMLButtonElement>, dir: 1 | -1) => {
    const next = fix(clamp(value + dir * step));
    // At the limit the button gets disabled and would lose focus: hand it over to the other one.
    if (next >= max && dir === 1) (e.currentTarget.parentElement?.firstElementChild as HTMLElement | null)?.focus();
    if (next <= min && dir === -1) (e.currentTarget.parentElement?.lastElementChild as HTMLElement | null)?.focus();
    onChange(next);
  };
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={(e) => bump(e, -1)}>−</button>
      <span className="mono" aria-live="polite">{format(value)}</span>
      <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={(e) => bump(e, 1)}>+</button>
    </div>
  );
}

const opts = <V extends string>(labels: Record<V, string>) => (Object.keys(labels) as V[]).map((value) => ({ value, label: labels[value] }));

/** Restore Defaults at the foot of the nav: asked in a card in its place. */
function RestoreDefaults() {
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  if (!asking) return <button type="button" className="set-restore" onClick={() => setAsking(true)}>{t.set.restore}</button>;
  return <RestoreCard box={box} onCancel={() => setAsking(false)} onRestore={() => { setAsking(false); void window.atelier.settings.reset(); }} />;
}

function RestoreCard({ box, onCancel, onRestore }: { box: React.RefObject<HTMLDivElement | null>; onCancel: () => void; onRestore: () => void }) {
  useDismiss(box, onCancel);
  return (
    <div ref={box} className="set-restore-confirm" role="group" aria-label={t.confirm.restoreTitle} data-own-esc="" onKeyDown={onEscCancel(onCancel)}>
      <p><b>{t.confirm.restoreTitle}</b> {t.confirm.restoreBody}</p>
      <ConfirmActions confirm={t.confirm.restore} onConfirm={onRestore} onCancel={onCancel} />
    </div>
  );
}

export function Appearance({ s }: { s: S }) {
  const light = themeOf(s.theme).appearance === 'light';
  return (
    <>
      {/* Themes: the cards take the section's width. */}
      <div className="set-block">
        <div className="set-text"><span className="set-label">{t.set.theme}</span><span className="set-hint">{t.set.themeHint}</span></div>
        <ThemePicker value={themeOf(s.theme).id} onChange={(v) => set({ theme: v })} />
      </div>
      {light && (
        <Row label={t.set.terminalColors} hint={t.set.terminalColorsHint} warn={s.terminalColors === 'theme' ? t.set.claudeTheme : null}>
          <Segmented label={t.set.terminalColors} value={s.terminalColors} options={opts(t.set.terminalColorOpts)} onChange={(v) => set({ terminalColors: v })} />
        </Row>
      )}
      <Row label={t.set.interfaceSize} hint={t.set.interfaceSizeHint}><Segmented label={t.set.interfaceSize} value={s.interfaceSize} options={opts(t.set.sizes)} onChange={(v) => set({ interfaceSize: v })} /></Row>
      {/* Session avatars: off, titles get the room. */}
      <Row label={t.set.sessionAvatars} hint={t.set.sessionAvatarsHint}><Toggle label={t.set.sessionAvatars} value={s.sessionAvatars} onChange={(v) => set({ sessionAvatars: v })} /></Row>
      <Row label={t.set.motion} hint={t.set.motionHint}><Segmented label={t.set.motion} value={s.motion} options={opts(t.set.motions)} onChange={(v) => set({ motion: v })} /></Row>
      <Row label={t.set.hiddenFiles} hint={t.set.hiddenFilesHint}><Toggle label={t.set.hiddenFiles} value={s.showHiddenFiles} onChange={(v) => set({ showHiddenFiles: v })} /></Row>
      <Row label={t.set.swapSidePanels} hint={t.set.swapSidePanelsHint}><Toggle label={t.set.swapSidePanels} value={s.swapSidePanels} onChange={(v) => set({ swapSidePanels: v })} /></Row>
      {/* Services (2026-11-02): off until turned on; Windows has no tmux view at all. */}
      {servicesView(true) && <Row label={t.set.showServices} hint={t.set.showServicesHint}><Toggle label={t.set.showServices} value={s.showServices} onChange={(v) => set({ showServices: v })} /></Row>}
      <WorkspacesRows s={s} />
    </>
  );
}

/**
 * Workspaces: on or off for this window's project (each project decides on its own; the welcome
 * window has none), unless they are on in every project (2026-11-02, shown in every window), and what applies to
 * every project that uses them.
 */
function WorkspacesRows({ s }: { s: S }) {
  const project = useApp((x) => (x.popout ? null : x.project));
  const on = useApp((x) => !!x.ws?.on);
  const everywhere = s.workspacesEverywhere;
  return (
    <>
      {project && (
        <>
          <div className="set-group-title">{t.ws.setThisProject}</div>
          <Row label={t.ws.setUse(project.name)} hint={everywhere ? t.ws.setUseEverywhereHint : t.ws.setUseHint} disabled={everywhere}>
            <Toggle label={t.ws.setUse(project.name)} value={on || everywhere} disabled={everywhere} onChange={(v) => useApp.getState().setWorkspacesOn(v)} />
          </Row>
        </>
      )}
      <div className="set-group-title">{t.ws.setEveryProject}</div>
      <Row label={t.ws.setEverywhere} hint={t.ws.setEverywhereHint}>
        <Toggle label={t.ws.setEverywhere} value={everywhere} onChange={(v) => set({ workspacesEverywhere: v })} />
      </Row>
      <Row label={t.ws.setFollows} hint={t.ws.setFollowsHint}>
        <Toggle label={t.ws.setFollows} value={s.wsJumpFollows} onChange={(v) => set({ wsJumpFollows: v })} />
      </Row>
    </>
  );
}

/** A choice among many (more than a segmented control holds): a button that opens the Aurora menu below it. */
function MenuSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <button type="button" className="set-select" aria-label={`${label}: ${current}`} aria-haspopup="menu"
      onClick={(e) => openBelow(e.currentTarget, options.map((o) => ({ id: o.value, label: o.label, icon: o.value === value ? 'check' as const : undefined, run: () => onChange(o.value) })))}>
      <span>{current}</span><Icon name="chevronDown" size={12} stroke={1.9} />
    </button>
  );
}

/** Terminal profiles: the default, or why they aren't there yet (an atelierd older than profiles). */
function Profiles({ s }: { s: S }) {
  const daemon = useApp((x) => x.daemon);
  const shells = useApp((x) => x.shells);
  const noPids = useApp((x) => portsNeedRestart(x.terminals, s.showPorts));
  const notice = daemon.connected ? restartNotice({ profiles: daemon.profilesAvailable, states2: daemon.states2Available, ports: !noPids, background: daemon.backgroundAvailable, aliases: daemon.aliasesAvailable, names: daemon.namesAvailable }) : null;
  const options = profileOptions(shells).map((p) => ({ value: p.key, label: p.label }));
  // A default that is no longer offered is shown by name until something else is chosen (main uses Atelier meanwhile).
  if (!options.some((o) => o.value === s.terminalProfile)) options.push({ value: s.terminalProfile, label: profileLabel(s.terminalProfile, shells) });
  return (
    <>
      {notice && (
        <div className="set-notice" role="note">
          <Icon name="info" size={15} />
          <span>{notice}</span>
          <button type="button" className="btn-ghost" onClick={() => void window.atelier.restartDaemon()}>{t.set.restartNow}</button>
        </div>
      )}
      <Row label={t.set.profile} hint={t.set.profileHint}><MenuSelect label={t.set.profile} value={s.terminalProfile} options={options} onChange={(v) => set({ terminalProfile: v })} /></Row>
      {zshEnv && daemon.profilesAvailable && daemon.shellEnv?.state === 'failed' && (
        <div className="set-notice" role="note">
          <Icon name="info" size={15} />
          <span>{t.set.shellEnvCaptureFailed(daemon.shellEnv.error ?? 'unknown error', daemon.shellEnv.capturedAt !== undefined)}</span>
        </div>
      )}
      {zshEnv && daemon.profilesAvailable && (
        <Row label={t.set.shellEnv} hint={daemon.shellEnv?.state === 'capturing' && daemon.shellEnv.capturedAt === undefined ? t.set.shellEnvReading : s.shellEnvAutoReload ? t.set.shellEnvHintAuto : t.set.shellEnvHint}>
          <button type="button" className="btn-ghost" onClick={() => void reloadShellEnv()}>{t.set.shellEnvReload}</button>
        </Row>
      )}
      {zshEnv && daemon.aliasesAvailable && (
        <Row label={t.set.terminalAliases} hint={t.set.terminalAliasesHint(daemon.shellEnv?.aliases ?? null)}>
          <Toggle label={t.set.terminalAliases} value={s.terminalAliases} onChange={(v) => set({ terminalAliases: v })} />
        </Row>
      )}
      {zshEnv && daemon.profilesAvailable && (
        <>
          <Row label={t.set.shellEnvAuto} hint={t.set.shellEnvAutoHint}>
            <Toggle label={t.set.shellEnvAuto} value={s.shellEnvAutoReload} onChange={(v) => set({ shellEnvAutoReload: v })} />
          </Row>
          <CheckedFiles extra={s.shellEnvWatchFiles} off={!s.shellEnvAutoReload} />
        </>
      )}
    </>
  );
}

/**
 * The preview of Terminal and Editor, docked at the top of the pane while the rows scroll under it, as long as it
 * leaves half of the pane to the controls. Measured live: font
 * size, line height, word wrap and the window's size all change its height or the pane's.
 */
function PreviewDock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  useLayoutEffect(() => {
    const band = ref.current;
    const pane = band?.parentElement;
    if (!band || !pane) return;
    const measure = () => {
      const on = previewDocks(band.offsetHeight, pane.clientHeight);
      setDocked(on);
      // Tab, the arrow keys and scrollIntoView bring a control into view below the band, never under it.
      pane.style.scrollPaddingTop = on ? `${band.offsetHeight + FOCUS_ROOM}px` : '';
    };
    const sizes = new ResizeObserver(measure);
    sizes.observe(band);
    sizes.observe(pane);
    measure();
    return () => { sizes.disconnect(); pane.style.scrollPaddingTop = ''; };
  }, []);
  return <div ref={ref} className={`set-preview-dock ${docked ? 'is-docked' : ''}`}>{children}</div>;
}

/** In the terminal's font (--term-font: the one in use or the one a picker shows), with the glyphs that tell fonts apart. */
function TerminalPreview({ s }: { s: S }) {
  const previewing = useApp((x) => x.fontPreview);
  return (
    <PreviewDock>
      <div className="set-preview term-preview mono" style={{ fontSize: s.terminalFontSize, lineHeight: s.terminalLineHeight }} aria-label={t.set.preview}>
        <span className={`tp-tag ${previewing ? 'is-live' : ''}`}>{t.fontPick.tag(previewing ?? s.terminalFontFamily, s.terminalFontSize)}</span>
        <div><span className="tp-dim">~/atelier</span> <b className="tp-violet">main</b> <span className="tp-dim">›</span> claude</div>
        <div><span className="tp-pink">✻</span> Ready when you are.</div>
        <div><span className="tp-dim">  src/</span>app.ts <span className="tp-sky">+12</span> <span className="tp-pink">−3</span>   <span className="tp-amber">0O 1lI {'{}'} =&gt; !=</span></div>
        <div><span className="tp-dim">›</span> <span className={`tp-cursor is-${s.cursorStyle} ${s.cursorBlink ? 'is-blink' : ''}`} /></div>
      </div>
    </PreviewDock>
  );
}

/** Settings › Terminal › Font: the picker, and a warning when the saved font isn't installed. */
function FontRow({ s }: { s: S }) {
  const { fonts } = useInstalledFonts();
  const missing = fonts !== null && fonts !== 'failed' && fontMissing(s.terminalFontFamily, fonts.all);
  return (
    <Row label={t.set.termFamily} hint={t.set.termFamilyHint} warn={missing ? t.set.termFamilyMissing(s.terminalFontFamily) : null}>
      <FontPicker family={s.terminalFontFamily} missing={missing} />
    </Row>
  );
}

function Terminal({ s }: { s: S }) {
  return (
    <>
      <TerminalPreview s={s} />
      {/* What the preview shows first, right under it; then what runs in the terminals. */}
      <FontRow s={s} />
      <Row label={t.set.termFont}><Stepper label={t.set.termFont} value={s.terminalFontSize} min={10} max={24} step={1} format={(v) => `${v} px`} onChange={(v) => set({ terminalFontSize: v })} /></Row>
      <Row label={t.set.lineHeight}><Stepper label={t.set.lineHeight} value={s.terminalLineHeight} min={1} max={1.6} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => set({ terminalLineHeight: v })} /></Row>
      <Row label={t.set.cursor}><Segmented label={t.set.cursor} value={s.cursorStyle} options={opts(t.set.cursors)} onChange={(v) => set({ cursorStyle: v })} /></Row>
      <Row label={t.set.cursorBlink}><Toggle label={t.set.cursorBlink} value={s.cursorBlink} onChange={(v) => set({ cursorBlink: v })} /></Row>
      <Profiles s={s} />
      {zshEnv && <Row label={t.set.optionMeta} hint={t.set.optionMetaHint}><Toggle label={t.set.optionMeta} value={s.optionAsMeta} onChange={(v) => set({ optionAsMeta: v })} /></Row>}
      <Row label={t.set.commandBlocks} hint={t.set.commandBlocksHint}><Toggle label={t.set.commandBlocks} value={s.commandBlocks} onChange={(v) => set({ commandBlocks: v })} /></Row>
      <Row label={t.set.clickMovesCursor} hint={t.set.clickMovesCursorHint}><Toggle label={t.set.clickMovesCursor} value={s.clickMovesCursor} onChange={(v) => set({ clickMovesCursor: v })} /></Row>
      <Row label={t.set.showPorts} hint={t.set.showPortsHint}><Toggle label={t.set.showPorts} value={s.showPorts} onChange={(v) => set({ showPorts: v })} /></Row>
      <Row label={t.set.showEphemeralPorts} hint={t.set.showEphemeralPortsHint} disabled={!s.showPorts}>
        <Toggle label={t.set.showEphemeralPorts} value={s.showEphemeralPorts} disabled={!s.showPorts} onChange={(v) => set({ showEphemeralPorts: v })} />
      </Row>
      <Row label={t.set.scrollback} hint={t.set.scrollbackHint}>
        <Segmented label={t.set.scrollback} value={String(s.scrollback)} options={[1000, 10000, 50000, 100000].map((n) => ({ value: String(n), label: n >= 1000 ? `${n / 1000}k` : String(n) }))} onChange={(v) => set({ scrollback: Number(v) })} />
      </Row>
      <TriggersEditor rules={s.triggers} />
    </>
  );
}

function Editor({ s }: { s: S }) {
  return (
    <>
      <PreviewDock>
        <div className={`set-preview code-preview mono ${s.wordWrap ? 'is-wrap' : ''}`} style={{ fontSize: s.editorFontSize, lineHeight: `${Math.round(s.editorFontSize * 1.6)}px` }} aria-label={t.set.preview}>
          <div><span className="tp-violet">export function</span> <span className="tp-sky">greet</span>(name: <span className="tp-pink">string</span>) {'{'}</div>
          <div>{'  '}<span className="tp-violet">return</span> <span className="tp-amber">`Hello, ${'{'}name{'}'} — this line is long enough to show how word wrap behaves in the editor.`</span>;</div>
          <div>{'}'}</div>
        </div>
      </PreviewDock>
      <Row label={t.set.editorFont}><Stepper label={t.set.editorFont} value={s.editorFontSize} min={10} max={24} step={1} format={(v) => `${v} px`} onChange={(v) => set({ editorFontSize: v })} /></Row>
      <Row label={t.set.wordWrap} hint={t.set.wordWrapHint(kbd('⌥Z'))}><Toggle label={t.set.wordWrap} value={s.wordWrap} onChange={(v) => set({ wordWrap: v })} /></Row>
      <Row label={t.set.markdownView} hint={t.set.markdownViewHint}><Segmented label={t.set.markdownView} value={s.markdownView} options={opts(t.set.markdownViews)} onChange={(v) => set({ markdownView: v })} /></Row>
      <Row label={t.set.markdownOutline} hint={t.set.markdownOutlineHint}><Toggle label={t.set.markdownOutline} value={s.markdownOutline} onChange={(v) => set({ markdownOutline: v })} /></Row>
      <Row label={t.set.jsonView} hint={t.set.jsonViewHint}><Segmented label={t.set.jsonView} value={s.jsonView} options={opts(t.set.jsonViews)} onChange={(v) => set({ jsonView: v })} /></Row>
      <Row label={t.set.jsonPathFormat} hint={t.set.jsonPathFormatHint}><Segmented label={t.set.jsonPathFormat} value={s.jsonPathFormat} options={opts(t.set.jsonPathFormats)} onChange={(v) => set({ jsonPathFormat: v })} /></Row>
      <Row label={t.set.jsonFollow} hint={t.set.jsonFollowHint}><Toggle label={t.set.jsonFollow} value={s.jsonTreeFollowsCursor} onChange={(v) => set({ jsonTreeFollowsCursor: v })} /></Row>
      <Row label={t.set.csvView} hint={t.set.csvViewHint}><Segmented label={t.set.csvView} value={s.csvView} options={opts(t.set.csvViews)} onChange={(v) => set({ csvView: v })} /></Row>
      <Row label={t.set.csvFollow} hint={t.set.csvFollowHint}><Toggle label={t.set.csvFollow} value={s.csvTableFollowsCursor} onChange={(v) => set({ csvTableFollowsCursor: v })} /></Row>
      <Row label={t.set.csvRainbow} hint={t.set.csvRainbowHint}><Toggle label={t.set.csvRainbow} value={s.csvRainbow} onChange={(v) => set({ csvRainbow: v })} /></Row>
      <Row label={t.set.csvAlign} hint={t.set.csvAlignHint}><Toggle label={t.set.csvAlign} value={s.csvAlign} onChange={(v) => set({ csvAlign: v })} /></Row>
      <Row label={t.set.previewTabs} hint={t.set.previewTabsHint}><Toggle label={t.set.previewTabs} value={s.previewTabs} onChange={(v) => set({ previewTabs: v })} /></Row>
    </>
  );
}

/**
 * Settings › Automations: on at all (2026-11-02: off until turned on), then the cap across
 * projects, what happens when it is full, Pause All.
 */
function Automations({ s }: { s: S }) {
  const ta = t.auto.settings;
  return (
    <>
      <Row label={ta.enabled} hint={ta.enabledHint}><Toggle label={ta.enabled} value={s.automationsEnabled} onChange={(v) => set({ automationsEnabled: v })} /></Row>
      {s.automationsEnabled && <AutomationsRows s={s} />}
    </>
  );
}

function AutomationsRows({ s }: { s: S }) {
  const ta = t.auto.settings;
  return (
    <>
      <Row label={ta.cap} hint={ta.capHint}>
        <Stepper label={ta.cap} value={s.automationsCap} min={1} max={10} step={1} format={String} onChange={(v) => set({ automationsCap: v })} />
      </Row>
      <Row label={ta.whenFull} hint={ta.whenFullHint}>
        <Segmented label={ta.whenFull} value={s.automationsWhenFull} options={[{ value: 'ask', label: ta.ask }, { value: 'queue', label: ta.queue }]} onChange={(v) => set({ automationsWhenFull: v })} />
      </Row>
      <Row label={ta.keepAwake} hint={ta.keepAwakeHint}><Toggle label={ta.keepAwake} value={s.automationsKeepAwake} onChange={(v) => set({ automationsKeepAwake: v })} /></Row>
      <Row label={ta.paused} hint={ta.pausedHint}><Toggle label={ta.paused} value={s.automationsPaused} onChange={(v) => set({ automationsPaused: v })} /></Row>
    </>
  );
}

/** Docker: the view, the engine, others, notifications, history. */
function Docker({ s }: { s: S }) {
  const engine = useDocker((x) => x.engine);
  const [custom, setCustom] = useState(s.dockerSocket !== '');
  const [draft, setDraft] = useState(s.dockerSocket);
  const bad = draft !== '' && !isDockerEngineSetting(draft);
  const commit = () => { if (!bad && draft !== s.dockerSocket) set({ dockerSocket: draft }); };
  const found = engine.state === 'absent' ? null : tildePath(engine.socket);
  return (
    <>
      <Row label={t.set.showDocker} hint={t.set.showDockerHint}><Segmented label={t.set.showDocker} value={s.showDocker} options={opts(t.set.showDockers)} onChange={(v) => set({ showDocker: v })} /></Row>
      <Row label={t.set.dockerEngine} hint={t.set.dockerEngineHint(found)}>
        <Segmented label={t.set.dockerEngine} value={custom ? 'custom' : 'detected'} options={opts(t.set.dockerEngines)}
          onChange={(v) => { setCustom(v === 'custom'); if (v === 'detected') { setDraft(''); set({ dockerSocket: '' }); } }} />
      </Row>
      {custom && (
        <Row label={t.set.dockerSocket} hint={t.set.dockerSocketHint} warn={bad ? t.set.dockerSocketBad : null}>
          <input className="set-text-input mono" value={draft} placeholder={t.set.dockerSocketPlaceholder} spellCheck={false} aria-label={t.set.dockerSocket}
            onChange={(e) => setDraft(e.target.value.trim())} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
        </Row>
      )}
      <Row label={t.set.dockerOthers} hint={t.set.dockerOthersHint}><Toggle label={t.set.dockerOthers} value={s.dockerOthers} onChange={(v) => set({ dockerOthers: v })} /></Row>
      <Row label={t.set.dockerNotify} hint={t.set.dockerNotifyHint}><Toggle label={t.set.dockerNotify} value={s.dockerNotify} onChange={(v) => set({ dockerNotify: v })} /></Row>
      <Row label={t.set.dockerLogLines} hint={t.set.dockerLogLinesHint}>
        <Stepper label={t.set.dockerLogLines} value={s.dockerLogLines} min={1000} max={20000} step={1000} format={(v) => v.toLocaleString('en-US')} onChange={(v) => set({ dockerLogLines: v })} />
      </Row>
      <p className="set-note">{t.set.dockerNote}</p>
    </>
  );
}

/** Databases. */
export function Databases({ s }: { s: S }) {
  return (
    <>
      <Row label={t.set.showDatabases} hint={t.set.showDatabasesHint}><Segmented label={t.set.showDatabases} value={s.showDatabases} options={opts(t.set.showDatabasesModes)} onChange={(v) => set({ showDatabases: v })} /></Row>
      <Row label={t.set.dbTimes}><Segmented label={t.set.dbTimes} value={s.dbTimes} options={opts(t.set.dbTimeModes)} onChange={(v) => set({ dbTimes: v })} /></Row>
      <Row label={t.set.dbPageSize} hint={t.set.dbPageSizeHint}><Segmented label={t.set.dbPageSize} value={s.dbPageSize} options={opts(t.set.dbPageSizes)} onChange={(v) => set({ dbPageSize: v })} /></Row>
      <Row label={t.set.dbTimeout}>
        <Stepper label={t.set.dbTimeout} value={s.dbTimeoutSec} min={5} max={120} step={5} format={(v) => `${v} s`} onChange={(v) => set({ dbTimeoutSec: v })} />
      </Row>
      <p className="set-note">{t.set.dbNote}</p>
    </>
  );
}

/** Redis. */
function Redis({ s }: { s: S }) {
  return (
    <>
      <Row label={t.set.showRedis} hint={t.set.showRedisHint}><Segmented label={t.set.showRedis} value={s.showRedis} options={opts(t.set.showRedises)} onChange={(v) => set({ showRedis: v })} /></Row>
      <Row label={t.set.redisInstances} hint={t.set.redisInstancesHint}>
        <button type="button" className="btn-ghost sm" onClick={() => useRedis.getState().setSheet({ kind: 'instances' })}>{t.set.redisManage}</button>
      </Row>
      <Row label={t.set.redisEdits} hint={t.set.redisEditsHint}><Segmented label={t.set.redisEdits} value={s.redisEdits} options={opts(t.set.redisEditModes)} onChange={(v) => set({ redisEdits: v })} /></Row>
      <Row label={t.set.redisMonitor} hint={t.set.redisMonitorHint}><Toggle label={t.set.redisMonitor} value={s.redisMonitor} onChange={(v) => set({ redisMonitor: v })} /></Row>
      <Row label={t.set.redisQueues} hint={t.set.redisQueuesHint}><Toggle label={t.set.redisQueues} value={s.redisQueues} onChange={(v) => set({ redisQueues: v })} /></Row>
      <Row label={t.set.redisNotify} hint={t.set.redisNotifyHint}><Toggle label={t.set.redisNotify} value={s.redisNotify} onChange={(v) => set({ redisNotify: v })} /></Row>
      <Row label={t.set.redisScanKeys} hint={t.set.redisScanKeysHint}>
        <Stepper label={t.set.redisScanKeys} value={s.redisScanKeys} min={1000} max={100000} step={1000} format={(v) => v.toLocaleString('en-US')} onChange={(v) => set({ redisScanKeys: v })} />
      </Row>
      <p className="set-note">{t.set.redisNote}</p>
    </>
  );
}

/** Source Control: when Atelier fetches on its own. */
function SourceControl({ s }: { s: S }) {
  return (
    <>
      <Row label={t.set.autoFetch} hint={t.set.autoFetchHint}><Segmented label={t.set.autoFetch} value={s.autoFetch} options={opts(t.set.autoFetches)} onChange={(v) => set({ autoFetch: v })} /></Row>
      <GitWrites s={s} />
      <p className="set-note">{t.set.scmNote}</p>
    </>
  );
}

/**
 * Git writes: Git actions first; in Read-only the rows after it are disabled (they keep their
 * values for when it is on again), and "Use what the sessions were asked" is disabled with messages Off too.
 */
function GitWrites({ s }: { s: S }) {
  const off = s.gitActions !== 'on';
  const noMessages = off || s.commitMessages === 'off';
  return (
    <>
      <Row label={t.set.gitActions} hint={t.set.gitActionsHint}><Segmented label={t.set.gitActions} value={s.gitActions} options={opts(t.set.gitActionsOptions)} onChange={(v) => set({ gitActions: v })} /></Row>
      <Row label={t.set.commitMessages} hint={t.set.commitMessagesHint} disabled={off}>
        <Segmented label={t.set.commitMessages} value={s.commitMessages} options={opts(t.set.commitMessagesOptions)} disabled={off} onChange={(v) => set({ commitMessages: v })} />
      </Row>
      <Row label={t.set.commitUsePrompts} hint={t.set.commitUsePromptsHint} disabled={noMessages}>
        <Toggle label={t.set.commitUsePrompts} value={s.commitUsePrompts} disabled={noMessages} onChange={(v) => set({ commitUsePrompts: v })} />
      </Row>
      <Row label={t.set.commitLanguage} hint={t.set.commitLanguageHint} disabled={noMessages}>
        <Segmented label={t.set.commitLanguage} value={s.commitLanguage} options={opts(t.set.commitLanguages)} disabled={noMessages} onChange={(v) => set({ commitLanguage: v })} />
      </Row>
      <Row label={t.set.commitCoAuthor} hint={t.set.commitCoAuthorHint} disabled={off}>
        <Toggle label={t.set.commitCoAuthor} value={s.commitCoAuthor} disabled={off} onChange={(v) => set({ commitCoAuthor: v })} />
      </Row>
      <Row label={t.set.commitNothingStaged} hint={t.set.commitNothingStagedHint} disabled={off}>
        <Segmented label={t.set.commitNothingStaged} value={s.commitNothingStaged} options={opts(t.set.commitNothingStagedOptions)} disabled={off} onChange={(v) => set({ commitNothingStaged: v })} />
      </Row>
    </>
  );
}

function Claude({ s }: { s: S }) {
  const gh = useApp((x) => x.prs.gh);
  const accounts = useAccounts();
  // Background work comes from atelierd: one without it has nothing to count until restarted.
  const noBackground = useApp((x) => x.daemon.connected && !x.daemon.backgroundAvailable);
  const noCloseStop = useApp((x) => x.daemon.connected && x.daemon.closeStopAvailable === false);
  // Why no PR chips show up: gh is not installed or not logged in (as main last saw it; only while the setting is on).
  const ghWarn = !s.prStatus ? null : gh === 'missing' ? t.set.ghMissing : gh === 'auth' ? t.set.ghAuth : null;
  // Sessions whose launch flags skip permissions don't use the mode.
  const override = permissionOverride(s.claudeFlags, accounts);
  const permWarn = !override ? null : 'all' in override ? t.flags.permOverriddenAll : t.flags.permOverriddenSome(override.names.join(', '));
  return (
    <>
      <Row label={t.set.model} hint={t.set.modelHint}><Segmented label={t.set.model} value={s.claudeModel} options={opts(t.set.models)} onChange={(v) => set({ claudeModel: v })} /></Row>
      <Row label={t.set.permission} hint={t.set.permissionHint} warn={permWarn} danger>
        <Segmented label={t.set.permission} value={s.claudePermissionMode} options={opts(t.set.permissions)} onChange={(v) => set({ claudePermissionMode: v })} />
      </Row>
      <LaunchFlags s={s} />
      <AccountsSettings s={s} />
      {/* An atelierd without kill-resumable keeps everything running until restarted. */}
      <Row label={t.set.closeWindow} hint={noCloseStop ? t.set.closeWindowNeedsRestart : t.set.closeWindowHint} disabled={noCloseStop}>
        <Segmented label={t.set.closeWindow} value={s.closeWindowSessions} options={opts(t.set.closeModes)} disabled={noCloseStop} onChange={(v) => set({ closeWindowSessions: v })} />
      </Row>
      {/* The same capability gives a single closed session back under Resume. */}
      <Row label={t.set.keepClosedSessions} hint={noCloseStop ? t.set.keepClosedSessionsNeedsRestart : t.set.keepClosedSessionsHint} disabled={noCloseStop}>
        <Toggle label={t.set.keepClosedSessions} value={s.keepClosedSessions} disabled={noCloseStop} onChange={(v) => set({ keepClosedSessions: v })} />
      </Row>
      <Row label={t.set.countBackgroundWork} hint={noBackground ? t.set.countBackgroundWorkNeedsRestart : t.set.countBackgroundWorkHint} disabled={noBackground}>
        <Toggle label={t.set.countBackgroundWork} value={s.countBackgroundWork} disabled={noBackground} onChange={(v) => set({ countBackgroundWork: v })} />
      </Row>
      <Row label={t.set.prStatus} hint={t.set.prStatusHint} warn={ghWarn}><Toggle label={t.set.prStatus} value={s.prStatus} onChange={(v) => set({ prStatus: v })} /></Row>
      {/* The "New MCP" chips and the Session panel's notice. */}
      <Row label={t.restart.setting} hint={t.restart.settingHint}><Toggle label={t.restart.setting} value={s.claudeMcpNotice} onChange={(v) => set({ claudeMcpNotice: v })} /></Row>
      {/* What Claude Code sends that Atelier doesn't recognize yet. */}
      <ClaudeCompatibility />
      <p className="set-note">{t.set.claudeNote}</p>
    </>
  );
}

/** Settings › Ask. */
function AskSettings({ s }: { s: S }) {
  const accounts = useAccounts();
  const choices = askAccountChoices(accounts, t.companion.sessionAccountPlain);
  return (
    <>
      <Row label={t.set.askModel} hint={t.set.askModelHint}><Segmented label={t.set.askModel} value={s.askModel} options={opts(t.set.askModels)} onChange={(v) => set({ askModel: v })} /></Row>
      {choices.length > 0 && (
        <Row label={t.set.askAccount} hint={t.set.askAccountHint}><Segmented label={t.set.askAccount} value={s.askAccount} options={choices} onChange={(v) => set({ askAccount: v })} /></Row>
      )}
      <Row label={t.set.askCatchUp} hint={t.set.askCatchUpHint}><Toggle label={t.set.askCatchUp} value={s.askCatchUpOnOpen} onChange={(v) => set({ askCatchUpOnOpen: v })} /></Row>
      <Row label={t.set.askAnswers} hint={t.set.askAnswersHint}><Segmented label={t.set.askAnswers} value={s.askAnswers} options={opts(t.set.askAnswerStyles)} onChange={(v) => set({ askAnswers: v })} /></Row>
      <AskKnown saved={s.askKnown} />
    </>
  );
}

/** Free text Ask reads as "what I already know": capped, counted, saved on blur and ⌘Enter (and when the sheet goes). */
function AskKnown({ saved }: { saved: string }) {
  const [text, setText] = useState(saved);
  const draft = useRef(text);
  const last = useRef(saved);
  const commit = () => { if (draft.current !== last.current) { last.current = draft.current; set({ askKnown: draft.current }); } };
  const edited = useRef(false);
  const change = (el: HTMLTextAreaElement) => {
    const raw = el.value; const caret = el.selectionStart;
    const v = cleanKnown(raw, ASK_KNOWN_MAX);
    edited.current = true; draft.current = v; setText(v);
    // A clipped paste or insertion must not throw the caret to the end: keep it where it was (inside the new value).
    // Only while the field still shows what React left there (value v, caret at its end): a selection or text that came
    // before this frame stays as it is.
    if (v !== raw) requestAnimationFrame(() => {
      if (el.value !== v || el.selectionStart !== v.length || el.selectionEnd !== v.length) return;
      const at = Math.max(0, Math.min(caret - (raw.length - v.length), v.length));
      el.setSelectionRange(at, at);
    });
  };
  const adopt = () => { edited.current = false; if (saved !== last.current) { last.current = saved; draft.current = saved; setText(saved); } };
  const blur = () => { commit(); if (!edited.current) adopt(); edited.current = false; };
  // Another window or Restore defaults changed it: shown at once unless the field has the keyboard (then on blur).
  useEffect(() => { if (saved !== last.current && document.activeElement?.id !== 'ask-known') adopt(); }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => commit, []); // eslint-disable-line react-hooks/exhaustive-deps
  const max = ASK_KNOWN_MAX;
  return (
    <div className="set-row ask-known">
      <div className="set-text"><span className="set-label">{t.set.askKnown}</span><span className="set-hint">{t.set.askKnownHint}</span></div>
      <textarea id="ask-known" className="ask-known-field" aria-label={t.set.askKnown} placeholder={t.set.askKnownPlaceholder} value={text} spellCheck={false} rows={4}
        onChange={(e) => change(e.target)}
        onBlur={blur}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
          else if (e.key === 'Escape' && draft.current) { e.preventDefault(); commit(); (e.currentTarget as HTMLElement).blur(); }
        }} />
      <span className={`ask-known-count mono${text.length >= max ? ' is-full' : ''}`} aria-live="off">{text.length} / {max}</span>
    </div>
  );
}

const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`;

/** One setup step: colored status and the action that resolves it. */
function Step({ title, tone, status, children }: { title: string; tone: 'ok' | 'warn' | 'err' | 'idle'; status: string; children?: ReactNode }) {
  return (
    <div className={`dict-step tone-${tone}`}>
      <span className="dict-dot" />
      <span className="dict-step-title">{title}</span>
      <span className="dict-step-status">{status}</span>
      <span className="grow" />
      {children}
    </div>
  );
}

/** Dictation test: records (the microphone, or the tests' WAV) and shows the text, without sessions. */
function TryIt({ ready }: { ready: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'listening' | 'working' | 'done'>('idle');
  const [result, setResult] = useState('');
  const rec = useRef<Recorder | null>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const start = async () => {
    const r = new Recorder();
    rec.current = r;
    setResult('');
    try {
      await r.start((l) => { if (meter.current) meter.current.style.transform = `scaleX(${l})`; }, () => void stop());
      if (rec.current === r) setPhase('listening');
    } catch (err) {
      // Stopped while the microphone was opening: the Recorder already closed everything, no error to show.
      if ((err as Error).message === 'cancelled') return;
      setResult(t.dictationNoMic);
      setPhase('done');
    }
  };
  const stop = async () => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    setPhase('working');
    const { pcm, speech } = trimSilence(await r.stop());
    if (!speech) { setResult(t.dictationNoSpeech); setPhase('done'); return; }
    const res = await window.atelier.dictation.transcribe(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), false, { sessions: [], branch: null, files: [], identifiers: [] });
    setResult(res.warning === 'engine-error' ? t.dictationFailed : res.text || t.dictationNoSpeech);
    setPhase('done');
  };
  useEffect(() => () => rec.current?.cancel(), []);
  return (
    <div className="dict-try">
      <div className="dict-try-head">
        {phase === 'listening'
          ? <button type="button" className="btn-primary" onClick={() => void stop()}><Icon name="stop" size={12} />{t.set.dictStop}</button>
          : <button type="button" className="btn-ghost" disabled={!ready || phase === 'working'} onClick={() => void start()}><Icon name="mic" size={13} />{t.set.dictTry}</button>}
        {phase === 'listening' && <><span className="dict-meter"><span ref={meter} /></span><span className="dict-try-label">{t.dictationPhase.listening}</span></>}
        {phase === 'working' && <span className="dict-try-label">{t.dictationPhase.transcribing}</span>}
        {!ready && <span className="set-hint">{t.set.dictTryNotReady}</span>}
      </div>
      {result && <p className="dict-try-result">{result}</p>}
    </div>
  );
}

function Dictation({ s }: { s: S }) {
  const st = useApp((x) => x.dictationStatus);
  useEffect(() => { void window.atelier.dictation.status().then((v) => useApp.getState().setDictationStatus(v)); }, []);
  const d = t.set;
  const micTone = st?.mic === 'granted' ? 'ok' : st?.mic === 'not-determined' ? 'warn' : 'err';
  const m = st?.model;
  const modelTone = m?.state === 'ready' ? 'ok' : m?.state === 'corrupted' || m?.error ? 'err' : m?.state === 'missing' ? 'warn' : 'idle';
  const modelStatus = !m ? '' : m.state === 'ready' ? d.dictModelReady
    : m.state === 'downloading' ? `${d.dictDownloading} ${Math.floor(((m.received ?? 0) / (m.total || 1)) * 100)}%`
      : m.state === 'verifying' ? d.dictVerifying : m.state === 'corrupted' ? d.dictCorrupted : m.error ?? d.dictModelMissing;
  const engineTone = st?.engine === 'ready' ? 'ok' : st?.engine === 'error' ? 'err' : 'idle';
  const ready = !!st && st.mic === 'granted' && m?.state === 'ready' && st.engine !== 'error';
  return (
    <>
      <Row label={d.dictEnable} hint={d.dictEnableHint}><Toggle label={d.dictEnable} value={s.dictationEnabled} onChange={(v) => set({ dictationEnabled: v })} /></Row>
      {s.dictationEnabled && st && (
        <>
          <div className="set-group-title">{d.dictSetup}</div>
          <div className="dict-steps">
            <Step title={d.dictMic} tone={micTone} status={d.dictMicState[st.mic] ?? st.mic}>
              {st.mic === 'not-determined' && <button type="button" className="sb-btn" onClick={() => void window.atelier.dictation.requestMic()}>{d.dictAllow}</button>}
              {(st.mic === 'denied' || st.mic === 'restricted') && <button type="button" className="sb-btn" onClick={() => void window.atelier.dictation.openPrivacy()}>{d.dictOpenPrivacy}</button>}
            </Step>
            <Step title={d.dictModel} tone={modelTone} status={modelStatus}>
              {(m?.state === 'missing' || m?.state === 'corrupted') && <button type="button" className="sb-btn" onClick={() => void window.atelier.dictation.download()}>{m.state === 'corrupted' || m.error ? d.dictDownloadAgain : `${d.dictDownload} · ${mb(m.total ?? 574_041_195)}`}</button>}
              {m?.state === 'downloading' && <><span className="dict-progress"><span style={{ transform: `scaleX(${(m.received ?? 0) / (m.total || 1)})` }} /></span><button type="button" className="sb-btn" onClick={() => void window.atelier.dictation.cancelDownload()}>{d.dictCancel}</button></>}
              {m?.state === 'ready' && <button type="button" className="sb-btn" onClick={() => void window.atelier.dictation.removeModel()}>{d.dictRemove}</button>}
            </Step>
            <Step title={d.dictEngine} tone={engineTone} status={st.engine === 'error' ? (st.engineError ?? 'Error') : (d.dictEngineState[st.engine] ?? st.engine)}>
              {st.engine === 'error' && <button type="button" className="sb-btn" onClick={() => void window.atelier.dictation.restartEngine()}>{d.dictRestart}</button>}
            </Step>
            <Step title={d.dictPolishStep} tone={st.polish === 'available' ? 'ok' : 'warn'} status={st.polish === 'available' ? d.dictPolishAvailable : d.dictPolishUnavailable} />
          </div>
          <div className="set-group-title">{d.dictOptions}</div>
          <Row label={d.dictShortcut} hint={d.dictShortcutHint}><Segmented label={d.dictShortcut} value={s.dictationShortcut} options={opts(d.dictShortcuts)} onChange={(v) => set({ dictationShortcut: v })} /></Row>
          <Row label={d.dictLanguage}><Segmented label={d.dictLanguage} value={s.dictationLanguage} options={opts(d.dictLanguages)} onChange={(v) => set({ dictationLanguage: v })} /></Row>
          <Row label={d.dictPolish} hint={d.dictPolishHint}><Toggle label={d.dictPolish} value={s.dictationPolish && st.polish === 'available'} onChange={(v) => set({ dictationPolish: v })} /></Row>
          <Row label={d.dictAutoSend} hint={d.dictAutoSendHint}><Toggle label={d.dictAutoSend} value={s.dictationAutoSend} onChange={(v) => set({ dictationAutoSend: v })} /></Row>
          <Row label={d.dictSounds}><Toggle label={d.dictSounds} value={s.dictationSounds} onChange={(v) => set({ dictationSounds: v })} /></Row>
          <Row label={d.dictKeep} hint={d.dictKeepHint}><Segmented label={d.dictKeep} value={s.dictationKeepLoaded} options={opts(d.dictKeeps)} onChange={(v) => set({ dictationKeepLoaded: v })} /></Row>
          <div className="set-group-title">{d.dictTryTitle}</div>
          <TryIt ready={ready} />
        </>
      )}
    </>
  );
}

function Notifications({ s }: { s: S }) {
  const tray = trayCopy(currentPlatform());
  return (
    <>
      <Row label={t.set.notifyWaiting} hint={t.set.notifyWaitingHint}><Toggle label={t.set.notifyWaiting} value={s.notifyWaiting} onChange={(v) => set({ notifyWaiting: v })} /></Row>
      <Row label={t.set.notifyDone} hint={t.set.notifyDoneHint}><Toggle label={t.set.notifyDone} value={s.notifyDone} onChange={(v) => set({ notifyDone: v })} /></Row>
      {/* Always shown: besides macOS banners it decides the bell's entries and the chime. */}
      <Row label={t.set.notifyDoneAfter} hint={t.set.notifyDoneAfterHint}>
        <Segmented label={t.set.notifyDoneAfter} value={s.notifyDoneAfter} options={opts(t.set.doneAfter)} onChange={(v) => set({ notifyDoneAfter: v })} />
      </Row>
      <Row label={t.set.notifyTriggers} hint={t.set.notifyTriggersHint}><Toggle label={t.set.notifyTriggers} value={s.notifyTriggers} onChange={(v) => set({ notifyTriggers: v })} /></Row>
      <Row label={t.set.notifySound} hint={t.set.notifySoundHint}><Toggle label={t.set.notifySound} value={s.notifySound} onChange={(v) => set({ notifySound: v })} /></Row>
      <Row label={t.set.dockBadge} hint={t.set.dockBadgeHint}><Toggle label={t.set.dockBadge} value={s.dockBadge} onChange={(v) => set({ dockBadge: v })} /></Row>
      <Row label={tray.label} hint={tray.hint}><Toggle label={tray.label} value={s.trayIcons} onChange={(v) => set({ trayIcons: v })} /></Row>
      <Row label={t.set.notifyTest} hint={t.set.notifyTestHint}>
        <button type="button" className="btn-ghost" onClick={() => { if (s.notifySound) playChime(); void window.atelier.notifications.test(); }}>{t.set.notifySendTest}</button>
      </Row>
      <Row label={t.set.notifyMacos} hint={t.set.notifyMacosHint}>
        <button type="button" className="btn-ghost" onClick={() => void window.atelier.notifications.openSettings()}>{t.set.notifyOpenSettings}</button>
      </Row>
    </>
  );
}

// The list of every shortcut comes with its section (the first paint has no room for it); so do Connectors'
// list and details pages, with Jira's and Notion's options. The header's "‹ Connectors" is ConnectorsBack.
const Keyboard = lazy(() => import('./SettingsKeyboard').then((m) => ({ default: m.Keyboard })));
const Connectors = lazy(() => import('./Connectors').then((m) => ({ default: m.Connectors })));

/** What the app and the site send (site/src/pages/privacy.astro). */
const PRIVACY_URL = 'https://useatelier.dev/privacy';

/** In-app updates: channel, last check, "Check Now", progress, errors, notes. */
function Updates() {
  const st = useApp((x) => x.updateStatus);
  const ready = useApp((x) => x.updateReady);
  const channelSetting = useApp((x) => x.settings.updateChannel);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void window.atelier.update.status().then((v) => { if (v) useApp.getState().setUpdateStatus(v); }).catch(() => {});
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => setNow(Date.now()), [st?.lastCheck]);
  if (storeUpdates()) return <StoreUpdates st={st} now={now} />;
  if (!st) return null;
  const sum = updateSummary(st);
  const p = st.phase;
  const notes = p.kind === 'ready' || p.kind === 'needs-restart' ? { version: p.version, text: p.notes } : st.currentNotes ? { version: st.version, text: st.currentNotes } : null;
  return (
    <>
      <div className="set-group-title">{t.upd.title}</div>
      <Row label={t.upd.channel} hint={t.upd.channelHint}>
        <Segmented label={t.upd.channel} value={channelSetting} options={channelOptions(st.buildChannel)} onChange={(v) => set({ updateChannel: v })} />
      </Row>
      <p className="set-note upd-privacy">
        {t.upd.privacy}{' '}
        <button type="button" className="link-btn" onClick={() => void window.atelier.openUrl(PRIVACY_URL)}>{t.upd.privacyLink}</button>
      </p>
      <Row label={t.upd.lastCheck} hint={checkedAgo(st.lastCheck, now)}>
        <button type="button" className="btn-ghost" disabled={!canCheck(st)} onClick={() => void window.atelier.update.check().then((v) => { if (v) useApp.getState().setUpdateStatus(v); })}>{t.upd.checkNow}</button>
      </Row>
      <div className={`upd-card tone-${sum.tone}`} role="status" aria-live="polite" aria-label={t.upd.title}>
        <span className="upd-dot" />
        <div className="upd-text">
          <span className="upd-title">{sum.title}</span>
          {sum.detail && <span className="upd-detail">{sum.detail}</span>}
          {sum.progress !== undefined && <span className="dict-progress upd-progress"><span style={{ transform: `scaleX(${sum.progress})` }} /></span>}
        </div>
        {sum.action === 'restart' && ready && (
          <button type="button" className="btn-primary" onClick={applyUpdate}>{t.upd.restart}</button>
        )}
        {sum.action === 'release-page' && <button type="button" className="btn-ghost" onClick={() => void window.atelier.update.openRelease()}>{t.upd.openRelease}</button>}
        {sum.action === 'applications' && <button type="button" className="btn-ghost" onClick={() => void window.atelier.update.openApplications()}>{t.upd.openApplications}</button>}
      </div>
      {notes && notes.text.trim() && (
        <section className="upd-notes" aria-label={t.upd.notesTitle(notes.version)}>
          <div className="upd-notes-title">{t.upd.notesTitle(notes.version)}</div>
          <Notes text={notes.text} />
        </section>
      )}
    </>
  );
}

/**
 * Windows: the Microsoft Store's updates. No channel and no privacy note (nothing goes
 * to our site); without the package (a dev run) only the card saying where updates come from.
 */
function StoreUpdates({ st, now }: { st: UpdateStatus | null; now: number }) {
  const ready = useApp((x) => x.updateReady);
  const sum = st ? updateSummary(st) : { tone: 'idle' as const, title: t.upd.store, detail: t.upd.storeDetail };
  return (
    <>
      <div className="set-group-title">{t.upd.title}</div>
      {st?.available && (
        <>
          <p className="set-note upd-privacy">{t.upd.storeNote}</p>
          <Row label={t.upd.lastCheck} hint={checkedAgo(st.lastCheck, now)}>
            <button type="button" className="btn-ghost" disabled={!canCheck(st)} onClick={() => void window.atelier.update.check().then((v) => { if (v) useApp.getState().setUpdateStatus(v); })}>{t.upd.checkNow}</button>
          </Row>
        </>
      )}
      <div className={`upd-card tone-${sum.tone}`} role="status" aria-live="polite" aria-label={t.upd.title}>
        <span className="upd-dot" />
        <div className="upd-text">
          <span className="upd-title">{sum.title}</span>
          {sum.detail && <span className="upd-detail">{sum.detail}</span>}
          {sum.progress !== undefined && <span className="dict-progress upd-progress"><span style={{ transform: `scaleX(${sum.progress})` }} /></span>}
        </div>
        {sum.changelog && <button type="button" className="btn-ghost" onClick={() => void window.atelier.openUrl(CHANGELOG_URL)}>{t.upd.whatsNew}</button>}
        {sum.action === 'restart' && ready && <button type="button" className="btn-primary" onClick={applyUpdate}>{t.upd.restart}</button>}
        {sum.action === 'store' && <button type="button" className="btn-ghost" onClick={() => void window.atelier.update.openStore()}>{t.upd.openStore}</button>}
      </div>
    </>
  );
}

function About() {
  const daemon = useApp((s) => s.daemon);
  const upd = useApp((s) => s.updateStatus);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { void window.atelier.appInfo().then(setInfo).catch(() => {}); }, []);
  const channel = versionChannel(upd);
  return (
    <>
      <div className="about-hero">
        <Logo size={56} />
        <div><div className="about-name">Atelier</div><div className="set-hint">{info ? `${t.set.version} ${info.version}${channel ? ` · ${channel}` : ''}` : ''}</div></div>
      </div>
      <Updates />
      <Row label={t.set.service}><span className={`about-status ${daemon.connected ? 'is-ok' : 'is-off'}`}><i />{daemon.connected ? t.set.connected(daemon.version ?? '?') : t.set.disconnected}</span></Row>
      {info && <Row label={t.set.runtime}><span className="set-hint mono">Electron {info.electron} · Chrome {info.chrome.split('.')[0]} · Node {info.node}</span></Row>}
      <div className="about-actions">
        <button type="button" className="btn-ghost" onClick={() => void window.atelier.openLogs()}>{t.set.openLogs}</button>
        <button type="button" className="btn-ghost" onClick={() => void window.atelier.openLicenses()}>{t.set.licenses}</button>
        <button type="button" className="btn-ghost is-danger" onClick={() => void window.atelier.restartDaemon()}>{t.set.restartDaemon}</button>
      </div>
    </>
  );
}

/** Settings: modal sheet with the sections on the left; every change applies immediately, in all windows. */
export function Settings() {
  const section = useApp((s) => s.settingsOpen) ?? 'appearance';
  const s = useApp((st) => st.settings);
  const close = () => useApp.getState().setSettingsOpen(null);
  // Connectors in the sidebar from one of its details pages: back to the list.
  const go = (id: SettingsSection) => { useApp.getState().setSettingsOpen(id); if (id === 'connectors') useApp.getState().openConnector(null); };
  const connectorDetail = useConnectorDetail();
  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  // The connector that needs you (reconnect / unavailable): a dot on its section, like the gear's.
  const connectorsAttention = useApp((st) => st.connectors.find((c) => needsAttention([c]))?.name ?? null);

  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('.set-nav-item.is-active')?.focus();
    // Keys handled at window level, before everything else: even with focus lost (click on text, a button
    // just disabled) Esc closes and Tab stays inside the sheet, and nothing reaches the terminal underneath.
    const onKey = (e: KeyboardEvent) => {
      const root = sheet.current;
      if (!root) return;
      // A menu opened from the sheet (Default profile) or the terminal font's popover handles its own keys, Esc included.
      if ((document.activeElement as HTMLElement | null)?.closest('.ctx-menu, .font-pop')) return;
      // A question over the sheet (Restart atelierd from About, a window closing) keeps its keys.
      // Open, not just focused: a click on its text drops the focus, and Esc must still be its own.
      if (document.querySelector('.confirm-sheet, .confirm-pop')) return;
      const inside = root.contains(document.activeElement);
      const target = e.target as HTMLElement | null;
      // ⌘[ on a connector's details page: back to the list, wherever the focus is.
      const st = useApp.getState();
      if (isConnectorsBackKey(e) && st.settingsOpen === 'connectors' && st.connectorDetail) {
        e.preventDefault(); e.stopPropagation(); st.openConnector(null); return;
      }
      if (e.key === 'Escape') {
        // In search with text, Esc first clears the field (like macOS search fields).
        if (inside && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value) return;
        // A part of the sheet that closes itself first (the Disconnect confirm of a connector).
        if (inside && target?.closest('[data-own-esc]')) return;
        e.preventDefault(); e.stopPropagation(); close(); return;
      }
      if (e.key === 'Tab') {
        // Only what Tab reaches: the unchosen options of groups (tabindex -1) do not count.
        const items = [...root.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not([tabindex="-1"]), textarea')];
        const first = items[0]; const last = items.at(-1);
        if (!inside) { e.preventDefault(); e.stopPropagation(); first?.focus(); return; }
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        return;
      }
      // Focus outside the sheet: bring it back in, the key goes no further.
      if (!inside) { e.preventDefault(); e.stopPropagation(); root.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    const back = opener.current;
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // Focus returns to the work only if nobody else already took it (a command that opens a terminal, a notification).
      if (document.activeElement && document.activeElement !== document.body) return;
      if (back instanceof HTMLElement && back.isConnected && !back.closest('.activity-bar')) { back.focus(); return; }
      document.querySelector<HTMLElement>('.terminal-slot[style*="block"] .xterm-helper-textarea, .file-view[style*="flex"] .cm-content')?.focus();
    };
  }, []);

  const onNavKey = (e: React.KeyboardEvent) => {
    if (!(e.target as HTMLElement).classList.contains('set-nav-item') || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const i = SECTIONS.findIndex((x) => x.id === section);
    go(SECTIONS[(i + (e.key === 'ArrowDown' ? 1 : SECTIONS.length - 1)) % SECTIONS.length]!.id);
    requestAnimationFrame(() => sheet.current?.querySelector<HTMLElement>('.set-nav-item.is-active')?.focus());
  };

  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={close}>
      <div className="settings" role="dialog" aria-modal="true" aria-label={t.set.title} ref={sheet} tabIndex={-1}
        onMouseDown={(e) => { e.stopPropagation(); if (!(e.target as HTMLElement).closest('button, input, textarea')) e.preventDefault(); }}>
        <nav className="set-nav" aria-label={t.set.sectionsLabel} onKeyDown={onNavKey}>
          <div className="set-nav-title">{t.set.title}</div>
          {SECTIONS.map((x) => (
            <button key={x.id} type="button" className={`set-nav-item ${x.id === section ? 'is-active' : ''}`} aria-current={x.id === section ? 'page' : undefined} onClick={() => go(x.id)}>
              <Icon name={x.icon} size={15} />{t.set.sections[x.id]}
              {x.id === 'connectors' && connectorsAttention && <span className="set-nav-dot" role="img" aria-label={t.conn.attention(connectorsAttention)} />}
            </button>
          ))}
          <span className="grow" />
          <RestoreDefaults />
        </nav>
        <section className="set-body">
          <header className="set-head">
            {section === 'connectors' && connectorDetail ? <ConnectorsBack /> : <h2>{t.set.sections[section]}</h2>}
            <button type="button" className="icon-btn" aria-label={t.set.close} onClick={close}><Icon name="x" size={14} /></button>
          </header>
          <div className="set-content" key={section}>
            {section === 'appearance' && <Appearance s={s} />}
            {section === 'terminal' && <Terminal s={s} />}
            {section === 'editor' && <Editor s={s} />}
            {section === 'scm' && <SourceControl s={s} />}
            {section === 'docker' && <Docker s={s} />}
            {section === 'redis' && <Redis s={s} />}
            {section === 'databases' && <Databases s={s} />}
            {section === 'automations' && <Automations s={s} />}
            {section === 'claude' && <Claude s={s} />}
            {section === 'connectors' && <Suspense fallback={null}><Connectors /></Suspense>}
            {section === 'ask' && <AskSettings s={s} />}
            {section === 'dictation' && <Dictation s={s} />}
            {section === 'notifications' && <Notifications s={s} />}
            {section === 'keyboard' && <Suspense fallback={null}><Keyboard /></Suspense>}
            {section === 'about' && <About />}
          </div>
        </section>
      </div>
    </div>
  );
}
