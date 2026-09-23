import * as React from "react";
import { type Locale } from "../../i18n";
import type { TrustedMarkdownHtml } from "../bootstrap";
import { LocalActions, type ClipboardPort, type DownloadPort, type NavigationPort } from "../components/LocalActions";
import { SafeMarkdown } from "../components/SafeMarkdown";

export interface MarkdownPageProps {
  locale: Locale;
  title: string;
  source: string;
  initialMarkdown: TrustedMarkdownHtml;
  clipboard?: ClipboardPort;
  download?: DownloadPort;
  navigation?: NavigationPort;
}

export function MarkdownPage({ locale, title, source, initialMarkdown, clipboard, download, navigation }: MarkdownPageProps) {
  const [wrap, setWrap] = React.useState(false);
  const [sourceVisible, setSourceVisible] = React.useState(false);

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h2>{title}</h2>
      <LocalActions
        actionScope={`markdown:${title}:${source}`}
        source={source}
        locale={locale}
        filename={title === "" ? "paste.md" : title}
        capabilities={{
          copy: true,
          download: true,
          wrap: { value: wrap, onChange: setWrap },
          sourcePreview: {
            sourceVisible,
            onSourceVisibleChange: setSourceVisible,
            preview: <SafeMarkdown html={initialMarkdown} wrap={wrap} />,
          },
        }}
        {...(clipboard === undefined ? {} : { clipboard })}
        {...(download === undefined ? {} : { download })}
        {...(navigation === undefined ? {} : { navigation })}
      />
    </section>
  );
}
