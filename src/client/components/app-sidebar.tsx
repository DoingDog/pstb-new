// Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.
import * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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

export interface SidebarMetadata {
  label: string;
  value: string;
}

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  destinations?: readonly SidebarDestination[];
  metadata?: readonly SidebarMetadata[];
  actions?: React.ReactNode;
  onDestinationSelect?(destination: SidebarDestination): void;
}

function SidebarDestinations({ destinations, onDestinationSelect }: {
  destinations: readonly SidebarDestination[] | undefined;
  onDestinationSelect: ((destination: SidebarDestination) => void) | undefined;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  if (destinations === undefined || destinations.length === 0) return null;

  return (
    <SidebarGroup>
      <SidebarGroupContent>
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
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar({ destinations, metadata, actions, onDestinationSelect, ...props }: AppSidebarProps) {
  return (
    <Sidebar {...props}>
      <SidebarContent>
        <SidebarDestinations destinations={destinations} onDestinationSelect={onDestinationSelect} />
        {metadata !== undefined && metadata.length > 0 && (
          <SidebarGroup>
            <SidebarGroupContent>
              <dl className="grid gap-2 px-2 text-sm">
                {metadata.map((item) => (
                  <div key={item.label} className="grid gap-0.5">
                    <dt className="text-muted-foreground">{item.label}</dt>
                    <dd className="break-words">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      {actions !== undefined && <SidebarFooter>{actions}</SidebarFooter>}
      <SidebarRail />
    </Sidebar>
  );
}
