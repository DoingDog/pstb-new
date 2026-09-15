// Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.
import * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

export interface SidebarDestination {
  id: string;
  label: string;
  selected: boolean;
  headingId?: string;
  onSelect?(): void;
}

export interface SidebarDestinationGroup {
  id: string;
  label: string;
  destinations: readonly SidebarDestination[];
}

export interface SidebarMetadata {
  label: string;
  value: string;
}

export interface SidebarActionGroup {
  id: string;
  label: string;
  content: React.ReactNode;
}

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  destinations?: readonly SidebarDestination[];
  destinationGroups?: readonly SidebarDestinationGroup[];
  destinationLabel?: string;
  metadata?: readonly SidebarMetadata[];
  metadataLabel?: string;
  actions?: React.ReactNode;
  actionGroups?: readonly SidebarActionGroup[];
  actionsLabel?: string;
  onDestinationSelect?(destination: SidebarDestination): void;
}

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
            <span>{label}</span>
            <ChevronRightIcon className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function SidebarDestinations({ destinations, onDestinationSelect }: {
  destinations: readonly SidebarDestination[];
  onDestinationSelect: ((destination: SidebarDestination) => void) | undefined;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {destinations.map((destination) => (
        <SidebarMenuItem key={destination.id}>
          <SidebarMenuButton
            type="button"
            size="lg"
            isActive={destination.selected}
            aria-current={destination.selected ? "page" : undefined}
            onClick={() => {
              destination.onSelect?.();
              if (isMobile) setOpenMobile(false);
              onDestinationSelect?.(destination);
            }}
          >
            {destination.label}
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

export function AppSidebar({
  destinations,
  destinationGroups,
  destinationLabel,
  metadata,
  metadataLabel,
  actions,
  actionGroups,
  actionsLabel,
  onDestinationSelect,
  ...props
}: AppSidebarProps) {
  const navigation = destinationGroups ?? (destinations === undefined || destinations.length === 0
    ? []
    : [{ id: "destinations", label: destinationLabel ?? "", destinations }]);
  const actionSections = actionGroups ?? (actions === undefined ? [] : [{ id: "actions", label: actionsLabel ?? "", content: actions }]);

  return (
    <Sidebar {...props}>
      <SidebarContent>
        {navigation.map((group) => (
          <SidebarSection key={group.id} label={group.label}>
            <SidebarDestinations destinations={group.destinations} onDestinationSelect={onDestinationSelect} />
          </SidebarSection>
        ))}
        {metadata !== undefined && metadata.length > 0 && (
          <SidebarSection label={metadataLabel ?? ""}>
            <dl className="grid gap-2 px-2 text-sm">
              {metadata.map((item) => (
                <div key={item.label} className="grid gap-0.5">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd className="break-words">{item.value}</dd>
                </div>
              ))}
            </dl>
          </SidebarSection>
        )}
      </SidebarContent>
      {actionSections.length > 0 && (
        <SidebarFooter>
          {actionSections.map((group) => <SidebarSection key={group.id} label={group.label}>{group.content}</SidebarSection>)}
        </SidebarFooter>
      )}
      <SidebarRail className="w-11 group-data-[side=left]:-right-[22px] group-data-[side=right]:-left-[22px]" style={{ width: "44px", minHeight: "44px" }} />
    </Sidebar>
  );
}
