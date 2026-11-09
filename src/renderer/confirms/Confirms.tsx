// Every window's in-app confirms that don't live in a row: mounted once per window, the
// project's, a pop-out's and the welcome one.
import { CloseHost } from './CloseHost';
import { UnsavedHost } from './UnsavedHost';
import { MainAskHost } from './MainAskHost';
import { WorkspaceCloseHost } from './WorkspaceCloseHost';

export function Confirms() {
  return <><CloseHost /><UnsavedHost /><MainAskHost /><WorkspaceCloseHost /></>;
}
