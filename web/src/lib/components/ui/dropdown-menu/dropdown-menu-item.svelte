<script lang="ts" module>
  import type { WithoutChildrenOrChild } from "bits-ui";
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

  export type DropdownMenuItemProps = WithoutChildrenOrChild<DropdownMenuPrimitive.ItemProps> & {
    inset?: boolean;
    variant?: "default" | "destructive";
    children?: import("svelte").Snippet;
  };
</script>

<script lang="ts">
  import { cn } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    inset = false,
    variant = "default",
    children,
    ...restProps
  }: DropdownMenuItemProps = $props();
</script>

<DropdownMenuPrimitive.Item
  bind:ref
  data-inset={inset ? "" : undefined}
  data-variant={variant}
  class={cn(
    "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</DropdownMenuPrimitive.Item>
