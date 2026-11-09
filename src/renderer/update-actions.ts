// "Restart to Update" (footer pill, Settings › About): when the staged update cannot be applied, the toast offers the
// release page (a manual install; on Windows the Microsoft Store), never a developer command.
import { useApp } from './store';
import { updateFailedToast } from './update-view';

export function applyUpdate(): void {
  void window.atelier.update.apply().then((ok) => {
    if (ok) return;
    const f = updateFailedToast();
    useApp.getState().showToast(f.text, { label: f.label, run: () => void (f.target === 'store' ? window.atelier.update.openStore() : window.atelier.update.openRelease()) });
  });
}
