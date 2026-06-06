import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionModel, TranscriptActiveTailModel, TranscriptMessage } from "../../types/symphony";
import { Icon, SessionStateChip, UnavailableButton } from "../common";
import { Message } from "../messages/Message";

const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;
const TRANSCRIPT_BACKFILL_THRESHOLD_PX = 80;

export function TranscriptPane({
  session,
  messages,
  loading = false,
  error = null,
  activeTail = null,
  hasPrevious = false,
  loadingPrevious = false,
  previousError = null,
  onLoadPrevious,
}: {
  session: SessionModel;
  messages: TranscriptMessage[];
  loading?: boolean;
  error?: string | null;
  activeTail?: TranscriptActiveTailModel | null;
  hasPrevious?: boolean;
  loadingPrevious?: boolean;
  previousError?: string | null;
  onLoadPrevious?: () => Promise<void>;
}) {
  const initialOpenSet = useMemo(() => new Set([5, 9, 10]), []);
  const [openSet, setOpenSet] = useState(initialOpenSet);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const previousSessionIdRef = useRef(session.id);
  const previousMessageCountRef = useRef(messages.length);
  const pinnedToBottomRef = useRef(true);
  const loadingPreviousRef = useRef(loadingPrevious);
  const hasPreviousRef = useRef(hasPrevious);
  const preserveBackfillScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const hasMessages = messages.length > 0;

  useLayoutEffect(() => {
    loadingPreviousRef.current = loadingPrevious;
    hasPreviousRef.current = hasPrevious;
  }, [hasPrevious, loadingPrevious]);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    const sessionChanged = previousSessionIdRef.current !== session.id;
    const messageCountIncreased = messages.length > previousMessageCountRef.current;
    const preserveScroll = preserveBackfillScrollRef.current;

    if (sessionChanged) {
      scrollTranscriptToBottom(element);
      pinnedToBottomRef.current = true;
      preserveBackfillScrollRef.current = null;
    } else if (preserveScroll && messageCountIncreased) {
      element.scrollTop = preserveScroll.scrollTop + Math.max(0, element.scrollHeight - preserveScroll.scrollHeight);
      pinnedToBottomRef.current = isTranscriptNearBottom(element);
      preserveBackfillScrollRef.current = null;
    } else if (pinnedToBottomRef.current && (messageCountIncreased || !loading)) {
      scrollTranscriptToBottom(element);
    }

    previousSessionIdRef.current = session.id;
    previousMessageCountRef.current = messages.length;
  }, [session.id, messages.length, loading]);

  function toggle(index: number) {
    setOpenSet((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function handleTranscriptScroll() {
    const element = transcriptRef.current;
    if (!element) return;
    pinnedToBottomRef.current = isTranscriptNearBottom(element);
    if (element.scrollTop > TRANSCRIPT_BACKFILL_THRESHOLD_PX) return;
    if (!hasPreviousRef.current || loadingPreviousRef.current || !onLoadPrevious) return;
    preserveBackfillScrollRef.current = { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    loadingPreviousRef.current = true;
    void onLoadPrevious()
      .catch(() => undefined)
      .finally(() => {
        loadingPreviousRef.current = false;
      });
  }

  return (
    <div className="transcript-wrap">
      <div className="transcript-head">
        <div>
          <h2>{session.title}</h2>
          <div className="meta">
            <span style={{ color: "var(--text-2)", fontFamily: "var(--font-sans)" }}>
              <strong style={{ color: "var(--text)", fontWeight: 500 }}>{session.issue}</strong>
            </span>
            <SessionStateChip state={session.state} />
            <span>{session.model}</span>
            <span style={{ color: "var(--text-4)" }}>·</span>
            <span>{session.id}</span>
            <span style={{ color: "var(--text-4)" }}>·</span>
            <span>
              {session.msgCount} messages · {session.toolCount} tools
            </span>
          </div>
        </div>
        <div className="right">
          <UnavailableButton className="btn" unavailableLabel="Open workspace" unavailableReason="workspace navigation is unavailable until a safe command route exists">
            <span>{Icon.branch()}</span>Open workspace
          </UnavailableButton>
          <UnavailableButton className="btn" unavailableLabel="Open issue" unavailableReason="issue navigation from transcripts is unavailable until a safe route exists">
            <span>{Icon.link()}</span>
            {session.issue}
          </UnavailableButton>
          <UnavailableButton className="icon-btn" unavailableLabel="More" unavailableReason="transcript action menus are unavailable until backend command routes exist">
            {Icon.more()}
          </UnavailableButton>
        </div>
      </div>
      <div
        className="transcript"
        data-active-tail={activeTail?.canAppend === true ? "true" : "false"}
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
      >
        {loadingPrevious ? <div className="transcript-status">Loading earlier transcript messages...</div> : null}
        {previousError ? <div className="transcript-status">Could not load earlier messages: {previousError}</div> : null}
        {loading ? (
          <div className="transcript-status">
            {hasMessages ? "Refreshing transcript... showing previous messages." : "Loading transcript..."}
          </div>
        ) : null}
        {error ? (
          <div className="transcript-status">
            {hasMessages ? `Could not refresh transcript: ${error}. Showing previous messages.` : `Transcript unavailable: ${error}`}
          </div>
        ) : null}
        {!loading && !error && !hasMessages ? <div className="transcript-status">No transcript messages for this session.</div> : null}
        {messages.map((message, index) => (
          <Message key={`${message.kind}-${index}`} message={message} open={openSet.has(index)} onToggle={() => toggle(index)} />
        ))}
      </div>
    </div>
  );
}

function isTranscriptNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
}

function scrollTranscriptToBottom(element: HTMLElement): void {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}
