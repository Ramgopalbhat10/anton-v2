import {
  ArrowDown,
  ArrowUp,
  Check,
  ChartColumn,
  FileText,
  Send,
  Table2,
} from "lucide-react";
import {
  createContext,
  Fragment,
  memo,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  buttonMessage,
  evaluate,
  formatValue,
  formMessage,
  libraryPath,
  numberOf,
  optionValue,
  parseFormula,
  type UiCell,
  type UiNode,
  type UiSpec,
  type UiTone,
  walk,
} from "../../core/ui-spec";
import { CodeBlock } from "@/components/code-block";
import { Markdown, FileLinks } from "@/components/markdown";
import { type ReplyPlace, ReplyActions } from "@/components/reply-cards";
import { Badge, Btn, Icon, Switch } from "@/components/signal";
import { UiChart } from "@/components/ui-chart";
import { outputUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

/*
 * A card the agent drew with its `show` tool (src/core/ui-spec.ts has the
 * catalog). Sorting, switching a chart to its table, inputs and formulas all
 * work here in the browser; a button or a form's submit sends the user's next
 * message, and once one has followed the card shows what was sent.
 */

type Values = Record<string, unknown>;

type ShowState = {
  sessionId: string;
  values: Values;
  set: (name: string, value: unknown) => void;
  /** Buttons and forms can send: the card is in the latest reply, nothing has followed it, and the agent is not working. */
  canSend: boolean;
  /** The message that followed the card, if any. */
  answer: string | null;
  send: (text: string) => void;
  /** Inside a form that was sent: its inputs keep what was sent. */
  sent: boolean;
};

const ShowState = createContext<ShowState | null>(null);

const TONE_TEXT: Record<UiTone, string> = {
  neutral: "text-(--text-tertiary)",
  accent: "text-(--accent-text)",
  success: "text-(--success-text)",
  warning: "text-(--warning-text)",
  danger: "text-(--danger-text)",
};

const FIELD =
  "h-8 w-full min-w-0 rounded-lg border border-(--border-subtle) bg-(--well-bg) px-2.5 text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-disabled) focus-visible:shadow-(--focus-ring) disabled:opacity-60";

/** Each input's starting value: what the agent set, else the first option, nothing, or off. */
function startingValues(spec: UiSpec): Values {
  const values: Values = {};
  walk(spec.children, (node) => {
    switch (node.type) {
      case "choice":
        values[node.name] = node.multiple ? [] : undefined;
        break;
      case "select":
        values[node.name] = optionValue(node.options[0]);
        break;
      case "number":
        values[node.name] = node.value ?? node.min ?? 0;
        break;
      case "toggle":
        values[node.name] = node.value ?? false;
        break;
      case "text_input":
        values[node.name] = "";
        break;
    }
  });
  return values;
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12px] leading-[16px] text-(--text-secondary)">
      {children}
    </span>
  );
}

function Stat({ node }: { node: Extract<UiNode, { type: "stat" }> }) {
  const tone =
    node.tone ??
    (node.change?.trim().startsWith("-") || node.change?.trim().startsWith("−")
      ? "danger"
      : node.change?.trim().startsWith("+")
        ? "success"
        : "neutral");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="in-caption truncate">{node.label}</span>
      <span className="flex items-baseline gap-2">
        <span className="in-num text-[20px] leading-[24px] font-medium tracking-[-0.01em] text-(--text-primary)">
          {formatValue(node.value, node.format)}
        </span>
        {node.change ? (
          <span className={cn("in-num text-[12px]", TONE_TEXT[tone])}>
            {node.change}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function Table({ node }: { node: Extract<UiNode, { type: "table" }> }) {
  const [sort, setSort] = useState<{ key: string; up: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return node.rows;
    const compare = (a: UiCell | undefined, b: UiCell | undefined) => {
      const x = numberOf(a);
      const y = numberOf(b);
      if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
      return String(a ?? "").localeCompare(String(b ?? ""), undefined, {
        numeric: true,
      });
    };
    return [...node.rows].sort(
      (a, b) => compare(a[sort.key], b[sort.key]) * (sort.up ? 1 : -1),
    );
  }, [node.rows, sort]);
  const numeric = (key: string, format?: string) =>
    (format && format !== "text") ||
    (node.rows.length > 0 &&
      node.rows.every(
        (row) =>
          row[key] === null ||
          row[key] === undefined ||
          typeof row[key] === "number",
      ));
  return (
    <div className="max-h-[420px] overflow-auto rounded-[10px] border border-(--border-subtle)">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-[1] bg-(--card-bg)">
          <tr>
            {node.columns.map((column) => {
              const right = column.align
                ? column.align === "right"
                : numeric(column.key, column.format);
              const sorted = sort?.key === column.key ? sort : null;
              return (
                <th
                  key={column.key}
                  className={cn(
                    "border-b border-(--border-subtle) p-0 font-medium",
                    right ? "text-right" : "text-left",
                  )}
                  aria-sort={
                    sorted ? (sorted.up ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort(
                        sorted
                          ? sorted.up
                            ? { key: column.key, up: false }
                            : null
                          : { key: column.key, up: true },
                      )
                    }
                    className={cn(
                      "flex h-8 w-full items-center gap-1 px-2.5 text-(--text-secondary) outline-none hover:text-(--text-primary) focus-visible:shadow-(--focus-ring-inset)",
                      right && "justify-end",
                    )}
                  >
                    {column.label ?? column.key}
                    {sorted ? (
                      <Icon icon={sorted.up ? ArrowUp : ArrowDown} size={11} />
                    ) : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              className="border-b border-(--border-subtle) last:border-b-0 hover:bg-(--bg-hover)"
            >
              {node.columns.map((column) => {
                const right = column.align
                  ? column.align === "right"
                  : numeric(column.key, column.format);
                return (
                  <td
                    key={column.key}
                    className={cn(
                      "h-8 px-2.5 py-1 align-middle text-(--text-primary)",
                      right && "in-num text-right",
                    )}
                  >
                    {formatValue(
                      row[column.key],
                      column.format ??
                        (typeof row[column.key] === "number"
                          ? "number"
                          : "text"),
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A chart with its title, and a switch to read it as a table. */
function Chart({ node }: { node: Extract<UiNode, { type: "chart" }> }) {
  const [asTable, setAsTable] = useState(false);
  const table: Extract<UiNode, { type: "table" }> = {
    type: "table",
    columns: [
      { key: node.x },
      ...node.series.map((series) => ({
        key: series.key,
        label: series.label,
        format: node.format,
      })),
    ],
    rows: node.data,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        {node.title ? (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-(--text-primary)">
            {node.title}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <button
          type="button"
          onClick={() => setAsTable((current) => !current)}
          aria-label={asTable ? "Show as a chart" : "Show as a table"}
          title={asTable ? "Show as a chart" : "Show as a table"}
          className="inline-flex size-6 items-center justify-center rounded-md text-(--icon-tertiary) outline-none hover:bg-(--bg-hover) hover:text-(--icon-secondary) focus-visible:shadow-(--focus-ring)"
        >
          <Icon icon={asTable ? ChartColumn : Table2} size={13} />
        </button>
      </div>
      {asTable ? <Table node={table} /> : <UiChart node={node} />}
    </div>
  );
}

/** Pieces that need room: in a row they wrap onto their own line before going narrower than 260px. */
const WIDE = new Set<UiNode["type"]>([
  "card",
  "chart",
  "table",
  "timeline",
  "form",
  "diff",
  "code",
  "col",
]);

function Timeline({ node }: { node: Extract<UiNode, { type: "timeline" }> }) {
  const DOT = {
    done: "bg-(--success-base)",
    active: "bg-(--accent-base) in-pulse",
    pending: "bg-(--neutral-600)",
    failed: "bg-(--danger-base)",
  } as const;
  return (
    <ol className="relative m-0 flex list-none flex-col gap-2.5 p-0">
      <span
        aria-hidden
        className="absolute top-2 bottom-2 left-[4.5px] w-px bg-(--border-default)"
      />
      {node.items.map((item, index) => (
        <li key={index} className="relative flex gap-3">
          <span
            className={cn(
              "relative z-[1] mt-[5px] size-2.5 shrink-0 rounded-full ring-[3px] ring-(--card-bg)",
              DOT[item.state ?? "pending"],
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 text-[12.5px] leading-[18px] [overflow-wrap:anywhere]",
                  item.state === "pending"
                    ? "text-(--text-secondary)"
                    : "text-(--text-primary)",
                )}
              >
                {item.title}
              </span>
              {item.time ? (
                <span className="in-num shrink-0 text-[11px] text-(--text-tertiary)">
                  {item.time}
                </span>
              ) : null}
            </span>
            {item.detail ? (
              <span className="text-[12px] leading-[17px] text-(--text-tertiary)">
                {item.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Diff({ node }: { node: Extract<UiNode, { type: "diff" }> }) {
  const lines = node.patch.replace(/\n$/, "").split("\n");
  return (
    <div className="overflow-hidden rounded-[10px] border border-(--border-subtle) bg-(--bg-inset)">
      {node.path ? (
        <div className="in-caption flex h-7 items-center border-b border-(--border-subtle) px-3">
          {node.path}
        </div>
      ) : null}
      <pre className="m-0 max-h-80 overflow-auto py-1.5 font-mono text-[12px] leading-[18px]">
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "px-3 whitespace-pre",
              line.startsWith("+") && !line.startsWith("+++")
                ? "bg-(--success-bg) text-(--success-text)"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "bg-(--danger-bg) text-(--danger-text)"
                  : line.startsWith("@@")
                    ? "text-(--accent-text)"
                    : "text-(--text-secondary)",
            )}
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function FileRef({ node }: { node: Extract<UiNode, { type: "file" }> }) {
  const links = useContext(FileLinks);
  const text = `${node.path}${node.line ? `:${node.line}` : ""}`;
  const body = (
    <>
      <Icon
        icon={FileText}
        size={13}
        className="shrink-0 text-(--icon-tertiary)"
      />
      <span className="min-w-0 truncate font-mono text-[12px]">
        {node.label ?? text}
      </span>
      {node.label ? (
        <span className="min-w-0 truncate font-mono text-[11px] text-(--text-tertiary)">
          {text}
        </span>
      ) : null}
    </>
  );
  if (!links)
    return <span className="flex min-w-0 items-center gap-2">{body}</span>;
  return (
    <button
      type="button"
      onClick={() => links.open(node.path, node.line)}
      title={`Open ${text} in Files`}
      className="flex h-8 max-w-full min-w-0 items-center gap-2 self-start rounded-lg border border-(--border-subtle) px-2.5 text-(--accent-text) outline-none hover:bg-(--bg-hover) focus-visible:shadow-(--focus-ring)"
    >
      {body}
    </button>
  );
}

function Formula({ node }: { node: Extract<UiNode, { type: "value" }> }) {
  const state = useContext(ShowState);
  const expr = useMemo(() => {
    try {
      return parseFormula(node.formula);
    } catch {
      return null;
    }
  }, [node.formula]);
  const numbers = Object.fromEntries(
    Object.entries(state?.values ?? {}).map(([name, value]) => [
      name,
      numberOf(value),
    ]),
  );
  const result = expr ? evaluate(expr, numbers) : Number.NaN;
  return (
    <div className="flex min-w-0 flex-col gap-1" aria-live="polite">
      <span className="in-caption truncate">{node.label}</span>
      <span className="in-num text-[20px] leading-[24px] font-medium tracking-[-0.01em] text-(--text-primary)">
        {Number.isFinite(result)
          ? formatValue(result, node.format ?? "number")
          : "–"}
      </span>
    </div>
  );
}

function Choice({ node }: { node: Extract<UiNode, { type: "choice" }> }) {
  const state = useContext(ShowState);
  if (!state) return null;
  const value = state.values[node.name];
  const chosen = (option: string) =>
    Array.isArray(value) ? value.includes(option) : value === option;
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      disabled={state.sent}
    >
      {node.label ? (
        <legend className="mb-1.5 p-0">
          <Label>{node.label}</Label>
        </legend>
      ) : null}
      <div
        className="flex flex-wrap gap-1.5"
        role={node.multiple ? "group" : "radiogroup"}
        aria-label={node.label ?? node.name}
      >
        {node.options.map((option) => {
          const key = optionValue(option);
          const on = chosen(key);
          return (
            <button
              key={key}
              type="button"
              role={node.multiple ? "checkbox" : "radio"}
              aria-checked={on}
              title={option.detail}
              onClick={() =>
                state.set(
                  node.name,
                  node.multiple
                    ? on
                      ? (value as string[]).filter((item) => item !== key)
                      : [...((value as string[]) ?? []), key]
                    : key,
                )
              }
              className={cn(
                "flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-left text-[12.5px] outline-none focus-visible:shadow-(--focus-ring) disabled:cursor-default",
                on
                  ? "border-(--accent-border) bg-(--accent-bg-subtle) text-(--text-primary)"
                  : "border-(--border-subtle) text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)",
              )}
            >
              {on ? (
                <Icon icon={Check} size={12} className="text-(--accent-text)" />
              ) : null}
              <span className="flex flex-col">
                <span>{option.label}</span>
                {option.detail ? (
                  <span className="text-[11px] text-(--text-tertiary)">
                    {option.detail}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function NumberInput({ node }: { node: Extract<UiNode, { type: "number" }> }) {
  const state = useContext(ShowState);
  if (!state) return null;
  const value = numberOf(state.values[node.name]);
  const shown = Number.isFinite(value) ? value : "";
  const update = (raw: string) =>
    state.set(node.name, raw === "" ? "" : Number(raw));
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <Label>{node.label ?? node.name}</Label>
        {node.slider ? (
          <span className="in-num text-[12px] text-(--text-primary)">
            {shown}
          </span>
        ) : null}
      </span>
      {node.slider ? (
        <input
          type="range"
          min={node.min ?? 0}
          max={node.max ?? 100}
          step={node.step ?? 1}
          value={shown}
          disabled={state.sent}
          onChange={(event) => update(event.target.value)}
          className="sg-range w-full accent-(--accent-base)"
        />
      ) : (
        <input
          type="number"
          min={node.min}
          max={node.max}
          step={node.step}
          value={shown}
          disabled={state.sent}
          onChange={(event) => update(event.target.value)}
          className={cn(FIELD, "in-num")}
        />
      )}
    </label>
  );
}

function SendButton({ node }: { node: Extract<UiNode, { type: "button" }> }) {
  const state = useContext(ShowState);
  if (!state) return null;
  const message = buttonMessage(node);
  const chosen =
    state.answer !== null && state.answer.trim() === message.trim();
  return (
    <Btn
      size="sm"
      variant={
        chosen || (node.primary && state.canSend) ? "primary" : "secondary"
      }
      icon={chosen ? Check : undefined}
      disabled={!state.canSend}
      aria-pressed={state.answer !== null ? chosen : undefined}
      onClick={() => state.send(message)}
      className={cn(
        "self-start",
        state.answer !== null && !chosen && "opacity-55",
      )}
    >
      {node.label}
    </Btn>
  );
}

function Form({ node }: { node: Extract<UiNode, { type: "form" }> }) {
  const state = useContext(ShowState);
  if (!state) return null;
  const sent =
    state.answer !== null &&
    state.answer.startsWith(`Submitted "${node.title}"`);
  return (
    <form
      className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-(--border-subtle) p-3"
      aria-label={node.title}
      onSubmit={(event) => {
        event.preventDefault();
        if (state.canSend) state.send(formMessage(node, state.values));
      }}
    >
      <span className="text-[12.5px] font-medium text-(--text-primary)">
        {node.title}
      </span>
      <ShowState.Provider
        value={{ ...state, sent: sent || state.answer !== null }}
      >
        <Nodes nodes={node.children} />
      </ShowState.Provider>
      <div className="flex items-center gap-2">
        <Btn
          type="submit"
          size="sm"
          variant={sent ? "secondary" : "primary"}
          icon={sent ? Check : Send}
          disabled={!state.canSend}
        >
          {sent ? "Sent" : (node.submit ?? "Submit")}
        </Btn>
      </div>
    </form>
  );
}

function NodeView({ node }: { node: UiNode }) {
  const state = useContext(ShowState);
  switch (node.type) {
    case "card":
      return (
        <section className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-(--border-subtle) p-3">
          {node.title || node.caption ? (
            <header className="flex flex-col gap-0.5">
              {node.title ? (
                <span className="text-[12.5px] font-medium text-(--text-primary)">
                  {node.title}
                </span>
              ) : null}
              {node.caption ? (
                <span className="text-[11.5px] text-(--text-tertiary)">
                  {node.caption}
                </span>
              ) : null}
            </header>
          ) : null}
          <Nodes nodes={node.children} />
        </section>
      );
    case "row":
      return (
        <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
          {node.children.map((child, index) => (
            // Panels wrap under each other on a narrow reply rather than squeezing; small pieces sit side by side.
            <div
              key={index}
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                WIDE.has(child.type) ? "basis-[260px]" : "basis-[120px]",
                child.type === "card" && "*:flex-1",
              )}
            >
              <NodeView node={child} />
            </div>
          ))}
        </div>
      );
    case "col":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <Nodes nodes={node.children} />
        </div>
      );
    case "divider":
      return <hr className="m-0 border-0 border-t border-(--border-subtle)" />;
    case "text":
      return (
        <div
          className={cn(
            node.muted &&
              "text-(--text-secondary) [&_.sg-markdown]:text-(--text-secondary)",
          )}
        >
          <Markdown text={node.text} />
        </div>
      );
    case "stat":
      return <Stat node={node} />;
    case "badge":
      return (
        <span className="self-start">
          <Badge tone={node.tone ?? "neutral"}>{node.label}</Badge>
        </span>
      );
    case "list":
      return (
        <Markdown
          text={node.items
            .map(
              (item, index) =>
                `${node.ordered ? `${index + 1}.` : "-"} ${item.replace(/\n/g, " ")}`,
            )
            .join("\n")}
        />
      );
    case "code":
      return (
        <CodeBlock code={node.code} language={node.language} className="mb-0" />
      );
    case "diff":
      return <Diff node={node} />;
    case "file":
      return <FileRef node={node} />;
    case "image":
      return state ? (
        <a
          href={outputUrl(state.sessionId, libraryPath(node.path))}
          target="_blank"
          rel="noreferrer"
          className="block w-fit"
        >
          <img
            src={outputUrl(state.sessionId, libraryPath(node.path))}
            alt={node.alt ?? node.path}
            className="block max-h-80 max-w-full rounded-[10px] border border-(--card-border)"
          />
        </a>
      ) : null;
    case "table":
      return <Table node={node} />;
    case "chart":
      return <Chart node={node} />;
    case "progress": {
      const share = Math.min(1, Math.max(0, node.value / (node.max ?? 100)));
      const tone =
        node.tone === "danger"
          ? "bg-(--danger-base)"
          : node.tone === "warning"
            ? "bg-(--warning-base)"
            : node.tone === "success"
              ? "bg-(--success-base)"
              : "bg-(--accent-base)";
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-baseline justify-between gap-2">
            <Label>{node.label}</Label>
            <span className="in-num text-[12px] text-(--text-primary)">
              {Math.round(share * 100)}%
            </span>
          </span>
          <div
            role="progressbar"
            aria-label={node.label}
            aria-valuenow={Math.round(share * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-(--neutral-750)"
          >
            <div
              className={cn("h-full rounded-full", tone)}
              style={{ width: `${share * 100}%` }}
            />
          </div>
        </div>
      );
    }
    case "timeline":
      return <Timeline node={node} />;
    case "value":
      return <Formula node={node} />;
    case "button":
      return <SendButton node={node} />;
    case "choice":
      return <Choice node={node} />;
    case "select":
      return state ? (
        <label className="flex min-w-0 flex-col gap-1.5">
          <Label>{node.label ?? node.name}</Label>
          <select
            value={String(state.values[node.name] ?? "")}
            disabled={state.sent}
            onChange={(event) => state.set(node.name, event.target.value)}
            className={FIELD}
          >
            {node.options.map((option) => (
              <option key={optionValue(option)} value={optionValue(option)}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null;
    case "text_input":
      return state ? (
        <label className="flex min-w-0 flex-col gap-1.5">
          <Label>{node.label ?? node.name}</Label>
          {node.multiline ? (
            <textarea
              value={String(state.values[node.name] ?? "")}
              placeholder={node.placeholder}
              disabled={state.sent}
              rows={3}
              onChange={(event) => state.set(node.name, event.target.value)}
              className={cn(FIELD, "h-auto py-1.5 leading-[18px]")}
            />
          ) : (
            <input
              value={String(state.values[node.name] ?? "")}
              placeholder={node.placeholder}
              disabled={state.sent}
              onChange={(event) => state.set(node.name, event.target.value)}
              className={FIELD}
            />
          )}
        </label>
      ) : null;
    case "number":
      return <NumberInput node={node} />;
    case "toggle":
      return state ? (
        <Switch
          checked={Boolean(state.values[node.name])}
          disabled={state.sent}
          onChange={(on) => state.set(node.name, on)}
          label={node.label}
          className="self-start text-left"
        />
      ) : null;
    case "form":
      return <Form node={node} />;
    default:
      // A component from a newer catalog than this page knows draws nothing.
      return null;
  }
}

function Nodes({ nodes }: { nodes: UiNode[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>
          <NodeView node={node} />
        </Fragment>
      ))}
    </>
  );
}

/** True when a tool's input looks like a card's tree; the server checked it, but history can hold anything. */
function asSpec(input: unknown): UiSpec | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.children)) return null;
  const title = typeof record.title === "string" ? record.title : undefined;
  const children = record.children.filter(
    (child): child is UiNode =>
      Boolean(child) &&
      typeof child === "object" &&
      typeof (child as UiNode).type === "string",
  );
  // A card holding one card would draw a frame in a frame: the inner one becomes the card.
  const only =
    children.length === 1 && children[0].type === "card" ? children[0] : null;
  if (only && !(title && only.title)) {
    const caption: UiNode[] = only.caption
      ? [{ type: "text", text: only.caption, muted: true }]
      : [];
    return {
      title: title ?? only.title,
      children: [...caption, ...only.children],
    };
  }
  return { title, children };
}

export const ShowCard = memo(function ShowCard({
  sessionId,
  input,
  place,
}: {
  sessionId: string;
  input: unknown;
  place: ReplyPlace;
}) {
  const spec = useMemo(() => asSpec(input), [input]);
  const { send, busy } = useContext(ReplyActions);
  const [values, setValues] = useState<Values>(() =>
    spec ? startingValues(spec) : {},
  );
  const state = useMemo<ShowState>(
    () => ({
      sessionId,
      values,
      set: (name, value) =>
        setValues((current) => ({ ...current, [name]: value })),
      canSend: place.latest && place.answer === null && !busy,
      answer: place.answer,
      send,
      sent: false,
    }),
    [sessionId, values, place.latest, place.answer, busy, send],
  );
  if (!spec || spec.children.length === 0) return null;
  // Inputs outside any form only feed formulas, so they stay live after the reply, like a calculator.
  return (
    <ShowState.Provider value={state}>
      <section
        className="in-card flex min-w-0 flex-col gap-3.5 px-4 pt-3.5 pb-4"
        aria-label={spec.title ?? "Card"}
      >
        {spec.title ? (
          <h3 className="m-0 text-[13px] leading-[18px] font-medium text-(--text-primary)">
            {spec.title}
          </h3>
        ) : null}
        <Nodes nodes={spec.children} />
      </section>
    </ShowState.Provider>
  );
});
