import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { useApp } from '../../store';
import { t } from '../../i18n/en';
import { copyText } from '../../clipboard';
import { isBracketed } from '../../terminal/focus';
import { askPromptReason } from '../../companion/model';
import { promptText } from '../../companion/view';
import { sendAsPrompt } from '../../companion/actions';
import { answerCopy } from '../../companion/copy';

/** How long Copy says Copied. */
const COPIED_MS = 1600;

/**
 * Under an answer: Copy (its Markdown, and its HTML), Use as prompt (into the session's prompt, never sent; off with
 * Review's tooltips when Claude isn't at its prompt) and Ask again (the same question once more; the
 * answer stays, the new one comes below). Shown on hover and keyboard focus, always for the latest answer (CSS).
 */
export function AnswerActions({ markdown, terminalId, question, busy, onAsk }: {
  markdown: string; terminalId: string; question: string | null; busy: boolean; onAsk: (q: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const title = useApp((s) => s.terminals.find((x) => x.id === terminalId)?.title ?? '');
  const text = useMemo(() => promptText(markdown), [markdown]);
  const why = useApp((s) => askPromptReason(s.terminals.find((x) => x.id === terminalId), isBracketed(terminalId), text));
  // Formatted: the Markdown as text, the answer as clean HTML for documents.
  const copy = () => { const c = answerCopy(markdown); void copyText(c.text, c.html).then((ok) => { if (ok) setCopied(true); }); };
  return (
    <div className="ask-acts" role="group" aria-label={t.companion.answerActions} data-copy="skip">
      <button type="button" className={`ask-act${copied ? ' is-done' : ''}`} data-tip={copied ? undefined : t.companion.copyTip} onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={14} stroke={copied ? 2.2 : 1.6} />{copied ? t.companion.copiedAnswer : t.companion.copy}
      </button>
      <button type="button" className="ask-act" aria-disabled={why !== null} data-tip={why ?? t.companion.useAsPromptTip(title)}
        onClick={() => { if (why === null) sendAsPrompt(terminalId, markdown); }}>
        <Icon name="send" size={14} />{t.companion.useAsPrompt}
      </button>
      {question !== null && (
        <button type="button" className="ask-act" aria-disabled={busy} data-tip={busy ? t.companion.oneAtATime : t.companion.askAgainTip(question)}
          onClick={() => { if (!busy) onAsk(question); }}>
          <Icon name="resume" size={14} />{t.companion.askAgain}
        </button>
      )}
      <span className="sr-only" role="status">{copied ? t.companion.copiedAnswer : ''}</span>
    </div>
  );
}
