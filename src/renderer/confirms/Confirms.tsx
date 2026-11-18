// Every window's in-app confirms that float over the page (a bubble beside a sidebar row, a popover, a
// centered sheet): mounted once per window, the project's, a pop-out's and the welcome one. The questions
// that grow inside their own row (a session's Restart, the file tree's Move to Trash) live in that row.
import { CloseHost } from './CloseHost';
import { UnsavedHost } from './UnsavedHost';
import { MainAskHost } from './MainAskHost';
import { WorkspaceCloseHost } from './WorkspaceCloseHost';
import { WsActivityCloseHost } from './WsActivityCloseHost';

export function Confirms() {
  return <><CloseHost /><UnsavedHost /><MainAskHost /><WorkspaceCloseHost /><WsActivityCloseHost /></>;
}
