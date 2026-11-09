import { createRoot } from 'react-dom/client';
import './styles';
import { App } from './App';
import { loadFonts } from './fonts';
import { spriteMarkup } from './icons/seti';
import { ErrorBoundary, loadTestFault } from './components/ErrorBoundary';
import { installErrorReporting } from './error-report';
import { t } from './i18n/en';
import { trackWindowActivity } from './motion';
import { currentPlatform } from '@shared/platform';

installErrorReporting();
// The theme the window opened on, before anything paints; the settings, when they arrive, agree.
if (window.atelier.bootTheme !== 'aurora') document.documentElement.dataset.theme = window.atelier.bootTheme;
// The window's frame differs per platform (traffic lights on macOS, caption buttons on Windows): CSS reads this.
document.documentElement.dataset.platform = currentPlatform();
// Lasting motion stops while the window is inactive; set before the first frame.
trackWindowActivity(window, document.documentElement, document.hasFocus());
void loadFonts().catch(() => { /* without fonts the system font is used */ }).finally(() => {
  createRoot(document.getElementById('root')!).render(<ErrorBoundary id="app" panel={t.appName} root><App /></ErrorBoundary>);
  loadTestFault();
  // File icons arrive after the first frame: startup does not wait for them. The markup is sanitized (shapes only).
  requestAnimationFrame(() => document.body.insertAdjacentHTML('afterbegin', spriteMarkup()));
});
