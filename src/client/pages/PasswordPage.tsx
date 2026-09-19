import * as React from "react";
import { errorMessage, labels, type Locale } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface PasswordPageProps {
  locale: Locale;
  errorCode: null | "FORBIDDEN";
}

export function PasswordPage({ locale, errorCode }: PasswordPageProps) {
  const copy = labels(locale);
  const [password, setPassword] = React.useState("");
  const [visible, setVisible] = React.useState(false);

  return (
    <form method="post" encType="application/x-www-form-urlencoded" className="flex max-w-md flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="password">{copy.password}</FieldLabel>
        <div className="flex gap-2">
          <Input id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
          <Button type="button" variant="outline" data-action="reveal" className="min-h-11" onClick={() => setVisible((current) => !current)}>{copy.reveal}</Button>
        </div>
      </Field>
      {errorCode === "FORBIDDEN" && <p role="alert" className="text-sm text-destructive">{errorMessage(locale, errorCode)}</p>}
      <Button type="submit" data-action="submit-password" className="min-h-11 self-start">{copy.continue}</Button>
    </form>
  );
}
