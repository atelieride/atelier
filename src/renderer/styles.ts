// The app's stylesheets, in cascade order. Apart from main.tsx so a feature's new stylesheet maps as CSS for the e2e
// selection (tests/e2e/areas.ts), not as the renderer's entry.
import './theme.css';
import './themes.css';
import './themes-docsy.css';
import './layout.css';
import './scm/scm.css';
import './scm/all.css';
import './git/git.css';
import './git/sync.css';
import './git/branches.css';
import './git/commit-all.css';
import './markdown.css';
import './json.css';
import './csv.css';
import './automations/automations.css';
// The Databases view's own stylesheet comes with its lazy chunk; the first paint needs only the tab strip's rules.
import './databases-tabs.css';
import './schedule.css';
import './restart.css';
