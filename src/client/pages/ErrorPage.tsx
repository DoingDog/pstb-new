import { errorMessage, labels, normalizeErrorMessageCode, type Locale } from "../../i18n";

export interface ErrorPageProps {
  locale: Locale;
  status: number;
  errorCode: string;
}

export function ErrorPage({ locale, status, errorCode }: ErrorPageProps) {
  const copy = labels(locale);
  const safeStatus = Number.isSafeInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const code = normalizeErrorMessageCode(errorCode);

  return (
    <section className="flex flex-col gap-4">
      <h2>{safeStatus}</h2>
      <p role="alert">{errorMessage(locale, code)}</p>
      <a href="/" className="inline-flex min-h-11 min-w-11 w-fit items-center text-primary underline-offset-4 hover:underline">{copy.create}</a>
    </section>
  );
}
