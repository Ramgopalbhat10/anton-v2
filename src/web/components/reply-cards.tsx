import { PrChecks, PrMetadata, PrStatus } from '@/components/pr-status';
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  FileDiff,
  MessageCircleQuestion,
} from "lucide-react";
import { createContext, memo, useContext, useMemo } from "react";
import { FileIcon, FileIcons } from "@/components/file-icons";
import { DiffBars, PathName } from "@/components/instrument";
import { Badge, DiffStat, Icon } from "@/components/signal";
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
    <section className="in-card overflow-hidden" aria-label="Question">
      <header className="flex items-start gap-2.5 px-3.5 pt-3 pb-2.5">
        <span className="mt-px inline-flex size-[22px] shrink-0 items-center justify-center rounded-[7px] border border-dashed border-(--accent-border) text-(--accent-text)">
          <Icon icon={MessageCircleQuestion} size={12} />
        </span>
        <h3 className="m-0 min-w-0 flex-1 text-[13px] leading-[20px] font-medium text-(--text-primary)">
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
                "group/option flex min-h-9 items-center gap-2.5 rounded-[9px] border px-2.5 py-1.5 text-left outline-none focus-visible:shadow-(--focus-ring)",
                chosen
                  ? "border-(--accent-border) bg-(--accent-bg-subtle)"
                  : "border-(--border-subtle)",
                open && !busy
                  ? "hover:border-(--border-strong) hover:bg-(--bg-hover)"
                  : "cursor-default",
                !open && !chosen && "opacity-55",
              )}
            >
              <span
                className={cn(
                  "in-num inline-flex size-5 shrink-0 items-center justify-center rounded-[6px] border text-[10.5px]",
                  chosen
                    ? "border-(--accent-border) text-(--accent-text)"
                    : "border-(--border-default) text-(--text-tertiary)",
                )}
              >
                {chosen ? <Icon icon={Check} size={11} /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[12.5px] leading-[18px] text-(--text-primary)">
                  {option.label}
                </span>
                {option.detail ? (
                  <span className="text-[11.5px] leading-[16px] text-(--text-tertiary)">
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
        <div className="border-t border-(--border-subtle) px-3.5 py-2 text-[11.5px] text-(--text-tertiary)">
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
      <span className="text-[11.5px] leading-[16px] text-(--text-tertiary)">
        Question
      </span>
      <h3 className="m-0 text-[13px] leading-[19px] font-normal text-(--text-primary)">
        {question}
      </h3>
      <p className="m-0 flex min-w-0 items-center gap-2 text-[12.5px] leading-[18px]">
        <span className="inline-flex shrink-0 items-center gap-1 text-(--success-text)">
          <Icon icon={Check} size={12} />
          {index >= 0 ? (
            <span className="in-num text-[11.5px]">
              {String.fromCharCode(65 + index)}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 truncate font-medium text-(--text-primary)">
          {answer}
        </span>
        <span className="shrink-0 text-[11.5px] text-(--text-tertiary)">
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
          <Icon icon={FileDiff} size={13} className="text-(--icon-tertiary)" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-(--text-secondary)">
            {paths ? (files.length === 1 ? "1 file changed" : `${files.length} files changed`) : (files.length === 1 ? "1 unpushed file" : `${files.length} unpushed files`)}
          </span>
          <span className="in-num text-[11.5px]">
            <DiffStat added={added} removed={removed} />
          </span>
        </header>
        <div className="flex flex-col gap-px border-t border-(--border-subtle) p-1">
          {files.slice(0, 12).map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => open(file.path)}
              title={`Open ${file.path} in Changes`}
              className="flex h-7 items-center gap-2 rounded-[7px] px-2 text-left outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
            >
              <FileIcon path={file.path} />
              <PathName path={file.path} className="flex-1" />
              <span className="in-num shrink-0 text-[11px]">
                <DiffStat added={file.added} removed={file.removed} />
              </span>
              <DiffBars added={file.added} removed={file.removed} />
            </button>
          ))}
          {files.length > 12 ? (
            <button
              type="button"
              onClick={() => showPanel("Changes")}
              className="h-7 rounded-[7px] px-2 text-left text-[12px] text-(--text-tertiary) hover:bg-(--bg-hover)"
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
    <div className="in-card">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="group/pr flex items-center gap-3 rounded-[inherit] px-3.5 py-2.5 no-underline outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[13px] leading-[18px] text-(--text-primary)">{title || "Pull request"}</span>
          <span className="flex flex-wrap items-center gap-2 text-[11.5px] leading-[16px] text-(--text-tertiary)">
            <PrStatus thread={{ prUrl: url, pullRequest: pull }} showFailing={false} />
            <PrMetadata sessionId={sessionId} url={url} />
            <PrChecks pull={pull ?? null} />
          </span>
        </span>
        <Icon
          icon={ExternalLink}
          size={12}
          className="shrink-0 text-(--icon-tertiary) opacity-0 transition-opacity group-hover/pr:opacity-100"
        />
      </a>
    </div>
  );
});
