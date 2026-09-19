import * as React from "react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { labels, type Locale } from "../../i18n";
import { AppSidebar, type SidebarActionGroup, type SidebarDestination, type SidebarDestinationGroup, type SidebarMetadata } from "./app-sidebar";
import { HelpProvider } from "./HelpTrigger";

export interface WorkbenchShellProps {
  locale: Locale;
  breadcrumb: readonly string[];
  headingId: string;
  destinationGroups: readonly SidebarDestinationGroup[];
  metadata?: readonly SidebarMetadata[];
  actionGroups?: readonly SidebarActionGroup[];
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  onDestinationSelect?(destination: SidebarDestination): void;
}

export function WorkbenchShell({
  locale,
  breadcrumb,
  headingId,
  destinationGroups,
  metadata,
  actionGroups,
  headerActions,
  children,
  onDestinationSelect,
}: WorkbenchShellProps) {
  const copy = labels(locale);
  const selectDestination = React.useCallback((destination: SidebarDestination) => {
    onDestinationSelect?.(destination);
    requestAnimationFrame(() => {
      const heading = document.getElementById(destination.headingId ?? headingId);
      if (heading instanceof HTMLElement) {
        heading.focus();
        return;
      }
      document.getElementById("workbench-sidebar-trigger")?.focus();
    });
  }, [headingId, onDestinationSelect]);

  return (
    <HelpProvider>
      <SidebarProvider>
        <AppSidebar
          destinationGroups={destinationGroups}
          {...(metadata === undefined ? {} : { metadata, metadataLabel: copy.documentStatus })}
          {...(actionGroups === undefined ? {} : { actionGroups })}
          onDestinationSelect={selectDestination}
        />
        <SidebarInset>
          <header className="flex min-w-0 items-center gap-2 border-b px-2 sm:px-4">
            <SidebarTrigger id="workbench-sidebar-trigger" aria-label={copy.toggleSidebar} className="size-11 shrink-0" />
            <Separator orientation="vertical" className="my-3 h-4" />
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList className="flex-nowrap overflow-hidden">
                {breadcrumb.map((item, index) => (
                  <React.Fragment key={`${index}:${item}`}>
                    {index > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem className="min-w-0 truncate">
                      <BreadcrumbPage className="truncate">{item}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </React.Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            {headerActions !== undefined && <div className="flex shrink-0 items-center gap-2">{headerActions}</div>}
          </header>
          <div className="mx-auto flex w-full max-w-[76rem] min-w-0 flex-1 flex-col gap-4 overflow-x-clip p-4">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </HelpProvider>
  );
}
