import { Icon } from './Icon';
import { t } from '../i18n/en';

/** "Pinned": a small filled pin on the corner of a pinned row's avatar or terminal icon. */
export function PinBadge() {
  return <span className="av-pin" data-tip={t.pinnedTip}><Icon name="pin" size={9} stroke={2} /></span>;
}
