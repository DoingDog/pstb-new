import * as React from "react";
import { dictionaries, errorMessage, labels, type Locale } from "../../i18n";
import { validateContent, validateId, validatePassword, validateTitle } from "../../pastes";
import { isPasteError } from "../../types";
import type { PasteSummary } from "../contracts";
import type { CreateRequest, PasteApi } from "../api";
import { HelpTrigger } from "../components/HelpTrigger";
import { LocalActions } from "../components/LocalActions";
import { NativeSelect } from "../components/NativeSelect";
import { Checkbox } from "../components/Checkbox";
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

type ValidationField = "content" | "title" | "password" | "customId";

type ValidationFailure = {
  field: ValidationField;
  message: string;
};

type PageFailure = ValidationFailure | {
  field: null;
  message: string;
};

function validationFailure(locale: Locale, error: unknown): ValidationFailure {
  if (!isPasteError(error)) return { field: "content", message: errorMessage(locale, "VALIDATION_FAILED") };
  const detail = (error.details?.fields as Array<{ field?: string; message?: string }> | undefined)?.[0];
  const field = detail?.field;
  if (error.code === "CONTENT_TOO_LARGE") return { field: "content", message: dictionaries[locale].validation.contentTooLarge };
  if (field === "content") {
    return {
      field,
      message: detail?.message?.includes("only Unicode scalar values") ? dictionaries[locale].validation.contentInvalidScalar : dictionaries[locale].validation.contentRequired,
    };
  }
  if (field === "title") {
    return {
      field,
      message: detail?.message?.includes("only Unicode scalar values")
        ? dictionaries[locale].validation.titleInvalidScalar
        : detail?.message?.includes("at most 200")
          ? dictionaries[locale].validation.titleTooLong
          : errorMessage(locale, "VALIDATION_FAILED"),
    };
  }
  if (field === "password") return { field, message: dictionaries[locale].validation.passwordInvalid };
  if (field === "id") return { field: "customId", message: dictionaries[locale].validation.customIdInvalid };
  return { field: "content", message: errorMessage(locale, "VALIDATION_FAILED") };
}

function validate(fields: CreateFields, locale: Locale): ValidationFailure | null {
  try {
    validateContent(fields.content);
    validateTitle(fields.title);
    validatePassword(fields.password);
    if (fields.customId !== "") validateId(fields.customId);
    return null;
  } catch (error) {
    return validationFailure(locale, error);
  }
}

function canonicalOffset(source: string, domOffset: number): number {
  let sourceOffset = 0;
  let normalizedOffset = 0;
  while (sourceOffset < source.length && normalizedOffset < domOffset) {
    if (source.charCodeAt(sourceOffset) === 13) {
      sourceOffset += source.charCodeAt(sourceOffset + 1) === 10 ? 2 : 1;
    } else {
      sourceOffset += 1;
    }
    normalizedOffset += 1;
  }
  return sourceOffset;
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
  const [failure, setFailure] = React.useState<PageFailure | null>(null);
  const [result, setResult] = React.useState<{ summary: PasteSummary; password: string; source: string } | null>(null);
  const [passwordVisible, setPasswordVisible] = React.useState(false);
  const canonicalContent = React.useRef(initialFields.content);
  const fileReadGeneration = React.useRef(0);
  const submissionGeneration = React.useRef(0);
  const submitting = React.useRef(false);
  const mounted = React.useRef(true);

  React.useEffect(() => () => {
    mounted.current = false;
    fileReadGeneration.current += 1;
    submissionGeneration.current += 1;
  }, []);

  const update = <Key extends keyof CreateFields>(key: Key, value: CreateFields[Key]) => {
    fileReadGeneration.current += 1;
    if (key === "content") canonicalContent.current = value as CreateFields["content"];
    setFields((current) => ({ ...current, [key]: value }));
    setFailure(null);
    setResult(null);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (submitting.current) return;
    event.preventDefault();
    const source = canonicalContent.current;
    const start = canonicalOffset(source, event.currentTarget.selectionStart);
    const end = canonicalOffset(source, event.currentTarget.selectionEnd);
    update("content", `${source.slice(0, start)}${event.clipboardData.getData("text/plain")}${source.slice(end)}`);
  };

  const onDrop = async (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const generation = ++fileReadGeneration.current;
    const file = event.dataTransfer.files.item(0);
    if (file === null) {
      const source = event.dataTransfer.getData("text/plain");
      canonicalContent.current = source;
      setFields((current) => ({ ...current, content: source }));
      setFailure(null);
      setResult(null);
      return;
    }

    const source = await file.text();
    if (!mounted.current || generation !== fileReadGeneration.current) return;
    canonicalContent.current = source;
    setFields((current) => ({ ...current, content: source, title: file.name }));
    setFailure(null);
    setResult(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const currentFields = { ...fields, content: canonicalContent.current };
    const error = validate(currentFields, locale);
    if (error !== null) {
      setSubmission("failed");
      setFailure(error);
      return;
    }

    const request: CreateRequest = {
      content: currentFields.content,
      title: currentFields.title,
      format: currentFields.format,
      expiration: currentFields.expiration,
      password: currentFields.password,
      viewOnce: currentFields.viewOnce,
      ...(currentFields.customId === "" ? {} : { customId: currentFields.customId }),
    };
    const attempt = ++submissionGeneration.current;
    const password = currentFields.password;
    const source = currentFields.content;
    submitting.current = true;
    fileReadGeneration.current += 1;
    setSubmission("pending");
    setFailure(null);

    try {
      const response = await create(request, new AbortController().signal);
      if (!mounted.current || attempt !== submissionGeneration.current) return;
      submitting.current = false;
      if (response.ok) {
        setResult({ summary: response.value, password, source });
        setSubmission("succeeded");
        return;
      }
      setSubmission("failed");
      setFailure({ field: null, message: errorMessage(locale, response.failure.code) });
    } catch {
      if (!mounted.current || attempt !== submissionGeneration.current) return;
      submitting.current = false;
      setSubmission("failed");
      setFailure({ field: null, message: errorMessage(locale, "NETWORK_ERROR") });
    }
  };

  const failed = (field: ValidationField): boolean => failure?.field === field;

  return (
    <div className="@container flex min-w-0 flex-1 flex-col gap-6">
      <form className="grid min-w-0 flex-1 grid-cols-1 gap-4 @lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" onSubmit={(event) => void submit(event)}>
        <div data-create-content-column className="flex min-w-0 flex-col">
          <Field className="flex-1">
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="create-content">{copy.content}</FieldLabel>
              <HelpTrigger label={`${copy.help}: ${copy.content}`} content={dictionaries[locale].help.contentLimit} descriptionId="create-content-help" />
            </div>
            <Textarea id="create-content" name="content" value={fields.content} rows={6} className="min-h-44 @lg:flex-1" aria-describedby="create-content-help" aria-invalid={failed("content") || undefined} aria-errormessage={failed("content") ? "create-validation-error" : undefined} onChange={(event) => update("content", event.currentTarget.value)} onPaste={onPaste} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void onDrop(event)} />
          </Field>
        </div>
        <div data-create-options-column className="flex min-w-0 flex-col gap-4">
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="create-title">{copy.title}</FieldLabel>
              <Input id="create-title" name="title" value={fields.title} className="min-h-11" aria-invalid={failed("title") || undefined} aria-errormessage={failed("title") ? "create-validation-error" : undefined} onChange={(event) => update("title", event.currentTarget.value)} />
            </Field>
            <Field>
              <div className="flex items-center gap-2">
                <FieldLabel htmlFor="create-format">{copy.format}</FieldLabel>
                <HelpTrigger label={`${copy.help}: ${copy.format}`} content={dictionaries[locale].help.format} descriptionId="create-format-help" />
              </div>
              <NativeSelect id="create-format" name="format" value={fields.format} aria-describedby="create-format-help" onChange={(event) => update("format", event.currentTarget.value as CreateFields["format"])}>
                <option value="text">{copy.text}</option>
                <option value="markdown">{copy.markdown}</option>
              </NativeSelect>
            </Field>
            <Field>
              <div className="flex items-center gap-2">
                <FieldLabel htmlFor="create-expiration">{copy.expiration}</FieldLabel>
                <HelpTrigger label={`${copy.help}: ${copy.expiration}`} content={dictionaries[locale].help.expiration} descriptionId="create-expiration-help" />
              </div>
              <NativeSelect id="create-expiration" name="expiration" value={String(fields.expiration)} aria-describedby="create-expiration-help" onChange={(event) => update("expiration", event.currentTarget.value === "permanent" ? "permanent" : Number(event.currentTarget.value) as Exclude<Expiration, "permanent">)}>
                {expirationOptions.map(([value, label]) => <option key={value} value={value}>{copy[label]}</option>)}
              </NativeSelect>
            </Field>
            <Field>
              <div className="flex items-center gap-2">
                <FieldLabel htmlFor="create-password">{copy.password}</FieldLabel>
                <HelpTrigger label={`${copy.help}: ${copy.password}`} content={dictionaries[locale].help.password} descriptionId="create-password-help" />
              </div>
              <div className="flex gap-2">
                <Input id="create-password" name="password" type={passwordVisible ? "text" : "password"} value={fields.password} className="min-h-11" aria-describedby="create-password-help" aria-invalid={failed("password") || undefined} aria-errormessage={failed("password") ? "create-validation-error" : undefined} onChange={(event) => update("password", event.currentTarget.value)} />
                <Button type="button" variant="outline" data-action="reveal" className="min-h-11" onClick={() => setPasswordVisible((visible) => !visible)}>{copy.reveal}</Button>
              </div>
            </Field>
            <Field>
              <label className="flex min-h-11 items-center gap-2" htmlFor="create-view-once">
                <Checkbox id="create-view-once" name="viewOnce" data-action="viewOnce" checked={fields.viewOnce} onChange={(event) => update("viewOnce", event.currentTarget.checked)} />
                <span>{copy.viewOnce}</span>
              </label>
            </Field>
            <Field>
              <FieldLabel htmlFor="create-custom-id">{copy.customId}</FieldLabel>
              <Input id="create-custom-id" name="customId" value={fields.customId} className="min-h-11" aria-invalid={failed("customId") || undefined} aria-errormessage={failed("customId") ? "create-validation-error" : undefined} onChange={(event) => update("customId", event.currentTarget.value)} />
            </Field>
          </FieldGroup>
          {failure !== null && <p id="create-validation-error" role="alert" className="text-sm text-destructive">{failure.message}</p>}
          <Button type="submit" data-action="create" className="min-h-11 self-start" disabled={submission === "pending"}>{copy.submit}</Button>
        </div>
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
