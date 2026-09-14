// Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.
import { errorMessage, labels } from "../i18n";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import type { InitialPage } from "./bootstrap";

interface AppProps {
  initialPage: InitialPage;
}

function PageContent({ initialPage }: AppProps) {
  switch (initialPage.ok) {
    case false: {
      const copy = labels(initialPage.locale);
      return (
        <>
          <h1>{copy.error}</h1>
          <p role="alert">{errorMessage(initialPage.locale, initialPage.errorCode)}</p>
        </>
      );
    }
    case true: {
      const { bootstrap } = initialPage;
      const copy = labels(bootstrap.locale);
      let title: string;

      switch (bootstrap.page) {
        case "create":
          title = copy.create;
          break;
        case "paste":
          title = copy.paste;
          break;
        case "markdown":
          title = bootstrap.title || copy.paste;
          break;
        case "password":
          title = copy.passwordRequired;
          break;
        case "error":
          title = errorMessage(bootstrap.locale, bootstrap.errorCode);
          break;
        default: {
          const exhaustive: never = bootstrap;
          return exhaustive;
        }
      }

      return <h1>{title}</h1>;
    }
  }
}

export function App({ initialPage }: AppProps) {
  const locale = initialPage.ok ? initialPage.bootstrap.locale : initialPage.locale;
  const copy = labels(locale);

  return (
    <SidebarProvider>
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1 !size-11" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{copy.brand}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">
          <PageContent initialPage={initialPage} />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
