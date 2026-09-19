import * as React from "react";
import { dictionaries, errorMessage, labels, type Locale } from "../../i18n";
import { validateContent, validateId, validatePassword, validateTitle } from "../../pastes";
import { isPasteError } from "../../types";
import type { PasteSummary } from "../contracts";
import type { CreateRequest, PasteApi } from "../api";
import { HelpTrigger } from "../components/HelpTrigger";
import { LocalActions } from "../components/LocalActions";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Expiration = 60 | 3_600 | 86_400 | 604_800 | 2_592_000 | 31_104_000 | "permanent";
type SubmissionState = "idle" | "pending" | "succeeded" | "failed";

export interface CreatePageProps {
  locale: Locale;
  create: PasteApi["create"];
}

interface CreateFields {
  content: string;
  title: string;
  format: "text" | "markdown";
  expiration: Expiration;
  password: string;
  viewOnce: boolean;
  customId: string;
}

const expirationOptions: ReadonlyArray<readonly [Expiration, keyof ReturnType<typeof labels>]> = [
  [60, "oneMinute"],
  [3_600, "oneHour"],
  [86_400, "oneDay"],
  [604_800, "oneWeek"],
  [2_592_000, "thirtyDays"],
  [31_104_000, "oneYear"],
  ["permanent", "permanent"],
];

const initialFields: CreateFields = {
  content: "",
  title: "",
  format: "text",
  expiration: 86_400,
  password: "",
  viewOnce: false,
  customId: "",
};

const representationKeys = ["view", "raw", "html", "markdown", "file"] as const;

function validationMessage(locale: Locale, error: unknown): string {
  if (!isPasteError(error)) return errorMessage(locale, "VALIDATION_FAILED");
  const detail = (error.details?.fields as Array<{ field?: string; message?: string }> | undefined)?.[0];
  const field = detail?.field;
  if (error.code === "CONTENT_TOO_LARGE") return dictionaries[locale].validation.contentTooLarge;
  if (field === "content") {
    return detail?.message?.includes("only Unicode scalar values") ? dictionaries[locale].validation.contentInvalidScalar : dictionaries[locale].validation.contentRequired;
  }
  if (field === "title") {
    return detail?.message?.includes("only Unicode scalar values") ? dictionaries[locale].validation.titleInvalidScalar : dictionaries[locale].validation.titleTooLong;
  }
  if (field === "password") return dictionaries[locale].validation.passwordInvalid;
  if (field === "id") return dictionaries[locale].validation.customIdInvalid;
  return errorMessage(locale, "VALIDATION_FAILED");
}

function validate(fields: CreateFields, locale: Locale): string | null {
  try {
    validateContent(fields.content);
    validateTitle(fields.title);
    validatePassword(fields.password);
    if (fields.customId !== "") validateId(fields.customId);
    return null;
  } catch (error) {
    return validationMessage(locale, error);
  }
}

function resultHref(path: string, password: string, protectedPaste: boolean): string {
  if (!protectedPaste) return path;
  const target = new URL(path, location.href);
  target.searchParams.set("password", password);
  return `${target.pathname}${target.search}${target.hash}`;
}

function filename(summary: PasteSummary): string {
  return summary.title === "" ? summary.id : summary.title;
}

export function CreatePage({ locale, create }: CreatePageProps) {
  const copy = labels(locale);
  const [fields, setFields] = React.useState<CreateFields>(initialFields);
  const [submission, setSubmission] = React.useState<SubmissionState>("idle");
  const [failure, setFailure] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ summary: PasteSummary; password: string; source: string } | null>(null);
  const [passwordVisible, setPasswordVisible] = React.useState(false);

  const update = <Key extends keyof CreateFields>(key: Key, value: CreateFields[Key]) => {
    setFields((current) => ({ ...current, [key]: value }));
    setFailure(null);
    setResult(null);
  };

  const onDrop = async (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    if (submission === "pending") return;
    const file = event.dataTransfer.files.item(0);
    if (file !== null) {
      const source = await file.text();
      const next = { ...fields, content: source, title: file.name };
      setFields(next);
      setResult(null);
      setFailure(validate(next, locale));
      return;
    }
    update("content", event.dataTransfer.getData("text/plain"));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submission === "pending") return;
    const error = validate(fields, locale);
    if (error !== null) {
      setSubmission("failed");
      setFailure(error);
      return;
    }

    const request: CreateRequest = {
      content: fields.content,
      title: fields.title,
      format: fields.format,
      expiration: fields.expiration,
      password: fields.password,
      viewOnce: fields.viewOnce,
      ...(fields.customId === "" ? {} : { customId: fields.customId }),
    };
    const password = fields.password;
    const source = fields.content;
    setSubmission("pending");
    setFailure(null);
    const response = await create(request, new AbortController().signal);
    if (response.ok) {
      setResult({ summary: response.value, password, source });
      setSubmission("succeeded");
      return;
    }
    setSubmission("failed");
    setFailure(errorMessage(locale, response.failure.code));
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <form className="flex min-w-0 flex-col gap-6" onSubmit={(event) => void submit(event)}>
        <FieldGroup>
          <Field>
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="create-content">{copy.content}</FieldLabel>
              <HelpTrigger label={`${copy.help}: ${copy.content}`} content={dictionaries[locale].help.contentLimit} descriptionId="create-content-help" />
            </div>
            <Textarea id="create-content" name="content" value={fields.content} aria-describedby="create-content-help" onChange={(event) => update("content", event.currentTarget.value)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void onDrop(event)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="create-title">{copy.title}</FieldLabel>
            <Input id="create-title" name="title" value={fields.title} onChange={(event) => update("title", event.currentTarget.value)} />
          </Field>
          <Field>
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="create-format">{copy.format}</FieldLabel>
              <HelpTrigger label={`${copy.help}: ${copy.format}`} content={dictionaries[locale].help.format} descriptionId="create-format-help" />
            </div>
            <select id="create-format" name="format" value={fields.format} aria-describedby="create-format-help" onChange={(event) => update("format", event.currentTarget.value as CreateFields["format"])}>
              <option value="text">{copy.text}</option>
              <option value="markdown">{copy.markdown}</option>
            </select>
          </Field>
          <Field>
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="create-expiration">{copy.expiration}</FieldLabel>
              <HelpTrigger label={`${copy.help}: ${copy.expiration}`} content={dictionaries[locale].help.expiration} descriptionId="create-expiration-help" />
            </div>
            <select id="create-expiration" name="expiration" value={String(fields.expiration)} aria-describedby="create-expiration-help" onChange={(event) => update("expiration", event.currentTarget.value === "permanent" ? "permanent" : Number(event.currentTarget.value) as Exclude<Expiration, "permanent">)}>
              {expirationOptions.map(([value, label]) => <option key={value} value={value}>{copy[label]}</option>)}
            </select>
          </Field>
          <Field>
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="create-password">{copy.password}</FieldLabel>
              <HelpTrigger label={`${copy.help}: ${copy.password}`} content={dictionaries[locale].help.password} descriptionId="create-password-help" />
            </div>
            <div className="flex gap-2">
              <Input id="create-password" name="password" type={passwordVisible ? "text" : "password"} value={fields.password} aria-describedby="create-password-help" onChange={(event) => update("password", event.currentTarget.value)} />
              <Button type="button" variant="outline" data-action="reveal" className="min-h-11" onClick={() => setPasswordVisible((visible) => !visible)}>{copy.reveal}</Button>
            </div>
          </Field>
          <Field>
            <label className="flex min-h-11 items-center gap-2" htmlFor="create-view-once">
              <Input id="create-view-once" name="viewOnce" type="checkbox" data-action="viewOnce" checked={fields.viewOnce} onChange={(event) => update("viewOnce", event.currentTarget.checked)} />
              <span>{copy.viewOnce}</span>
            </label>
          </Field>
          <Field>
            <FieldLabel htmlFor="create-custom-id">{copy.customId}</FieldLabel>
            <Input id="create-custom-id" name="customId" value={fields.customId} onChange={(event) => update("customId", event.currentTarget.value)} />
          </Field>
        </FieldGroup>
        {failure !== null && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        <Button type="submit" data-action="create" className="min-h-11 self-start" disabled={submission === "pending"}>{copy.submit}</Button>
      </form>
      {result !== null && (
        <section aria-label={result.summary.id} className="flex min-w-0 flex-col gap-3">
          <dl className="grid gap-2 sm:grid-cols-2">
            <div><dt>ID</dt><dd>{result.summary.id}</dd></div>
            <div><dt>{copy.title}</dt><dd>{result.summary.title}</dd></div>
            <div><dt>{copy.format}</dt><dd>{copy[result.summary.format]}</dd></div>
            <div><dt>{copy.viewOnce}</dt><dd>{result.summary.viewOnce ? copy.enabled : copy.standard}</dd></div>
            <div><dt>{copy.protected}</dt><dd>{result.summary.protected ? copy.enabled : copy.notProtected}</dd></div>
            <div><dt>{copy.size}</dt><dd>{result.summary.contentBytes} {copy.bytes}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-3">
            {representationKeys.map((kind) => <a key={kind} href={resultHref(result.summary.links[kind], result.password, result.summary.protected)}>{copy[kind]}</a>)}
          </div>
          <LocalActions actionScope={`create:${result.summary.id}`} source={result.source} locale={locale} filename={filename(result.summary)} capabilities={{ copy: true }} />
        </section>
      )}
    </div>
  );
}
