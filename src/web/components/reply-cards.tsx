import { PrChecks, PrMetadata, PrStatus, prNumber } from '@/components/pr-status';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  FileDiff,
  GitMerge,
  MessageCircleQuestion,
} from "lucide-react";
import { createContext, memo, useContext, useMemo, useState } from "react";
import { FileIcon, FileIcons } from "@/components/file-icons";
import { DiffBars, PathName } from "@/components/instrument";
import { Badge, Btn, DiffStat, Icon } from "@/components/signal";
import { MergeBox, MergeMethodMenu, mergeLabel, type MergeMethod } from '@/components/pr-merge';
import { field } from "@/components/tool-describe";
import { api } from "@/lib/api";
import { type FileDiff as Diff, parsePatch } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { focusChange, ShowPanel } from "@/lib/workspace";

/*
 * Cards a reply carries for what Anton already knows: a question to answer
 * with a tap, the files a turn changed, and the pull request it opened.
 */

/**
 * How a card in a reply answers: by sending the user's next message. `live`
 * is false while the agent works; `answer` is the message that followed the
 * reply, once there is one, so a card shows what was picked after a reload.
 */
export type ReplyActions = { send: (text: string) => void; busy: boolean };
export const ReplyActions = createContext<ReplyActions>({
  send: () => undefined,
  busy: true,
});

/** What a card in one reply knows of the conversation after it. */
export type ReplyPlace = { latest: boolean; answer: string | null };

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

type AskOption = { label: string; detail?: string };

function askOf(input: unknown): {
  question: string;
  options: AskOption[];
  recommended: number | null;
} {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) =>
        option &&
        typeof option === "object" &&
        typeof (option as AskOption).label === "string"
          ? [option as AskOption]
          : [],
      )
    : [];
  const recommended =
    typeof record.recommended === "number" && options[record.recommended]
      ? record.recommended
      : null;
  return { question: field(input, "question"), options, recommended };
}

/** A question from the ask tool: tap an option to answer with it, or type an answer in the composer. */
export const AskCard = memo(function AskCard({
  input,
  place,
}: {
  input: unknown;
  place: ReplyPlace;
}) {
  const { send, busy } = useContext(ReplyActions);
  const { question, options, recommended } = askOf(input);
  const picked =
    place.answer === null
      ? -1
      : options.findIndex((option) => same(option.label, place.answer ?? ""));
  const open = place.latest && place.answer === null;
  if (place.answer !== null)
    return (
      <AnsweredCard
        question={question}
        answer={picked === -1 ? place.answer : options[picked].label}
        index={picked}
      />
    );
  return (
    <section className={cn("in-callout overflow-hidden", open && "in-callout--warn")} aria-label="Question">
      <header className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
        <span className={cn("mt-0.5 inline-flex shrink-0 items-center justify-center", open ? "text-(--warn)" : "text-(--text-3)")}>
          <Icon icon={MessageCircleQuestion} size={16} />
        </span>
        <h3 className="m-0 min-w-0 flex-1 text-body-lg leading-[20px] font-medium text-(--text)">
          {question}
        </h3>
      </header>
      <div
        className="flex flex-col gap-1 px-2 pb-2"
        role="group"
        aria-label={question}
      >
        {options.map((option, index) => {
          const chosen = index === picked;
          return (
            <button
              key={option.label}
              type="button"
              disabled={!open || busy}
              aria-pressed={chosen}
              onClick={() => send(option.label)}
              className={cn(
                "group/option flex min-h-9 items-center gap-2.5 rounded-control border px-2.5 py-1.5 text-left outline-none focus-visible:shadow-(--focus)",
                chosen
                  ? "border-(--accent-line) bg-(--accent-soft)"
                  : "border-(--line-strong) bg-(--bg-panel)",
                open && !busy
                  ? "hover:border-(--line-strong) hover:bg-(--bg-hover)"
                  : "cursor-default",
                !open && !chosen && "opacity-55",
              )}
            >
              <span
                className={cn(
                  "in-num inline-flex size-5 shrink-0 items-center justify-center rounded-control border text-micro",
                  chosen
                    ? "border-(--accent-line) text-(--accent-text)"
                    : "border-(--line-strong) text-(--text-3)",
                )}
              >
                {chosen ? <Icon icon={Check} size={11} /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body leading-[18px] text-(--text)">
                  {option.label}
                </span>
                {option.detail ? (
                  <span className="text-small leading-[16px] text-(--text-3)">
                    {option.detail}
                  </span>
                ) : null}
              </span>
              {index === recommended ? (
                <Badge tone="accent">Recommended</Badge>
              ) : null}
            </button>
          );
        })}
      </div>
      {open ? (
        <div className="border-t border-(--line) px-3.5 py-2 text-small text-(--text-3)">
          Pick one, or type your own answer below.
        </div>
      ) : null}
    </section>
  );
});

/**
 * A question once answered, as Claude shows a decided card: the question, and
 * under it what was picked (its letter) or what you wrote instead. The
 * options it did not take are no longer worth the room.
 */
function AnsweredCard({
  question,
  answer,
  index,
}: {
  question: string;
  answer: string;
  index: number;
}) {
  return (
    <section
      className="in-card flex flex-col gap-1.5 px-3.5 py-2.5"
      aria-label="Answered question"
    >
      <span className="text-small leading-[16px] text-(--text-3)">
        Question
      </span>
      <h3 className="m-0 text-body leading-[19px] font-normal text-(--text)">
        {question}
      </h3>
      <p className="m-0 flex min-w-0 items-center gap-2 text-body leading-[18px]">
        <span className="inline-flex shrink-0 items-center gap-1 text-(--ok)">
          <Icon icon={Check} size={12} />
          {index >= 0 ? (
            <span className="in-num text-small">
              {String.fromCharCode(65 + index)}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 truncate font-medium text-(--text)">
          {answer}
        </span>
        <span className="shrink-0 text-small text-(--text-3)">
          {index >= 0 ? "You chose" : "You answered"}
        </span>
      </p>
    </section>
  );
}

/** The files this turn changed, from the task's diff, each opening in the Changes panel. */
export const ChangesCard = memo(function ChangesCard({
  sessionId,
  paths,
}: {
  sessionId: string;
  paths?: string[];
}) {
  const showPanel = useContext(ShowPanel);
  const changes = useQuery({
    queryKey: ["changes", sessionId, "unpushed"],
    queryFn: () => api.changes(sessionId),
  });
  const files = useChangedFiles(changes.data?.patch, paths);
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const open = (path: string) => {
    focusChange(sessionId, path);
    showPanel("Changes");
  };
  return (
    <FileIcons>
      <section className="in-card overflow-hidden" aria-label={paths ? "Files changed" : "Unpushed changes"}>
        <header className="flex h-9 items-center gap-2 px-3">
          <Icon icon={FileDiff} size={13} className="text-(--text-3)" />
          <span className="min-w-0 flex-1 truncate text-small text-(--text-2)">
            {paths ? (files.length === 1 ? "1 file changed" : `${files.length} files changed`) : (files.length === 1 ? "1 unpushed file" : `${files.length} unpushed files`)}
          </span>
          <span className="in-num text-small">
            <DiffStat added={added} removed={removed} />
          </span>
        </header>
        <div className="flex flex-col gap-px border-t border-(--line) p-1">
          {files.slice(0, 12).map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => open(file.path)}
              title={`Open ${file.path} in Changes`}
              className="flex h-7 items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus)"
            >
              <FileIcon path={file.path} />
              <PathName path={file.path} className="flex-1" />
              <span className="in-num shrink-0 text-micro">
                <DiffStat added={file.added} removed={file.removed} />
              </span>
              <DiffBars added={file.added} removed={file.removed} />
            </button>
          ))}
          {files.length > 12 ? (
            <button
              type="button"
              onClick={() => showPanel("Changes")}
              className="h-7 rounded-control px-2 text-left text-small text-(--text-3) hover:bg-(--bg-hover)"
            >
              {files.length - 12} more in Changes
            </button>
          ) : null}
        </div>
      </section>
    </FileIcons>
  );
});

/** The task's diff, kept to the files this turn wrote; a file changed back to how it was is left out. */
function useChangedFiles(patch: string | undefined, paths?: string[]): Diff[] {
  const key = paths?.join("\n");
  return useMemo(() => {
    if (!patch) return [];
    return parsedFiles(patch).filter((file) =>
      !paths || paths.some(
        (path) =>
          file.path === path ||
          file.path.endsWith(`/${path}`) ||
          path.endsWith(`/${file.path}`),
      ),
    );
  }, [patch, key]);
}

/** The last patch parsed, since every reply's card reads the same one. */
const parsed = new Map<string, Diff[]>();
function parsedFiles(patch: string): Diff[] {
  let files = parsed.get(patch);
  if (!files) {
    files = parsePatch(patch);
    parsed.clear();
    parsed.set(patch, files);
  }
  return files;
}

/** Only fetch the full PR when the user asks to merge, not on every reply or agent step. */
function ChatMerge({ sessionId, url }: { sessionId: string; url: string }) {
  const queryClient = useQueryClient();
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.pull>> | null>(null);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const load = useMutation({
    mutationFn: async () => {
      const number = Number(prNumber(url));
      if (!number) throw new Error('This pull request cannot be merged here.');
      const list = await queryClient.fetchQuery({ queryKey: ['pulls', sessionId], queryFn: () => api.pulls(sessionId), staleTime: 0 });
      if (!list.pulls.some((item) => item.number === number && item.url === url)) throw new Error('This pull request is not recorded for this task. Open it on GitHub to merge.');
      const pull = await queryClient.fetchQuery({ queryKey: ['pull', sessionId, number], queryFn: () => api.pull(sessionId, number), staleTime: 0 });
      if (pull.url !== url) throw new Error('This pull request could not be verified.');
      return pull;
    },
    onSuccess: setDetail,
  });
  if (detail) return <div className="px-3.5 pb-2.5 @min-[540px]/pr:py-2.5"><MergeBox sessionId={sessionId} pull={detail} ownWork compact initialConfirming initialMethod={method} onMerged={setDetail} /></div>;
  return <div className="flex min-w-0 flex-wrap items-center gap-2 px-3.5 pb-2.5 @min-[540px]/pr:py-2.5">
    <div className="flex shrink-0 items-center"><Btn size="sm" variant="secondary" icon={GitMerge} disabled={load.isPending} className="rounded-r-none" onClick={() => load.mutate()}>{load.isPending ? 'Checking pull request…' : mergeLabel[method]}</Btn><MergeMethodMenu method={method} onChange={setMethod} disabled={load.isPending} /></div>
    {load.isError ? <span role="alert" className="text-small text-(--bad)">{load.error.message}</span> : null}
  </div>;
}

/** The pull request a turn opened: its number and title, and its state and checks as GitHub last reported them. */
export const PullRequestCard = memo(function PullRequestCard({
  sessionId,
  url,
  title,
}: {
  sessionId: string;
  url: string;
  title: string;
}) {
  const session = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.session(sessionId),
  });
  const pull = session.data?.prUrl === url ? session.data.pullRequest : null;
  // .in-card lays itself out as a column, so the row is a link inside it.
  return (
    <div className="in-card @container/pr overflow-hidden">
      <div className="flex min-w-0 flex-col @min-[540px]/pr:flex-row @min-[540px]/pr:items-center">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="group/pr flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 no-underline outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-inset)"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-body leading-[18px] text-(--text)">{title || "Pull request"}</span>
          <span className="flex flex-wrap items-center gap-2 text-small leading-[16px] text-(--text-3)">
            <PrStatus thread={{ prUrl: url, pullRequest: pull }} showFailing={false} />
            <PrMetadata sessionId={sessionId} url={url} />
            <PrChecks pull={pull ?? null} />
          </span>
        </span>
        <Icon
          icon={ExternalLink}
          size={12}
          className="shrink-0 text-(--text-3) opacity-0 transition-opacity group-hover/pr:opacity-100"
        />
      </a>
      {session.data && !session.data.review && pull?.state === 'open' ? <ChatMerge key={url} sessionId={sessionId} url={url} /> : null}
      </div>
    </div>
  );
});
